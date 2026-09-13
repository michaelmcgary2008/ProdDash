'use strict';

/**
 * PCO Plan — server part.
 *
 * Owns the one Planning Center Services connection, keeps the current plan
 * (order of service) for the configured service type in memory, and fans it
 * out to every tile over SSE. Browsers never talk to Planning Center.
 *
 *   GET  /state    → { state, now }        (instant paint for new tiles)
 *   GET  /stream   → SSE, `state` events   (change-detected, heartbeated)
 *   POST /refresh  → re-read the plan now
 *   GET  /service-types → { options } for the admin "Service type" select,
 *                         grouped by Planning Center folder path
 *   GET  /plans?serviceTypeId=… → { options } for the admin "Plan" select
 *   GET  /documents → { options } for the admin start / end document selects
 *                     (documents ProPresenter has shown or lists — see below)
 *   GET  /timers        → snapshot for the Timers module (guide: "Offering
 *   GET  /timers/stream → SSE, `timers` events   timers to the Timers module")
 *
 * Planning Center API v2 (https://api.planningcenteronline.com/services/v2):
 *   Auth: Personal Access Token (HTTP Basic client_id:secret) or an OAuth 2.0
 *   bearer token. Responses are JSON:API — `data`, `included`, `links.next`.
 *   GET /folders, /service_types                       (setup browsing)
 *   GET /service_types/{st}/plans?filter=future|past   (pick the plan)
 *   GET /service_types/{st}/plans/{id}                 (title, dates…)
 *   GET …/plans/{id}/plan_times                        (service start times)
 *   GET …/plans/{id}/items?include=song,arrangement,item_notes
 *
 * Following ProPresenter: instead of talking to ProPresenter a second time,
 * this module reads the propresenter-now-next module's own SSE feed over
 * loopback (/api/modules/propresenter-now-next/stream, on shell.port) and
 * matches the live presentation name to a plan item. Item start/end
 * timestamps are tracked here, once, so every tile agrees on the runtime.
 *
 * Service timing: a plan's services (9:00, 11:00…) take turns owning the
 * service clock — the rules live in service-timing.js. A service starts at
 * its scheduled time, or (admin "Service timing") when a chosen ProPresenter
 * document goes live, and ends when the chosen end document goes live, with
 * schedule failsafes for both. The result is offered to the Timers module as
 * three timers: the service, the current item and the countdown to the
 * service.
 *
 * PCO_PLAN_API_BASE=http://127.0.0.1:24700 points the module at
 * tools/pco-mock.js for development.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MATCH_THRESHOLD, similarity } = require('./matching');
const {
  MINUTE,
  serviceTimes,
  serviceWindows,
  selectService,
  freshService,
  advance,
  fmtTime,
} = require('./service-timing');

const DEFAULT_API_BASE = 'https://api.planningcenteronline.com';
const API_BASE = String(process.env.PCO_PLAN_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
const SERVICES = '/services/v2';

/** Abort a hung Planning Center request well before the poll cadence. */
const REQUEST_TIMEOUT_MS = 12000;
/** Fastest allowed plan re-read (PCO rate limit is 100 requests / 20 s per app). */
const MIN_POLL_S = 10;
/** Backoff after a failed plan read. */
const RETRY_MS = 15000;
/** SSE comment ping cadence — keeps idle connections alive through sleepy Wi-Fi. */
const HEARTBEAT_MS = 15000;
/** The Now/Next module whose feed we follow. */
const NOW_NEXT_ID = 'propresenter-now-next';
const NOW_NEXT_RETRY_MS = 3000;
const NOW_NEXT_MISSING_RETRY_MS = 15000;
/** How many distinct documents seen live are remembered for the admin selects. */
const SEEN_DOCUMENTS_MAX = 200;
/**
 * Service timer tone (the Timers module colours by it): running behind the
 * plan — completed items over their planned length, plus the current item's
 * overrun — by BEHIND_WARN_MS is `warn`, by BEHIND_DANGER_MS `danger`; past
 * the planned total length is `warn`, by more than BEHIND_DANGER_MS `danger`.
 */
const BEHIND_WARN_MS = 2 * MINUTE;
const BEHIND_DANGER_MS = 5 * MINUTE;

/** Set by init(), read by the routes — both are rebuilt together on remount. */
let current = null;

/* ── small helpers ──────────────────────────────────────────────────── */

function clearedState() {
  return {
    configured: false,     // credentials present
    serviceTypeSet: false, // a service type is chosen
    reachable: false,      // last Planning Center read succeeded
    lastError: '',
    lastFetched: 0,
    apiBase: API_BASE,
    serviceType: { id: '', name: '' },
    plan: null,
    items: [],
    live: clearedLive(),
    service: clearedService(),
    timing: null,          // the admin's service-timing choices (no secrets)
  };
}

function clearedLive() {
  return {
    following: false,     // admin switch on
    available: false,     // Now/Next feed reachable
    reason: '',           // why not available
    ppEnabled: false,
    ppReachable: false,
    activeName: '',       // what ProPresenter has live right now
    matched: false,       // activeName maps to a plan item
    currentItemId: '',
    currentScore: 0,
    serviceStartedAt: 0,  // the service's actual start, ms epoch (0 until it starts)
    serviceEndedAt: 0,    // …and its end, once it has one
    history: {},          // itemId → { startedAt, endedAt }
  };
}

/** The service that owns the clock, as tiles and the timers see it. */
function clearedService() {
  return {
    id: '',
    phase: 'none',        // 'none' (no plan / no services) | 'idle' | 'running' | 'stopped'
    startedAt: 0,
    endedAt: 0,
    startTrigger: '',
    endTrigger: '',
    cue: '',
    name: '',
    label: '',
    index: -1,
    count: 0,
    startsAt: 0,
    endsAt: 0,
    windowFrom: 0,
    windowUntil: 0,
  };
}

/**
 * Fallback for a shell that does not hand us its port (init() without
 * `shell`, i.e. ProdDash before 1.4.0): guess the way the shell decides —
 * PORT env, then this machine's proddash.json in the data directory, then the
 * checked-in config/proddash.json, then 24500 — and correct the guess from
 * the Host header of the first request that reaches a route (see learnPort).
 */
function guessShellPort() {
  const env = Number(process.env.PORT);
  if (env) return env;
  const home = os.homedir();
  const fromEnv = String(process.env.PRODDASH_DATA_DIR || '').trim();
  const root = path.join(__dirname, '..', '..');
  const dataDir = fromEnv
    ? path.resolve(root, fromEnv)
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ProdDash')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'ProdDash')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'proddash');
  for (const file of [path.join(dataDir, 'proddash.json'), path.join(root, 'config', 'proddash.json')]) {
    try {
      const port = Number(JSON.parse(fs.readFileSync(file, 'utf8')).port);
      if (port) return port;
    } catch { /* try the next one */ }
  }
  return 24500;
}

