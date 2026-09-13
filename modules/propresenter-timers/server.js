'use strict';

/**
 * Timers — server part.
 *
 * One tile for every timer and clock in the room, from any source. Each
 * SOURCE turns its own world into the module guide's standard timer objects
 * ({ id, label, kind, state, startedAt, elapsedMs, remainingMs, targetMs,
 * status, detail } — see "Offering timers to the Timers module") and reports
 * its health. This file merges the sources, fans the merged state out to the
 * tiles over SSE, and offers the whole set to the rest of ProdDash as a
 * timers provider itself. Browsers never talk to ProPresenter, the audio
 * hardware or other modules directly.
 *
 * Sources (one factory each, below):
 *   propresenter  the ProPresenter openAPI timer list + live values, polled
 *                 exactly as before (admin switch: ppEnabled)
 *   ltc           SMPTE LTC decoded from an audio input by the built-in
 *                 listener (ltc-listener.js / ltc.js — untouched), shown as a
 *                 kind:"clock" timer whose status.text is the timecode and
 *                 whose `ltc` extension carries fps/df/ageMs so the tile can
 *                 count frames between reports (admin switch: ltcEnabled)
 *   clock         time of day. Trivial here — the tile paints its own wall
 *                 clock — it exists so the clock is one more entry in
 *                 /timers and in the tile's list, like everything else
 *   modules       every other module whose manifest says
 *                 "provides": ["timers"], discovered from the shell's
 *                 /api/modules over loopback (shell.port, never guessed) and
 *                 read through its /timers/stream when that answers as SSE,
 *                 else its /timers polled every 2 s. Re-discovered every 30 s
 *                 so a newly installed provider appears without a restart.
 *                 PCO Plan sits behind pcoEnabled, everything else behind
 *                 moduleTimersEnabled.
 *
 * ADDING A SOURCE (another timer platform) is a dozen lines. Write a factory
 * that returns
 *
 *   { id, label, kind, start(emit), stop(), health() }
 *
 *   id      short, stable ('propresenter', 'ltc', …) — the tile keys its
 *           show/hide settings on `${id}:${timer.id}`
 *   label   the heading the tile puts over this source's timers
 *   kind    which tile switch governs it: 'propresenter' | 'ltc' | 'clock'
 *           | 'module' (a new platform would add its own switch and kind)
 *   start(emit) begins following the upstream and calls
 *           emit({ status, message, timers, updatedAt }) whenever the view
 *           changes — status 'ok' | 'connecting' | 'error', message one
 *           human line (shown under the heading while not ok), timers an
 *           array of standard timer objects as of updatedAt
 *   stop()  tears everything down (a re-init follows every admin save)
 *   health() → { status, message } for the admin health line
 *
 * then, in init(), push it onto `fixed` behind its own admin `switch` field
 * (named as that group's `toggle` in module.json). Merging, change
 * detection, both SSE feeds, /timers and the tile are generic — nothing
 * else changes.
 *
 * Routes:
 *   GET /state          → { state }            tile snapshot (instant paint)
 *   GET /stream         → SSE `state` events    tile feed, change-detected
 *   GET /timers         → provider snapshot     the module guide's contract
 *   GET /timers/stream  → SSE `timers` events   same, for other consumers
 *   GET /ltc/devices    → this machine's audio inputs, for the admin page's
 *                         device picker (select + optionsRoute)
 *
 * ProPresenter endpoints, verified against openapi.propresenter.com (v1):
 *   GET /v1/timers          → [ { id:{uuid,name,index}, allows_overrun,
 *                                 countdown:{duration} | count_down_to_time:{time_of_day,period}
 *                                 | elapsed:{start_time,end_time} } ]
 *   GET /v1/timers/current  → [ { id:{uuid,name,index}, time:"HH:MM:SS", state } ]
 *     `time` may be negative ("-00:00:02") while overrunning, and some builds
 *     append hundredths. `state` enum is stopped|running|complete|overrunning|
 *     overran — but the spec's own example says "overrun", so anything
 *     containing "overr" is overrun. The API exposes NO per-timer color.
 *   ProPresenter's HTTP server is easily overwhelmed, so requests run strictly
 *   sequentially, live values are the only every-tick call, and the timer
 *   list rides a slow lane.
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { createLtcListener } = require('./ltc-listener');

/** This module's id — left out of provider discovery (we don't consume ourselves). */
const SELF_ID = 'propresenter-timers';
/** The provider the admin "PCO Plan" switch governs; every other provider follows "Other modules". */
const PCO_ID = 'pco-plan';

/* ProPresenter cadence. */
const POLL_MS = 500;
const RETRY_MS = 2500;
const SLOW_EVERY = 4;
const REQUEST_TIMEOUT_MS = 4000;

