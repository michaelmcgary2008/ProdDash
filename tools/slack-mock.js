/**
 * Mock Slack Web API for developing the slack module without a workspace.
 *
 *   node tools/slack-mock.js [port]                       (default 24716)
 *   SLACK_API_BASE=http://127.0.0.1:24716/api node server.js
 *
 * Then, in /admin → Slack, paste any token that starts with xoxp- (a user
 * token: auth.test answers as the location account "Apollo Beach") or xoxb-
 * (a bot token: bot_id set, user "proddash"); anything else is invalid_auth.
 * Two more tokens exercise the error paths: xoxp-revoked → token_revoked,
 * xoxp-noscope → missing_scope (needed channels:history) on history reads.
 *
 * Methods, all under /api/<method>, POST form or JSON (GET works too):
 *   auth.test               identity for the token (see above)
 *   conversations.list      #production, #ops, #campus-leads (private) as
 *                           member; #announcements not a member; paginated
 *   conversations.info      one channel, with is_member
 *   conversations.history   newest-first window (limit); not_in_channel for
 *                           #announcements
 *   conversations.replies   a thread's parent + replies
 *   users.info              display names and profile images (SVG squares
 *                           served by this mock under /img/u/<id>.svg)
 *   chat.postMessage        appends to the channel (echoes `username` for
 *                           bots as a bot_message); text containing "!429"
 *                           answers HTTP 429 with Retry-After: 3
 *   emoji.list              four custom emoji: two images (/img/e/<name>.svg),
 *                           an alias of a standard emoji, an alias of a custom
 *   reactions.add/.remove   on a message (or reply) by channel + timestamp;
 *                           already_reacted / no_reaction / message_not_found
 *                           as Slack answers them; name "nope" → invalid_name
 *
 * #production is seeded with mrkdwn, mentions, a link, a thread, a bot
 * attachment and a file; it gains a new fake message every ~8 s, edits one
 * every ~25 s, deletes one every ~40 s and adds a thread reply every ~30 s.
 * #ops gets a quieter trickle (every ~20 s), so a dashboard with both
 * transcripts shows two channels moving at their own pace — and a
 * chat.postMessage to either lands in that channel's history, which is how
 * a send to the *selected* transcript can be watched arriving in the right
 * tile. Every request is logged.
 *
 * Multi-channel dev flow: run this, then ProdDash with SLACK_API_BASE set,
 * paste xoxp-anything in /admin → Slack, tick #production and #ops under
 * Channels, Apply, and add both transcripts plus Send message from ＋.
 */
'use strict';

const http = require('http');

const PORT = Number.parseInt(process.argv[2] || '24716', 10);

/* ── data ───────────────────────────────────────────────────────────── */

const USERS = {
  U001: { name: 'apollo.beach', real_name: 'Apollo Beach', display_name: 'Apollo Beach' },
  U002: { name: 'michael', real_name: 'Michael McGary', display_name: 'Michael' },
  U003: { name: 'sarah.lee', real_name: 'Sarah Lee', display_name: 'Sarah' },
  U004: { name: 'north.attleboro', real_name: 'North Attleboro', display_name: 'North Attleboro' },
  U005: { name: 'dan.k', real_name: 'Dan Kowalski', display_name: 'Dan K' },
  UBOT: { name: 'proddash', real_name: 'ProdDash', display_name: '', is_bot: true },
};

const CHANNELS = [
  { id: 'C001', name: 'production', is_private: false, is_member: true },
  { id: 'C002', name: 'ops', is_private: false, is_member: true },
  { id: 'G001', name: 'campus-leads', is_private: true, is_member: true },
  { id: 'C003', name: 'announcements', is_private: false, is_member: false },
];

let tsCounter = 0;
function ts(offsetMs = 0) {
  tsCounter += 1;
  return `${Math.floor((Date.now() + offsetMs) / 1000)}.${String(tsCounter).padStart(6, '0')}`;
}

/** channel id -> messages (ascending); replies live inside their parent. */
const history = new Map();
for (const c of CHANNELS) history.set(c.id, []);

function push(channelId, msg) {
  const list = history.get(channelId);
  const m = { type: 'message', ts: msg.ts || ts(), ...msg };
  list.push(m);
  if (list.length > 400) list.splice(0, list.length - 400);
  return m;
}

/** A message or a reply by timestamp, anywhere in a channel. */
function findMessage(channelId, stamp) {
  for (const m of history.get(channelId) || []) {
    if (m.ts === stamp) return m;
    for (const r of m.replies || []) if (r.ts === stamp) return r;
  }
  return null;
}

