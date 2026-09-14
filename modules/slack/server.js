'use strict';

/**
 * Slack — server part.
 *
 * One Slack Web API connection per ProdDash machine — the campus's shared
 * location account (a user token), or a bot — polling the configured
 * channels' recent history (one poller per channel, all inside one rate
 * budget) and fanning the lot out to every tile over SSE, plus PIN-gated
 * sending from this machine so a message reads as coming from the location.
 * Browsers never talk to Slack; the token and the PIN stay here.
 *
 *   GET  /state      snapshot: identity, channels (keyed by id), sending state
 *   GET  /stream     SSE `state` events (change-detected, heartbeated)
 *   GET  /channels   admin multiselect options — the channels the account is in
 *   POST /unlock     { pin } → { token, expiresAt }   (constant-time, lockout)
 *   POST /lock       Bearer → forget that unlock token
 *   GET  /quick      Bearer → preset labels + indexes (never the message text)
 *   POST /send       Bearer, { text, channel } → chat.postMessage
 *   POST /react      Bearer, { channel, ts, name, remove? } → reactions.add / .remove
 *   GET  /emoji      { standard: {code: emoji}, custom: {name: {url}|{char}}, version }
 *   GET  /emoji-image/<name>, GET /avatar/<u/USER|b/BOT>   images proxied from Slack's CDN
 *   POST /quick      Bearer, { index, channel } → post that preset
 *
 * `channel` on /send and /quick must be one of the configured channel ids
 * (400 otherwise): a PIN-unlocked browser chooses among the admin's channels,
 * never an arbitrary one. A quick reply with its own "| #channel" ignores the
 * request's channel — an explicit binding wins over the selection.
 *
 * Rate budget. Slack allows an internal app roughly 50+ conversations.history
 * calls a minute per token (Tier 3). The module keeps all its pollers under
 * HISTORY_BUDGET_PER_MIN (40) so conversations.replies, users.info and sends
 * have room:
 *
 *   interval per channel = max(pollSeconds, ceil(channels × 60 / 40)) seconds
 *
 *   1 channel  → max(2, ceil(1.5)) = 2 s   (30 history calls/min)
 *   2 channels → max(2, ceil(3))   = 3 s   (40/min)
 *   3 channels → max(2, ceil(4.5)) = 5 s   (36/min)
 *   5 channels → max(2, ceil(7.5)) = 8 s   (37.5/min)
 *
 * Pollers are phase-staggered across that interval so they never fire in a
 * burst; with no tile watching, every channel drops to IDLE_POLL_S.
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
/**
 * conversations.history calls per minute the whole module allows itself.
 * Slack gives an internal app's token roughly 50+ a minute (Tier 3); the
 * rest is headroom for conversations.replies, users.info and sends. The
 * per-channel interval follows from it — see pollIntervalMs().
 */
const HISTORY_BUDGET_PER_MIN = 40;
/** With no tile watching, poll this slowly instead — the API budget is shared with sends. */
const IDLE_POLL_S = 15;
/** …once nothing has asked for /state or /stream for this long. */
const IDLE_AFTER_MS = 30000;
const HISTORY_MIN = 5;
const HISTORY_MAX = 200;
/** Thread fetches per poll across the module, split between channels (at least one each). */
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
/** The first read of each channel right after boot, one after another (then the phase-locked cadence). */
const FIRST_READ_MS = 50;
const FIRST_READ_STAGGER_MS = 250;
/** A slot that has (nearly) passed is skipped rather than fired late. */
const MIN_SLOT_GAP_MS = 200;
/** tiles() waits at most this long for the first conversations.info answers after boot. */
const NAMES_WAIT_MS = 1500;
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

/* ── config ─────────────────────────────────────────────────────────── */

/**
 * The configured channel ids, in admin order. `channels` is the multiselect
 * (an array); a `channel` string is what 1.0.0 saved and is honoured as a
 * one-item list until the admin saves the new field — the module never
 * rewrites admin config itself.
 */
function configuredChannels(config) {
  const out = [];
  const add = (v) => {
    const s = String(v ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  if (Array.isArray(config?.channels) && config.channels.length) config.channels.forEach(add);
  else add(config?.channel);
  return out;
}

/**
 * Effective per-channel poll interval, in ms:
 *
 *   max(pollSeconds, ceil(channels × 60 / HISTORY_BUDGET_PER_MIN)) seconds
 *
 * so all channels together stay at or under the budget. With the default
 * 2 s: 1 channel → 2 s, 2 → 3 s, 3 → 5 s, 4 → 6 s, 5 → 8 s, 10 → 15 s.
 */
function pollIntervalMs(pollSeconds, channelCount) {
  const budgeted = Math.ceil((Math.max(1, channelCount) * 60) / HISTORY_BUDGET_PER_MIN);
  return Math.max(MIN_POLL_S, pollSeconds, budgeted) * 1000;
}

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
    case 'channel_not_found': return `${chan} was not found (channel_not_found) — pick it again in Admin → Slack → Channels`;
    case 'is_archived': return `${chan} is archived (is_archived)`;
    case 'msg_too_long': return 'Message too long for Slack (msg_too_long)';
    case 'no_text': return 'Nothing to send (no_text)';
    case 'restricted_action': return `Posting in ${chan} is restricted by a workspace admin (restricted_action)`;
    case 'invalid_name': return 'Slack has no emoji by that name (invalid_name)';
    case 'too_many_reactions': return 'Slack allows 23 different reactions on a message (too_many_reactions)';
    case 'too_many_emoji': return 'That message already carries as many reactions as Slack allows (too_many_emoji)';
    case 'message_not_found': return 'That message is gone (message_not_found)';
    case 'bad_response': return `Slack answered with something that isn't JSON (HTTP ${err.status})`;
    default: return `Slack error: ${err?.code || err?.message || err}${err?.detail ? ` — ${err.detail}` : ''}`;
  }
}