/* Other modules' timers. */
const DISCOVER_MS = 30000; // re-read /api/modules: a newly installed provider shows up without a restart
const DISCOVER_RETRY_MS = 5000; // …sooner while the shell isn't answering yet (boot)
const DISCOVER_FIRST_MS = 1500; // init() runs before the shell listens
const MODULE_POLL_MS = 2000; // GET /timers cadence for a provider with no stream
const BACKOFF_MIN_MS = 3000;
const BACKOFF_MAX_MS = 15000;
const GRACE_MS = 10000; // a provider's timers survive this long without a fresh snapshot
const STREAM_SILENCE_MS = 45000; // a stream with no bytes for this long (heartbeats are 15 s) is dead
const MAX_TIMERS_PER_PROVIDER = 50;

/** SSE comment ping cadence — keeps idle connections alive through sleepy Wi-Fi. */
const HEARTBEAT_MS = 15000;

const KINDS = new Set(['elapsed', 'countdown', 'clock']);
const STATES = new Set(['running', 'paused', 'stopped', 'idle']);
const TONES = new Set(['ok', 'warn', 'danger', 'muted']);

/** Set by init(), read by routes() and tiles() — all rebuilt together on remount. */
let current = null;

/* ── small helpers ────────────────────────────────────────────────────── */

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Open an SSE response, send the first frame, and register it in `set`. */
function openSse(req, res, set, firstFrame) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  res.write(firstFrame);
  if (!set) return void res.end();
  // A viewer that stops reading (locked tablet, sleeping laptop) must not
  // queue frames forever; keepalive probes make the OS notice.
  try { req.socket.setKeepAlive(true, 15000); } catch { /* gone */ }
  set.add(res);
  req.on('close', () => set.delete(res));
}

function writeAll(set, payload) {
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}