/** Slack's reactions array: [{ name, users, count }], edited in place. */
function addReaction(m, name, userId) {
  m.reactions = m.reactions || [];
  let r = m.reactions.find((x) => x.name === name);
  if (r && r.users.includes(userId)) return 'already_reacted';
  if (!r) {
    r = { name, users: [], count: 0 };
    m.reactions.push(r);
  }
  r.users.push(userId);
  r.count = r.users.length;
  return '';
}

function removeReaction(m, name, userId) {
  const r = (m.reactions || []).find((x) => x.name === name);
  if (!r || !r.users.includes(userId)) return 'no_reaction';
  r.users = r.users.filter((u) => u !== userId);
  r.count = r.users.length;
  if (!r.count) m.reactions = m.reactions.filter((x) => x !== r);
  if (!m.reactions.length) delete m.reactions;
  return '';
}

/* A square SVG with an initial, one hue per id — the mock's stand-in for a
   profile image or a custom emoji picture. */
const IMAGE_HUES = { U001: 150, U002: 210, U003: 330, U004: 30, U005: 270, UBOT: 0, party_parrot: 120, waters: 200 };
function squareSvg(id, letter) {
  const hue = IMAGE_HUES[id] ?? 180;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72" rx="18" fill="hsl(${hue} 50% 45%)"/><text x="36" y="47" text-anchor="middle" font-family="system-ui, sans-serif" font-size="34" font-weight="700" fill="#fff">${letter}</text></svg>`;
}
const CUSTOM_EMOJI = {
  party_parrot: (port) => `http://127.0.0.1:${port}/img/e/party_parrot.svg`,
  waters: (port) => `http://127.0.0.1:${port}/img/e/waters.svg`,
  thumbsup_all: () => 'alias:+1',
  parrot: () => 'alias:party_parrot',
};

function seed() {
  const min = 60000;
  const at = (minsAgo) => ts(-minsAgo * min);
  push('C001', { ts: at(58), user: 'U003', subtype: 'channel_join', text: '<@U003> has joined the channel' });
  push('C001', { ts: at(55), user: 'U002', text: 'Morning all — doors at 9:15, first service 10:00. Run of show is in <#C002|ops>.' });
  push('C001', { ts: at(50), user: 'U001', text: 'Apollo Beach is up. Stream key checked, ProPresenter online :white_check_mark:' });
  push('C001', { ts: at(47), user: 'U004', text: 'North Attleboro here — we have *no audio* on the sermon feed yet, working on it' });
  push('C001', { ts: at(44), user: 'U002', text: '<@U004> try the Dante patch — `Sermon Feed L/R` should be on 31/32. _Ping me if not._' });
  const parent = push('C001', { ts: at(40), user: 'U003', text: 'Countdown video is the new one this week, right? ~old one~ &lt;-- not this', reply_count: 2, latest_reply: '' });
  parent.replies = [
    { type: 'message', ts: at(39), user: 'U002', text: 'Yes — "Countdown 5 min (Sept)" in the media bin', thread_ts: parent.ts },
    { type: 'message', ts: at(38), user: 'U003', text: 'Got it :+1:', thread_ts: parent.ts },
  ];
  parent.latest_reply = parent.replies[1].ts;
  push('C001', {
    ts: at(35), subtype: 'bot_message', bot_id: 'B002', username: 'Planning Center', text: '',
    attachments: [{ fallback: 'Plan updated: Sunday Service — Sept 14 (2 items changed)', title: 'Plan updated', text: 'Sunday Service — Sept 14 (2 items changed)' }],
  });
  push('C001', { ts: at(30), user: 'U005', text: 'Lower thirds for the announcements: <https://waterschurch.org/plan|this week’s plan>', files: [{ id: 'F001', name: 'lower-thirds-0914.png', title: 'lower-thirds-0914.png' }] });
  const fixed = push('C001', { ts: at(25), user: 'U004', text: 'Audio fixed — Dante patch was it. Thanks <@U002> :pray:', edited: { user: 'U004', ts: at(24) } });
  fixed.reactions = [{ name: '+1', users: ['U002', 'U003', 'U001'], count: 3 }, { name: 'party_parrot', users: ['U005'], count: 1 }, { name: 'pray::skin-tone-3', users: ['U002'], count: 1 }];
  push('C001', { ts: at(23), user: 'U002', text: 'Custom emoji check :party_parrot: :waters: and an unknown :not_an_emoji: stay put' });
  push('C001', { ts: at(20), user: 'U002', text: '<!here> 10 minutes to doors. Campuses, post "ready" when your pre-service loop is running.' });
  push('C001', { ts: at(15), user: 'U001', text: 'Apollo Beach ready' });
  push('C001', { ts: at(14), user: 'U004', text: 'North Attleboro ready' });

  push('C002', { ts: at(120), user: 'U002', text: 'Run of show for Sept 14 is pinned. Changes go here, not in DMs.' });
  push('C002', { ts: at(90), user: 'U005', text: 'Bumper video is 0:42 this week, not 0:30 — adjust your timers.' });
  push('G001', { ts: at(200), user: 'U002', text: 'Leads: budget call moved to Tuesday 2pm.' });
  push('C003', { ts: at(300), user: 'U002', text: 'Staff meeting notes are in the drive.' });
}
seed();

