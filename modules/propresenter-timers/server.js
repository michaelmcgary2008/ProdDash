'use strict';

/**
 * ProPresenter Timers — server part.
 *
 * Polls the ProPresenter openAPI for the configured timer list and the live
 * timer values, decodes LTC timecode from an audio input, and fans one
 * merged state object out to every tile over SSE. Browsers never talk to
 * ProPresenter or the audio hardware directly.
 *
 *   GET /state        → { state: <state> }   (instant paint for new tiles)
 *   GET /stream       → SSE, `state` events  (change-detected, heartbeated)
 *   GET /ltc/devices  → this machine's audio input devices, for the admin
 *                       page's device picker (select + optionsRoute).
 *
 * Endpoints used, verified against openapi.propresenter.com (API v1):
 *   GET /v1/timers          → [ { id:{uuid,name,index}, allows_overrun,
 *                                 countdown:{duration} | count_down_to_time:{time_of_day,period}
 *                                 | elapsed:{start_time,end_time} } ]
 *   GET /v1/timers/current  → [ { id:{uuid,name,index}, time:"HH:MM:SS", state } ]
 *     `time` may be negative ("-00:00:02") while overrunning, and some builds
 *     append hundredths ("00:00:01.00" appears in the spec's schema example).
 *     `state` enum is stopped|running|complete|overrunning|overran — but the
 *     spec's own response example says "overrun", so treat anything containing
 *     "overr" as overrun. The API exposes NO per-timer color anywhere.
 *
 * LTC: ProPresenter exposes no timecode over any API (the HTTP openAPI has
 * no timecode route, and the classic stage-display websocket drops the
 * field — both verified dead on ProPresenter 21.4), so LTC is read from the
 * audio signal itself. Behind the admin "LTC listener" switch: off means no
 * LTC tile in the picker and nothing captured; on, the built-in listener
 * (ltc-listener.js) captures the admin-selected device/channel and decodes
 * in-process. It is the module's one and only LTC source.
 *
 * ProPresenter's built-in HTTP server is easily overwhelmed (see the hot-path
 * notes in ../propresenter-now-next/propresenter-core). So: requests run
 * strictly sequentially, the next tick is scheduled only after the previous
 * one finished, live values are the only every-tick call, and the timer list
 * rides a slow lane. The endpoints do offer `?chunked` streaming, but polling
 * matches how propresenter-core survives real-world ProPresenter quirks.
 */

/** Hot-path cadence — live timer values. */
const POLL_MS = 500;
/** Backoff while ProPresenter is unreachable. */
const RETRY_MS = 2500;
/** The configured-timer list refreshes every Nth tick (~2s at 500ms). */
const SLOW_EVERY = 4;
/** Abort a hung request well before it can stall the loop for good. */
const REQUEST_TIMEOUT_MS = 4000;
/** SSE comment ping cadence — keeps idle connections alive through sleepy Wi-Fi. */
const HEARTBEAT_MS = 15000;

const { spawn } = require('child_process');
const { createLtcListener } = require('./ltc-listener');

/** Set by init(), read by the routes — both are rebuilt together on remount. */
let current = null;

function clearedState(enabled, ltcEnabled = false, timerFont = 'default') {
  return {
    enabled,
    ltcEnabled,
    timerFont,
    reachable: false,
    lastError: '',
    timers: [],
    // supported true once the listener has a verdict; false when the
    // listener is off, has no device, or its capture failed (note says
    // why). status is running|stopped|nosignal; while running, ageMs lets
    // clients count frames locally between updates.
    ltc: { supported: false, time: '', receiving: false, status: '', fps: 0, df: false, source: '', note: '' },
  };
}

