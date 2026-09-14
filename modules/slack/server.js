'use strict';

/**
 * Slack — server part.
 *
 * One Slack Web API connection per ProdDash machine — the campus's shared
 * location account (a user token), or a bot — polled for the configured
 * channel's recent history and fanned out to every tile over SSE, plus
 * PIN-gated sending from this machine so a message reads as coming from the
 * location. Browsers never talk to Slack; the token and the PIN stay here.
 *
 *   GET  /state      snapshot: identity, channel, messages, sending state
 *   GET  /stream     SSE `state` events (change-detected, heartbeated)
 *   GET  /channels   admin select options — the channels the account is in
 *   POST /unlock     { pin } → { token, expiresAt }   (constant-time, lockout)
 *   POST /lock       Bearer → forget that unlock token
 *   GET  /quick      Bearer → preset labels + indexes (never the message text)
 *   POST /send       Bearer, { text, channel? } → chat.postMessage
 *   POST /quick      Bearer, { index } → post that preset
 *
 * SLACK_API_BASE=http://127.0.0.1:24716/api points the module at
 * tools/slack-mock.js for development.
 */

const crypto = require('crypto');

const DEFAULT_API_BASE = 'https://slack.com/api';
const API_BASE = String(process.env.SLACK_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');

/** Abort a hung Slack request well before the poll cadence stacks up. */
const REQUEST_TIMEOUT_MS = 10000;
/** SSE comment ping cadence — keeps idle connections alive through sleepy Wi-Fi. */
const HEARTBEAT_MS = 15000;
/** Fastest allowed history poll; the admin default is 2 s. */
const MIN_POLL_S = 1;
/** With no tile watching, poll this slowly instead — the API budget is shared with sends. */
const IDLE_POLL_S = 15;
/** …once nothing has asked for /state or /stream for this long. */
const IDLE_AFTER_MS = 30000;
const HISTORY_MIN = 5;
const HISTORY_MAX = 200;
/** Thread fetches per poll (oldest parent first) — keeps a busy channel inside Tier 3. */
const THREAD_FETCHES_PER_POLL = 3;
const THREAD_REPLIES_LIMIT = 50;
const USER_LOOKUPS_PER_POLL = 15;
const USER_TTL_MS = 60 * 60 * 1000;
const CHANNEL_LIST_TTL_MS = 10 * 60 * 1000;
const RETRY_NETWORK_MS = 10000;
/** A bad token or an unreadable channel: nothing we do fixes it, so re-check slowly. */
const RETRY_CONFIG_MS = 60000;
/** "Join it in Slack" — someone may just have. */
const RETRY_MEMBERSHIP_MS = 30000;
const PIN_RE = /^\d{4,8}$/;
const PIN_MAX_WRONG = 5;
const PIN_LOCKOUT_MS = 30000;
const SEND_MIN_INTERVAL_MS = 1000;
const MAX_TEXT_CHARS = 4000;
const BODY_LIMIT_BYTES = 64 * 1024;
const DEFAULT_ICON = ':satellite_antenna:';
const UNLOCK_SWEEP_MS = 30000;

/** Set by init(), read by routes() and tiles() — all rebuilt together on remount. */
let current = null;

/* ── Slack Web API ──────────────────────────────────────────────────── */

class SlackError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Call one Web API method. Form-encoded by default; chat.postMessage takes JSON. */
async function slackCall(token, method, params = {}, { json = false } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    body = JSON.stringify(params);
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') form.set(k, String(v));
    }
    body = form.toString();
  }
  let response;
  try {
    response = await fetch(`${API_BASE}/${method}`, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SlackError('network', { network: true, detail: err?.message || String(err) });
  }
  if (response.status === 429) {
    const retryAfter = Math.max(1, Math.trunc(Number(response.headers.get('retry-after'))) || 5);
    throw new SlackError('ratelimited', { retryAfter, status: 429 });
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new SlackError('bad_response', { status: response.status });
  }
  if (!response.ok || !data || data.ok !== true) {
    const meta = data?.response_metadata;
    throw new SlackError(String(data?.error || `http_${response.status}`), {
      status: response.status,
      needed: data?.needed ? String(data.needed) : '',
      detail: Array.isArray(meta?.messages) ? meta.messages.join('; ') : '',
    });
  }
  return data;
}