const CHATTER = [
  { user: 'U003', text: 'Walk-in music is a touch loud at the back, can we come down 2 dB?' },
  { user: 'U002', text: 'Cue 4 is the *baptism video* — heads up, it has its own audio' },
  { user: 'U005', text: 'Livestream is live, 38 viewers already :tada:' },
  { user: 'U004', text: 'North Attleboro: pastor is running about 3 min long today' },
  { user: 'U002', text: 'Copy. Apollo Beach, hold your bumper until you hear from us' },
  { user: 'U003', text: 'Lyrics slide 3 of "Living Hope" has a typo — fixing for second service' },
  { user: 'U005', text: 'Stream bitrate dipped for a sec, back to normal now' },
  { user: 'U002', text: 'Offering moment is *after* the sermon this week, not before' },
  { user: 'U004', text: 'Anyone else seeing the ProPresenter stage display lag?' },
  { user: 'U003', text: 'Kids check-in is slammed, could use one more volunteer at the desk' },
  { user: 'U002', text: 'Great first service everyone :clap: reset in 15' },
];
let chatterIx = 0;

const OPS_CHATTER = [
  { user: 'U005', text: 'Ops: parking team is short two people, sending greeters over' },
  { user: 'U002', text: 'Cafe is out of oat milk again :sweat_smile:' },
  { user: 'U005', text: 'Second-service headcount: 412 in the room, 38 online' },
  { user: 'U002', text: 'Facilities: the lobby HVAC is back, thanks Dan' },
];
let opsIx = 0;

function tickNew() {
  const line = CHATTER[chatterIx % CHATTER.length];
  chatterIx += 1;
  const m = push('C001', { user: line.user, text: line.text });
  console.log(`[slack-mock] + new message ${m.ts} from ${line.user}`);
}

function tickOps() {
  const line = OPS_CHATTER[opsIx % OPS_CHATTER.length];
  opsIx += 1;
  const m = push('C002', { user: line.user, text: line.text });
  console.log(`[slack-mock] + new message ${m.ts} in #ops from ${line.user}`);
}

function tickEdit() {
  const list = history.get('C001');
  const recent = list.slice(-8).filter((m) => m.user && !m.subtype && !m.edited);
  if (!recent.length) return;
  const m = recent[Math.floor(Math.random() * recent.length)];
  m.text += ' — fixed';
  m.edited = { user: m.user, ts: ts() };
  console.log(`[slack-mock] ~ edited ${m.ts}`);
}

function tickDelete() {
  const list = history.get('C001');
  const candidates = list.slice(-10, -2).filter((m) => m.user && !m.subtype && !m.reply_count);
  if (!candidates.length) return;
  const victim = candidates[Math.floor(Math.random() * candidates.length)];
  list.splice(list.indexOf(victim), 1);
  console.log(`[slack-mock] - deleted ${victim.ts}`);
}

function tickReply() {
  const list = history.get('C001');
  const parent = list.find((m) => m.reply_count);
  if (!parent) return;
  const reply = { type: 'message', ts: ts(), user: ['U002', 'U003', 'U005'][parent.replies.length % 3], text: `Thread reply ${parent.replies.length + 1} :eyes:`, thread_ts: parent.ts };
  parent.replies.push(reply);
  parent.reply_count = parent.replies.length;
  parent.latest_reply = reply.ts;
  console.log(`[slack-mock] ↳ reply on ${parent.ts} (${parent.reply_count} total)`);
}