/** Errors that no amount of retrying fixes — config has to change. */
function isConfigError(err) {
  return ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'missing_scope', 'channel_not_found'].includes(err?.code);
}

/* ── mrkdwn → plain text with a few inline marks ────────────────────── */

/* ── emoji: Slack's :codes: → characters; the workspace's custom set; images ── */

/** Slack's short names → emoji — modules/slack/emoji.json, built from iamcal/emoji-data (MIT). */
const EMOJI_NAMES = require('./emoji.json').names;
/** One code as it sits between colons: "+1", "+1::skin-tone-3", "party_parrot". */
const EMOJI_CODE_RE = /^([a-z0-9_+-]{1,100})(?:::(skin-tone-[2-6]))?$/i;
/** How long the workspace's custom emoji list is believed before emoji.list is asked again. */
const EMOJI_LIST_TTL_MS = 60 * 60 * 1000;
let emojiReverse = null; // character (variation selector stripped) → the name Slack knows it by

/** The character for a standard code, '' for a custom or unknown one. */
function emojiChar(code) {
  const m = EMOJI_CODE_RE.exec(String(code || ''));
  if (!m) return '';
  const base = EMOJI_NAMES[m[1].toLowerCase()];
  if (!base) return '';
  const tone = m[2] ? EMOJI_NAMES[m[2].toLowerCase()] : '';
  return tone ? base.replace(/\uFE0F/g, '') + tone : base;
}

/** The short name for a character ('' if Slack has none) — a reaction needs the name, not the glyph. */
function emojiName(char) {
  if (!emojiReverse) {
    emojiReverse = new Map();
    for (const [name, ch] of Object.entries(EMOJI_NAMES)) {
      if (name.startsWith('skin-tone-')) continue;
      const key = ch.replace(/\uFE0F/g, '');
      if (!emojiReverse.has(key)) emojiReverse.set(key, name); // keys are sorted: "+1" wins over "thumbsup"
    }
  }
  const s = String(char || '').replace(/\uFE0F/g, '');
  const tone = /[\u{1F3FB}-\u{1F3FF}]$/u.exec(s);
  if (tone) {
    const base = emojiReverse.get(s.slice(0, -tone[0].length));
    const toneName = Object.keys(EMOJI_NAMES).find((n) => n.startsWith('skin-tone-') && EMOJI_NAMES[n] === tone[0]);
    return base && toneName ? `${base}::${toneName}` : '';
  }
  return emojiReverse.get(s) || '';
}

/**
 * The admin's "Quick emojis" — "👍 🙏 :white_check_mark: :party_parrot:" →
 * [{ name, char }]. A standard emoji gets both; a custom code keeps its name
 * and no character (the browser draws the image); a glyph Slack has no name
 * for can be sent but not reacted with (name ''). Eight at most.
 */
function parseQuickEmojis(text) {
  const out = [];
  for (const tok of String(text || '').split(/\s+/).filter(Boolean)) {
    const code = /^:([^:\s]+(?:::skin-tone-[2-6])?):$/i.exec(tok);
    if (code) {
      const name = code[1].toLowerCase();
      if (EMOJI_CODE_RE.test(name)) out.push({ name, char: emojiChar(name) });
    } else out.push({ name: emojiName(tok), char: tok });
    if (out.length >= 8) break;
  }
  return out;
}

/* Avatars and custom emoji are images on Slack's CDN; browsers only talk to
   ProdDash, so the module fetches them and keeps them a while. */
const IMAGE_CACHE_MAX = 400;
const IMAGE_TTL_MS = 6 * 60 * 60 * 1000;
const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const imageCache = new Map(); // url → { buf, type, at } — module-wide, survives a re-init
const imageInFlight = new Map();

function fetchImage(url) {
  const hit = imageCache.get(url);
  if (hit && Date.now() - hit.at < IMAGE_TTL_MS) return Promise.resolve(hit);
  if (imageInFlight.has(url)) return imageInFlight.get(url);
  const p = (async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = String(response.headers.get('content-type') || 'image/png').split(';')[0].trim();
    if (!type.startsWith('image/')) throw new Error(`not an image (${type})`);
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > IMAGE_MAX_BYTES) throw new Error('too large');
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    const entry = { buf, type, at: Date.now() };
    imageCache.set(url, entry);
    return entry;
  })().finally(() => imageInFlight.delete(url));
  imageInFlight.set(url, p);
  return p;
}

