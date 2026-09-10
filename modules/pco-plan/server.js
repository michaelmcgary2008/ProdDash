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
 *
 * Planning Center API v2 (https://api.planningcenteronline.com/services/v2):
 *   Auth: Personal Access Token (HTTP Basic app_id:secret) or an OAuth 2.0
 *   bearer token. Responses are JSON:API — `data`, `included`, `links.next`.
 *   GET /folders, /service_types                       (setup browsing)
 *   GET /service_types/{st}/plans?filter=future|past   (pick the plan)
 *   GET /service_types/{st}/plans/{id}                 (title, dates…)
 *   GET …/plans/{id}/plan_times                        (service start times)
 *   GET …/plans/{id}/items?include=song,arrangement,item_notes
 *
 * Phase 2 — following ProPresenter: instead of talking to ProPresenter a
 * second time, this module reads the propresenter-now-next module's own SSE
 * feed over loopback (/api/modules/propresenter-now-next/stream) and matches
 * the live presentation name to a plan item. Item start/end timestamps are
 * tracked here, once, so every tile agrees on the runtime. The shell's port
 * is guessed the way the shell decides it and then confirmed from the Host
 * header of the first tile request.
 *
 * PCO_PLAN_API_BASE=http://127.0.0.1:24700 points the module at
 * tools/pco-mock.js for development.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
/** Minimum name-similarity to call a ProPresenter document a plan item. */
const MATCH_THRESHOLD = 0.6;

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
    serviceStartedAt: 0,  // first matched item start, ms epoch
    history: {},          // itemId → { startedAt, endedAt }
  };
}

/**
 * First guess at the shell's port, so the loopback Now/Next feed lands on this
 * ProdDash before any browser has talked to us. Mirrors how the shell decides:
 * PORT env, then this machine's proddash.json in the data directory, then the
 * checked-in config/proddash.json, then 24500. The guess is corrected from the
 * Host header of the first request that reaches a route (see learnPort).
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

/** Same title tidying as propresenter-core.cleanItemName (drops [tags], date codes). */
function cleanTitle(raw) {
  const original = String(raw || '').trim();
  let s = original;
  s = s.replace(/[[({][^\])}]*[\])}]/g, ' ');
  s = s.replace(/^\s*\d{6,8}\b[\s\-–—:.]*/, '');
  s = s.replace(/\s[-–—]+\s/g, ' ');
  s = s.replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s || original;
}

function normalize(raw) {
  return cleanTitle(raw)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'to', 'in', 'is', 'my', 'your', 'our']);
function tokens(norm) {
  return new Set(norm.split(' ').filter((t) => t && !STOPWORDS.has(t)));
}

/** 0..1 similarity between two titles. */
function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return 0.85;
  const ta = tokens(na);
  const tb = tokens(nb);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return (2 * common) / (ta.size + tb.size); // Dice coefficient
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

function pickServiceTime(planTimes, nowMs) {
  const services = planTimes.filter((t) => t.timeType === 'service' && t.startsAt);
  const pool = services.length ? services : planTimes.filter((t) => t.startsAt);
  if (!pool.length) return null;
  pool.sort((a, b) => a.startsAt - b.startsAt);
  // The service that is running or up next; after the last one, the last one.
  const upcoming = pool.find((t) => (t.endsAt || t.startsAt + 90 * 60000) > nowMs);
  return upcoming || pool[pool.length - 1];
}

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

/* ── the module ─────────────────────────────────────────────────────── */