setInterval(tickNew, 8000).unref();
setInterval(tickOps, 20000).unref();
setInterval(tickEdit, 25000).unref();
setInterval(tickDelete, 40000).unref();
setInterval(tickReply, 30000).unref();

/* ── plumbing ───────────────────────────────────────────────────────── */

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function parseParams(req, url, raw) {
  const params = Object.fromEntries(url.searchParams.entries());
  const ctype = String(req.headers['content-type'] || '');
  if (raw) {
    if (ctype.includes('application/json')) {
      try { Object.assign(params, JSON.parse(raw)); } catch { /* ignore */ }
    } else {
      for (const [k, v] of new URLSearchParams(raw)) params[k] = v;
    }
  }
  return params;
}

function tokenOf(req, params) {
  const m = /^Bearer\s+(\S+)/.exec(String(req.headers.authorization || ''));
  return m ? m[1] : String(params.token || '');
}

function identity(token) {
  if (token === 'xoxp-revoked') return { error: 'token_revoked' };
  if (/^xoxp-/.test(token)) return { ok: true, url: 'https://waters.slack.com/', team: 'Waters Church', user: 'apollo.beach', team_id: 'T001', user_id: 'U001', noscope: token === 'xoxp-noscope' };
  if (/^xoxb-/.test(token)) return { ok: true, url: 'https://waters.slack.com/', team: 'Waters Church', user: 'proddash', team_id: 'T001', user_id: 'UBOT', bot_id: 'B001' };
  return { error: 'invalid_auth' };
}

function channelRecord(c) {
  return { id: c.id, name: c.name, name_normalized: c.name, is_channel: !c.is_private, is_group: c.is_private, is_private: c.is_private, is_member: c.is_member, is_archived: false, num_members: 12 };
}

function publicMessage(m) {
  const { replies, ...rest } = m;
  return rest;
}

