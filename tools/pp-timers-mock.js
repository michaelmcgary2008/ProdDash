/**
 * Mock ProPresenter timer + timecode API for developing the
 * propresenter-timers module without a live ProPresenter (the older
 * band-lineup-display/tmp/pp-mock.js simulates slides, not timers).
 *
 *   node tools/pp-timers-mock.js [port] [--no-ltc] [--drop=<uuid,...>]
 *                                [--stage-pwd=<pwd>] [--no-ltc-field]
 *
 * Serves the endpoint shapes verified against openapi.propresenter.com:
 *   GET /version            (reachability probe)
 *   GET /v1/timers          configured timers (countdown / countdown-to-time /
 *                           elapsed variants, matching the spec's oneOf shapes)
 *   GET /v1/timers/current  live values — one countdown running, one that hits
 *                           zero after 20s and overruns (negative time, state
 *                           "overrunning"), one stopped, one elapsed running
 *   GET /v1/timecode/status hypothetical LTC route (NOT in the published
 *                           spec — the module probes it for forward compat).
 *                           Advancing HH:MM:SS:FF at 30fps that drops to
 *                           no-signal for 15s out of every 60s.
 *                           Pass --no-ltc to 404 it and exercise the
 *                           "not available on this ProPresenter" path.
 *
 * --drop=<uuid,...> omits those timers from both timer endpoints — restart
 * the mock with e.g. --drop=T2-WALKIN to simulate a timer being deleted in
 * ProPresenter (a solo tile for it must say so, not error).
 *
 * Also serves the classic stage-display websocket at /stagedisplay (the
 * Pro6-era protocol ProPresenter still answers): ath / psl / asl / sl, a
 * per-second "sys" clock, and "tmr" text updates — including a stage layout
 * with a field labeled "LTC" whose text advances at 30 fps and freezes
 * during the same 15 s/60 s no-signal window as the HTTP endpoint. Combine
 * with --no-ltc to make the stage feed the only timecode source (the module
 * prefers the HTTP route when it answers). --stage-pwd=<pwd> rejects other
 * stage passwords ("Your Password is incorrect", as real ProPresenter says);
 * --no-ltc-field serves the stage layout without the LTC field.
 *
 * Every incoming request is logged so we can confirm what the module fetches.
 */
'use strict';

const http = require('http');

const args = process.argv.slice(2);
const PORT = Number.parseInt(args.find((a) => /^\d+$/.test(a)) || '1600', 10);
const NO_LTC = args.includes('--no-ltc');
const DROP = new Set(args.flatMap((a) => (a.startsWith('--drop=') ? a.slice(7).split(',') : [])));
const STAGE_PWD = (args.find((a) => a.startsWith('--stage-pwd=')) || '').slice(12);
const NO_LTC_FIELD = args.includes('--no-ltc-field');
// Like real ProPresenter 21: the layout list omits the timecode field, but
// its updates still stream — exercises the module's heuristic binding.
const LTC_UNLISTED = args.includes('--ltc-unlisted');
const FPS = 30;

const startedAt = Date.now();
const elapsedSec = () => Math.floor((Date.now() - startedAt) / 1000);

/* ── configured timers (the /v1/timers document) ─────────────────── */

const TIMERS = [
  {
    id: { uuid: 'T1-SERMON', name: 'Sermon Countdown', index: 0 },
    allows_overrun: false,
    countdown: { duration: 25 * 60 },
  },
  {
    id: { uuid: 'T2-WALKIN', name: 'Walk-in', index: 1 },
    allows_overrun: true,
    countdown: { duration: 20 }, // hits zero fast so the overrun path is easy to watch
  },
  {
    id: { uuid: 'T3-DOORS', name: 'Doors Open', index: 2 },
    allows_overrun: false,
    count_down_to_time: { time_of_day: 9 * 3600, period: 'am' },
  },
  {
    id: { uuid: 'T4-SERVICE', name: 'Service Elapsed', index: 3 },
    allows_overrun: false,
    elapsed: { start_time: 0, end_time: null },
  },
];

/* ── live values (the /v1/timers/current document) ───────────────── */

/** Format seconds the way ProPresenter reports timer values: "HH:MM:SS",
    with a leading "-" once a timer overruns. */