/** A Slack error as a sentence a tech can act on. */
function describeError(err, ctx = {}) {
  const who = ctx.name || 'The Slack account';
  const chan = ctx.channel ? `#${ctx.channel}` : 'the channel';
  switch (err?.code) {
    case 'network': return `Slack unreachable: ${err.detail}`;
    case 'ratelimited': return `Slack is rate-limiting — try again in ${err.retryAfter} s`;
    case 'invalid_auth': return 'Slack rejected the token (invalid_auth) — paste a current User OAuth Token in Admin → Slack';
    case 'not_authed': return 'No token reached Slack (not_authed) — paste the User OAuth Token in Admin → Slack';
    case 'token_revoked': return 'The token was revoked (token_revoked) — Reinstall to Workspace in the Slack app and paste the new token';
    case 'token_expired': return 'The token expired (token_expired) — Reinstall to Workspace in the Slack app and paste the new token';
    case 'account_inactive': return 'The Slack account behind the token is deactivated (account_inactive)';
    case 'missing_scope': return `The token is missing the ${err.needed || 'required'} scope (missing_scope) — add it under OAuth & Permissions, reinstall, paste the new token`;
    case 'not_in_channel': return `${who} isn't a member of ${chan} — join it in Slack`;
    case 'channel_not_found': return 'Channel not found (channel_not_found) — pick it again in Admin → Slack → Channel';
    case 'is_archived': return `${chan} is archived (is_archived)`;
    case 'msg_too_long': return 'Message too long for Slack (msg_too_long)';
    case 'no_text': return 'Nothing to send (no_text)';
    case 'restricted_action': return `Posting in ${chan} is restricted by a workspace admin (restricted_action)`;
    case 'bad_response': return `Slack answered with something that isn't JSON (HTTP ${err.status})`;
    default: return `Slack error: ${err?.code || err?.message || err}${err?.detail ? ` — ${err.detail}` : ''}`;
  }
}

/** Errors that no amount of retrying fixes — config has to change. */
function isConfigError(err) {
  return ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'missing_scope', 'channel_not_found'].includes(err?.code);
}

/* ── mrkdwn → plain text with a few inline marks ────────────────────── */

const EMOJI = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', white_check_mark: '✅', heavy_check_mark: '✔️',
  x: '❌', pray: '🙏', tada: '🎉', fire: '🔥', eyes: '👀', heart: '❤️', clap: '👏', warning: '⚠️',
  rotating_light: '🚨', smile: '😄', grinning: '😀', joy: '😂', sweat_smile: '😅', thinking_face: '🤔',
  wave: '👋', ok_hand: '👌', raised_hands: '🙌', bell: '🔔', microphone: '🎤', musical_note: '🎵',
  video_camera: '📹', tv: '📺', church: '⛪', zap: '⚡', 100: '💯', point_right: '👉', muscle: '💪',
  slightly_smiling_face: '🙂', raised_hand: '✋', satellite_antenna: '📡',
};

function unescapeSlack(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Slack mrkdwn → plain text. Mentions, channel links, broadcasts and URLs are
 * spelled out; *bold* _italic_ ~strike~ `code` markers are kept for the
 * client to style; :shortcodes: in the small map become the emoji.
 */
function renderMrkdwn(raw, lookupUser, lookupChannel) {
  let text = String(raw || '');
  text = text.replace(/<([^<>]+)>/g, (m, inner) => {
    if (inner.startsWith('@')) {
      const [id, label] = inner.slice(1).split('|');
      return '@' + (label || lookupUser(id) || id);
    }
    if (inner.startsWith('#')) {
      const [id, label] = inner.slice(1).split('|');
      return '#' + (label || lookupChannel(id) || id);
    }
    if (inner.startsWith('!')) {
      const [cmd, label] = inner.slice(1).split('|');
      if (cmd.startsWith('subteam^')) return label ? (label.startsWith('@') ? label : '@' + label) : '@group';
      if (cmd.startsWith('date^')) {
        const secs = Number(cmd.split('^')[1]);
        return label || (secs ? new Date(secs * 1000).toLocaleString() : 'date');
      }
      return '@' + (label || cmd);
    }
    const [url, label] = inner.split('|');
    if (label && label !== url) return `${label} (${url})`;
    return url.replace(/^mailto:/, '');
  });
  text = unescapeSlack(text);
  text = text.replace(/:([a-z0-9_+-]+):/g, (m, code) => EMOJI[code] || m);
  return text;
}

/** Text from a blocks-only message (section / context / rich_text). */
function textFromBlocks(blocks) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return void node.forEach(walk);
    if (typeof node.text === 'string' && (node.type === 'text' || node.type === 'mrkdwn' || node.type === 'plain_text')) {
      out.push(node.text);
      return;
    }
    if (node.type === 'link') return void out.push(node.text || node.url || '');
    if (node.type === 'emoji' && node.name) return void out.push(`:${node.name}:`);
    if (node.type === 'user' && node.user_id) return void out.push(`<@${node.user_id}>`);
    if (node.type === 'channel' && node.channel_id) return void out.push(`<#${node.channel_id}>`);
    if (node.type === 'broadcast' && node.range) return void out.push(`<!${node.range}>`);
    for (const key of ['text', 'elements', 'fields', 'title']) if (node[key]) walk(node[key]);
  };
  walk(blocks);
  return out.join(' ').replace(/\s+\n/g, '\n').trim();
}