function findChannel(ref) {
  const s = String(ref || '');
  return CHANNELS.find((c) => c.id === s || c.name === s.replace(/^#/, ''));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const raw = req.method === 'POST' ? await readBody(req) : '';
  const params = parseParams(req, url, raw);
  const method = url.pathname.replace(/^\/api\//, '');
  const summary = Object.entries(params).filter(([k]) => k !== 'token').map(([k, v]) => `${k}=${String(v).slice(0, 40)}`).join(' ');
  console.log(`[slack-mock] ${req.method} ${url.pathname} ${summary}`);

  const img = url.pathname.match(/^\/img\/(u|e)\/([A-Za-z0-9_+-]+)\.svg$/);
  if (img) {
    const id = img[2];
    const letter = img[1] === 'u' ? (USERS[id]?.display_name || USERS[id]?.real_name || id)[0].toUpperCase() : id[0].toUpperCase();
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(squareSvg(id, letter));
  }
  if (!url.pathname.startsWith('/api/')) return send(res, 404, { ok: false, error: 'unknown_method' });

  const token = tokenOf(req, params);
  const who = identity(token);
  if (!who.ok) return send(res, 200, { ok: false, error: who.error });

  switch (method) {
    case 'auth.test': {
      const { noscope, ...rest } = who;
      return send(res, 200, rest);
    }

    case 'users.info': {
      const u = USERS[String(params.user)];
      if (!u) return send(res, 200, { ok: false, error: 'user_not_found' });
      const img = `http://127.0.0.1:${PORT}/img/u/${params.user}.svg`;
      return send(res, 200, { ok: true, user: { id: params.user, name: u.name, real_name: u.real_name, is_bot: Boolean(u.is_bot), profile: { display_name: u.display_name, real_name: u.real_name, image_48: img, image_72: img } } });
    }

    case 'conversations.list': {
      const types = String(params.types || 'public_channel').split(',');
      let list = CHANNELS.filter((c) => (c.is_private ? types.includes('private_channel') : types.includes('public_channel')));
      if (who.bot_id) list = list.filter((c) => c.is_member); // a bot sees only what it's in
      const limit = Math.max(1, Math.min(1000, Number(params.limit) || 100));
      const start = params.cursor ? Number(Buffer.from(String(params.cursor), 'base64').toString()) || 0 : 0;
      const page = list.slice(start, start + limit);
      const next = start + limit < list.length ? Buffer.from(String(start + limit)).toString('base64') : '';
      return send(res, 200, { ok: true, channels: page.map(channelRecord), response_metadata: { next_cursor: next } });
    }

    case 'conversations.info': {
      const c = findChannel(params.channel);
      if (!c) return send(res, 200, { ok: false, error: 'channel_not_found' });
      return send(res, 200, { ok: true, channel: channelRecord(c) });
    }

    case 'conversations.history': {
      const c = findChannel(params.channel);
      if (!c) return send(res, 200, { ok: false, error: 'channel_not_found' });
      if (who.noscope) return send(res, 200, { ok: false, error: 'missing_scope', needed: 'channels:history', provided: 'channels:read,chat:write' });
      if (!c.is_member) return send(res, 200, { ok: false, error: 'not_in_channel' });
      const limit = Math.max(1, Math.min(1000, Number(params.limit) || 100));
      const list = history.get(c.id);
      const window = list.slice(-limit).reverse().map(publicMessage);
      return send(res, 200, { ok: true, messages: window, has_more: list.length > limit, pin_count: 0 });
    }

    case 'conversations.replies': {
      const c = findChannel(params.channel);
      if (!c) return send(res, 200, { ok: false, error: 'channel_not_found' });
      if (!c.is_member) return send(res, 200, { ok: false, error: 'not_in_channel' });
      const parent = history.get(c.id).find((m) => m.ts === String(params.ts));
      if (!parent) return send(res, 200, { ok: false, error: 'thread_not_found' });
      const limit = Math.max(1, Math.min(1000, Number(params.limit) || 100));
      return send(res, 200, { ok: true, messages: [publicMessage(parent), ...(parent.replies || []).slice(0, limit - 1)], has_more: false });
    }

    case 'emoji.list': {
      const emoji = {};
      for (const [name, v] of Object.entries(CUSTOM_EMOJI)) emoji[name] = v(PORT);
      return send(res, 200, { ok: true, emoji, cache_ts: '1700000000.000000' });
    }

    case 'reactions.add':
    case 'reactions.remove': {
      const c = findChannel(params.channel);
      if (!c) return send(res, 200, { ok: false, error: 'channel_not_found' });
      if (!c.is_member) return send(res, 200, { ok: false, error: 'not_in_channel' });
      const name = String(params.name || '');
      if (!name || name === 'nope') return send(res, 200, { ok: false, error: 'invalid_name' });
      const m = findMessage(c.id, String(params.timestamp || ''));
      if (!m) return send(res, 200, { ok: false, error: 'message_not_found' });
      const err = method === 'reactions.add' ? addReaction(m, name, who.user_id) : removeReaction(m, name, who.user_id);
      if (err) return send(res, 200, { ok: false, error: err });
      console.log(`[slack-mock] ${method === 'reactions.add' ? '➕' : '➖'} :${name}: on ${m.ts} in #${c.name} by ${who.user}`);
      return send(res, 200, { ok: true });
    }

    case 'chat.postMessage': {
      const c = findChannel(params.channel);
      if (!c) return send(res, 200, { ok: false, error: 'channel_not_found' });
      if (!c.is_member) return send(res, 200, { ok: false, error: 'not_in_channel' });
      const text = String(params.text || '');
      if (!text.trim()) return send(res, 200, { ok: false, error: 'no_text' });
      if (text.includes('!429')) return send(res, 429, { ok: false, error: 'ratelimited' }, { 'Retry-After': '3' });
      let m;
      if (who.bot_id && params.username) {
        m = push(c.id, { subtype: 'bot_message', bot_id: who.bot_id, username: String(params.username), icons: params.icon_emoji ? { emoji: String(params.icon_emoji) } : undefined, text });
      } else if (who.bot_id) {
        m = push(c.id, { user: who.user_id, bot_id: who.bot_id, bot_profile: { id: who.bot_id, name: 'ProdDash' }, text });
      } else {
        m = push(c.id, { user: who.user_id, text });
      }
      if (params.thread_ts) m.thread_ts = String(params.thread_ts);
      console.log(`[slack-mock] ✉ posted to #${c.name} as ${params.username || who.user}: ${text.slice(0, 60)}`);
      return send(res, 200, { ok: true, channel: c.id, ts: m.ts, message: publicMessage(m) });
    }

    default:
      return send(res, 200, { ok: false, error: 'unknown_method' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[slack-mock] Slack Web API mock on http://127.0.0.1:${PORT}/api`);
  console.log('[slack-mock] tokens: xoxp-anything (user "Apollo Beach"), xoxb-anything (bot), xoxp-revoked, xoxp-noscope');
  console.log('[slack-mock] run ProdDash with: SLACK_API_BASE=http://127.0.0.1:%d/api node server.js', PORT);
});