function hms(totalSeconds) {
  const sign = totalSeconds < 0 ? '-' : '';
  const s = Math.abs(totalSeconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}:${ss}`;
}

function currentTimes() {
  const t = elapsedSec();
  const sermonLeft = Math.max(0, 25 * 60 - t);
  const walkinLeft = 20 - t;
  return [
    {
      id: TIMERS[0].id,
      time: hms(sermonLeft),
      state: sermonLeft > 0 ? 'running' : 'complete',
    },
    {
      id: TIMERS[1].id,
      time: hms(walkinLeft),
      state: walkinLeft > 0 ? 'running' : 'overrunning',
    },
    {
      id: TIMERS[2].id,
      time: hms(10 * 60),
      state: 'stopped',
    },
    {
      id: TIMERS[3].id,
      time: hms(t),
      state: 'running',
    },
  ];
}

/* ── LTC timecode: 45s receiving / 15s no-signal, repeating ──────── */

let frozenTimecode = '00:00:00:00';

function timecodeStatus() {
  const ms = Date.now() - startedAt;
  const receiving = (Math.floor(ms / 1000) % 60) < 45;
  if (!receiving) return { time: frozenTimecode, receiving: false };
  const frames = Math.floor(ms / (1000 / FPS));
  const ff = String(frames % FPS).padStart(2, '0');
  frozenTimecode = `${hms(Math.floor(ms / 1000)).replace(/^-/, '')}:${ff}`;
  return { time: frozenTimecode, receiving: true };
}

/* ── server ──────────────────────────────────────────────────────── */

function sendJson(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  console.log(`[pp-timers-mock] ${req.method} ${req.url}`);

  if (p === '/version') {
    return sendJson(res, { name: 'NA-ProP (timers mock)', platform: 'mac', host_description: 'ProPresenter 20.0.1', api_version: 'v1' });
  }
  if (p === '/v1/timers') return sendJson(res, TIMERS.filter((t) => !DROP.has(t.id.uuid)));
  if (p === '/v1/timers/current') return sendJson(res, currentTimes().filter((t) => !DROP.has(t.id.uuid)));
  if (p === '/v1/timecode/status' && !NO_LTC) return sendJson(res, timecodeStatus());

  sendJson(res, { error: 'not found' }, 404);
});

/* ── stage-display websocket (/stagedisplay) ─────────────────────── */

const cryptoMod = require('crypto');
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const STAGE_LAYOUT = {
  acn: 'sl',
  uid: 'MOCK-LAYOUT-1',
  nme: 'Timers',
  fme: [
    { nme: 'Current Slide', typ: 1 },
    ...(NO_LTC_FIELD || LTC_UNLISTED ? [] : [{ nme: 'LTC', typ: 7, uid: 'LTC-FIELD' }]),
    { nme: 'Sermon Countdown', typ: 7, uid: 'T1-SERMON' },
  ],
};

/** Server→client frames are unmasked. Text only — plenty for this protocol. */
function wsEncode(str) {
  const p = Buffer.from(str);
  let h;
  if (p.length < 126) {
    h = Buffer.from([0x81, p.length]);
  } else {
    h = Buffer.alloc(4);
    h[0] = 0x81;
    h[1] = 126;
    h.writeUInt16BE(p.length, 2);
  }
  return Buffer.concat([h, p]);
}

server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/stagedisplay') return void socket.destroy();
  const key = req.headers['sec-websocket-key'];
  if (!key) return void socket.destroy();
  console.log('[pp-timers-mock] stage display client connected');
  const accept = cryptoMod.createHash('sha1').update(key + WS_MAGIC).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);

  const send = (obj) => {
    try { socket.write(wsEncode(JSON.stringify(obj))); } catch { /* gone */ }
  };
  let authed = false;
  let buf = Buffer.alloc(0);
  let lastLtcText = '';

  const sysTimer = setInterval(() => {
    if (authed) send({ acn: 'sys', txt: ' ' + new Date().toLocaleTimeString() });
  }, 1000);
  const tmrTimer = setInterval(() => {
    if (!authed) return;
    // noise a client must filter out: an ordinary timer's text
    send({ acn: 'tmr', uid: 'T1-SERMON', txt: hms(Math.max(0, 25 * 60 - elapsedSec())) });
  }, 1000);
  const ltcTimer = setInterval(() => {
    if (!authed || NO_LTC_FIELD) return;
    const tc = timecodeStatus();
    // During no-signal the on-stage field is frozen: no updates at all —
    // exactly what the module's staleness heuristic must catch.
    if (!tc.receiving || tc.time === lastLtcText) return;
    lastLtcText = tc.time;
    send({ acn: 'tmr', uid: 'LTC-FIELD', txt: tc.time });
  }, 250);

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.slice(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buf = buf.slice(off + maskLen + len);

      if (opcode === 0x8) return void socket.destroy();
      if (opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (opcode !== 0x1) continue;
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { continue; }
      console.log('[pp-timers-mock] stage <-', JSON.stringify(msg).slice(0, 120));
      if (msg.acn === 'ath') {
        if (STAGE_PWD && String(msg.pwd || '') !== STAGE_PWD) {
          send({ acn: 'ath', ath: false, majorVersion: 7, minorVersion: 21, err: 'Your Password is incorrect' });
        } else {
          authed = true;
          send({ acn: 'ath', ath: true, err: '' });
        }
      } else if (msg.acn === 'psl') {
        send({ acn: 'psl', uid: 'MOCK-LAYOUT-1' });
      } else if (msg.acn === 'asl') {
        send({ acn: 'asl', ary: [STAGE_LAYOUT] });
      }
    }
  });

  const cleanup = () => {
    clearInterval(sysTimer);
    clearInterval(tmrTimer);
    clearInterval(ltcTimer);
  };
  socket.on('close', cleanup);
  socket.on('error', () => { cleanup(); socket.destroy(); });
});

server.listen(PORT, () => {
  console.log(`[pp-timers-mock] listening on http://127.0.0.1:${PORT}${NO_LTC ? ' (timecode endpoint disabled)' : ''}${NO_LTC_FIELD ? ' (stage layout has no LTC field)' : ''}${STAGE_PWD ? ' (stage password required)' : ''}`);
});