module.exports = {
  init({ config, log }) {
    const streams = new Set();
    // Endpoint config. Legacy flat host/port keys (saved before the endpoint
    // field existed) can only still be present until the admin form is
    // re-saved, so when they exist they win over the endpoint's default.
    const ep = config.propresenter && typeof config.propresenter === 'object' ? config.propresenter : {};
    const host = String(config.host ?? ep.host ?? '');
    const port = Number(config.port ?? ep.port) || 1025;
    const password = String(config.password || '');
    const enabled = Boolean(host && port);
    const ltcEnabled = Boolean(config.ltcEnabled);
    const ltcDevice = String(config.ltcDevice || '');
    const ltcChannel = Math.max(1, Math.trunc(Number(config.ltcChannel)) || 1);
    const timerFont = config.timerFont === 'monospace' ? 'monospace' : 'default';

    let latest = clearedState(enabled, ltcEnabled, timerFont);
    let lastFrame = '';
    let stopped = false;
    let pollTimer = null;
    let tick = 0;

    /** uuid → { name, index, type, allowsOverrun } from /v1/timers, in list order. */
    let timerConfigs = new Map();
    /** Built-in listener's latest word: { state, time, fps, df, ageMs } | { error }. */
    let listenerLtc = null;

    /** The LTC verdict — the built-in listener is the only source. */
    function composeLtc() {
      if (!ltcEnabled) {
        return { supported: false, source: '', time: '', receiving: false, status: '', fps: 0, df: false, note: 'LTC listener disabled' };
      }
      if (!listenerLtc) {
        return { supported: false, source: '', time: '', receiving: false, status: '', fps: 0, df: false, note: 'Starting LTC listener…' };
      }
      if (listenerLtc.error) {
        return { supported: false, source: '', time: '', receiving: false, status: '', fps: 0, df: false, note: listenerLtc.error };
      }
      const running = listenerLtc.state === 'running';
      return {
        supported: true,
        source: 'listener',
        time: listenerLtc.time,
        receiving: running,
        status: listenerLtc.state,
        fps: listenerLtc.fps,
        df: listenerLtc.df,
        // While running: how old this timecode is, so clients can pin the
        // anchor to their own clock and count frames between updates.
        ...(running && Number.isFinite(listenerLtc.ageMs) ? { ageMs: Math.max(0, listenerLtc.ageMs) } : {}),
        note: '',
      };
    }

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

    function timerType(entry) {
      if (entry.countdown) return 'countdown';
      if (entry.count_down_to_time) return 'countdown_to_time';
      if (entry.elapsed) return 'elapsed';
      return 'unknown';
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
          type: timerType(entry),
          allowsOverrun: Boolean(entry.allows_overrun),
        });
      }
      timerConfigs = next;
    }

    /** Merge configured timers (order, type) with live values into one list. */
    function mergeTimers(currentTimes) {
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
        const now = live.get(uuid);
        live.delete(uuid);
        out.push({
          uuid,
          name: (now && now.name) || cfg.name,
          type: cfg.type,
          allowsOverrun: cfg.allowsOverrun,
          time: now ? now.time : '',
          state: now ? now.state : '',
        });
      }
      // Timers reported live but missing from the (possibly stale) config
      // list still deserve a card — type unknown until the slow lane catches up.
      for (const [uuid, now] of live) {
        out.push({ uuid, name: now.name || 'Timer', type: 'unknown', allowsOverrun: false, time: now.time, state: now.state });
      }
      return out;
    }

    function broadcast() {
      latest = {
        enabled,
        ltcEnabled,
        timerFont,
        reachable: latest.reachable,
        lastError: latest.lastError,
        timers: latest.timers,
        ltc: composeLtc(),
      };
      if (!streams.size) return;
      let frame;
      try {
        frame = JSON.stringify(latest);
      } catch {
        return;
      }
      if (frame === lastFrame) return;
      lastFrame = frame;
      const payload = `event: state\ndata: ${frame}\n\n`;
      for (const res of streams) {
        try {
          res.write(payload);
        } catch {
          streams.delete(res);
        }
      }
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
        latest.timers = mergeTimers(currentTimes);
        latest.reachable = true;
        latest.lastError = '';
      } catch (err) {
        latest.reachable = false;
        latest.lastError = err instanceof Error ? err.message : String(err);
      }
      broadcast();
      if (stopped) return;
      pollTimer = setTimeout(pollTick, latest.reachable ? POLL_MS : RETRY_MS);
    }

    if (enabled) {
      pollTick();
      log(`polling timers on ${host}:${port}`);
    } else {
      log('no ProPresenter host configured — set one in /admin');
    }

    // The built-in listener is independent of ProPresenter — LTC-only
    // setups (no host configured) still get the LTC card.
    let ltcListener = null;
    if (ltcEnabled) {
      if (ltcDevice) {
        ltcListener = createLtcListener({
          device: ltcDevice,
          channel: ltcChannel,
          moduleDir: __dirname,
          log,
          onUpdate(update) {
            listenerLtc = update;
            broadcast();
          },
        });
      } else {
        listenerLtc = { error: 'LTC listener is on but no audio device is selected — pick one in Admin' };
        broadcast();
      }
    }

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

    current = { streams, getLatest: () => latest };

    return {
      stop() {
        stopped = true;
        clearTimeout(pollTimer);
        clearInterval(heartbeat);
        ltcListener?.stop();
        for (const res of streams) {
          try { res.end(); } catch { /* already gone */ }
        }
        streams.clear();
        if (current && current.streams === streams) current = null;
      },
      health() {
        // LTC status suffix for the admin health line.
        const ltcNote = !ltcEnabled
          ? ''
          : latest.ltc.supported
            ? `, LTC ${latest.ltc.status}`
            : (latest.ltc.note ? ` (LTC: ${latest.ltc.note})` : '');
        if (!enabled) {
          // The LTC listener works regardless of ProPresenter — an
          // LTC-only setup is half-configured but working.
          if (latest.ltc.supported) return { status: 'ok', message: `No ProPresenter host configured — LTC only, ${latest.ltc.status}` };
          return { status: 'error', message: 'No ProPresenter host configured' };
        }
        if (latest.reachable) {
          return { status: 'ok', message: `Polling ${host}:${port}, ${latest.timers.length} timer(s)${ltcNote}` };
        }
        return {
          status: 'error',
          message: latest.lastError
            ? `ProPresenter unreachable: ${latest.lastError}`
            : 'Trying to reach ProPresenter…',
        };
      },
    };
  },

  /**
   * The Add-tile picker's entries: one per discovered timer, plus "All
   * timers" and the LTC card (moduleApi.variant carries the entry id —
   * 'all', 'timer:<uuid>' or 'ltc'). Answered from the poller's latest
   * state, never from a fresh upstream request — the picker must stay
   * instant, and a dead ProPresenter must not stall it.
   */
  tiles() {
    const state = current ? current.getLatest() : null;
    if (!state || (!state.enabled && !state.ltcEnabled)) return []; // unconfigured → classic single entry
    const TYPE_LABEL = {
      countdown: 'Countdown timer',
      countdown_to_time: 'Countdown to a time of day',
      elapsed: 'Elapsed timer',
      unknown: 'Timer',
    };
    const oneCard = { defaultSize: { w: 3, h: 2 }, minSize: { w: 2, h: 1 } };
    return [
      {
        id: 'all',
        name: 'All timers',
        description: state.ltcEnabled
          ? 'Every timer and the LTC timecode, selectable per tile'
          : 'Every timer, selectable per tile',
      },
      ...state.timers.map((t) => ({
        id: `timer:${t.uuid}`,
        name: t.name,
        description: TYPE_LABEL[t.type] || 'Timer',
        ...oneCard,
      })),
      // The LTC entry exists only while the admin switch is on.
      ...(state.ltcEnabled
        ? [{ id: 'ltc', name: 'LTC timecode', description: 'Incoming timecode (HH:MM:SS:FF)', ...oneCard }]
        : []),
    ];
  },

  routes() {
    const sendJson = (res, code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    return {
      'GET /state': (req, res) => {
        sendJson(res, 200, { state: current ? current.getLatest() : clearedState(false) });
      },

      // The admin device picker asks this machine what it can hear. The
      // options shape matches the admin select's optionsRoute contract.
      'GET /ltc/devices': (req, res) => {
        const bin = require('path').join(__dirname, 'ltc-capture');
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

      'GET /stream': (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        const state = current ? current.getLatest() : clearedState(false);
        res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
        if (!current) return void res.end();
        const { streams } = current;
        // A viewer that stops reading (locked tablet, sleeping laptop) must
        // not queue frames forever; keepalive probes make the OS notice.
        try { req.socket.setKeepAlive(true, 15000); } catch { /* gone */ }
        streams.add(res);
        req.on('close', () => streams.delete(res));
      },
    };
  },
};