/* ── small helpers ──────────────────────────────────────────────────── */

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        const body = JSON.parse(data);
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        reject(new Error('Malformed JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** Route handlers are async — the shell only catches synchronous throws. */
function guard(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: err?.message || String(err) });
        else try { res.end(); } catch { /* gone */ }
      });
  };
}

function bearer(req) {
  const m = /^Bearer\s+([A-Za-z0-9]+)\s*$/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : '';
}

function clientIp(req) {
  return String(req.socket?.remoteAddress || '');
}

/** Constant-time PIN compare (lengths are folded in after the timing-safe step). */
function pinMatches(given, expected) {
  const a = Buffer.alloc(16);
  const b = Buffer.alloc(16);
  a.write(String(given).slice(0, 16));
  b.write(String(expected).slice(0, 16));
  const same = crypto.timingSafeEqual(a, b);
  return same && given.length === expected.length;
}

/**
 * "Label | Message | #channel" per line. A line with no "|" is both its label
 * and its message; the channel (optional) is a name the account can see.
 */
function parseQuickReplies(text) {
  const out = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|').map((p) => p.trim());
    const label = parts[0];
    const message = parts.length > 1 && parts[1] ? parts[1] : label;
    const channel = parts.length > 2 ? parts[2].replace(/^#/, '') : '';
    if (!label || !message) continue;
    out.push({ label, message, channel });
  }
  return out;
}

const SYSTEM_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name',
  'channel_archive', 'channel_unarchive', 'group_join', 'group_leave', 'group_topic',
  'group_purpose', 'group_name', 'pinned_item', 'unpinned_item', 'bot_add', 'bot_remove',
  'sh_room_created', 'reminder_add', 'huddle_thread',
]);

/* ── the module ─────────────────────────────────────────────────────── */

