'use strict';

/**
 * ProPresenter Timers — server part.
 *
 * Polls the ProPresenter openAPI for the configured timer list, the live
 * timer values, and (when the connected build exposes it) LTC timecode, and
 * fans one merged state object out to every tile over SSE. Browsers never
 * talk to ProPresenter directly.
 *
 *   GET /state   → { state: <state> }   (instant paint for new tiles)
 *   GET /stream  → SSE, `state` events  (change-detected, heartbeated)
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
 *   GET /v1/timecode/status → NOT in the published spec. The spec (fetched
 *     2026-08, 0 mentions of "timecode", not in the /v1/status/updates
 *     allowlist either) documents no timecode/LTC route at all — verified
 *     live: ProPresenter 21.4 returns 404. We probe this candidate route
 *     once per connection anyway so a future ProPresenter that adds it
 *     lights up without a module update.
 *
 * Because the HTTP API has no timecode, LTC actually comes from the classic
 * stage-display websocket (see stage-ws.js): a stage layout field labeled
 * "LTC" streams its text to us. Source precedence: the HTTP route if it ever
 * answers (authoritative), else the stage field, else "not available".
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

const { createStageLtcClient } = require('./stage-ws');

/** Set by init(), read by the routes — both are rebuilt together on remount. */
let current = null;

function clearedState(enabled) {
  return {
    enabled,
    reachable: false,
    lastError: '',
    timers: [],
    // supported: null = no verdict yet (probing, or ProPresenter
    // unreachable); true once a timecode source is live; false when both
    // sources came up empty (note says why, when we know).
    ltc: { supported: null, time: '', receiving: false, source: '', note: '' },
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

    let latest = clearedState(enabled);
    let lastFrame = '';
    let stopped = false;
    let pollTimer = null;
    let tick = 0;

    /** uuid → { name, index, type, allowsOverrun } from /v1/timers, in list order. */
    let timerConfigs = new Map();
    /** null = probe /v1/timecode/status on the next reachable tick. */
    let ltcSupported = null;
    let ltcLast = { time: '', receiving: false };
    /** Live view of the stage-display websocket's LTC field (stage-ws.js). */
    let stageLtc = { bound: false, time: '', receiving: false, note: '' };

    /** One LTC verdict from both sources: HTTP route wins if it ever
        answers (authoritative), else the stage-display field. */
    function composeLtc() {
      if (ltcSupported === true) {
        return { supported: true, source: 'api', time: ltcLast.time, receiving: ltcLast.receiving, note: '' };
      }
      if (stageLtc.bound) {
        return { supported: true, source: 'stage', time: stageLtc.time, receiving: stageLtc.receiving, note: '' };
      }
      if (ltcSupported === null && !stageLtc.note) {
        return { supported: null, source: '', time: '', receiving: false, note: '' };
      }
      return { supported: false, source: '', time: '', receiving: false, note: stageLtc.note || '' };
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

    /**
     * Liberal parse of a hypothetical timecode-status body (no spec documents
     * its shape — see the header comment). Looks for an "HH:MM:SS:FF"-shaped
     * string and a receiving/running boolean under likely key names.
     */
    function parseLtc(body) {
      const out = { time: '', receiving: false };
      if (!body || typeof body !== 'object') return out;
      const TC = /^-?\d{1,2}:\d{2}:\d{2}[:;.]\d{1,3}$/;
      for (const key of ['time', 'timecode', 'current_time', 'value']) {
        if (typeof body[key] === 'string' && TC.test(body[key])) {
          out.time = body[key];
          break;
        }
      }
      if (!out.time) {
        for (const value of Object.values(body)) {
          if (typeof value === 'string' && TC.test(value)) {
            out.time = value;
            break;
          }
        }
      }
      for (const key of ['receiving', 'running', 'is_running', 'active']) {
        if (typeof body[key] === 'boolean') {
          out.receiving = body[key];
          break;
        }
      }
      return out;
    }

    async function pollLtc() {
      // A 404 verdict is retried once a minute — an endpoint appearing
      // without an unreachable spell (ProPresenter hot-swapped in testing,
      // or some future in-place upgrade) must not stay invisible forever.
      if (ltcSupported === false && tick % 120 !== 0) return;
      try {
        const body = await requestJson('/v1/timecode/status');
        if (ltcSupported === null) log('timecode endpoint answered — LTC card is live');
        ltcSupported = true;
        ltcLast = parseLtc(body);
      } catch (err) {
        // 404 = this ProPresenter has no timecode API (the expected case, as
        // of API v1). Anything else is a real failure — let the tick handle it.
        if (err && err.status === 404) {
          ltcSupported = false;
          ltcLast = { time: '', receiving: false };
          return;
        }
        throw err;
      }
    }

    function broadcast() {
      latest = {
        enabled,
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
        // Probe timecode once per connection; poll it only when it exists.
        await pollLtc();
        latest.timers = mergeTimers(currentTimes);
        latest.reachable = true;
        latest.lastError = '';
      } catch (err) {
        latest.reachable = false;
        latest.lastError = err instanceof Error ? err.message : String(err);
        // Re-probe timecode after a reconnect — the unreachable spell may
        // have been a ProPresenter upgrade or a different machine.
        ltcSupported = null;
        ltcLast = { time: '', receiving: false };
      }
      broadcast();
      if (stopped) return;
      pollTimer = setTimeout(pollTick, latest.reachable ? POLL_MS : RETRY_MS);
    }

    let stageClient = null;
    if (enabled) {
      pollTick();
      log(`polling timers on ${host}:${port}`);
      stageClient = createStageLtcClient({
        host,
        port,
        password: String(config.stagePassword || ''),
        log,
        // The HTTP poller knows every configured timer's uuid — anything
        // else streaming timecode-shaped text can be heuristically bound.
        isTimerUid: (uid) => timerConfigs.has(uid),
        onUpdate(update) {
          stageLtc = update;
          broadcast();
        },
      });
    } else {
      log('no ProPresenter host configured — set one in /admin');
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
        stageClient?.stop();
        for (const res of streams) {
          try { res.end(); } catch { /* already gone */ }
        }
        streams.clear();
        if (current && current.streams === streams) current = null;
      },
      health() {
        if (!enabled) return { status: 'error', message: 'No ProPresenter host configured' };
        if (latest.reachable) {
          const ltc = latest.ltc;
          const ltcNote = ltc.supported
            ? (ltc.source === 'stage' ? ', LTC via stage display' : ', LTC via API')
            : (ltc.note ? ` (${ltc.note})` : '');
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
    if (!state || !state.enabled) return []; // unconfigured → classic single entry
    const TYPE_LABEL = {
      countdown: 'Countdown timer',
      countdown_to_time: 'Countdown to a time of day',
      elapsed: 'Elapsed timer',
      unknown: 'Timer',
    };
    const oneCard = { defaultSize: { w: 3, h: 2 }, minSize: { w: 2, h: 1 } };
    return [
      { id: 'all', name: 'All timers', description: 'Every timer and the LTC timecode, selectable per tile' },
      ...state.timers.map((t) => ({
        id: `timer:${t.uuid}`,
        name: t.name,
        description: TYPE_LABEL[t.type] || 'Timer',
        ...oneCard,
      })),
      { id: 'ltc', name: 'LTC timecode', description: 'Incoming timecode (HH:MM:SS:FF)', ...oneCard },
    ];
  },

  routes() {
    return {
      'GET /state': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ state: current ? current.getLatest() : clearedState(false) }));
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