module.exports = {
  init({ config, log }) {
    const streams = new Set();
    const pco = createPcoClient(config);
    const serviceTypeId = String(config.serviceTypeId || '').trim();
    const pinnedPlanId = String(config.planId || '').trim();
    const pollMs = Math.max(MIN_POLL_S, Number(config.pollSeconds) || 30) * 1000;
    const follow = config.followProPresenter !== false;

    let state = clearedState();
    state.configured = pco.configured;
    state.serviceTypeSet = Boolean(serviceTypeId);
    state.serviceType = { id: serviceTypeId, name: '' };
    state.live.following = follow;

    let stopped = false;
    let pollTimer = null;
    let inFlight = null;
    let lastFrame = '';

    /* — broadcasting — */

    function frameOf() {
      return JSON.stringify(state);
    }

    function broadcast(force) {
      const frame = frameOf();
      if (!force && frame === lastFrame) return;
      lastFrame = frame;
      if (!streams.size) return;
      const payload = `event: state\ndata: ${JSON.stringify({ state, now: Date.now() })}\n\n`;
      for (const res of streams) {
        try {
          res.write(payload);
        } catch {
          streams.delete(res);
        }
      }
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
        state.plan = null;
        state.items = [];
        state.reachable = true;
        state.lastError = '';
        state.lastFetched = Date.now();
        return;
      }
      const [planTimes, items] = await Promise.all([readPlanTimes(planRec.id), readItems(planRec.id)]);
      const plan = shapePlan(planRec, serviceTypeId, planTimes);
      const service = pickServiceTime(planTimes, Date.now());
      if (service) {
        plan.serviceStartsAt = service.startsAt;
        plan.serviceEndsAt = service.endsAt;
        plan.serviceName = service.name;
      }
      scheduleItems(items, plan.serviceStartsAt || plan.sortDate);
      if (state.plan?.id !== plan.id) {
        if (state.plan) log(`plan changed: ${state.plan.id} → ${plan.id} (${plan.dates} ${plan.title})`);
        else log(`following plan ${plan.id}: ${plan.dates} ${plan.title || ''}`.trim());
        resetLiveTracking();
      }
      state.plan = plan;
      state.items = items;
      state.reachable = true;
      state.lastError = '';
      state.lastFetched = Date.now();
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
        schedulePoll(delay);
      })();
      try {
        await inFlight;
      } finally {
        inFlight = null;
      }
    }

    /* — phase 2: follow the ProPresenter Now/Next feed over loopback — */

    let nnRequest = null;
    let nnRetryTimer = null;
    let lastLiveName = null;
    const guessedPort = guessShellPort();
    let nnPort = guessedPort;
    /** Learned ports that refused the loopback connection (a reverse proxy's port, say). */
    const badPorts = new Set();

    /** A browser reached us on this Host — normally the port the shell really serves on. */
    function learnPort(hostHeader) {
      const port = portFromHost(hostHeader);
      if (!port || port === nnPort || badPorts.has(port)) return;
      log(`ProdDash is on port ${port} (guessed ${nnPort}) — reconnecting the ProPresenter feed there`);
      nnPort = port;
      if (!follow || stopped) return;
      clearTimeout(nnRetryTimer);
      try { nnRequest?.destroy(); } catch { /* gone */ }
      nnRequest = null;
      connectNowNext();
    }

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
      lastLiveName = null;
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

    function applyLiveView(view) {
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
        return;
      }
      if (name === lastLiveName) return;
      lastLiveName = name;
      const hit = matchItem(name);
      live.matched = Boolean(hit);
      if (hit) {
        live.currentScore = hit.score;
        if (hit.item.id !== live.currentItemId) startItem(hit.item.id);
      }
      broadcast();
    }

    function startItem(itemId) {
      const live = state.live;
      const now = Date.now();
      if (live.currentItemId && live.history[live.currentItemId] && !live.history[live.currentItemId].endedAt) {
        live.history[live.currentItemId].endedAt = now;
      }
      live.currentItemId = itemId;
      live.history[itemId] = { startedAt: now, endedAt: 0 };
      if (!live.serviceStartedAt) live.serviceStartedAt = now;
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
      }
      if (stopped) return;
      clearTimeout(nnRetryTimer);
      nnRetryTimer = setTimeout(connectNowNext, retryMs);
      nnRetryTimer.unref?.();
    }

    function connectNowNext() {
      if (stopped || !follow) return;
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
        if (port !== guessedPort) {
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
      state.lastError = 'No Planning Center credentials — add an Application ID + Secret (or OAuth token) in /admin';
      log(state.lastError);
    } else if (!serviceTypeId) {
      state.lastError = 'No service type selected — choose one under PCO Plan in /admin';
      log(state.lastError);
    } else {
      log(`reading service type ${serviceTypeId} from ${API_BASE} (${pco.method})${pinnedPlanId ? `, plan ${pinnedPlanId} pinned` : ''}`);
      schedulePoll(0);
    }
    if (follow) {
      state.live.reason = 'Connecting to the ProPresenter module feed';
      connectNowNext();
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

    current = {
      streams,
      pco,
      getState: () => state,
      learnPort,
      refresh() {
        clearTimeout(pollTimer);
        return poll();
      },
      listPlans,
      pickPlan,
    };

    return {
      stop() {
        stopped = true;
        clearInterval(heartbeat);
        clearTimeout(pollTimer);
        clearTimeout(nnRetryTimer);
        try { nnRequest?.destroy(); } catch { /* gone */ }
        for (const res of streams) {
          try { res.end(); } catch { /* already gone */ }
        }
        streams.clear();
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
        const live = follow ? (state.live.available ? '' : ' · ProPresenter feed unavailable') : '';
        return { status: 'ok', message: `Following ${name}${plan}${live}` };
      },
    };
  },

  routes({ log }) {
    const json = (res, status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    return {
      'GET /state': (req, res) => {
        current?.learnPort(req.headers.host);
        json(res, 200, { state: current ? current.getState() : clearedState(), now: Date.now() });
      },

      'GET /stream': (req, res) => {
        current?.learnPort(req.headers.host);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
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
