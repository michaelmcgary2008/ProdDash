/**
 * Mock ProPresenter timer + timecode API for developing the
 * propresenter-timers module without a live ProPresenter (the older
 * band-lineup-display/tmp/pp-mock.js simulates slides, not timers).
 *
 *   node tools/pp-timers-mock.js [port] [--no-ltc]
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
 * Every incoming request is logged so we can confirm what the module fetches.
 */
'use strict';

const http = require('http');

const args = process.argv.slice(2);
const PORT = Number.parseInt(args.find((a) => /^\d+$/.test(a)) || '1600', 10);
const NO_LTC = args.includes('--no-ltc');
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
  if (p === '/v1/timers') return sendJson(res, TIMERS);
  if (p === '/v1/timers/current') return sendJson(res, currentTimes());
  if (p === '/v1/timecode/status' && !NO_LTC) return sendJson(res, timecodeStatus());

  sendJson(res, { error: 'not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`[pp-timers-mock] listening on http://127.0.0.1:${PORT}${NO_LTC ? ' (timecode endpoint disabled)' : ''}`);
});