/** Port a browser used to reach us, from a Host header ("10.3.8.41:24500"). */
function portFromHost(hostHeader) {
  const m = /:(\d+)$/.exec(String(hostHeader || '').trim());
  if (m) return Number(m[1]) || 0;
  return hostHeader ? 80 : 0;
}

function localYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** "1:02:03" / "4:05" for a duration in ms (for logs and status lines). */
function fmtDur(ms) {
  const s = Math.max(0, Math.round(Math.abs(Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/* ── Planning Center client ─────────────────────────────────────────── */

function createPcoClient(config) {
  const token = String(config.accessToken || '').trim();
  const appId = String(config.appId || '').trim();
  const secret = String(config.secret || '');
  let auth = '';
  if (token) auth = `Bearer ${token}`;
  else if (appId && secret) auth = 'Basic ' + Buffer.from(`${appId}:${secret}`).toString('base64');

  async function get(target, params) {
    const url = new URL(/^https?:\/\//.test(target) ? target : API_BASE + target);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    let response;
    try {
      response = await fetch(url, {
        headers: { Authorization: auth, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const e = new Error(`Planning Center unreachable: ${err?.message || err}`);
      e.network = true;
      throw e;
    }
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        detail = body?.errors?.[0]?.detail || body?.errors?.[0]?.title || '';
      } catch { /* no JSON body */ }
      const e = new Error(
        response.status === 401
          ? 'Planning Center rejected the credentials (401)'
          : `Planning Center ${response.status}${detail ? `: ${detail}` : ''}`
      );
      e.status = response.status;
      if (response.status === 429) e.retryAfter = Number(response.headers.get('retry-after')) || 10;
      throw e;
    }
    return response.json();
  }

  /** Follow JSON:API `links.next` until the collection is complete. */
  async function getAll(target, params) {
    const data = [];
    const included = [];
    let url = target;
    let query = { per_page: 100, ...(params || {}) };
    for (let page = 0; page < 30; page += 1) {
      const body = await get(url, query);
      if (Array.isArray(body?.data)) data.push(...body.data);
      if (Array.isArray(body?.included)) included.push(...body.included);
      const next = body?.links?.next;
      if (!next) break;
      url = next;
      query = {}; // `next` already carries the query string
    }
    return { data, included };
  }

  return { configured: Boolean(auth), method: token ? 'oauth' : 'pat', get, getAll };
}

/* ── plan shaping ───────────────────────────────────────────────────── */

/** Scheduled start of every item from the chosen service start time. */
function scheduleItems(items, serviceStartMs) {
  for (const item of items) item.startsAt = 0;
  if (!serviceStartMs) return;
  let t = serviceStartMs;
  for (const item of items) {
    if (item.servicePosition !== 'during') continue;
    item.startsAt = t;
    t += (item.length || 0) * 1000;
  }
  // Post-service items run on from the end of the service…
  for (const item of items) {
    if (item.servicePosition !== 'post') continue;
    item.startsAt = t;
    t += (item.length || 0) * 1000;
  }
  // …and pre-service items are counted backwards to end at the service start.
  let back = serviceStartMs;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.servicePosition !== 'pre') continue;
    back -= (item.length || 0) * 1000;
    item.startsAt = back;
  }
}

/** Planned length of the service proper (the "during" items), ms. */
function plannedLengthMs(items) {
  return (items || [])
    .filter((it) => it.servicePosition === 'during')
    .reduce((sum, it) => sum + (Number(it.length) || 0) * 1000, 0);
}

function shapeItems(itemsBody) {
  const included = new Map();
  for (const rec of itemsBody.included || []) included.set(`${rec.type}/${rec.id}`, rec);
  const rel = (item, name) => item?.relationships?.[name]?.data;
  const items = (itemsBody.data || []).map((it) => {
    const a = it.attributes || {};
    const songRef = rel(it, 'song');
    const song = songRef ? included.get(`Song/${songRef.id}`) : null;
    const arrRef = rel(it, 'arrangement');
    const arrangement = arrRef ? included.get(`Arrangement/${arrRef.id}`) : null;
    const noteRefs = Array.isArray(rel(it, 'item_notes')) ? rel(it, 'item_notes') : [];
    const notes = noteRefs
      .map((ref) => included.get(`ItemNote/${ref.id}`))
      .filter(Boolean)
      .map((n) => ({
        category: String(n.attributes?.category_name || ''),
        content: String(n.attributes?.content || '').trim(),
      }))
      .filter((n) => n.content);
    return {
      id: String(it.id),
      sequence: Number(a.sequence) || 0,
      title: String(a.title || '').trim(),
      itemType: String(a.item_type || 'item'),
      length: Number(a.length) || 0,
      servicePosition: String(a.service_position || 'during'),
      description: String(a.description || '').trim(),
      keyName: String(a.key_name || '').trim(),
      song: song
        ? {
            title: String(song.attributes?.title || ''),
            author: String(song.attributes?.author || ''),
            ccli: song.attributes?.ccli_number ? String(song.attributes.ccli_number) : '',
          }
        : null,
      arrangement: arrangement ? String(arrangement.attributes?.name || '') : '',
      notes,
      startsAt: 0,
    };
  });
  items.sort((x, y) => x.sequence - y.sequence);
  return items;
}

function shapePlan(planRec, serviceTypeId, planTimes) {
  const a = planRec?.attributes || {};
  return {
    id: String(planRec?.id || ''),
    serviceTypeId: String(serviceTypeId),
    title: String(a.title || '').trim(),
    seriesTitle: String(a.series_title || '').trim(),
    dates: String(a.dates || '').trim(),
    shortDates: String(a.short_dates || '').trim(),
    sortDate: a.sort_date ? Date.parse(a.sort_date) || 0 : 0,
    totalLength: Number(a.total_length) || 0,
    itemsCount: Number(a.items_count) || 0,
    url: String(a.planning_center_url || ''),
    planTimes,
    serviceStartsAt: 0,
    serviceEndsAt: 0,
    serviceName: '',
  };
}

/** "9:00 service" / "9:00 First Service" — how a service is named in details and logs. */
function serviceLabel(win) {
  if (!win || !win.startsAt) return '';
  const name = String(win.name || '').trim();
  return `${fmtTime(win.startsAt)} ${name && !/^service$/i.test(name) ? name : 'service'}`;
}

/** What /timers answers while the module is not running. */
function emptyTimers(now) {
  return { source: 'pco-plan', label: 'PCO Plan', updatedAt: now, timers: [] };
}

/* ── the module ─────────────────────────────────────────────────────── */

module.exports = {
  init({ config, log, shell }) {
    const streams = new Set();       // /stream clients (tiles)
    const timerStreams = new Set();  // /timers/stream clients (the Timers module)
    const pco = createPcoClient(config);
    const serviceTypeId = String(config.serviceTypeId || '').trim();
    const pinnedPlanId = String(config.planId || '').trim();
    const pollMs = Math.max(MIN_POLL_S, Number(config.pollSeconds) || 30) * 1000;
    const follow = config.followProPresenter !== false;

    // Service timing choices (admin "Service timing"). A blank number field
    // reaches us as 0, which is a legitimate choice; an absent one as the
    // schema default.
    const minutes = (value, dflt, max) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 && value !== undefined && value !== null && value !== ''
        ? Math.min(max, n)
        : dflt;
    };
    const triggersOn = Boolean(config.useDocumentTriggers);
    const startDocument = triggersOn ? String(config.serviceStartDocument || '').trim() : '';
    const endDocument = triggersOn ? String(config.serviceEndDocument || '').trim() : '';
    const wantsDocumentStart = triggersOn && String(config.serviceStartTrigger || 'schedule') === 'document';
    const timing = {
      preRollMs: minutes(config.preRollMinutes, 30, 240) * MINUTE,
      startGraceMs: minutes(config.startGraceMinutes, 10, 120) * MINUTE,
      triggersOn,
      startMode: wantsDocumentStart && startDocument ? 'document' : 'schedule',
      startDocument,
      endDocument,
    };
    const serviceOpts = {
      startMode: timing.startMode,
      startDocument: timing.startDocument,
      endDocument: timing.endDocument,
      startGraceMs: timing.startGraceMs,
    };
    // Document cues need the ProPresenter feed even when the tiles don't follow it.
    const wantFeed = follow || triggersOn;

    let state = clearedState();
    state.configured = pco.configured;
    state.serviceTypeSet = Boolean(serviceTypeId);
    state.serviceType = { id: serviceTypeId, name: '' };
    state.live.following = follow;
    state.timing = { ...timing };

    let stopped = false;
    let pollTimer = null;
    let inFlight = null;
    let lastFrame = '';
    let lastTimersSig = '';

    /* — broadcasting — */

    function frameOf() {
      return JSON.stringify(state);
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

    function broadcast(force) {
      const frame = frameOf();
      if (!force && frame === lastFrame) return;
      lastFrame = frame;
      if (!streams.size) return;
      writeAll(streams, `event: state\ndata: ${JSON.stringify({ state, now: Date.now() })}\n\n`);
    }

    /**
     * The timers change "structurally" far less often than their displayed
     * value does (the consumer extrapolates from startedAt), so a frame goes
     * out only when something other than the running values changed.
     */
    function timersSignature(snap) {
      return JSON.stringify(snap.timers.map((t) => [t.id, t.state, t.startedAt, t.targetMs, t.status, t.detail]));
    }

    function broadcastTimers(force) {
      const snap = timersSnapshot(Date.now());
      const sig = timersSignature(snap);
      if (!force && sig === lastTimersSig) return;
      lastTimersSig = sig;
      if (!timerStreams.size) return;
      writeAll(timerStreams, `event: timers\ndata: ${JSON.stringify(snap)}\n\n`);
    }

    /* — plan reading — */

    function planPath(planId) {
      return `${SERVICES}/service_types/${encodeURIComponent(serviceTypeId)}/plans/${encodeURIComponent(planId)}`;
    }

    /** The plans around now for a service type: a few upcoming, a few recent, oldest first. */
    async function listPlans(stId, { future = 5, past = 3 } = {}) {
      const base = `${SERVICES}/service_types/${encodeURIComponent(stId)}/plans`;
      const [fut, pst] = await Promise.all([
        pco.get(base, { filter: 'future', order: 'sort_date', per_page: future }),
        pco.get(base, { filter: 'past', order: '-sort_date', per_page: past }),
      ]);
      const byId = new Map();
      for (const rec of [...(fut?.data || []), ...(pst?.data || [])]) {
        const sortDate = Date.parse(rec?.attributes?.sort_date || '');
        if (!rec?.id || !Number.isFinite(sortDate)) continue;
        byId.set(String(rec.id), { rec, sortDate });
      }
      return Array.from(byId.values()).sort((x, y) => x.sortDate - y.sortDate);
    }

    /** Today's plan, else the next upcoming one, else the most recent past one. */
    function pickPlan(plans) {
      if (!plans.length) return null;
      const now = Date.now();
      const today = localYmd(new Date(now));
      const todays = plans.find((p) => localYmd(new Date(p.sortDate)) === today);
      if (todays) return todays.rec;
      const next = plans.find((p) => p.sortDate > now);
      if (next) return next.rec;
      return plans[plans.length - 1].rec;
    }

    async function choosePlanId(stId) {
      return pickPlan(await listPlans(stId));
    }

    async function readPlanTimes(planId) {
      const body = await pco.getAll(`${planPath(planId)}/plan_times`);
      return (body.data || [])
        .map((t) => ({
          id: String(t.id),
          name: String(t.attributes?.name || '').trim(),
          timeType: String(t.attributes?.time_type || 'service'),
          startsAt: Date.parse(t.attributes?.starts_at || '') || 0,
          endsAt: Date.parse(t.attributes?.ends_at || '') || 0,
        }))
        .filter((t) => t.startsAt)
        .sort((x, y) => x.startsAt - y.startsAt);
    }

    async function readItems(planId) {
      const target = `${planPath(planId)}/items`;
      try {
        return shapeItems(await pco.getAll(target, { include: 'song,arrangement,item_notes' }));
      } catch (err) {
        // An account/API that refuses one of the includes still has items.
        if (err.status && err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429) {
          log(`items include rejected (${err.message}) — reading items without includes`);
          return shapeItems(await pco.getAll(target));
        }
        throw err;
      }
    }

    async function readPlan() {
      if (!pco.configured || !serviceTypeId) return;
      let planRec = null;
      if (pinnedPlanId) {
        planRec = (await pco.get(planPath(pinnedPlanId)))?.data || null;
      } else {
        const chosen = await choosePlanId(serviceTypeId);
        // Re-read the chosen plan by id: the list endpoint's attributes are the
        // same, but this keeps one code path and picks up edits immediately.
        planRec = chosen ? (await pco.get(planPath(chosen.id)))?.data || chosen : null;
      }
      if (!state.serviceType.name) {
        try {
          const st = await pco.get(`${SERVICES}/service_types/${encodeURIComponent(serviceTypeId)}`);
          state.serviceType = { id: serviceTypeId, name: String(st?.data?.attributes?.name || '') };
        } catch (err) {
          if (err.status === 404) throw new Error(`Service type ${serviceTypeId} does not exist — pick another in the setup page`);
          throw err;
        }
      }
      if (!planRec) {
        if (state.plan) log('no plan found any more — service timing reset');
        state.plan = null;
        state.items = [];
        state.reachable = true;
        state.lastError = '';
        state.lastFetched = Date.now();
        syncServiceSafe(Date.now(), null);
        return;
      }
      const [planTimes, items] = await Promise.all([readPlanTimes(planRec.id), readItems(planRec.id)]);
      const plan = shapePlan(planRec, serviceTypeId, planTimes);
      const planChanged = state.plan?.id !== plan.id;
      if (planChanged) {
        if (state.plan) log(`plan changed: ${state.plan.id} → ${plan.id} (${plan.dates} ${plan.title}) — service timing reset`);
        else log(`following plan ${plan.id}: ${plan.dates} ${plan.title || ''}`.trim());
      }
      state.plan = plan;
      state.items = items;
      state.reachable = true;
      state.lastError = '';
      state.lastFetched = Date.now();
      if (planChanged) {
        // A new plan: the next syncService picks its first window afresh
        // (and resets the item timing while doing so).
        win = null;
        svc = freshService(null);
      }
      // Service selection, item schedule and the running clock all follow
      // from the plan's service times — decided in one place.
      syncServiceSafe(Date.now(), null);
    }

    function schedulePoll(ms) {
      if (stopped) return;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, ms);
      pollTimer.unref?.();
    }

    async function poll() {
      if (stopped) return;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        let delay = pollMs;
        try {
          await readPlan();
        } catch (err) {
          state.reachable = false;
          state.lastError = err?.message || String(err);
          delay = err?.retryAfter ? (err.retryAfter + 1) * 1000 : RETRY_MS;
          log(`plan read failed: ${state.lastError}`);
        }
        broadcast();
        broadcastTimers();
        schedulePoll(delay);
      })();
      try {
        await inFlight;
      } finally {
        inFlight = null;
      }
    }

    /* — service timing: which service owns the clock, and its start / end — */

    let windows = [];                 // serviceWindows() of the current plan
    let win = null;                   // the window that owns the clock now
    let svc = freshService(null);     // its idle → running → stopped state (service-timing.js)
    let lastTimingError = '';
    let countdownTargetId = '';
    let countdownSince = 0;

    /** A plan with no plan times still has a date — treat it as one service starting then. */
    function planServices(plan) {
      if (serviceTimes(plan.planTimes).length) return plan.planTimes;
      return plan.sortDate ? [{ id: 'plan', name: '', timeType: 'service', startsAt: plan.sortDate, endsAt: 0 }] : [];
    }

    /** The plan's header times and every item's scheduled start follow the current service. */
    function applyServiceTimes() {
      const plan = state.plan;
      if (!plan) return;
      plan.serviceStartsAt = win ? win.startsAt : 0;
      plan.serviceEndsAt = win ? win.endsAt : 0;
      plan.serviceName = win ? win.name : '';
      scheduleItems(state.items, plan.serviceStartsAt || plan.sortDate);
    }

    /** state.service and the live mirror fields, from `win` + `svc`. */
    function mirrorService() {
      const finite = (v) => (Number.isFinite(v) ? v : 0);
      state.service = {
        ...clearedService(),
        ...svc,
        name: win ? win.name : '',
        label: serviceLabel(win),
        index: win ? win.index : -1,
        count: win ? win.count : 0,
        startsAt: win ? win.startsAt : 0,
        endsAt: win ? win.endsAt : 0,
        windowFrom: win ? finite(win.windowFrom) : 0,
        windowUntil: win ? finite(win.windowUntil) : 0,
      };
      state.live.serviceStartedAt = svc.phase === 'running' || svc.phase === 'stopped' ? svc.startedAt : 0;
      state.live.serviceEndedAt = svc.phase === 'stopped' ? svc.endedAt : 0;
    }

    /**
     * Bring the service timing up to `now`, optionally with a document that
     * has just gone live in ProPresenter (`cue`). Selects the window that
     * owns the clock (flipping — and resetting item timing — when the next
     * service's window has opened), then advances that service's own
     * idle → running → stopped state. Pure logic in service-timing.js.
     */
    function syncService(now, cue) {
      const plan = state.plan;
      if (!plan) {
        if (win || svc.phase !== 'none') {
          win = null;
          windows = [];
          svc = freshService(null);
          mirrorService();
        }
        return;
      }
      const endedAt = svc.phase === 'stopped' && svc.endedAt ? { [svc.id]: svc.endedAt } : {};
      windows = serviceWindows(planServices(plan), {
        preRollMs: timing.preRollMs,
        plannedMs: plannedLengthMs(state.items),
        endedAt,
      });
      const next = selectService(windows, now);
      if (!next) {
        // A plan with neither service times nor a date: nothing to time.
        if (win || svc.phase !== 'none') {
          const hadWindow = Boolean(win);
          win = null;
          svc = freshService(null);
          if (hadWindow) resetLiveTracking();
          applyServiceTimes();
          mirrorService();
        }
        return;
      }
      if (!win || win.id !== next.id) {
        // Leaving a window: a service still running is stopped at the boundary
        // (the "next service's start" failsafe), then the new service takes
        // over with fresh item timing.
        if (win && svc.id === win.id && svc.phase === 'running') {
          const leaving = windows.find((w) => w.id === win.id) || win;
          const out = advance(svc, leaving, serviceOpts, Math.max(now, leaving.failsafeEndAt), null);
          const endedAtMs = out.changed ? Math.min(out.svc.endedAt, now) : now;
          log(`service ${serviceLabel(leaving)} ${out.changed ? out.event : 'left its window while running'} (ran ${fmtDur(endedAtMs - svc.startedAt)})`);
        }
        win = next;
        svc = freshService(win);
        log(`service window → ${serviceLabel(win)} (${win.index + 1} of ${win.count}; scheduled start ${fmtTime(win.startsAt)}, start by ${timing.startMode}${timing.endDocument ? ', end by document' : ''})`);
        resetLiveTracking();
        applyServiceTimes();
      } else {
        win = next; // refreshed fields — the plan's times may have been edited
        if (plan.serviceStartsAt !== win.startsAt || plan.serviceEndsAt !== win.endsAt || plan.serviceName !== win.name) {
          applyServiceTimes();
        }
      }
      const out = advance(svc, win, serviceOpts, now, cue);
      if (out.changed) {
        svc = out.svc;
        log(`service ${serviceLabel(win)} ${out.event}`);
      }
      mirrorService();
    }

    /** syncService that can never take the plan display down with it. */
    function syncServiceSafe(now, cue) {
      try {
        syncService(now, cue);
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg !== lastTimingError) {
          lastTimingError = msg;
          log(`service timing error (plan display unaffected): ${msg}`);
        }
      }
    }

    /* — timers offered to the Timers module — */

    /** How far behind the plan the service runs, ms (negative = ahead). */
    function behindMs(now) {
      const history = state.live.history || {};
      let drift = 0;
      let any = false;
      for (const it of state.items) {
        const h = history[it.id];
        if (!h) continue;
        if (h.endedAt) {
          drift += (h.endedAt - h.startedAt) - (it.length || 0) * 1000;
          any = true;
        } else if (it.length) {
          const over = (now - h.startedAt) - it.length * 1000;
          if (over > 0) {
            drift += over;
            any = true;
          }
        }
      }
      return any ? drift : 0;
    }

    function serviceTone(elapsedMs, plannedMs, behind) {
      const over = plannedMs ? elapsedMs - plannedMs : 0;
      if (over > BEHIND_DANGER_MS || behind >= BEHIND_DANGER_MS) return 'danger';
      if (over > 0 || behind >= BEHIND_WARN_MS) return 'warn';
      return 'ok';
    }

    /** The service the countdown counts to: the idle current one, or the next one once this one ended. */
    function countdownTarget() {
      if (!win) return null;
      if (svc.phase === 'idle') return win;
      if (svc.phase === 'stopped') return windows[win.index + 1] || null;
      return null;
    }

    function timersSnapshot(now) {
      const plan = state.plan;
      const live = state.live;
      const items = state.items.filter((it) => it.itemType !== 'header');
      const idx = live.currentItemId ? items.findIndex((it) => it.id === live.currentItemId) : -1;
      const item = idx >= 0 ? items[idx] : null;
      const hist = item ? live.history[item.id] : null;
      const label = serviceLabel(win);
      const itemDetail = item ? `Item ${idx + 1} of ${items.length}` : '';
      const itemTitle = item ? item.title || item.song?.title || '(untitled)' : '';
      const plannedMs = plannedLengthMs(state.items)
        || (plan?.totalLength ? plan.totalLength * 1000 : 0)
        || (win && win.endsAt > win.startsAt ? win.endsAt - win.startsAt : 0)
        || null;
      const timer = (id, name, kind) => ({
        id,
        label: name,
        kind,
        state: 'idle',
        startedAt: null,
        elapsedMs: null,
        remainingMs: null,
        targetMs: null,
        status: null,
        detail: '',
      });

      // "Service" — elapsed since the service started, against its planned length.
      const service = timer('service', 'Service', 'elapsed');
      service.targetMs = plannedMs;
      if (!plan || !win) {
        service.status = { text: plan ? 'No service times in this plan' : 'No plan', tone: 'muted' };
      } else if (svc.phase === 'running') {
        const elapsed = now - svc.startedAt;
        const behind = behindMs(now);
        service.state = 'running';
        service.startedAt = svc.startedAt;
        service.elapsedMs = elapsed;
        service.status = {
          text: itemTitle || (behind >= BEHIND_WARN_MS ? `Behind ${fmtDur(behind)}` : ''),
          tone: serviceTone(elapsed, plannedMs, behind),
        };
        service.detail = [label, itemDetail].filter(Boolean).join(' · ');
      } else if (svc.phase === 'stopped') {
        service.state = 'stopped';
        service.startedAt = svc.startedAt;
        service.elapsedMs = svc.endedAt - svc.startedAt;
        service.status = { text: `Ended ${fmtTime(svc.endedAt)}`, tone: 'muted' };
        service.detail = label;
      } else {
        const waiting = timing.startMode === 'document' && now >= win.startsAt;
        service.status = waiting
          ? { text: 'Waiting for the start document', tone: 'warn' }
          : { text: `Starts ${fmtTime(win.startsAt)}`, tone: 'muted' };
        service.detail = label;
      }

      // "Current item" — the live plan item's runtime against its planned length.
      const currentItem = timer('item', 'Current item', 'elapsed');
      if (item && hist) {
        const elapsed = (hist.endedAt || now) - hist.startedAt;
        const planned = item.length ? item.length * 1000 : 0;
        const over = planned ? elapsed - planned : 0;
        currentItem.state = hist.endedAt ? 'stopped' : 'running';
        currentItem.startedAt = hist.startedAt;
        currentItem.elapsedMs = elapsed;
        currentItem.targetMs = planned || null;
        currentItem.status = {
          text: itemTitle,
          tone: over > planned * 0.25 + 30000 ? 'danger' : over > 0 ? 'warn' : 'ok',
        };
        currentItem.detail = itemDetail;
      } else {
        currentItem.status = {
          text: !live.following ? 'Not following ProPresenter' : !live.available ? 'ProPresenter feed unavailable' : 'Nothing live',
          tone: 'muted',
        };
      }

      // "Countdown to service" — to the current service's start, then to the
      // next one once this one has ended; frozen at zero while it runs; idle
      // when today holds no further service.
      const countdown = timer('countdown', 'Countdown to service', 'countdown');
      const target = countdownTarget();
      if (target && localYmd(new Date(target.startsAt)) === localYmd(new Date(now))) {
        if (target.id !== countdownTargetId) {
          countdownTargetId = target.id;
          countdownSince = now;
        }
        const remaining = Math.max(0, target.startsAt - now);
        countdown.detail = serviceLabel(target);
        if (remaining > 0) {
          countdown.state = 'running';
          countdown.startedAt = countdownSince;
          countdown.targetMs = target.startsAt - countdownSince;
          countdown.remainingMs = remaining;
        } else {
          countdown.state = 'stopped';
          countdown.remainingMs = 0;
          countdown.status = {
            text: timing.startMode === 'document' ? 'Waiting for the start document' : 'Service time',
            tone: 'muted',
          };
        }
      } else if (win && svc.phase === 'running') {
        countdown.state = 'stopped';
        countdown.remainingMs = 0;
        countdown.detail = label;
      } else {
        countdown.status = { text: 'No upcoming service today', tone: 'muted' };
      }

      return { source: 'pco-plan', label: 'PCO Plan', updatedAt: now, timers: [service, currentItem, countdown] };
    }

    /* — the ProPresenter Now/Next feed over loopback — */

    let nnRequest = null;
    let nnRetryTimer = null;
    let lastLiveName = null;
    let lastView = null;                 // the latest Now/Next view-model (playlist items → document list)
    const seenDocuments = new Map();     // document name → last seen live, ms
    // The shell tells us its port (ProdDash ≥ 1.4.0). Without it, fall back to
    // guessing and learning it from the first browser's Host header.
    const shellPort = Number(shell?.port) || 0;
    const guessedPort = shellPort || guessShellPort();
    let nnPort = guessedPort;
    /** Learned ports that refused the loopback connection (a reverse proxy's port, say). */
    const badPorts = new Set();

    /** Fallback only: a browser reached us on this Host — normally the shell's real port. */
    function learnPort(hostHeader) {
      if (shellPort) return; // the shell told us; nothing to learn
      const port = portFromHost(hostHeader);
      if (!port || port === nnPort || badPorts.has(port)) return;
      log(`ProdDash is on port ${port} (guessed ${nnPort}) — reconnecting the ProPresenter feed there`);
      nnPort = port;
      if (!wantFeed || stopped) return;
      clearTimeout(nnRetryTimer);
      try { nnRequest?.destroy(); } catch { /* gone */ }
      nnRequest = null;
      connectNowNext();
    }

    /**
     * Forget the item timing (a new plan, or the next service's window). Only
     * a *change* of document is a cue from here on — whatever is live at this
     * moment (the previous service's loop, a document left up) must not start
     * or end the new service — but the highlight may pick it straight back up.
     */
    function resetLiveTracking() {
      const keep = state.live;
      state.live = {
        ...clearedLive(),
        following: keep.following,
        available: keep.available,
        reason: keep.reason,
        ppEnabled: keep.ppEnabled,
        ppReachable: keep.ppReachable,
        activeName: keep.activeName,
      };
      lastLiveName = keep.activeName || '';
      if (follow && keep.activeName) {
        const hit = matchItem(keep.activeName);
        state.live.matched = Boolean(hit);
        if (hit) {
          state.live.currentScore = hit.score;
          startItem(hit.item.id);
        }
      }
    }

    /** Best plan item for a live presentation name, preferring the ones ahead of us. */
    function matchItem(name) {
      const items = state.items.filter((it) => it.itemType !== 'header');
      if (!items.length) return null;
      const currentIdx = items.findIndex((it) => it.id === state.live.currentItemId);
      let best = null;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const score = Math.max(similarity(name, item.title), item.song ? similarity(name, item.song.title) : 0);
        if (score < MATCH_THRESHOLD) continue;
        // Distance ahead of the current item (wrapping so items behind rank last).
        const dist = currentIdx < 0 ? i : (i - currentIdx + items.length) % items.length;
        if (
          !best
          || score > best.score + 0.001
          || (Math.abs(score - best.score) <= 0.001 && dist < best.dist)
        ) {
          best = { item, score, dist };
        }
      }
      return best;
    }

    /** Remember a document ProPresenter put live, most recent first, for the admin selects. */
    function rememberDocument(name) {
      const n = String(name || '').trim();
      if (!n) return;
      seenDocuments.delete(n);
      seenDocuments.set(n, Date.now());
      while (seenDocuments.size > SEEN_DOCUMENTS_MAX) seenDocuments.delete(seenDocuments.keys().next().value);
    }

    /**
     * Options for the admin "Start document" / "End document" selects. The
     * Now/Next module exposes the live document and the active playlist's
     * items — not ProPresenter's library — so the list is: what is live now,
     * the active playlist, every document seen live since ProdDash started,
     * and whatever is saved (kept selectable even when ProPresenter doesn't
     * show it right now).
     */
    function documentOptions() {
      const options = [{ value: '', label: 'None' }];
      const seen = new Set(['']);
      const add = (name, group) => {
        const n = String(name || '').trim();
        if (!n || seen.has(n)) return;
        seen.add(n);
        options.push({ value: n, label: n, group });
      };
      const live = state.live;
      if (live.activeName) add(live.activeName, 'Live now');
      const playlist = Array.isArray(lastView?.items) ? lastView.items : [];
      const playlistGroup = lastView?.playlistName ? `Playlist: ${lastView.playlistName}` : 'Active playlist';
      for (const it of playlist) {
        if (!it || it.isHidden || it.type === 'header') continue;
        add(it.name, playlistGroup);
      }
      const recent = [...seenDocuments.entries()].sort((a, b) => b[1] - a[1]);
      for (const [name] of recent) add(name, 'Seen live since ProdDash started');
      for (const saved of [timing.startDocument, timing.endDocument]) {
        if (saved && !seen.has(saved)) add(saved, 'Saved (not in ProPresenter right now)');
      }
      let note = '';
      if (!wantFeed) note = 'Turn on ProPresenter document triggers (or Follow ProPresenter Module), save, then reopen this list.';
      else if (!live.available) note = `ProPresenter module feed unavailable — ${live.reason || 'reconnecting'}; showing what was seen earlier and what is saved.`;
      else if (!live.ppReachable) note = 'ProPresenter is unreachable — showing what was seen earlier and what is saved.';
      return { options, note };
    }

    function applyLiveView(view) {
      lastView = view && typeof view === 'object' ? view : null;
      const live = state.live;
      live.available = true;
      live.reason = '';
      live.ppEnabled = Boolean(view?.enabled);
      live.ppReachable = Boolean(view?.reachable);
      const activeItem = Array.isArray(view?.items) && view.activeIndex >= 0 ? view.items[view.activeIndex] : null;
      const name = String(activeItem?.name || view?.activePresentationName || '').trim();
      live.activeName = name;
      if (!name) {
        // Cleared output between items is normal — the current item stays current.
        lastLiveName = '';
        broadcast();
        broadcastTimers();
        return;
      }
      if (name === lastLiveName) {
        broadcast(); // reachability may have changed; the frame check keeps it quiet otherwise
        return;
      }
      lastLiveName = name;
      rememberDocument(name);
      if (follow) {
        const hit = matchItem(name);
        live.matched = Boolean(hit);
        if (hit) {
          live.currentScore = hit.score;
          if (hit.item.id !== live.currentItemId) startItem(hit.item.id);
        }
      }
      // The same document is also a possible service start / end cue.
      syncServiceSafe(Date.now(), name);
      broadcast();
      broadcastTimers();
    }

    function startItem(itemId) {
      const live = state.live;
      const now = Date.now();
      if (live.currentItemId && live.history[live.currentItemId] && !live.history[live.currentItemId].endedAt) {
        live.history[live.currentItemId].endedAt = now;
      }
      live.currentItemId = itemId;
      live.history[itemId] = { startedAt: now, endedAt: 0 };
      const item = state.items.find((it) => it.id === itemId);
      log(`live item → ${item?.title || itemId}`);
    }

    function nowNextUnavailable(reason, retryMs) {
      const live = state.live;
      if (live.available || live.reason !== reason) {
        live.available = false;
        live.reason = reason;
        live.ppReachable = false;
        broadcast();
        broadcastTimers();
      }
      if (stopped) return;
      clearTimeout(nnRetryTimer);
      nnRetryTimer = setTimeout(connectNowNext, retryMs);
      nnRetryTimer.unref?.();
    }

    function connectNowNext() {
      if (stopped || !wantFeed) return;
      const port = nnPort;
      const req = http.get(
        { host: '127.0.0.1', port, path: `/api/modules/${NOW_NEXT_ID}/stream`, headers: { Accept: 'text/event-stream' } },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            const why = res.statusCode === 404
              ? 'ProPresenter module is disabled or not installed'
              : `ProPresenter module feed answered ${res.statusCode}`;
            return nowNextUnavailable(why, NOW_NEXT_MISSING_RETRY_MS);
          }
          res.setEncoding('utf8');
          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk;
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              let event = 'message';
              let data = '';
              for (const line of block.split('\n')) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data += line.slice(5).trim();
              }
              if (event !== 'state' || !data) continue;
              try {
                applyLiveView(JSON.parse(data));
              } catch { /* a bad frame is not fatal */ }
            }
          });
          res.on('end', () => nowNextUnavailable('ProPresenter module feed ended — reconnecting', NOW_NEXT_RETRY_MS));
          res.on('error', () => nowNextUnavailable('ProPresenter module feed dropped — reconnecting', NOW_NEXT_RETRY_MS));
        }
      );
      req.on('error', (err) => {
        if (req !== nnRequest) return; // superseded by a reconnect on the learned port
        if (!shellPort && port !== guessedPort) {
          // The Host header lied (reverse proxy, port forward) — that port is
          // not this ProdDash. Go back to the guess and never trust it again.
          badPorts.add(port);
          nnPort = guessedPort;
          log(`port ${port} refused the loopback (${err.message}) — back to port ${guessedPort}`);
        }
        nowNextUnavailable(`ProdDash loopback failed: ${err.message}`, NOW_NEXT_RETRY_MS);
      });
      req.setTimeout(45000, () => req.destroy(new Error('feed went silent')));
      nnRequest = req;
    }

    /* — start — */

    if (!pco.configured) {
      state.lastError = 'No Planning Center credentials — add a Client ID + Secret (or OAuth token) in /admin';
      log(state.lastError);
    } else if (!serviceTypeId) {
      state.lastError = 'No service type selected — choose one under PCO Plan in /admin';
      log(state.lastError);
    } else {
      log(`reading service type ${serviceTypeId} from ${API_BASE} (${pco.method})${pinnedPlanId ? `, plan ${pinnedPlanId} pinned` : ''}`);
      schedulePoll(0);
    }
    log(
      `service timing: pre-roll ${Math.round(timing.preRollMs / MINUTE)} min; start by ${
        timing.startMode === 'document'
          ? `document "${timing.startDocument}" (failsafe ${Math.round(timing.startGraceMs / MINUTE)} min after the scheduled start)`
          : 'the scheduled time'
      }; end ${timing.endDocument ? `by document "${timing.endDocument}"` : 'at the next service / plan end'}`
    );
    if (wantsDocumentStart && !startDocument) {
      log('service start is set to "ProPresenter document" but no start document is chosen — starting by the scheduled time instead');
    }
    if (wantFeed) {
      state.live.reason = 'Connecting to the ProPresenter module feed';
      connectNowNext();
    }
    mirrorService();

    const heartbeat = setInterval(() => {
      writeAll(streams, ': ping\n\n');
      writeAll(timerStreams, ': ping\n\n');
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    // The clock moves services along on its own: scheduled starts, window
    // flips, failsafes, the countdown reaching zero. Every step is guarded —
    // timing can never take the plan display down.
    const ticker = setInterval(() => {
      if (stopped) return;
      syncServiceSafe(Date.now(), null);
      try {
        broadcast();
        broadcastTimers();
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg !== lastTimingError) {
          lastTimingError = msg;
          log(`broadcast error: ${msg}`);
        }
      }
    }, 1000);
    ticker.unref?.();

    current = {
      streams,
      timerStreams,
      pco,
      getState: () => state,
      learnPort,
      refresh() {
        clearTimeout(pollTimer);
        return poll();
      },
      listPlans,
      pickPlan,
      timersSnapshot,
      documentOptions,
    };

    return {
      stop() {
        stopped = true;
        clearInterval(heartbeat);
        clearInterval(ticker);
        clearTimeout(pollTimer);
        clearTimeout(nnRetryTimer);
        try { nnRequest?.destroy(); } catch { /* gone */ }
        for (const set of [streams, timerStreams]) {
          for (const res of set) {
            try { res.end(); } catch { /* already gone */ }
          }
          set.clear();
        }
        if (current && current.streams === streams) current = null;
      },
      health() {
        if (!pco.configured) return { status: 'error', message: 'No Planning Center credentials configured' };
        if (!serviceTypeId) return { status: 'error', message: 'No service type selected — pick one in the Service type list below' };
        if (!state.reachable) {
          return { status: state.lastFetched ? 'error' : 'connecting', message: state.lastError || 'Reading the plan…' };
        }
        const name = state.serviceType.name || serviceTypeId;
        const plan = state.plan ? ` · ${state.plan.dates}${state.plan.title ? ` — ${state.plan.title}` : ''}` : ' · no plan found';
        const service = win ? ` · ${serviceLabel(win)} ${svc.phase}` : '';
        const live = wantFeed ? (state.live.available ? '' : ' · ProPresenter feed unavailable') : '';
        return { status: 'ok', message: `Following ${name}${plan}${service}${live}` };
      },
    };
  },

  routes({ log }) {
    const json = (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const sseHead = (res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
    };

    return {
      'GET /state': (req, res) => {
        current?.learnPort(req.headers.host);
        json(res, 200, { state: current ? current.getState() : clearedState(), now: Date.now() });
      },

      'GET /stream': (req, res) => {
        current?.learnPort(req.headers.host);
        sseHead(res);
        const state = current ? current.getState() : clearedState();
        res.write(`event: state\ndata: ${JSON.stringify({ state, now: Date.now() })}\n\n`);
        if (!current) return void res.end();
        const { streams } = current;
        try { req.socket.setKeepAlive(true, 15000); } catch { /* gone */ }
        streams.add(res);
        req.on('close', () => streams.delete(res));
      },

      'POST /refresh': (req, res) => {
        if (!current) return json(res, 503, { error: 'Module not running.' });
        current.refresh().then(
          () => json(res, 200, { ok: true, state: current?.getState() }),
          (err) => json(res, 502, { error: err?.message || String(err) })
        );
      },

      /* — timers for the Timers module (module guide: "Offering timers") — */

      'GET /timers': (req, res) => {
        const now = Date.now();
        json(res, 200, current ? current.timersSnapshot(now) : emptyTimers(now));
      },

      'GET /timers/stream': (req, res) => {
        sseHead(res);
        const now = Date.now();
        res.write(`event: timers\ndata: ${JSON.stringify(current ? current.timersSnapshot(now) : emptyTimers(now))}\n\n`);
        if (!current) return void res.end();
        const { timerStreams } = current;
        try { req.socket.setKeepAlive(true, 15000); } catch { /* gone */ }
        timerStreams.add(res);
        req.on('close', () => timerStreams.delete(res));
      },

      /** Options for the admin "Start document" / "End document" selects. */
      'GET /documents': (req, res) => {
        if (!current) return json(res, 200, { options: [{ value: '', label: 'None' }], note: 'Module not running.' });
        json(res, 200, current.documentOptions());
      },

      /**
       * Options for the admin page's "Service type" select: every service
       * type, grouped by its Planning Center folder path — so the folders
       * are browsable as <optgroup>s right in the admin form.
       */
      'GET /service-types': async (req, res) => {
        if (!current) return json(res, 503, { error: 'Module not running.' });
        const { pco } = current;
        if (!pco.configured) return json(res, 200, { options: [], error: 'No Planning Center credentials yet.' });
        try {
          const [folderBody, stBody] = await Promise.all([
            pco.getAll(`${SERVICES}/folders`),
            pco.getAll(`${SERVICES}/service_types`),
          ]);
          const folders = new Map();
          for (const f of folderBody.data || []) {
            folders.set(String(f.id), {
              id: String(f.id),
              name: String(f.attributes?.name || 'Folder'),
              parentId: f.relationships?.parent?.data?.id ? String(f.relationships.parent.data.id) : '',
            });
          }
          const serviceTypes = (stBody.data || []).map((st) => ({
            id: String(st.id),
            name: String(st.attributes?.name || 'Service type'),
            frequency: String(st.attributes?.frequency || ''),
            parentId: st.relationships?.parent?.data?.id ? String(st.relationships.parent.data.id) : '',
          }));
          // Fill in any folder the list did not include (some accounts only
          // list root folders) by fetching the missing parents individually.
          const missing = new Set();
          for (const st of serviceTypes) if (st.parentId && !folders.has(st.parentId)) missing.add(st.parentId);
          for (const f of folders.values()) if (f.parentId && !folders.has(f.parentId)) missing.add(f.parentId);
          let guard = 0;
          while (missing.size && guard < 50) {
            const id = missing.values().next().value;
            missing.delete(id);
            guard += 1;
            try {
              const one = (await pco.get(`${SERVICES}/folders/${encodeURIComponent(id)}`))?.data;
              const parentId = one?.relationships?.parent?.data?.id ? String(one.relationships.parent.data.id) : '';
              folders.set(id, { id, name: String(one?.attributes?.name || 'Folder'), parentId });
              if (parentId && !folders.has(parentId)) missing.add(parentId);
            } catch {
              folders.set(id, { id, name: `Folder ${id}`, parentId: '' });
            }
          }
          // "Campuses › North Campus" — the folder path from the root down.
          const pathOf = (parentId) => {
            const names = [];
            let id = parentId;
            const seen = new Set();
            while (id && folders.has(id) && !seen.has(id)) {
              seen.add(id);
              names.unshift(folders.get(id).name);
              id = folders.get(id).parentId;
            }
            return names.join(' › ');
          };
          const options = serviceTypes
            .map((st) => ({ value: st.id, label: st.name, group: pathOf(st.parentId) }))
            .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
          json(res, 200, { options });
        } catch (err) {
          log(`service type list failed: ${err?.message || err}`);
          json(res, err?.status === 401 ? 401 : 502, { options: [], error: err?.message || String(err) });
        }
      },

      /**
       * Options for the admin page's "Plan" select, for the service type the
       * admin currently has picked (?serviceTypeId=…): the upcoming and recent
       * plans, with the one Automatic would choose marked.
       */
      'GET /plans': async (req, res) => {
        if (!current) return json(res, 503, { error: 'Module not running.' });
        const { pco } = current;
        const params = new URLSearchParams(req.search || '');
        const stId = String(params.get('serviceTypeId') || '').trim();
        const auto = { value: '', label: 'Automatic — today\'s plan, else the next upcoming' };
        if (!pco.configured || !stId) return json(res, 200, { options: [auto] });
        try {
          const plans = await current.listPlans(stId, { future: 8, past: 6 });
          const picked = current.pickPlan(plans);
          const now = Date.now();
          const options = [auto];
          // Upcoming first (soonest at the top), then the recent ones.
          const ordered = [
            ...plans.filter((p) => p.sortDate >= now - 12 * 3600000),
            ...plans.filter((p) => p.sortDate < now - 12 * 3600000).reverse(),
          ];
          for (const { rec, sortDate } of ordered) {
            const a = rec.attributes || {};
            const bits = [String(a.dates || a.short_dates || new Date(sortDate).toLocaleDateString())];
            if (a.series_title) bits.push(String(a.series_title));
            if (a.title) bits.push(String(a.title));
            let label = bits.join(' — ');
            if (picked && rec.id === picked.id) label += '  (Automatic picks this)';
            options.push({ value: String(rec.id), label, group: sortDate >= now - 12 * 3600000 ? 'Upcoming' : 'Recent' });
          }
          json(res, 200, { options });
        } catch (err) {
          json(res, err?.status === 401 ? 401 : 502, { options: [auto], error: err?.message || String(err) });
        }
      },
    };
  },
};