/** "HH:MM:SS", "-HH:MM:SS", "MM:SS", optional ".hh" → signed milliseconds, or null. */
function hmsToMs(str) {
  const m = /^\s*(-)?(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?\s*$/.exec(String(str || ''));
  if (!m) return null;
  const h = m[2] ? Number(m[2]) : 0;
  let ms = (h * 3600 + Number(m[3]) * 60 + Number(m[4])) * 1000;
  if (m[5]) ms += Math.round(Number('0.' + m[5]) * 1000);
  return m[1] ? -ms : ms;
}

/** ms → "M:SS" / "H:MM:SS" (for detail lines). */
function fmtMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (v) => String(v).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** ProPresenter's count_down_to_time target: seconds since midnight + am/pm/24h. */
function timeOfDayText(seconds, period) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '';
  const h = Math.floor(s / 3600) % 24;
  const m = Math.floor((s % 3600) / 60);
  const p = String(period || '').toLowerCase();
  if (p === 'am' || p === 'pm') return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${p}`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function errorText(err) {
  return String(err?.cause?.code || err?.code || err?.message || err || 'failed');
}

/* ── validation of what other modules hand us ─────────────────────────── */

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** One timer object from a provider, coerced to the contract (or null to drop it). */
function sanitizeTimer(t) {
  if (!t || typeof t !== 'object') return null;
  const id = t.id === null || t.id === undefined ? '' : String(t.id);
  if (!id) return null;
  let status = null;
  if (t.status && typeof t.status === 'object' && t.status.text !== undefined && t.status.text !== null) {
    status = { text: String(t.status.text).slice(0, 200) };
    if (TONES.has(t.status.tone)) status.tone = t.status.tone;
  }
  return {
    id,
    label: String(t.label || id).slice(0, 120),
    kind: KINDS.has(t.kind) ? t.kind : 'elapsed',
    state: STATES.has(t.state) ? t.state : 'stopped',
    startedAt: numOrNull(t.startedAt),
    elapsedMs: numOrNull(t.elapsedMs),
    remainingMs: numOrNull(t.remainingMs),
    targetMs: numOrNull(t.targetMs),
    status,
    detail: t.detail === null || t.detail === undefined ? '' : String(t.detail).slice(0, 200),
  };
}

/** A provider's /timers document → { label, timers, updatedAt }, or null when it isn't one. */
function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.timers)) return null;
  return {
    label: raw.label ? String(raw.label).slice(0, 60) : '',
    timers: raw.timers.map(sanitizeTimer).filter(Boolean).slice(0, MAX_TIMERS_PER_PROVIDER),
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

/* ── source: ProPresenter ─────────────────────────────────────────────── */

function createProPresenterSource({ config, log }) {
  // Endpoint config. Legacy flat host/port keys (saved before the endpoint
  // field existed) can only still be present until the admin form is
  // re-saved, so when they exist they win over the endpoint's default.
  const ep = config.propresenter && typeof config.propresenter === 'object' ? config.propresenter : {};
  const host = String(config.host ?? ep.host ?? '');
  const port = Number(config.port ?? ep.port) || 1025;
  const password = String(config.password || '');
  const configured = Boolean(host && port);

  let emit = () => {};
  let stopped = false;
  let pollTimer = null;
  let tick = 0;
  let reachable = false;
  let lastError = '';
  let timers = [];
  let updatedAt = 0;
  /** uuid → { name, index, type, allowsOverrun, targetMs, detail } from /v1/timers, in list order. */
  let timerConfigs = new Map();

  function url(target) {
    const built = new URL(`http://${host}:${port}${target}`);
    if (password) built.searchParams.set('password', password);
    return built;
  }

  async function requestJson(target) {
    const response = await fetch(url(target), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const err = new Error(`ProPresenter ${response.status} ${response.statusText}`);
      err.status = response.status;
      throw err;
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  function describe(entry) {
    if (entry.countdown) {
      const targetMs = Number(entry.countdown.duration) > 0 ? Number(entry.countdown.duration) * 1000 : null;
      return { type: 'countdown', targetMs, detail: targetMs !== null ? `Countdown ${fmtMs(targetMs)}` : 'Countdown' };
    }
    if (entry.count_down_to_time) {
      const at = timeOfDayText(entry.count_down_to_time.time_of_day, entry.count_down_to_time.period);
      return { type: 'countdown_to_time', targetMs: null, detail: at ? `Counts down to ${at}` : 'Counts down to a time of day' };
    }
    if (entry.elapsed) {
      const end = Number(entry.elapsed.end_time);
      const targetMs = Number.isFinite(end) && end > 0 ? end * 1000 : null;
      return { type: 'elapsed', targetMs, detail: targetMs !== null ? `Elapsed · to ${fmtMs(targetMs)}` : 'Elapsed' };
    }
    return { type: 'unknown', targetMs: null, detail: '' };
  }

  function applyTimerList(list) {
    if (!Array.isArray(list)) return;
    const next = new Map();
    for (const entry of list) {
      const uuid = entry?.id?.uuid;
      if (!uuid) continue;
      next.set(uuid, {
        name: String(entry.id.name || 'Timer'),
        index: Number(entry.id.index) || 0,
        allowsOverrun: Boolean(entry.allows_overrun),
        ...describe(entry),
      });
    }
    timerConfigs = next;
  }

  /** One ProPresenter timer (configured entry + live value) → a standard timer object. */
  function toTimer(uuid, cfg, live, now) {
    const rawState = String(live?.state || '').toLowerCase();
    const overrun = rawState.includes('overr');
    const value = live ? hmsToMs(live.time) : null;
    const type = cfg ? cfg.type : 'unknown';
    // A timer reported live but missing from the (stale) config list has an
    // unknown type until the slow lane catches up (~2 s); treat it as elapsed
    // meanwhile — the whole-second display can't drift wrong in that time.
    const kind = type === 'countdown' || type === 'countdown_to_time' ? 'countdown' : 'elapsed';
    const targetMs = cfg ? cfg.targetMs : null;
    let state;
    if (!live) state = 'idle';
    else if (rawState === 'running' || overrun) state = 'running';
    else if (rawState === 'complete') state = 'stopped';
    else {
      // ProPresenter's "stopped" covers both a timer that never started
      // (still showing its full length) and one paused mid-way.
      const atStart = value === null || (kind === 'countdown' ? targetMs !== null && value === targetMs : value === 0);
      state = atStart ? 'idle' : 'paused';
    }
    const elapsedMs = kind === 'elapsed' ? value : targetMs !== null && value !== null ? targetMs - value : null;
    const remainingMs = kind === 'countdown' ? value : targetMs !== null && value !== null ? targetMs - value : null;
    const startedAt = state === 'running' && elapsedMs !== null ? now - elapsedMs : null;
    const text = !live ? '—' : overrun ? 'Overrun' : rawState === 'running' ? 'Running' : rawState === 'complete' ? 'Complete' : 'Stopped';
    const tone = overrun ? 'danger' : rawState === 'running' ? 'ok' : rawState === 'complete' ? 'warn' : 'muted';
    return {
      id: uuid,
      label: (live && live.name) || (cfg && cfg.name) || 'Timer',
      kind,
      state,
      startedAt,
      elapsedMs,
      remainingMs,
      targetMs,
      status: { text, tone },
      detail: cfg ? cfg.detail : '',
    };
  }

  /** Merge configured timers (order, type) with live values into one list. */
  function mergeTimers(currentTimes, now) {
    const live = new Map();
    if (Array.isArray(currentTimes)) {
      for (const entry of currentTimes) {
        const uuid = entry?.id?.uuid;
        if (!uuid) continue;
        live.set(uuid, {
          name: String(entry.id.name || ''),
          time: typeof entry.time === 'string' ? entry.time : '',
          state: typeof entry.state === 'string' ? entry.state : '',
        });
      }
    }
    const out = [];
    for (const [uuid, cfg] of timerConfigs) {
      const now_ = live.get(uuid) || null;
      live.delete(uuid);
      out.push(toTimer(uuid, cfg, now_, now));
    }
    // Timers reported live but missing from the (possibly stale) config
    // list still deserve a card — type unknown until the slow lane catches up.
    for (const [uuid, now_] of live) out.push(toTimer(uuid, null, now_, now));
    return out;
  }

  function status() {
    if (!configured) return 'error';
    if (reachable) return 'ok';
    return lastError ? 'error' : 'connecting';
  }

  function message() {
    if (!configured) return 'No ProPresenter host configured — set one in Admin, or switch ProPresenter timers off';
    if (reachable) return `Polling ${host}:${port}, ${timers.length} timer${timers.length === 1 ? '' : 's'}`;
    return lastError ? `Unreachable at ${host}:${port} — ${lastError}` : `Reaching ${host}:${port}…`;
  }

  function publish() {
    if (stopped) return;
    emit({ status: status(), message: message(), timers, updatedAt });
  }

  async function pollTick() {
    if (stopped) return;
    try {
      tick += 1;
      // Slow lane first on the very first tick so cards get names/types
      // immediately; afterwards every SLOW_EVERY ticks.
      if (tick % SLOW_EVERY === 1 || !timerConfigs.size) {
        applyTimerList(await requestJson('/v1/timers'));
      }
      // THE HOT PATH — live values every tick.
      const currentTimes = await requestJson('/v1/timers/current');
      updatedAt = Date.now();
      timers = mergeTimers(currentTimes, updatedAt);
      reachable = true;
      lastError = '';
    } catch (err) {
      reachable = false;
      lastError = err instanceof Error ? err.message : String(err);
    }
    publish();
    if (stopped) return;
    pollTimer = setTimeout(pollTick, reachable ? POLL_MS : RETRY_MS);
  }

  return {
    id: 'propresenter',
    label: 'ProPresenter',
    kind: 'propresenter',
    start(e) {
      emit = e;
      if (!configured) {
        log('ProPresenter timers on, but no host configured — set one in /admin');
        publish();
        return;
      }
      log(`polling timers on ${host}:${port}`);
      pollTick();
    },
    stop() {
      stopped = true;
      clearTimeout(pollTimer);
    },
    health() {
      return { status: status(), message: message() };
    },
  };
}

/* ── source: LTC timecode (built-in listener) ─────────────────────────── */

function createLtcSource({ config, log, moduleDir }) {
  const device = String(config.ltcDevice || '');
  const channel = Math.max(1, Math.trunc(Number(config.ltcChannel)) || 1);

  let emit = () => {};
  let listener = null;
  let stopped = false;
  /** The listener's latest word: { state, time, fps, df, ageMs } | { error } | null while starting. */
  let word = null;

  function rateText() {
    return word?.df ? '29.97 DF' : word?.fps ? `${word.fps} fps` : '';
  }

  /** The LTC timecode as one standard timer object (kind clock, timecode in status.text). */
  function timer() {
    const base = { id: 'ltc', label: 'Timecode', kind: 'clock', startedAt: null, elapsedMs: null, remainingMs: null, targetMs: null };
    if (!word || word.error) {
      const note = word ? word.error : 'Starting LTC listener…';
      return { ...base, state: 'idle', status: { text: '', tone: 'muted' }, detail: note, ltc: { time: '', fps: 0, df: false, status: '', note } };
    }
    const running = word.state === 'running';
    const rate = rateText();
    const ltc = { time: word.time || '', fps: word.fps || 0, df: Boolean(word.df), status: word.state, note: '' };
    // While running: how old this timecode is, so the tile can pin the
    // anchor to its own clock and count frames between reports.
    if (running && Number.isFinite(word.ageMs)) ltc.ageMs = Math.max(0, word.ageMs);
    return {
      ...base,
      state: running ? 'running' : word.state === 'stopped' ? 'stopped' : 'idle',
      status: { text: word.time || '', tone: running ? 'ok' : word.state === 'stopped' ? 'muted' : 'warn' },
      detail: running ? (rate ? `Running · ${rate}` : 'Running') : word.state === 'stopped' ? 'Stopped' : 'No signal',
      ltc,
    };
  }

  function status() {
    if (!word) return 'connecting';
    return word.error ? 'error' : 'ok';
  }

  function message() {
    if (!word) return 'Starting LTC listener…';
    if (word.error) return word.error;
    const rate = rateText();
    return word.state === 'running' ? `LTC running${rate ? ` · ${rate}` : ''}` : word.state === 'stopped' ? 'LTC stopped' : 'LTC no signal';
  }

  function publish() {
    if (stopped) return;
    emit({ status: status(), message: message(), timers: [timer()], updatedAt: Date.now() });
  }

  return {
    id: 'ltc',
    label: 'LTC',
    kind: 'ltc',
    start(e) {
      emit = e;
      if (!device) {
        word = { error: 'LTC timecode is on but no audio device is selected — pick one in Admin' };
        publish();
        return;
      }
      publish();
      listener = createLtcListener({
        device,
        channel,
        moduleDir,
        log,
        onUpdate(update) {
          word = update;
          publish();
        },
      });
    },
    stop() {
      stopped = true;
      listener?.stop();
      listener = null;
    },
    health() {
      return { status: status(), message: message() };
    },
  };
}

/* ── source: time of day ──────────────────────────────────────────────── */

function createClockSource() {
  return {
    id: 'clock',
    label: 'Clock',
    kind: 'clock',
    start(emit) {
      // status.text (the ISO time) is stamped when a snapshot is served —
      // see stampClock() — so this never has to re-emit.
      emit({
        status: 'ok',
        message: 'ticking',
        updatedAt: Date.now(),
        timers: [{ id: 'local', label: 'Clock', kind: 'clock', state: 'running', startedAt: null, elapsedMs: null, remainingMs: null, targetMs: null, status: { text: '', tone: 'ok' }, detail: '' }],
      });
    },
    stop() {},
    health() {
      return { status: 'ok', message: '' };
    },
  };
}

/* ── source: another module's timers (over loopback) ─────────────────── */

function createModuleSource({ moduleId, name, shellPort, log }) {
  const base = `/api/modules/${encodeURIComponent(moduleId)}`;
  let emit = () => {};
  let stopped = false;
  let label = String(name || moduleId);
  let timers = [];
  let updatedAt = 0;
  let lastOkAt = 0;
  let lastError = '';
  let state = 'connecting'; // 'ok' | 'connecting' | 'error'
  let via = ''; // 'stream' | 'poll' once we know which the provider offers
  let stream = null; // the open http.ClientRequest of /timers/stream
  let pollTimer = null;
  let pollInflight = false;
  let retryTimer = null;
  let silenceTimer = null;
  let backoff = BACKOFF_MIN_MS;

  function message() {
    if (state === 'ok') return `${timers.length} timer${timers.length === 1 ? '' : 's'}${via ? ` (${via})` : ''}`;
    if (state === 'connecting') return lastError ? `reconnecting — ${lastError}` : 'connecting…';
    return `unreachable — ${lastError}`;
  }

  function publish() {
    if (stopped) return;
    emit({ label, status: state, message: message(), timers, updatedAt });
  }

  function accept(raw) {
    const snap = sanitizeSnapshot(raw);
    if (!snap) {
      fail('malformed /timers snapshot');
      return;
    }
    if (snap.label) label = snap.label;
    timers = snap.timers;
    updatedAt = snap.updatedAt;
    lastOkAt = Date.now();
    lastError = '';
    state = 'ok';
    backoff = BACKOFF_MIN_MS;
    publish();
  }

  /** A provider restarting mid-service drops its stream for a moment; its
      timers stay up through the grace period and only then disappear. */
  function fail(why) {
    lastError = why;
    if (Date.now() - lastOkAt > GRACE_MS) {
      timers = [];
      state = 'error';
    } else {
      state = 'connecting';
    }
    publish();
  }

  function later(fn, ms) {
    const t = setTimeout(() => { if (!stopped) fn(); }, ms);
    t.unref?.();
    return t;
  }

  function backoffLater(fn) {
    clearTimeout(retryTimer);
    retryTimer = later(fn, backoff);
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
  }

  function closeStream() {
    clearTimeout(silenceTimer);
    silenceTimer = null;
    if (stream) {
      const s = stream;
      stream = null;
      try { s.destroy(); } catch { /* already gone */ }
    }
  }

  function connectStream() {
    if (stopped || stream) return;
    let done = false;
    const drop = (why) => {
      if (done || stopped) return;
      done = true;
      closeStream();
      fail(why);
      backoffLater(connectStream);
    };
    const req = http.get({ host: '127.0.0.1', port: shellPort, path: `${base}/timers/stream`, headers: { Accept: 'text/event-stream' } }, (res) => {
      const type = String(res.headers['content-type'] || '');
      if (res.statusCode !== 200 || !/text\/event-stream/i.test(type)) {
        // No stream here (404: the provider only serves /timers; 502: it
        // failed to start) — poll instead, and try the stream again at the
        // next discovery pass.
        done = true;
        res.resume();
        stream = null;
        via = 'poll';
        poll();
        return;
      }
      via = 'stream';
      clearTimeout(pollTimer);
      pollTimer = null;
      res.setEncoding('utf8');
      let buf = '';
      const armSilence = () => {
        clearTimeout(silenceTimer);
        silenceTimer = later(() => drop('stream went silent'), STREAM_SILENCE_MS);
      };
      armSilence();
      res.on('data', (chunk) => {
        armSilence();
        buf += chunk.replace(/\r\n/g, '\n');
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          let event = 'message';
          const data = [];
          for (const line of block.split('\n')) {
            if (!line || line.startsWith(':')) continue;
            const colon = line.indexOf(':');
            const field = colon < 0 ? line : line.slice(0, colon);
            let value = colon < 0 ? '' : line.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            if (field === 'event') event = value;
            else if (field === 'data') data.push(value);
          }
          if (!data.length || (event !== 'timers' && event !== 'message')) continue;
          try {
            accept(JSON.parse(data.join('\n')));
          } catch { /* not for us */ }
        }
        if (buf.length > 1e6) buf = ''; // runaway guard: never an SSE frame this size
      });
      res.on('end', () => drop('stream ended'));
      res.on('close', () => drop('stream closed'));
      res.on('error', (err) => drop(errorText(err)));
    });
    stream = req;
    req.on('error', (err) => drop(errorText(err)));
  }

  async function pollOnce() {
    pollTimer = null;
    if (stopped || pollInflight || via === 'stream') return;
    pollInflight = true;
    let ok = false;
    try {
      const res = await fetch(`http://127.0.0.1:${shellPort}${base}/timers`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (via === 'stream' || stopped) return; // the stream came up meanwhile
      accept(body);
      ok = true;
    } catch (err) {
      if (!stopped && via !== 'stream') fail(errorText(err));
    } finally {
      pollInflight = false;
    }
    if (stopped || via === 'stream') return;
    if (ok) {
      pollTimer = later(pollOnce, MODULE_POLL_MS);
    } else {
      pollTimer = later(pollOnce, backoff);
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
    }
  }

  function poll() {
    if (stopped || pollTimer || pollInflight) return;
    pollTimer = later(pollOnce, 0);
  }

  return {
    id: moduleId,
    kind: 'module',
    get label() {
      return label;
    },
    start(e) {
      emit = e;
      publish();
      connectStream();
    },
    stop() {
      stopped = true;
      closeStream();
      clearTimeout(retryTimer);
      clearTimeout(pollTimer);
      retryTimer = null;
      pollTimer = null;
    },
    /** Called on every discovery pass: a provider that had no stream may have one now. */
    retryStream() {
      if (!stopped && !stream && via === 'poll') connectStream();
    },
    health() {
      return { status: state, message: message() };
    },
  };
}

/**
 * Finds timer providers — every active module whose manifest says
 * "provides": ["timers"] — by reading the shell's own /api/modules over
 * loopback, and keeps one module source per provider alive.
 */
function createModuleDiscovery({ shellPort, log, flags, onAdd, onRemove }) {
  const sources = new Map(); // module id → source
  let timer = null;
  let stopped = false;
  let listed = null; // providers named by the last successful read, [{ id, name }]
  let listError = '';

  function wanted(id) {
    return id === PCO_ID ? flags.pco : flags.modules;
  }

  async function discover() {
    timer = null;
    if (stopped) return;
    try {
      if (!shellPort) throw new Error('shell port unknown (needs ProdDash 1.4.0)');
      const res = await fetch(`http://127.0.0.1:${shellPort}/api/modules`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (stopped) return;
      const mods = Array.isArray(body?.modules) ? body.modules : [];
      listed = mods
        .filter((m) => m && typeof m.id === 'string' && m.id !== SELF_ID && Array.isArray(m.provides) && m.provides.includes('timers'))
        .map((m) => ({ id: m.id, name: String(m.name || m.id) }));
      listError = '';
      const keep = new Set();
      for (const m of listed) {
        if (!wanted(m.id)) continue;
        keep.add(m.id);
        const have = sources.get(m.id);
        if (have) {
          have.retryStream();
        } else {
          const source = createModuleSource({ moduleId: m.id, name: m.name, shellPort, log });
          sources.set(m.id, source);
          log(`following timers offered by module "${m.id}"`);
          onAdd(source);
        }
      }
      // Disabled, uninstalled, or no longer offering timers: the shell is
      // authoritative, so its timers go now rather than after the grace.
      for (const [id, source] of sources) {
        if (keep.has(id)) continue;
        source.stop();
        sources.delete(id);
        log(`module "${id}" no longer offers timers`);
        onRemove(id);
      }
    } catch (err) {
      listError = errorText(err);
    }
    if (!stopped) {
      timer = setTimeout(discover, listError ? DISCOVER_RETRY_MS : DISCOVER_MS);
      timer.unref?.();
    }
  }

  return {
    start() {
      if (!flags.pco && !flags.modules) return;
      timer = setTimeout(discover, DISCOVER_FIRST_MS);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      for (const source of sources.values()) source.stop();
      sources.clear();
    },
    /** Health lines for the admin page: one for PCO Plan, one per other provider. */
    health() {
      const parts = [];
      let status = 'ok';
      const bump = (s) => {
        if (s === 'error') status = 'error';
        else if (s === 'connecting' && status === 'ok') status = 'connecting';
      };
      if (!flags.pco) parts.push('PCO Plan: off');
      if (!flags.modules) parts.push('Other modules: off');
      if (!flags.pco && !flags.modules) return { status, parts };
      if (listed === null) {
        parts.push(listError ? `Modules: waiting for the shell (${listError})` : 'Modules: discovering…');
        return { status: 'connecting', parts };
      }
      if (listError) {
        parts.push(`Modules: cannot re-read /api/modules (${listError})`);
        bump('error');
      }
      if (flags.pco) {
        const pco = sources.get(PCO_ID);
        if (pco) {
          const h = pco.health();
          parts.push(`PCO Plan: ${h.message}`);
          bump(h.status);
        } else {
          parts.push('PCO Plan: not installed, or not offering timers yet');
        }
      }
      if (flags.modules) {
        const others = [...sources.values()].filter((s) => s.id !== PCO_ID);
        if (!others.length) parts.push('Other modules: none offering timers');
        for (const s of others) {
          const h = s.health();
          parts.push(`${s.label}: ${h.message}`);
          bump(h.status);
        }
      }
      return { status, parts };
    },
  };
}

/* ── the module ───────────────────────────────────────────────────────── */

/** Sort order of the sources in the tile: fixed ones first, then PCO Plan, then other modules by name. */
const ORDER = { propresenter: 0, ltc: 1, clock: 2, [PCO_ID]: 3 };

function emptyState(timerFont = 'default') {
  return { serverNow: Date.now(), timerFont, sources: [] };
}

function emptyProvider() {
  return { source: SELF_ID, label: 'Timers', updatedAt: Date.now(), timers: [] };
}

module.exports = {
  init({ config, log, shell }) {
    const shellPort = Number(shell && shell.port) || 0;
    const timerFont = config.timerFont === 'monospace' ? 'monospace' : 'default';
    const flags = {
      pp: config.ppEnabled !== false,
      ltc: Boolean(config.ltcEnabled),
      pco: config.pcoEnabled !== false,
      modules: config.moduleTimersEnabled !== false,
    };

    const tileStreams = new Set();
    const providerStreams = new Set();
    /** source id → { id, kind, label, status, message, timers, updatedAt } */
    const views = new Map();
    let latest = emptyState(timerFont);
    let lastKey = '';
    let stopped = false;

    const orderedViews = () => [...views.values()].sort((a, b) => ((ORDER[a.id] ?? 10) - (ORDER[b.id] ?? 10)) || a.label.localeCompare(b.label));

    /** The tile state: every source, its health, its timers as of updatedAt. */
    function buildState() {
      return {
        serverNow: Date.now(),
        timerFont,
        sources: orderedViews().map((v) => ({ id: v.id, label: v.label, kind: v.kind, status: v.status, message: v.message, updatedAt: v.updatedAt, timers: v.timers })),
      };
    }

    /**
     * The provider snapshot (the module guide's contract): all enabled
     * sources merged, ids prefixed with their source so they stay unique,
     * every duration re-anchored to this snapshot's own instant.
     */
    function buildProviderSnapshot() {
      const now = Date.now();
      const timers = [];
      for (const v of orderedViews()) {
        for (const t of v.timers) {
          const out = { ...t, id: `${v.id}:${t.id}`, group: v.label };
          if (v.id === 'clock') out.status = { text: new Date(now).toISOString(), tone: 'ok' };
          if (t.state === 'running' && v.updatedAt > 0) {
            const dt = Math.max(0, now - v.updatedAt);
            if (out.elapsedMs !== null && out.elapsedMs !== undefined) out.elapsedMs += dt;
            if (out.remainingMs !== null && out.remainingMs !== undefined) out.remainingMs -= dt;
            if (out.ltc && Number.isFinite(out.ltc.ageMs)) out.ltc = { ...out.ltc, ageMs: out.ltc.ageMs + dt };
          }
          timers.push(out);
        }
      }
      return { source: SELF_ID, label: 'Timers', updatedAt: now, timers };
    }

    /** Recompute the merged state; broadcast only when something other than the clocks moved. */
    function rebuild() {
      if (stopped) return;
      latest = buildState();
      // updatedAt / serverNow move on every poll; the tiles extrapolate from
      // them but don't need a frame for that alone.
      let key;
      try {
        key = JSON.stringify(latest.sources.map((v) => [v.id, v.label, v.status, v.message, v.timers]));
      } catch {
        return;
      }
      if (key === lastKey) return;
      lastKey = key;
      if (tileStreams.size) writeAll(tileStreams, `event: state\ndata: ${JSON.stringify(latest)}\n\n`);
      if (providerStreams.size) writeAll(providerStreams, `event: timers\ndata: ${JSON.stringify(buildProviderSnapshot())}\n\n`);
    }

    const emitFor = (source) => (view) => {
      if (stopped) return;
      views.set(source.id, {
        id: source.id,
        kind: source.kind,
        label: String(view.label || source.label),
        status: view.status === 'ok' || view.status === 'connecting' || view.status === 'error' ? view.status : 'ok',
        message: String(view.message || ''),
        timers: Array.isArray(view.timers) ? view.timers : [],
        updatedAt: Number(view.updatedAt) || Date.now(),
      });
      rebuild();
    };

    // The fixed sources, each behind its admin switch. Add a platform here.
    const fixed = [];
    if (flags.pp) fixed.push(createProPresenterSource({ config, log }));
    else log('ProPresenter timers are off (admin switch)');
    if (flags.ltc) fixed.push(createLtcSource({ config, log, moduleDir: __dirname }));
    fixed.push(createClockSource());

    const discovery = createModuleDiscovery({
      shellPort,
      log,
      flags,
      onAdd(source) {
        source.start(emitFor(source));
      },
      onRemove(id) {
        views.delete(id);
        rebuild();
      },
    });

    for (const source of fixed) {
      try {
        source.start(emitFor(source));
      } catch (err) {
        log(`${source.id} failed to start: ${err.message}`);
      }
    }
    discovery.start();
    if (!flags.pco && !flags.modules) log('module timers are off (admin switches)');

    const heartbeat = setInterval(() => {
      writeAll(tileStreams, ': ping\n\n');
      writeAll(providerStreams, ': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    current = {
      tileStreams,
      providerStreams,
      getState: () => ({ ...latest, serverNow: Date.now() }),
      getProviderSnapshot: buildProviderSnapshot,
    };

    return {
      stop() {
        stopped = true;
        clearInterval(heartbeat);
        discovery.stop();
        for (const source of fixed) {
          try { source.stop(); } catch { /* already down */ }
        }
        for (const set of [tileStreams, providerStreams]) {
          for (const res of set) {
            try { res.end(); } catch { /* already gone */ }
          }
          set.clear();
        }
        if (current && current.tileStreams === tileStreams) current = null;
      },
      health() {
        const parts = [];
        let status = 'ok';
        const bump = (s) => {
          if (s === 'error') status = 'error';
          else if (s === 'connecting' && status === 'ok') status = 'connecting';
        };
        for (const source of fixed) {
          if (source.id === 'clock') continue;
          const h = source.health();
          parts.push(`${source.label}: ${h.message}`);
          bump(h.status);
        }
        if (!flags.pp) parts.push('ProPresenter: off');
        if (!flags.ltc) parts.push('LTC: off');
        const d = discovery.health();
        parts.push(...d.parts);
        bump(d.status);
        return { status, message: parts.join(' · ') };
      },
    };
  },

  /**
   * The Add-tile picker's entries: "All timers" plus one solo card per known
   * timer from any source (moduleApi.variant carries the entry id — 'all',
   * or 'solo:<source>:<timer id>'; the older 'timer:<uuid>' / 'ltc' ids keep
   * working). Answered from the merged state, never from upstream — the
   * picker must stay instant and a dead upstream must not stall it.
   */
  tiles() {
    const state = current ? current.getState() : null;
    if (!state) return [];
    const KIND_LABEL = { countdown: 'Countdown', elapsed: 'Elapsed timer', clock: 'Clock' };
    const oneCard = { defaultSize: { w: 3, h: 2 }, minSize: { w: 2, h: 1 } };
    const out = [{ id: 'all', name: 'All timers', description: 'Every timer, clock and timecode — choose which per tile' }];
    for (const src of state.sources) {
      for (const t of src.timers) {
        const what = src.id === 'ltc' ? 'Incoming timecode (HH:MM:SS:FF)' : src.id === 'clock' ? 'Time of day' : KIND_LABEL[t.kind] || 'Timer';
        out.push({ id: `solo:${src.id}:${t.id}`, name: t.label, description: `${src.label} · ${what}`, ...oneCard });
      }
    }
    return out;
  },

  routes() {
    return {
      'GET /state': (req, res) => {
        sendJson(res, 200, { state: current ? current.getState() : emptyState() });
      },

      'GET /stream': (req, res) => {
        const state = current ? current.getState() : emptyState();
        openSse(req, res, current ? current.tileStreams : null, `event: state\ndata: ${JSON.stringify(state)}\n\n`);
      },

      // ProdDash itself as a timers provider — the module guide's contract.
      'GET /timers': (req, res) => {
        sendJson(res, 200, current ? current.getProviderSnapshot() : emptyProvider());
      },

      'GET /timers/stream': (req, res) => {
        const snap = current ? current.getProviderSnapshot() : emptyProvider();
        openSse(req, res, current ? current.providerStreams : null, `event: timers\ndata: ${JSON.stringify(snap)}\n\n`);
      },

      // The admin device picker asks this machine what it can hear. The
      // options shape matches the admin select's optionsRoute contract.
      'GET /ltc/devices': (req, res) => {
        const bin = path.join(__dirname, 'ltc-capture');
        const child = spawn(bin, ['--list'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 4000 });
        let err = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (t) => { err += t; });
        child.on('error', () => {
          sendJson(res, 200, { options: [], error: 'LTC capture tool missing — see modules/propresenter-timers/ltc-capture.swift' });
        });
        child.on('exit', () => {
          if (res.writableEnded) return;
          const options = [];
          for (const line of err.split('\n')) {
            const m = line.match(/^ltc-capture:\s+(.*?)\s+(\d+) ch\s+(\d+) Hz\s+uid=/);
            if (m) options.push({ value: m[1], label: `${m[1]} — ${m[2]} ch @ ${(Number(m[3]) / 1000)} kHz` });
          }
          sendJson(res, 200, { options });
        });
      },
    };
  },
};