module.exports = {
  init({ config, log }) {
    /* ── config ── */
    const token = String(config.token || '').trim();
    const sendAs = String(config.sendAs || '').trim();
    const channelId = String(config.channel || '').trim();
    const pollMs = Math.max(MIN_POLL_S, Number(config.pollSeconds) || 2) * 1000;
    const historyCount = Math.min(HISTORY_MAX, Math.max(HISTORY_MIN, Math.trunc(Number(config.historyCount)) || 40));
    const includeReplies = Boolean(config.includeReplies);
    const sendEnabled = Boolean(config.sendEnabled);
    const pin = String(config.pin || '').trim();
    const pinOk = PIN_RE.test(pin);
    const idleMs = Math.min(240, Math.max(1, Number(config.pinIdleMinutes) || 10)) * 60 * 1000;
    const quickReplies = parseQuickReplies(config.quickReplies);

    /* ── state (all inside this closure so a re-init starts clean) ── */
    let stopped = false;
    let identity = null;        // { kind: 'user'|'bot', name, handle, userId, team, botId }
    let authError = '';
    let channel = null;         // { id, name, isMember, isPrivate }
    let channelError = '';
    let pollError = '';
    let lastPollAt = 0;
    let rawWindow = [];         // conversations.history messages, as Slack sent them (newest first)
    const threads = new Map();  // parent ts -> { latestReply, replyCount, replies: [raw…] }
    const users = new Map();    // user id -> { name, at }
    const pendingUsers = new Set();
    const channelNames = new Map(); // channel id -> name (from list/info calls)
    let channelList = { at: 0, channels: [] };
    let channelListPromise = null;
    let snapshotCache = null;
    let lastSig = '';
    let lastInterest = Date.now();
    let pollTimer = null;
    let polling = false;
    let pollAgain = false;
    let currentIntervalMs = pollMs;
    const streams = new Set();
    const unlocks = new Map();     // token -> { expiresAt, lastSendAt, ip }
    const pinAttempts = new Map(); // ip -> { count, lockedUntil }

    /* ── names ── */
    function lookupUser(id) {
      if (!id) return '';
      const hit = users.get(id);
      if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.name;
      pendingUsers.add(id);
      return hit ? hit.name : '';
    }

    function lookupChannel(id) {
      return channelNames.get(id) || '';
    }

    async function resolveUsers() {
      const ids = [...pendingUsers].slice(0, USER_LOOKUPS_PER_POLL);
      if (!ids.length) return false;
      let changed = false;
      await Promise.all(ids.map(async (id) => {
        pendingUsers.delete(id);
        try {
          const data = await slackCall(token, 'users.info', { user: id });
          const u = data.user || {};
          const name = String(u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || id);
          users.set(id, { name, at: Date.now() });
          changed = true;
        } catch (err) {
          // Unknown or deactivated: remember the raw id for a while so we
          // don't ask again every poll. Rate limits and outages retry.
          if (err.code !== 'network' && err.code !== 'ratelimited') users.set(id, { name: id, at: Date.now() });
        }
      }));
      return changed;
    }

    /* ── channel list (admin options, #name → id, <#C…> rendering) ── */
    async function loadChannelList(force = false) {
      if (!force && Date.now() - channelList.at < CHANNEL_LIST_TTL_MS) return channelList.channels;
      if (channelListPromise) return channelListPromise;
      channelListPromise = (async () => {
        const all = [];
        let cursor = '';
        for (let page = 0; page < 10; page += 1) {
          const data = await slackCall(token, 'conversations.list', {
            types: 'public_channel,private_channel',
            exclude_archived: 'true',
            limit: 200,
            cursor: cursor || undefined,
          });
          for (const c of data.channels || []) {
            if (!c?.id) continue;
            channelNames.set(String(c.id), String(c.name || ''));
            all.push({ id: String(c.id), name: String(c.name || ''), isMember: Boolean(c.is_member), isPrivate: Boolean(c.is_private) });
          }
          cursor = String(data.response_metadata?.next_cursor || '');
          if (!cursor) break;
        }
        all.sort((a, b) => a.name.localeCompare(b.name));
        channelList = { at: Date.now(), channels: all };
        return all;
      })();
      try {
        return await channelListPromise;
      } finally {
        channelListPromise = null;
      }
    }

    /** "#name" or a channel id → the channel id, or '' when the account can't see it. */
    async function resolveChannel(ref) {
      const s = String(ref || '').trim();
      if (!s) return channelId;
      if (/^[CG][A-Z0-9]{6,}$/.test(s)) return s;
      const name = s.replace(/^#/, '').toLowerCase();
      let list = await loadChannelList();
      let hit = list.find((c) => c.name.toLowerCase() === name);
      if (!hit) {
        list = await loadChannelList(true);
        hit = list.find((c) => c.name.toLowerCase() === name);
      }
      return hit ? hit.id : '';
    }

    /* ── normalisation ── */
    function nameFor(m) {
      if (m.subtype === 'bot_message' && m.username) return String(m.username);
      if (m.user) {
        const n = lookupUser(String(m.user));
        if (n) return n;
      }
      if (m.bot_profile?.name) return String(m.bot_profile.name);
      if (m.username) return String(m.username);
      return String(m.user || m.bot_id || 'unknown');
    }

    function textFor(m) {
      let text = renderMrkdwn(m.text, lookupUser, lookupChannel).trim();
      if (!text && Array.isArray(m.attachments)) {
        text = m.attachments
          .map((a) => renderMrkdwn(a?.fallback || a?.text || a?.title || '', lookupUser, lookupChannel).trim())
          .filter(Boolean)
          .join('\n');
      }
      if (!text && Array.isArray(m.blocks)) text = renderMrkdwn(textFromBlocks(m.blocks), lookupUser, lookupChannel);
      if (Array.isArray(m.files) && m.files.length) {
        const files = m.files.map((f) => `[file: ${f?.title || f?.name || 'file'}]`).join(' ');
        text = text ? `${text}\n${files}` : files;
      }
      return text;
    }

    function normalize(m, parentTs = '') {
      if (!m || typeof m !== 'object' || !m.ts) return null;
      if (m.subtype === 'tombstone') return null;
      const name = nameFor(m);
      const system = SYSTEM_SUBTYPES.has(m.subtype || '');
      let text = textFor(m);
      if (m.subtype === 'channel_join' || m.subtype === 'group_join') text = `${name} joined ${channel ? '#' + channel.name : 'the channel'}`;
      else if (m.subtype === 'channel_leave' || m.subtype === 'group_leave') text = `${name} left ${channel ? '#' + channel.name : 'the channel'}`;
      const out = {
        id: String(m.ts),
        ts: String(m.ts),
        time: Math.round(Number(m.ts) * 1000) || Date.now(),
        name,
        text,
        edited: Boolean(m.edited),
        system,
        subtype: String(m.subtype || ''),
        bot: Boolean(m.bot_id) || m.subtype === 'bot_message',
        me: Boolean(identity && m.user && m.user === identity.userId),
      };
      if (parentTs) out.parent = parentTs;
      else {
        out.replyCount = Math.max(0, Math.trunc(Number(m.reply_count)) || 0);
        if (includeReplies && out.replyCount) {
          const t = threads.get(out.ts);
          out.replies = t ? t.replies.map((r) => normalize(r, out.ts)).filter(Boolean) : [];
        }
      }
      return out;
    }

    function identityLabel() {
      if (!identity) return '';
      if (identity.kind === 'bot') return sendAs ? `${identity.name} (bot) as "${sendAs}"` : `${identity.name} (bot)`;
      return identity.name;
    }

    function sendingAs() {
      if (!identity) return '';
      return identity.kind === 'bot' && sendAs ? sendAs : identity.name;
    }

    function health() {
      if (!token) return { status: 'error', message: 'No Slack token — paste the location account’s User OAuth Token in Admin → Slack' };
      if (authError) return { status: 'error', message: authError };
      if (!identity) return { status: 'connecting', message: 'Checking the Slack token…' };
      const who = identityLabel();
      if (!channelId) return { status: 'error', message: `${who} · pick a channel in Admin → Slack → Channel` };
      if (channelError) return { status: 'error', message: `${who} · ${channelError}` };
      if (!channel) return { status: 'connecting', message: `${who} · looking up the channel…` };
      const sending = !sendEnabled ? 'sending off' : !pinOk ? 'sending on — set a 4–8 digit PIN' : 'sending on';
      if (pollError) return { status: 'error', message: `${who} · #${channel.name} · ${pollError}` };
      if (!lastPollAt) return { status: 'connecting', message: `${who} · #${channel.name} · first read…` };
      const age = Date.now() - lastPollAt;
      if (age > 3 * currentIntervalMs + 5000) {
        return { status: 'connecting', message: `${who} · #${channel.name} · last read ${Math.round(age / 1000)} s ago` };
      }
      return { status: 'ok', message: `${who} · #${channel.name} · ${sending}` };
    }

    function snapshot() {
      if (snapshotCache) return snapshotCache;
      const messages = rawWindow
        .map((m) => normalize(m))
        .filter(Boolean)
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      const h = health();
      snapshotCache = {
        identity: identity
          ? { kind: identity.kind, name: identity.name, team: identity.team, sendAs: identity.kind === 'bot' ? sendAs : '' }
          : null,
        sendingAs: sendingAs(),
        channel: channel ? { id: channel.id, name: channel.name, isMember: channel.isMember } : (channelId ? { id: channelId, name: lookupChannel(channelId), isMember: null } : null),
        messages,
        includeReplies,
        historyCount,
        sending: { enabled: sendEnabled, pinSet: pinOk, idleMinutes: idleMs / 60000 },
        status: { state: h.status, message: h.message, lastPollAt },
        apiBase: API_BASE,
      };
      return snapshotCache;
    }

    function invalidate() {
      snapshotCache = null;
    }

    /** Broadcast the snapshot when anything a tile shows has changed. */
    function broadcastIfChanged() {
      invalidate();
      const snap = snapshot();
      const { lastPollAt: _ignored, ...statusSig } = snap.status;
      const sig = JSON.stringify({ ...snap, status: statusSig });
      if (sig === lastSig) return;
      lastSig = sig;
      if (!streams.size) return;
      const payload = `event: state\ndata: ${JSON.stringify(snap)}\n\n`;
      for (const res of streams) {
        try {
          res.write(payload);
        } catch {
          streams.delete(res);
        }
      }
    }

    /* ── the poll loop: token → channel → history (+ threads, names) ── */
    function schedule(ms) {
      if (stopped) return;
      clearTimeout(pollTimer);
      currentIntervalMs = ms;
      pollTimer = setTimeout(tick, ms);
      pollTimer.unref?.();
    }

    function pollSoon() {
      if (stopped) return;
      if (polling) {
        pollAgain = true;
        return;
      }
      clearTimeout(pollTimer);
      pollTimer = setTimeout(tick, 250);
      pollTimer.unref?.();
    }

    function watched() {
      return streams.size > 0 || Date.now() - lastInterest < IDLE_AFTER_MS;
    }

    async function checkAuth() {
      const data = await slackCall(token, 'auth.test', {});
      const userId = String(data.user_id || '');
      const id = {
        kind: data.bot_id ? 'bot' : 'user',
        name: String(data.user || 'Slack'),
        handle: String(data.user || ''),
        userId,
        team: String(data.team || ''),
        botId: data.bot_id ? String(data.bot_id) : '',
      };
      // The handle is "apollo.beach"; the display name is "Apollo Beach".
      if (userId) {
        try {
          const u = await slackCall(token, 'users.info', { user: userId });
          const name = String(u.user?.profile?.display_name || u.user?.real_name || u.user?.profile?.real_name || '').trim();
          if (name) id.name = name;
          users.set(userId, { name: id.name, at: Date.now() });
        } catch { /* the handle will do */ }
      }
      identity = id;
      authError = '';
      log(`token belongs to ${identityLabel()} (${id.team || 'team unknown'})${id.kind === 'bot' && !sendAs ? ' — messages will read as the app; set "Send as" to name the location' : ''}`);
    }

    async function checkChannel() {
      const data = await slackCall(token, 'conversations.info', { channel: channelId });
      const c = data.channel || {};
      channel = {
        id: String(c.id || channelId),
        name: String(c.name || c.name_normalized || channelId),
        isMember: c.is_member !== false,
        isPrivate: Boolean(c.is_private),
      };
      channelNames.set(channel.id, channel.name);
      channelError = '';
      if (!channel.isMember) {
        channelError = `${identity?.name || 'The account'} isn't a member of #${channel.name} — join it in Slack`;
        throw new SlackError('not_in_channel');
      }
    }

    async function readHistory() {
      const data = await slackCall(token, 'conversations.history', { channel: channelId, limit: historyCount });
      const messages = Array.isArray(data.messages) ? data.messages.filter((m) => m && m.ts) : [];
      rawWindow = messages;
      lastPollAt = Date.now();
      pollError = '';

      // Threads: parents in the window whose reply set changed since we
      // last read it — oldest first, a few per poll.
      const inWindow = new Set(messages.map((m) => String(m.ts)));
      for (const ts of [...threads.keys()]) if (!inWindow.has(ts)) threads.delete(ts);
      if (includeReplies) {
        const stale = messages
          .filter((m) => Number(m.reply_count) > 0)
          .filter((m) => {
            const t = threads.get(String(m.ts));
            return !t || t.latestReply !== String(m.latest_reply || '') || t.replyCount !== Number(m.reply_count);
          })
          .sort((a, b) => Number(a.ts) - Number(b.ts))
          .slice(0, THREAD_FETCHES_PER_POLL);
        for (const parent of stale) {
          try {
            const rep = await slackCall(token, 'conversations.replies', { channel: channelId, ts: parent.ts, limit: THREAD_REPLIES_LIMIT });
            const replies = (rep.messages || []).filter((r) => r && r.ts && String(r.ts) !== String(parent.ts));
            threads.set(String(parent.ts), { latestReply: String(parent.latest_reply || ''), replyCount: Number(parent.reply_count), replies });
          } catch (err) {
            if (err.code === 'ratelimited') throw err;
            log(`thread ${parent.ts}: ${describeError(err, { name: identity?.name, channel: channel?.name })}`);
          }
        }
      }
    }

    async function tick() {
      if (stopped || polling) return;
      polling = true;
      pollAgain = false;
      let next = watched() ? pollMs : Math.max(pollMs, IDLE_POLL_S * 1000);
      try {
        if (!identity) await checkAuth();
        if (!channelId) {
          next = RETRY_CONFIG_MS;
        } else {
          if (!channel || channelError) await checkChannel();
          await readHistory();
          await resolveUsers();
        }
      } catch (err) {
        const ctx = { name: identity?.name, channel: channel?.name };
        const text = describeError(err, ctx);
        if (!identity) {
          authError = text;
          next = isConfigError(err) ? RETRY_CONFIG_MS : RETRY_NETWORK_MS;
        } else if (!channel || channelError) {
          if (!channelError) channelError = text;
          next = err.code === 'not_in_channel' ? RETRY_MEMBERSHIP_MS : isConfigError(err) ? RETRY_CONFIG_MS : RETRY_NETWORK_MS;
        } else {
          pollError = text;
          if (err.code === 'not_in_channel') {
            channel.isMember = false;
            channelError = text;
            next = RETRY_MEMBERSHIP_MS;
          } else next = isConfigError(err) ? RETRY_CONFIG_MS : Math.max(pollMs, RETRY_NETWORK_MS);
        }
        if (err.code === 'ratelimited') next = err.retryAfter * 1000;
        log(text);
      } finally {
        polling = false;
        broadcastIfChanged();
        if (pollAgain) pollSoon();
        else schedule(next);
      }
    }

    /* ── unlock tokens ── */
    function sweepUnlocks() {
      const now = Date.now();
      for (const [t, u] of unlocks) if (u.expiresAt <= now) unlocks.delete(t);
      for (const [ip, a] of pinAttempts) if (a.lockedUntil && a.lockedUntil <= now && !a.count) pinAttempts.delete(ip);
    }

    /** The unlock behind a request, or null (the client re-asks for the PIN). */
    function unlockFor(req) {
      const t = bearer(req);
      const u = t ? unlocks.get(t) : null;
      if (!u) return null;
      if (u.expiresAt <= Date.now()) {
        unlocks.delete(t);
        return null;
      }
      return { token: t, ...u };
    }

    /** Everything a send needs before Slack is asked; answers the response itself when refusing. */
    function sendGate(req, res) {
      if (!sendEnabled) {
        sendJson(res, 403, { error: 'Sending is off — turn it on in Admin → Slack → Sending', code: 'sending_off' });
        return null;
      }
      if (!pinOk) {
        sendJson(res, 403, { error: 'Set a PIN in Admin → Slack → Sending', code: 'no_pin' });
        return null;
      }
      const u = unlockFor(req);
      if (!u) {
        sendJson(res, 401, { error: 'Locked — enter the PIN', code: 'locked' });
        return null;
      }
      return u;
    }

    async function postMessage(targetChannelId, text) {
      const params = { channel: targetChannelId, text };
      if (identity?.kind === 'bot' && sendAs) {
        params.username = sendAs;
        params.icon_emoji = DEFAULT_ICON;
      }
      return slackCall(token, 'chat.postMessage', params, { json: true });
    }

    /** Post on behalf of an unlock; answers the response. */
    async function deliver(req, res, unlock, { text, channelRef, what }) {
      const now = Date.now();
      if (now - unlock.lastSendAt < SEND_MIN_INTERVAL_MS) {
        return sendJson(res, 429, { error: 'One message per second — try again', code: 'too_fast' });
      }
      unlocks.get(unlock.token).lastSendAt = now;
      if (!identity || authError) {
        return sendJson(res, 502, { error: authError || 'Slack token not checked yet — try again in a moment' });
      }
      let target = channelId;
      if (channelRef) {
        try {
          target = await resolveChannel(channelRef);
        } catch (err) {
          return sendJson(res, 502, { error: describeError(err, { name: identity.name, channel: channel?.name }) });
        }
        if (!target) return sendJson(res, 400, { error: `No channel named #${String(channelRef).replace(/^#/, '')} that ${identity.name} can see` });
      }
      if (!target) return sendJson(res, 400, { error: 'No channel — pick one in Admin → Slack → Channel' });
      const targetName = lookupChannel(target) || target;
      try {
        const data = await postMessage(target, text);
        const u = unlocks.get(unlock.token);
        if (u) u.expiresAt = Date.now() + idleMs;
        const preview = text.replace(/\s+/g, ' ').slice(0, 60);
        log(`${what} → #${targetName} as ${sendingAs()}: "${preview}${text.length > 60 ? '…' : ''}"`);
        if (target === channelId) pollSoon();
        return sendJson(res, 200, {
          ok: true,
          ts: String(data.ts || ''),
          channel: `#${targetName}`,
          sendingAs: sendingAs(),
          expiresAt: u ? u.expiresAt : unlock.expiresAt,
        });
      } catch (err) {
        const message = describeError(err, { name: sendingAs() || identity.name, channel: targetName });
        log(`${what} to #${targetName} failed: ${message}`);
        return sendJson(res, err.code === 'ratelimited' ? 429 : 502, { error: message, code: err.code || 'slack_error' });
      }
    }

    /* ── go ── */
    const heartbeat = setInterval(() => {
      for (const res of streams) {
        try {
          res.write(': ping\n\n');
        } catch {
          streams.delete(res);
        }
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const sweeper = setInterval(sweepUnlocks, UNLOCK_SWEEP_MS);
    sweeper.unref?.();

    if (!token) log('no Slack token configured — paste one in /admin');
    else {
      if (sendEnabled && !pinOk) log('sending is on but no valid PIN (4–8 digits) is set — send tiles stay locked');
      schedule(50);
    }

    current = {
      streams,
      snapshot,
      health,
      quickReplies,
      sendGate,
      deliver,
      unlockFor,
      touch() { lastInterest = Date.now(); },
      wake() {
        lastInterest = Date.now();
        if (identity && channel && Date.now() - lastPollAt > pollMs) pollSoon();
      },
      loadChannelList,
      channelId,
      pinOk,
      sendEnabled,
      identityName: () => identity?.name || '',
      channelName: () => channel?.name || '',
      unlock(req, res, given) {
        if (!sendEnabled) return sendJson(res, 403, { error: 'Sending is off — turn it on in Admin → Slack → Sending', code: 'sending_off' });
        if (!pinOk) return sendJson(res, 403, { error: 'Set a PIN in Admin → Slack → Sending', code: 'no_pin' });
        const ip = clientIp(req);
        const now = Date.now();
        let a = pinAttempts.get(ip);
        if (a && a.lockedUntil > now) {
          const secs = Math.ceil((a.lockedUntil - now) / 1000);
          return sendJson(res, 429, { error: `Too many wrong PINs — locked for ${secs} s`, code: 'lockout', retryAfter: secs });
        }
        if (a && a.lockedUntil && a.lockedUntil <= now) a = null; // lockout served — clean slate
        const str = String(given ?? '');
        if (!PIN_RE.test(str) || !pinMatches(str, pin)) {
          const count = (a ? a.count : 0) + 1;
          if (count >= PIN_MAX_WRONG) {
            pinAttempts.set(ip, { count: 0, lockedUntil: now + PIN_LOCKOUT_MS });
            log(`wrong PIN ×${PIN_MAX_WRONG} from ${ip} — locked for ${PIN_LOCKOUT_MS / 1000} s`);
            return sendJson(res, 429, { error: `Wrong PIN — locked for ${PIN_LOCKOUT_MS / 1000} s`, code: 'lockout', retryAfter: PIN_LOCKOUT_MS / 1000 });
          }
          pinAttempts.set(ip, { count, lockedUntil: 0 });
          return sendJson(res, 401, { error: 'Wrong PIN', code: 'wrong_pin', triesLeft: PIN_MAX_WRONG - count });
        }
        pinAttempts.delete(ip);
        const t = crypto.randomBytes(32).toString('hex');
        const expiresAt = now + idleMs;
        unlocks.set(t, { expiresAt, lastSendAt: 0, ip });
        log(`unlocked from ${ip} (auto-lock after ${idleMs / 60000} min idle)`);
        return sendJson(res, 200, { token: t, expiresAt, idleMs, sendingAs: sendingAs(), channel: channel ? `#${channel.name}` : '' });
      },
      lock(req, res) {
        const t = bearer(req);
        if (t) unlocks.delete(t);
        return sendJson(res, 200, { ok: true });
      },
    };

    return {
      stop() {
        stopped = true;
        clearTimeout(pollTimer);
        clearInterval(heartbeat);
        clearInterval(sweeper);
        unlocks.clear(); // an admin Apply locks every send tile
        for (const res of streams) {
          try { res.end(); } catch { /* already gone */ }
        }
        streams.clear();
        if (current && current.streams === streams) current = null;
      },
      health,
    };
  },

  tiles() {
    const snap = current ? current.snapshot() : null;
    const chan = snap?.channel?.name ? `#${snap.channel.name}` : 'the configured channel';
    const who = snap?.sendingAs ? ` as ${snap.sendingAs}` : '';
    return [
      { id: 'transcript', name: 'Transcript', description: `Live transcript of ${chan}`, defaultSize: { w: 4, h: 4 }, minSize: { w: 2, h: 2 }, settings: { view: 'transcript' } },
      { id: 'send', name: 'Send message', description: `PIN-protected message to ${chan}${who}`, defaultSize: { w: 3, h: 3 }, minSize: { w: 2, h: 2 }, settings: { view: 'send' } },
      { id: 'quick', name: 'Quick replies', description: `PIN-protected preset buttons${who}`, defaultSize: { w: 3, h: 2 }, minSize: { w: 2, h: 1 }, settings: { view: 'quick' } },
    ];
  },

  routes() {
    const unmounted = (res) => sendJson(res, 503, { error: 'Slack module is restarting — try again' });

    return {
      'GET /state': (req, res) => {
        if (!current) return unmounted(res);
        current.wake();
        sendJson(res, 200, current.snapshot());
      },

      'GET /stream': (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        if (!current) {
          res.write(`event: state\ndata: ${JSON.stringify({ messages: [], status: { state: 'connecting', message: 'Slack module is restarting…' } })}\n\n`);
          return void res.end();
        }
        res.write(`event: state\ndata: ${JSON.stringify(current.snapshot())}\n\n`);
        // A viewer that stops reading (locked tablet, sleeping laptop) must
        // not queue frames forever; keepalive probes make the OS notice.
        try { req.socket.setKeepAlive(true, 15000); } catch { /* gone */ }
        current.streams.add(res);
        current.wake();
        req.on('close', () => current && current.streams.delete(res));
      },

      // The admin "Channel" select: channels the account is a member of.
      'GET /channels': guard(async (req, res) => {
        if (!current) return unmounted(res);
        try {
          const list = await current.loadChannelList(true);
          const options = list
            .filter((c) => c.isMember)
            .map((c) => ({ value: c.id, label: `#${c.name}${c.isPrivate ? ' (private)' : ''}` }));
          sendJson(res, 200, { options });
        } catch (err) {
          // 200 with no options: the admin page keeps the saved value selectable.
          sendJson(res, 200, { options: [], error: describeError(err, { name: current.identityName() }) });
        }
      }),

      'POST /unlock': guard(async (req, res) => {
        if (!current) return unmounted(res);
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        current.unlock(req, res, body.pin);
      }),

      'POST /lock': (req, res) => {
        if (!current) return unmounted(res);
        current.lock(req, res);
      },

      // Labels and indexes only — the message text never leaves the server.
      'GET /quick': (req, res) => {
        if (!current) return unmounted(res);
        const unlock = current.sendGate(req, res);
        if (!unlock) return;
        sendJson(res, 200, {
          presets: current.quickReplies.map((q, index) => ({ index, label: q.label, channel: q.channel ? `#${q.channel}` : '' })),
          expiresAt: unlock.expiresAt,
        });
      },

      'POST /send': guard(async (req, res) => {
        if (!current) return unmounted(res);
        const unlock = current.sendGate(req, res);
        if (!unlock) return;
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        const text = String(body.text ?? '').replace(/\r\n/g, '\n').trim();
        if (!text) return sendJson(res, 400, { error: 'Nothing to send' });
        if (text.length > MAX_TEXT_CHARS) return sendJson(res, 400, { error: `Too long — ${MAX_TEXT_CHARS} characters at most` });
        await current.deliver(req, res, unlock, { text, channelRef: body.channel ? String(body.channel) : '', what: 'sent' });
      }),

      'POST /quick': guard(async (req, res) => {
        if (!current) return unmounted(res);
        const unlock = current.sendGate(req, res);
        if (!unlock) return;
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        const index = Math.trunc(Number(body.index));
        const preset = Number.isInteger(index) ? current.quickReplies[index] : null;
        if (!preset) return sendJson(res, 404, { error: 'No such quick reply — the list may have changed in Admin' });
        await current.deliver(req, res, unlock, { text: preset.message, channelRef: preset.channel, what: `quick reply "${preset.label}"` });
      }),
    };
  },
};