/** Only https, or plain http on this machine (the mock) — never a URL a message could smuggle in. */
function imageUrlAllowed(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

/** Answer with the image at `url`: 404 with none, 502 when the CDN fails — the <img> then falls back. */
async function serveImage(res, url) {
  if (!imageUrlAllowed(url)) {
    res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    return void res.end('No image');
  }
  try {
    const img = await fetchImage(url);
    res.writeHead(200, { 'Content-Type': img.type, 'Content-Length': img.buf.length, 'Cache-Control': 'private, max-age=3600' });
    res.end(img.buf);
  } catch {
    res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Image unavailable');
  }
}

function unescapeSlack(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Slack mrkdwn → plain text. Mentions, channel links, broadcasts and URLs are
 * spelled out; *bold* _italic_ ~strike~ `code` markers are kept for the
 * client to style; standard :codes: become their emoji, and a custom one
 * stays as :code: for the client to draw from the workspace's set.
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
  text = text.replace(/:([a-z0-9_+-]+(?:::skin-tone-[2-6])?):/gi, (m, code) => emojiChar(code) || m);
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
 * and its message; the channel (optional) is a name the account can see —
 * a reply that carries one always goes there, whatever transcript is selected.
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
    const channelIds = configuredChannels(config);
    const pollSeconds = Math.max(MIN_POLL_S, Number(config.pollSeconds) || 2);
    const pollMs = pollSeconds * 1000;
    const intervalMs = pollIntervalMs(pollSeconds, channelIds.length);
    const historyCount = Math.min(HISTORY_MAX, Math.max(HISTORY_MIN, Math.trunc(Number(config.historyCount)) || 40));
    const includeReplies = Boolean(config.includeReplies);
    const threadFetchesPerPoll = Math.max(1, Math.floor(THREAD_FETCHES_PER_POLL / Math.max(1, channelIds.length)));
    const sendEnabled = Boolean(config.sendEnabled);
    const pin = String(config.pin || '').trim();
    const pinOk = PIN_RE.test(pin);
    const idleMs = Math.min(240, Math.max(1, Number(config.pinIdleMinutes) || 10)) * 60 * 1000;
    const quickReplies = parseQuickReplies(config.quickReplies);
    const quickEmojis = parseQuickEmojis(config.quickEmojis);

    /* ── state (all inside this closure so a re-init starts clean) ── */
    let stopped = false;
    let identity = null;        // { kind: 'user'|'bot', name, handle, userId, team, botId }
    let authError = '';
    let authPromise = null;     // one auth.test in flight, shared by every poller
    let rateLimitedUntil = 0;   // a 429 applies to the token, so every poller waits
    const pollers = new Map();  // channel id -> poller (configured order)
    const users = new Map();    // user id -> { name, at }
    const pendingUsers = new Set();
    const channelNames = new Map(); // channel id -> name (from list/info calls)
    let channelList = { at: 0, channels: [] };
    let channelListPromise = null;
    let lastSig = '';
    let lastInterest = Date.now();
    const epoch = Date.now();   // the phase-locked slots count from here
    const streams = new Set();
    const unlocks = new Map();     // token -> { expiresAt, lastSendAt, ip }
    const pinAttempts = new Map(); // ip -> { count, lockedUntil }

    /**
     * One channel's poller: its own window, thread cache, timer and error,
     * sharing the token, the name caches and the SSE fan-out with the rest.
     */
    function makePoller(id, index) {
      const ch = {
        id,
        index,
        name: '',            // from conversations.info (or the channel list)
        isMember: null,      // null until conversations.info has answered
        isPrivate: false,
        checked: false,      // conversations.info succeeded at least once
        error: '',           // one sentence a tech can act on; '' while fine
        errorKind: '',       // 'config' | 'membership' | 'poll' — decides the retry
        lastPollAt: 0,
        periodMs: intervalMs, // the cadence the last schedule used (for staleness)
        rawWindow: [],       // conversations.history messages, as Slack sent them (newest first)
        threads: new Map(),  // parent ts -> { latestReply, replyCount, replies: [raw…] }
        messagesCache: null, // normalised window, rebuilt when it or a name changed
        timer: null,
        polling: false,
        pollAgain: false,
        settleFirst: null,
      };
      ch.firstRead = new Promise((resolve) => { ch.settleFirst = resolve; });
      return ch;
    }
    channelIds.forEach((id, index) => pollers.set(id, makePoller(id, index)));

    /* ── names ── */
    function lookupUser(id) {
      if (!id) return '';
      const hit = users.get(id);
      if (hit && Date.now() - hit.at < USER_TTL_MS) return hit.name;
      pendingUsers.add(id);
      return hit ? hit.name : '';
    }

    function lookupChannel(id) {
      return channelNames.get(id) || pollers.get(id)?.name || '';
    }

    /** A user's picture as Slack lists it (the 72 px one fits a transcript row). */
    function profileImage(u) {
      const p = u?.profile || {};
      return String(p.image_72 || p.image_48 || p.image_32 || p.image_original || '');
    }

    /* Bot messages carry their own icon; remembered by bot so a later message
       from the same bot without icons (a plain bot_message) still has one. */
    const botIcons = new Map(); // bot id / username → image url
    function botIconOf(m) {
      const icons = m.icons || m.bot_profile?.icons || {};
      const url = String(icons.image_72 || icons.image_64 || icons.image_48 || icons.image_36 || '');
      const key = String(m.bot_id || m.username || m.bot_profile?.id || 'bot');
      if (url) botIcons.set(key, url);
      const emoji = icons.emoji ? emojiChar(String(icons.emoji).replace(/^:|:$/g, '')) : '';
      return { key, url: url || botIcons.get(key) || '', emoji };
    }

    /** [{ name, count, me }] for a message's reactions, or nothing. `me` = this account reacted. */
    function reactionsOf(m) {
      if (!Array.isArray(m.reactions) || !m.reactions.length) return undefined;
      const meId = identity?.userId || '';
      const out = [];
      for (const r of m.reactions) {
        const name = String(r?.name || '');
        if (!EMOJI_CODE_RE.test(name)) continue;
        const users = Array.isArray(r.users) ? r.users : [];
        const count = Math.max(0, Math.trunc(Number(r.count)) || users.length);
        if (count > 0) out.push({ name, count, me: Boolean(meId && users.includes(meId)) });
      }
      return out.length ? out : undefined;
    }

    /* ── the workspace's custom emoji (emoji.list, hourly) ── */
    let customEmoji = new Map(); // name → { url } | { char } (an alias of a standard emoji)
    let customEmojiSig = '';
    let emojiVersion = 0;        // bumps when the set changes; tiles refetch /emoji then
    let emojiCheckedAt = 0;
    let emojiPromise = null;
    let emojiScopeMissing = false;

    function loadCustomEmoji() {
      if (emojiScopeMissing || Date.now() - emojiCheckedAt < EMOJI_LIST_TTL_MS) return Promise.resolve();
      if (!emojiPromise) {
        emojiPromise = (async () => {
          emojiCheckedAt = Date.now();
          const data = await slackCall(token, 'emoji.list', {});
          const raw = data.emoji && typeof data.emoji === 'object' ? data.emoji : {};
          const resolve = (name, depth) => {
            const v = raw[name];
            if (typeof v !== 'string' || depth > 5) return null;
            if (v.startsWith('alias:')) {
              const to = v.slice('alias:'.length);
              if (to in raw) return resolve(to, depth + 1);
              const ch = emojiChar(to);
              return ch ? { char: ch } : null;
            }
            return imageUrlAllowed(v) ? { url: v } : null;
          };
          const next = new Map();
          for (const name of Object.keys(raw).sort()) {
            if (!EMOJI_CODE_RE.test(name) || name.includes('::')) continue;
            const e = resolve(name, 0);
            if (e) next.set(name, e);
          }
          const sig = JSON.stringify([...next]);
          if (sig !== customEmojiSig) {
            customEmoji = next;
            customEmojiSig = sig;
            emojiVersion += 1;
            invalidateAll();
            log(`${next.size} custom emoji in the workspace`);
          }
        })().catch((err) => {
          if (err.code === 'missing_scope') {
            emojiScopeMissing = true;
            log('custom emoji stay as :codes: — the token lacks the emoji:read scope (add it under OAuth & Permissions, reinstall, paste the new token); standard emoji are unaffected');
          } else {
            emojiCheckedAt = Date.now() - EMOJI_LIST_TTL_MS + RETRY_NETWORK_MS; // ask again soon
            if (err.code !== 'ratelimited') log(`emoji.list: ${describeError(err, { name: identity?.name })}`);
          }
        }).finally(() => { emojiPromise = null; });
      }
      return emojiPromise;
    }

    function invalidateAll() {
      for (const ch of pollers.values()) ch.messagesCache = null;
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
          users.set(id, { name, image: profileImage(u), at: Date.now() });
          changed = true;
        } catch (err) {
          // Unknown or deactivated: remember the raw id for a while so we
          // don't ask again every poll. Rate limits and outages retry.
          if (err.code !== 'network' && err.code !== 'ratelimited') users.set(id, { name: id, at: Date.now() });
        }
      }));
      if (changed) invalidateAll();
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
        // A poller that hasn't heard from conversations.info yet can take its name from here.
        for (const ch of pollers.values()) if (!ch.name && channelNames.get(ch.id)) ch.name = channelNames.get(ch.id);
        invalidateAll();
        return all;
      })();
      try {
        return await channelListPromise;
      } finally {
        channelListPromise = null;
      }
    }

    /** "#name" or a channel id → the channel id, or '' when the account can't see it. */
    async function resolveChannelRef(ref) {
      const s = String(ref || '').trim();
      if (!s) return '';
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

    function normalize(m, ch, parentTs = '') {
      if (!m || typeof m !== 'object' || !m.ts) return null;
      if (m.subtype === 'tombstone') return null;
      const name = nameFor(m);
      const system = SYSTEM_SUBTYPES.has(m.subtype || '');
      const chanLabel = ch.name ? '#' + ch.name : 'the channel';
      let text = textFor(m);
      if (m.subtype === 'channel_join' || m.subtype === 'group_join') text = `${name} joined ${chanLabel}`;
      else if (m.subtype === 'channel_leave' || m.subtype === 'group_leave') text = `${name} left ${chanLabel}`;
      const icon = m.user ? null : botIconOf(m);
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
        // the picture in the row: a user's profile image or a bot's icon, by
        // key for GET /avatar/<key>; a bot with only an :emoji: icon shows that
        avatar: m.user ? `u/${m.user}` : icon?.url ? `b/${icon.key}` : '',
        avatarEmoji: icon?.emoji || '',
        reactions: reactionsOf(m),
      };
      if (parentTs) out.parent = parentTs;
      else {
        out.replyCount = Math.max(0, Math.trunc(Number(m.reply_count)) || 0);
        if (includeReplies && out.replyCount) {
          const t = ch.threads.get(out.ts);
          out.replies = t ? t.replies.map((r) => normalize(r, ch, out.ts)).filter(Boolean) : [];
        }
      }
      return out;
    }

    function messagesOf(ch) {
      if (!ch.messagesCache) {
        ch.messagesCache = ch.rawWindow
          .map((m) => normalize(m, ch))
          .filter(Boolean)
          .sort((a, b) => Number(a.ts) - Number(b.ts));
      }
      return ch.messagesCache;
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

    function labelOf(ch) {
      return `#${ch.name || lookupChannel(ch.id) || ch.id}`;
    }

    function isStale(ch) {
      return ch.lastPollAt > 0 && Date.now() - ch.lastPollAt > 3 * ch.periodMs + 5000;
    }

    /** One channel's status as its transcript tile shows it (token trouble folded in). */
    function channelStatus(ch) {
      if (!token) return { state: 'error', message: 'No Slack token — paste the location account’s User OAuth Token in Admin → Slack' };
      if (authError) return { state: 'error', message: authError };
      if (!identity) return { state: 'connecting', message: 'Checking the Slack token…' };
      if (ch.error) return { state: 'error', message: ch.error };
      if (!ch.lastPollAt) return { state: 'connecting', message: `${labelOf(ch)} · first read…` };
      if (isStale(ch)) return { state: 'connecting', message: `${labelOf(ch)} · last read ${Math.round((Date.now() - ch.lastPollAt) / 1000)} s ago` };
      return { state: 'ok', message: `${labelOf(ch)} · live` };
    }

    /** The admin health line: who, which channels, what's wrong, sending. */
    function health() {
      if (!token) return { status: 'error', message: 'No Slack token — paste the location account’s User OAuth Token in Admin → Slack' };
      if (authError) return { status: 'error', message: authError };
      if (!identity) return { status: 'connecting', message: 'Checking the Slack token…' };
      const who = identityLabel();
      const list = [...pollers.values()];
      if (!list.length) return { status: 'error', message: `${who} · pick channels in Admin → Slack → Channels` };
      const names = list.map(labelOf).join(', ');
      const sending = !sendEnabled ? 'sending off' : !pinOk ? 'sending on — set a 4–8 digit PIN' : 'sending on';
      const problems = [...new Set(list.filter((ch) => ch.error).map((ch) => (ch.error.includes(labelOf(ch)) ? ch.error : `${labelOf(ch)}: ${ch.error}`)))];
      if (problems.length) return { status: 'error', message: `${who} · ${names} · ${problems.join(' · ')} · ${sending}` };
      if (list.some((ch) => !ch.lastPollAt)) return { status: 'connecting', message: `${who} · ${names} · first read…` };
      const stale = list.filter(isStale);
      if (stale.length) {
        const ago = stale.map((ch) => `${labelOf(ch)} last read ${Math.round((Date.now() - ch.lastPollAt) / 1000)} s ago`).join(', ');
        return { status: 'connecting', message: `${who} · ${names} · ${ago}` };
      }
      const cadence = intervalMs > pollMs ? ` · every ${intervalMs / 1000} s (rate budget)` : '';
      return { status: 'ok', message: `${who} · ${names}${cadence} · ${sending}` };
    }

    function channelView(ch) {
      return {
        id: ch.id,
        name: ch.name || lookupChannel(ch.id) || '',
        isMember: ch.isMember,
        isPrivate: ch.isPrivate,
        messages: messagesOf(ch),
        lastPollAt: ch.lastPollAt,
        pollAge: ch.lastPollAt ? Date.now() - ch.lastPollAt : null,
        error: ch.error,
        status: channelStatus(ch),
      };
    }

    function snapshot() {
      const h = health();
      const channels = {};
      let lastPollAt = 0;
      for (const ch of pollers.values()) {
        channels[ch.id] = channelView(ch);
        lastPollAt = Math.max(lastPollAt, ch.lastPollAt);
      }
      return {
        identity: identity
          ? { kind: identity.kind, name: identity.name, team: identity.team, sendAs: identity.kind === 'bot' ? sendAs : '' }
          : null,
        sendingAs: sendingAs(),
        channelOrder: [...pollers.keys()],
        channels,
        includeReplies,
        historyCount,
        pollSeconds: intervalMs / 1000,
        sending: { enabled: sendEnabled, pinSet: pinOk, idleMinutes: idleMs / 60000 },
        // the pad submits by itself once this many digits are in (never the PIN)
        pinLength: pinOk ? pin.length : 0,
        quickEmojis,
        emojiVersion,
        status: { state: h.status, message: h.message, lastPollAt },
        apiBase: API_BASE,
      };
    }

    /** Broadcast the snapshot when anything a tile shows has changed (ages don't count). */
    function broadcastIfChanged() {
      const snap = snapshot();
      const sig = JSON.stringify(snap, (key, value) => (key === 'pollAge' || key === 'lastPollAt' ? undefined : value));
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

    /* ── the poll loops: token → channel → history (+ threads, names) ── */
    function watched() {
      return streams.size > 0 || Date.now() - lastInterest < IDLE_AFTER_MS;
    }

    /**
     * Delay to poller `index`'s next slot at cadence `periodMs`: slots are
     * spread evenly across the period from `epoch`, so channels never read
     * in a burst, and a slot that has just passed is skipped, not fired late.
     */
    function slotDelay(index, periodMs) {
      const phase = Math.round((index * periodMs) / Math.max(1, pollers.size));
      const elapsed = Date.now() - epoch;
      const k = Math.floor((elapsed - phase) / periodMs) + 1;
      let delay = phase + k * periodMs - elapsed;
      if (delay < MIN_SLOT_GAP_MS) delay += periodMs;
      return delay;
    }

    /** `plainMs` for an error retry; without it, the regular phase-locked cadence. */
    function scheduleNext(ch, plainMs = null) {
      if (stopped) return;
      clearTimeout(ch.timer);
      let delay = plainMs;
      if (delay === null) {
        ch.periodMs = watched() ? intervalMs : Math.max(intervalMs, IDLE_POLL_S * 1000);
        delay = slotDelay(ch.index, ch.periodMs);
      }
      ch.timer = setTimeout(() => tick(ch), delay);
      ch.timer.unref?.();
    }

    function pollSoon(ch, delay = 250) {
      if (stopped) return;
      if (ch.polling) {
        ch.pollAgain = true;
        return;
      }
      clearTimeout(ch.timer);
      ch.timer = setTimeout(() => tick(ch), delay);
      ch.timer.unref?.();
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
          users.set(userId, { name: id.name, image: profileImage(u.user), at: Date.now() });
        } catch { /* the handle will do */ }
      }
      identity = id;
      authError = '';
      invalidateAll();
      log(`token belongs to ${identityLabel()} (${id.team || 'team unknown'})${id.kind === 'bot' && !sendAs ? ' — messages will read as the app; set "Send as" to name the location' : ''}`);
    }

    /** Every poller wants the identity; the first to ask makes the one call. */
    function ensureAuth() {
      if (identity) return Promise.resolve();
      if (!authPromise) {
        authPromise = checkAuth().finally(() => { authPromise = null; });
      }
      return authPromise;
    }

    async function checkChannel(ch) {
      const data = await slackCall(token, 'conversations.info', { channel: ch.id });
      const c = data.channel || {};
      ch.name = String(c.name || c.name_normalized || ch.id);
      ch.isPrivate = Boolean(c.is_private);
      ch.isMember = c.is_member !== false;
      ch.checked = true;
      channelNames.set(ch.id, ch.name);
      invalidateAll();
      if (!ch.isMember) throw new SlackError('not_in_channel');
    }

    async function readHistory(ch) {
      const data = await slackCall(token, 'conversations.history', { channel: ch.id, limit: historyCount });
      const messages = Array.isArray(data.messages) ? data.messages.filter((m) => m && m.ts) : [];
      ch.rawWindow = messages;
      ch.messagesCache = null;
      ch.lastPollAt = Date.now();
      ch.isMember = true;

      // Threads: parents in the window whose reply set changed since we
      // last read it — oldest first, a few per poll.
      const inWindow = new Set(messages.map((m) => String(m.ts)));
      for (const ts of [...ch.threads.keys()]) if (!inWindow.has(ts)) ch.threads.delete(ts);
      if (includeReplies) {
        const stale = messages
          .filter((m) => Number(m.reply_count) > 0)
          .filter((m) => {
            const t = ch.threads.get(String(m.ts));
            return !t || t.latestReply !== String(m.latest_reply || '') || t.replyCount !== Number(m.reply_count);
          })
          .sort((a, b) => Number(a.ts) - Number(b.ts))
          .slice(0, threadFetchesPerPoll);
        for (const parent of stale) {
          try {
            const rep = await slackCall(token, 'conversations.replies', { channel: ch.id, ts: parent.ts, limit: THREAD_REPLIES_LIMIT });
            const replies = (rep.messages || []).filter((r) => r && r.ts && String(r.ts) !== String(parent.ts));
            ch.threads.set(String(parent.ts), { latestReply: String(parent.latest_reply || ''), replyCount: Number(parent.reply_count), replies });
          } catch (err) {
            if (err.code === 'ratelimited') throw err;
            log(`${labelOf(ch)} thread ${parent.ts}: ${describeError(err, { name: identity?.name, channel: ch.name })}`);
          }
        }
      }
    }

    /** Record a failed poll on its channel (or the token); returns the retry delay. */
    function failed(ch, err) {
      const text = describeError(err, { name: identity?.name, channel: ch.name || ch.id });
      if (!identity) {
        if (authError !== text) log(text);
        authError = text;
        return isConfigError(err) ? RETRY_CONFIG_MS : RETRY_NETWORK_MS;
      }
      let retry;
      if (err.code === 'ratelimited') {
        rateLimitedUntil = Date.now() + err.retryAfter * 1000;
        ch.errorKind = 'poll';
        retry = err.retryAfter * 1000 + 100 + ch.index * 100;
      } else if (err.code === 'not_in_channel') {
        ch.isMember = false;
        ch.errorKind = 'membership';
        retry = RETRY_MEMBERSHIP_MS;
      } else if (isConfigError(err)) {
        ch.errorKind = 'config';
        retry = RETRY_CONFIG_MS;
      } else {
        ch.errorKind = 'poll';
        retry = Math.max(intervalMs, RETRY_NETWORK_MS);
      }
      if (ch.error !== text) log(`${labelOf(ch)}: ${text}`);
      ch.error = text;
      return retry;
    }

    async function tick(ch) {
      if (stopped || ch.polling) return;
      ch.polling = true;
      ch.pollAgain = false;
      let retry = null; // a plain delay for error retries; null → the regular cadence
      try {
        const wait = rateLimitedUntil - Date.now();
        if (wait > 0) {
          retry = wait + 100 + ch.index * 100;
        } else {
          await ensureAuth();
          await loadCustomEmoji();
          if (!ch.checked || ch.errorKind === 'membership') await checkChannel(ch);
          await readHistory(ch);
          if (ch.error) log(`${labelOf(ch)}: reading again`);
          ch.error = '';
          ch.errorKind = '';
          await resolveUsers();
        }
      } catch (err) {
        retry = failed(ch, err);
      } finally {
        ch.polling = false;
        if (ch.settleFirst) {
          ch.settleFirst();
          ch.settleFirst = null;
        }
        broadcastIfChanged();
        if (ch.pollAgain) pollSoon(ch);
        else scheduleNext(ch, retry);
      }
    }

    /**
     * tiles() names each transcript after its channel; right after boot the
     * names are still on their way, so it waits (briefly) for the first
     * conversations.info answers rather than baking "#C0123" into tile titles.
     */
    function namesReady() {
      if (!token || authError || stopped) return Promise.resolve();
      const pending = [...pollers.values()].filter((ch) => !ch.checked && !ch.error).map((ch) => ch.firstRead);
      if (!pending.length) return Promise.resolve();
      return Promise.race([
        Promise.all(pending),
        new Promise((resolve) => { setTimeout(resolve, NAMES_WAIT_MS).unref?.(); }),
      ]);
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

    /**
     * The channel a browser asked to post to. Only a configured channel id is
     * accepted — the selection is a choice among the admin's channels, never
     * a way to reach some other one. Nothing asked for → the first configured.
     */
    function chooseTarget(requested) {
      const s = String(requested ?? '').trim();
      if (s) {
        if (pollers.has(s)) return { id: s };
        const name = lookupChannel(s);
        return { error: `${name ? `#${name}` : s} isn't one of the configured channels — pick it in Admin → Slack → Channels` };
      }
      if (!channelIds.length) return { error: 'No channel configured — pick channels in Admin → Slack → Channels' };
      return { id: channelIds[0] };
    }

    async function postMessage(targetChannelId, text) {
      const params = { channel: targetChannelId, text };
      if (identity?.kind === 'bot' && sendAs) {
        params.username = sendAs;
        params.icon_emoji = DEFAULT_ICON;
      }
      return slackCall(token, 'chat.postMessage', params, { json: true });
    }

    /**
     * Add or remove a reaction on behalf of an unlock — the same gate as a
     * send, since it is the location's name on it. The message's channel must
     * be one of the configured ones. `already_reacted` / `no_reaction` count
     * as done: Slack already holds the state that was asked for.
     */
    async function react(req, res, unlock, { channel, ts, name, remove }) {
      if (!identity || authError) {
        return sendJson(res, 502, { error: authError || 'Slack token not checked yet — try again in a moment' });
      }
      const target = String(channel ?? '').trim() ? chooseTarget(channel) : { error: 'Which channel?' };
      if (target.error) return sendJson(res, 400, { error: target.error, code: 'bad_channel' });
      const stamp = String(ts ?? '').trim();
      if (!/^\d{1,16}\.\d{1,9}$/.test(stamp)) return sendJson(res, 400, { error: 'Which message?' });
      const code = String(name ?? '').trim().replace(/^:|:$/g, '').toLowerCase();
      if (!EMOJI_CODE_RE.test(code)) return sendJson(res, 400, { error: 'Not an emoji name' });
      const targetName = lookupChannel(target.id) || target.id;
      try {
        await slackCall(token, remove ? 'reactions.remove' : 'reactions.add', { channel: target.id, timestamp: stamp, name: code });
      } catch (err) {
        if (err.code !== 'already_reacted' && err.code !== 'no_reaction') {
          const message = describeError(err, { name: identity.name, channel: targetName });
          log(`reaction :${code}: in #${targetName} failed: ${message}`);
          const status = ['invalid_name', 'too_many_reactions', 'too_many_emoji'].includes(err.code) ? 400
            : err.code === 'message_not_found' ? 404 : 502;
          return sendJson(res, status, { error: message, code: err.code });
        }
      }
      const u = unlocks.get(unlock.token);
      if (u) u.expiresAt = Date.now() + idleMs;
      log(`${remove ? 'removed' : 'added'} :${code}: on ${stamp} in #${targetName} as ${sendingAs()}`);
      if (pollers.has(target.id)) pollSoon(pollers.get(target.id));
      return sendJson(res, 200, { ok: true, expiresAt: u ? u.expiresAt : unlock.expiresAt, channel: `#${targetName}` });
    }

    /**
     * Post on behalf of an unlock; answers the response. `targetId` is an
     * already-validated configured channel; `presetChannel` (a quick reply's
     * own "| #channel") overrides it.
     */
    async function deliver(req, res, unlock, { text, targetId, presetChannel = '', what }) {
      const now = Date.now();
      if (now - unlock.lastSendAt < SEND_MIN_INTERVAL_MS) {
        return sendJson(res, 429, { error: 'One message per second — try again', code: 'too_fast' });
      }
      unlocks.get(unlock.token).lastSendAt = now;
      if (!identity || authError) {
        return sendJson(res, 502, { error: authError || 'Slack token not checked yet — try again in a moment' });
      }
      let target = targetId || '';
      if (presetChannel) {
        try {
          target = await resolveChannelRef(presetChannel);
        } catch (err) {
          return sendJson(res, 502, { error: describeError(err, { name: identity.name, channel: presetChannel }) });
        }
        if (!target) return sendJson(res, 400, { error: `No channel named #${String(presetChannel).replace(/^#/, '')} that ${identity.name} can see` });
      }
      if (!target) return sendJson(res, 400, { error: 'No channel configured — pick channels in Admin → Slack → Channels' });
      const targetName = lookupChannel(target) || target;
      try {
        const data = await postMessage(target, text);
        const u = unlocks.get(unlock.token);
        if (u) u.expiresAt = Date.now() + idleMs;
        const preview = text.replace(/\s+/g, ' ').slice(0, 60);
        log(`${what} → #${targetName} as ${sendingAs()}: "${preview}${text.length > 60 ? '…' : ''}"`);
        if (pollers.has(target)) pollSoon(pollers.get(target));
        return sendJson(res, 200, {
          ok: true,
          ts: String(data.ts || ''),
          channel: `#${targetName}`,
          channelId: target,
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
      if (!channelIds.length) log('no channels configured — pick some in /admin → Slack → Channels');
      else {
        if (!Array.isArray(config.channels) || !config.channels.length) {
          log(`using the single channel saved by an earlier version (${channelIds[0]}) — pick it under Channels in /admin to keep it`);
        }
        const budgeted = Math.ceil((channelIds.length * 60) / HISTORY_BUDGET_PER_MIN);
        log(`polling ${channelIds.length} channel${channelIds.length === 1 ? '' : 's'} every ${intervalMs / 1000} s each — max(${pollSeconds} s, ceil(${channelIds.length}×60/${HISTORY_BUDGET_PER_MIN}) = ${budgeted} s) keeps history reads at ≤${HISTORY_BUDGET_PER_MIN}/min`);
        for (const ch of pollers.values()) scheduleNext(ch, FIRST_READ_MS + ch.index * FIRST_READ_STAGGER_MS);
      }
    }

    current = {
      streams,
      snapshot,
      health,
      quickReplies,
      sendGate,
      deliver,
      react,
      /** Everything a tile needs to draw emoji: the shipped table plus the workspace's own. */
      emojiTable() {
        const custom = {};
        for (const [name, e] of customEmoji) {
          custom[name] = e.url ? { url: `/api/modules/slack/emoji-image/${encodeURIComponent(name)}` } : { char: e.char };
        }
        return { standard: EMOJI_NAMES, custom, version: emojiVersion };
      },
      customEmojiUrl: (name) => customEmoji.get(String(name || ''))?.url || '',
      /** "u/U123" → that user's profile image; "b/<bot>" → that bot's icon. */
      avatarUrl(key) {
        const [kind, id] = String(key || '').split('/');
        if (kind === 'u') return users.get(id)?.image || '';
        if (kind === 'b') return botIcons.get(id) || '';
        return '';
      },
      unlockFor,
      chooseTarget,
      namesReady,
      touch() { lastInterest = Date.now(); },
      wake() {
        lastInterest = Date.now();
        if (!identity) return;
        // Somebody is looking again: catch every channel up, one after another.
        let n = 0;
        for (const ch of pollers.values()) {
          if (ch.checked && !ch.error && Date.now() - ch.lastPollAt > intervalMs) pollSoon(ch, 250 + 150 * n++);
        }
      },
      loadChannelList,
      channelIds,
      channelName: (id) => lookupChannel(id),
      pinOk,
      sendEnabled,
      identityName: () => identity?.name || '',
      sendingAs,
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
        return sendJson(res, 200, { token: t, expiresAt, idleMs, sendingAs: sendingAs() });
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
        for (const ch of pollers.values()) {
          clearTimeout(ch.timer);
          if (ch.settleFirst) {
            ch.settleFirst();
            ch.settleFirst = null;
          }
        }
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

  /**
   * The picker: one transcript per configured channel, titled with the
   * channel's name (the shell makes the entry's name the tile's title), then
   * the two send surfaces, one of each per dashboard. Between init() and a
   * poller's first answer a name may still be unknown — "#<id>" then.
   */
  async tiles({ config }) {
    const c = current;
    const ids = c ? c.channelIds : configuredChannels(config || {});
    if (c) await c.namesReady();
    const who = c?.sendingAs() ? ` as ${c.sendingAs()}` : '';
    const entries = ids.map((id) => ({
      id: `transcript:${id}`,
      name: `#${(c && c.channelName(id)) || id}`,
      description: 'Live transcript',
      defaultSize: { w: 4, h: 4 },
      minSize: { w: 2, h: 2 },
      settings: { view: 'transcript', channel: id },
    }));
    entries.push(
      {
        id: 'send',
        name: 'Send message',
        description: `PIN-protected message to the transcript clicked last${who}`,
        single: true,
        defaultSize: { w: 3, h: 3 },
        minSize: { w: 2, h: 2 },
        settings: { view: 'send' },
      },
      {
        id: 'quick',
        name: 'Quick replies',
        description: `PIN-protected preset buttons${who}`,
        single: true,
        defaultSize: { w: 3, h: 2 },
        minSize: { w: 2, h: 1 },
        settings: { view: 'quick' },
      },
    );
    return entries;
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
          res.write(`event: state\ndata: ${JSON.stringify({ channelOrder: [], channels: {}, status: { state: 'connecting', message: 'Slack module is restarting…' } })}\n\n`);
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

      // The admin "Channels" multiselect: channels the account is a member of.
      'GET /channels': guard(async (req, res) => {
        if (!current) return unmounted(res);
        try {
          const list = await current.loadChannelList(true);
          const options = list
            .filter((c) => c.isMember)
            .map((c) => ({ value: c.id, label: `#${c.name}${c.isPrivate ? ' (private)' : ''}` }));
          sendJson(res, 200, { options });
        } catch (err) {
          // 200 with no options: the admin page keeps the saved values checked.
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

      // The emoji a tile may need to draw — fetched once per page, again when the version bumps.
      'GET /emoji': (req, res) => {
        if (!current) return unmounted(res);
        sendJson(res, 200, current.emojiTable());
      },

      // Pictures proxied from Slack's CDN: a custom emoji by name, a profile image or bot icon by key.
      'GET /emoji-image/*': guard(async (req, res) => {
        if (!current) return unmounted(res);
        await serveImage(res, current.customEmojiUrl(decodeURIComponent(String(req.wildcard || '').replace(/^\/+/, ''))));
      }),
      'GET /avatar/*': guard(async (req, res) => {
        if (!current) return unmounted(res);
        await serveImage(res, current.avatarUrl(decodeURIComponent(String(req.wildcard || '').replace(/^\/+/, ''))));
      }),

      // A reaction as the location — PIN-gated like a send.
      'POST /react': guard(async (req, res) => {
        if (!current) return unmounted(res);
        const unlock = current.sendGate(req, res);
        if (!unlock) return;
        let body;
        try {
          body = await readJson(req);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
        await current.react(req, res, unlock, { channel: body.channel, ts: body.ts, name: body.name, remove: Boolean(body.remove) });
      }),

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
        const target = current.chooseTarget(body.channel);
        if (target.error) return sendJson(res, 400, { error: target.error, code: 'bad_channel' });
        await current.deliver(req, res, unlock, { text, targetId: target.id, what: 'sent' });
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
        // A channel the browser names is checked even when the preset's own
        // binding is about to override it — an unconfigured id is never accepted.
        const target = current.chooseTarget(body.channel);
        if (target.error && (body.channel || !preset.channel)) return sendJson(res, 400, { error: target.error, code: 'bad_channel' });
        await current.deliver(req, res, unlock, {
          text: preset.message,
          targetId: target.id || '',
          presetChannel: preset.channel,
          what: `quick reply "${preset.label}"`,
        });
      }),
    };
  },
};
