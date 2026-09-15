'use strict';

/**
 * ProdCom Transcript — server part.
 *
 * One connection to ProdCom for the whole server, however many dashboards
 * show the transcript. The module holds the channel list, the groups and
 * the last entries, follows ProdCom's SSE stream, and hands every browser a
 * snapshot on connect plus each change as it happens. (It used to proxy each
 * browser's stream to ProdCom one to one — N screens meant N upstream
 * connections; ProdCom now sees one.)
 *
 * Routes (under /api/modules/prodcom-transcript):
 *   GET /state   → { status, channels, groups, entries }   (entries by date)
 *   GET /stream  → SSE: `state` (the snapshot, first), then `entry` for each
 *                  changed entry, `clear`, and `status` when the link changes
 *
 * ProdCom's API, as the reference listener speaks it:
 *   GET /api/v1/channels, /api/v1/groups, /api/v1/transcript?limit=N and the
 *   SSE /api/v1/transcript/stream, whose frames carry an entry, or a
 *   { type, entry | data } wrapper, in a few historical shapes (see
 *   extractEntries). A bearer API key is sent when one is configured.
 */

const http = require('http');

const HISTORY_LIMIT = 100;            // entries asked for on (re)connect
const ENTRIES_MAX = 300;              // entries kept in memory
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 15000;
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_LISTS_MS = 5 * 60 * 1000; // channels and groups re-read
const HEARTBEAT_MS = 15000;

/** The ProdCom base URL from the endpoint config. A legacy prodcomUrl (saved
    before the endpoint field existed) can only still be present until the
    admin form is re-saved, so when it exists it wins over the endpoint's
    schema default. */
function resolveTarget(config) {
  if (config.prodcomUrl) return new URL(config.prodcomUrl);
  const ep = config.prodcom;
  if (ep && ep.host && Number(ep.port)) return new URL(`http://${ep.host}:${Number(ep.port)}`);
  return null;
}

/** Entries inside whatever ProdCom sent: a bare entry, or one wrapped in data / payload / entry / entries / transcript. */
function extractEntries(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.flatMap(extractEntries);
  if (typeof obj.text === 'string' && (obj.id || obj.channelId)) return [obj];
  for (const key of ['data', 'payload', 'entry', 'entries', 'transcript']) {
    if (obj[key] && typeof obj[key] === 'object') {
      const found = extractEntries(obj[key]);
      if (found.length) return found;
    }
  }
  return [];
}

/** One entry as the tiles read it; an entry without an id is keyed by channel and time. */
function normalizeEntry(e) {
  const id = e.id !== undefined && e.id !== null && e.id !== '' ? String(e.id) : `${e.channelId || ''}|${e.date || ''}`;
  return {
    id,
    channelId: e.channelId === undefined || e.channelId === null ? '' : String(e.channelId),
    channelName: e.channelName ? String(e.channelName) : '',
    text: String(e.text ?? ''),
    date: e.date ? String(e.date) : new Date().toISOString(),
    inProgress: Boolean(e.inProgress),
  };
}

let current = null; // the running instance, for routes()

module.exports = {
  init({ config, log }) {
    const target = resolveTarget(config);
    const apiKey = String(config.apiKey || '');
    const channels = [];
    const groups = [];
    const entries = new Map(); // id → entry, in arrival order
    const streams = new Set(); // browsers' SSE responses
    let status = { state: 'connecting', message: target ? 'Connecting to ProdCom…' : 'No ProdCom server configured' };
    let stopped = false;
    let upstream = null;
    let generation = 0;        // callbacks from a superseded connection are ignored
    let retryTimer = null;
    let retryMs = RETRY_MIN_MS;

    const authHeaders = () => (apiKey ? { authorization: `Bearer ${apiKey}` } : {});

    async function getJson(pathname) {
      const res = await fetch(new URL(pathname, target), {
        headers: { accept: 'application/json', ...authHeaders() },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
      return res.json();
    }

    function sortedEntries() {
      return [...entries.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
    }

    function snapshot() {
      return { status, channels, groups, entries: sortedEntries() };
    }

    function broadcast(event, data) {
      if (!streams.size) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of streams) {
        try {
          res.write(frame);
        } catch {
          streams.delete(res);
        }
      }
    }

    function setStatus(state, message) {
      if (status.state === state && status.message === message) return;
      status = { state, message };
      broadcast('status', status);
    }

    function trim() {
      while (entries.size > ENTRIES_MAX) entries.delete(entries.keys().next().value);
    }

    /** A changed entry: kept, and told to every browser. */
    function upsert(raw) {
      const e = normalizeEntry(raw);
      const prev = entries.get(e.id);
      if (prev && prev.text === e.text && prev.inProgress === e.inProgress && prev.channelId === e.channelId) return;
      entries.set(e.id, e);
      trim();
      broadcast('entry', e);
    }

    function clearAll() {
      entries.clear();
      broadcast('clear', {});
    }

    async function loadLists() {
      const [ch, gr] = await Promise.all([
        getJson('/api/v1/channels'),
        getJson('/api/v1/groups').catch(() => ({ data: [] })), // groups are optional in ProdCom
      ]);
      channels.splice(0, channels.length, ...(ch.data || []).map((c) => ({ id: String(c.id), name: String(c.name || c.id), color: c.color || '#8b98a5' })));
      groups.splice(0, groups.length, ...(gr.data || []).map((g) => ({ id: String(g.id), name: String(g.name || g.id), channelIds: Array.isArray(g.channelIds) ? g.channelIds.map(String) : [] })));
    }

    async function loadHistory() {
      const body = await getJson(`/api/v1/transcript?limit=${HISTORY_LIMIT}`);
      for (const e of extractEntries(body).map(normalizeEntry)) entries.set(e.id, e);
      trim();
    }

    function handleFrame(block) {
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) return;
      let obj;
      try {
        obj = JSON.parse(data.join('\n'));
      } catch {
        return;
      }
      const kind = String(obj?.type || obj?.event || '').toLowerCase();
      if (kind.includes('clear')) return clearAll();
      extractEntries(obj).forEach(upsert);
    }

    function scheduleRetry() {
      if (stopped) return;
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
    }

    function fail(gen, why) {
      if (stopped || gen !== generation) return;
      generation += 1; // whatever else this connection reports is stale now
      try { upstream?.destroy(); } catch { /* already gone */ }
      upstream = null;
      setStatus('error', `ProdCom unreachable (${why}) — retrying`);
      log(`ProdCom ${target.origin}: ${why} — retrying in ${retryMs / 1000} s`);
      scheduleRetry();
    }

    /** Lists and history first (a fresh snapshot for the tiles), then the live stream. */
    async function connect() {
      if (stopped || !target) return;
      const gen = ++generation;
      try {
        await loadLists();
        await loadHistory();
      } catch (err) {
        if (gen !== generation || stopped) return;
        return fail(gen, err.cause?.code || err.code || err.message);
      }
      if (gen !== generation || stopped) return;
      broadcast('state', snapshot());
      const url = new URL('/api/v1/transcript/stream', target);
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: 'GET',
        headers: { accept: 'text/event-stream', ...authHeaders() },
      }, (res) => {
        if (gen !== generation) return void res.destroy();
        if (res.statusCode !== 200) {
          res.resume();
          return fail(gen, `HTTP ${res.statusCode} from the transcript stream`);
        }
        retryMs = RETRY_MIN_MS;
        setStatus('ok', 'Live');
        log(`following ${target.origin} — ${channels.length} channels, ${entries.size} entries`);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (gen !== generation) return;
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            handleFrame(buf.slice(0, i));
            buf = buf.slice(i + 2);
          }
          if (buf.length > 1e6) buf = ''; // a frame that never ends is dropped
        });
        res.on('end', () => fail(gen, 'stream ended'));
        res.on('error', (err) => fail(gen, err.code || err.message));
      });
      req.on('error', (err) => fail(gen, err.code || err.message));
      req.end();
      upstream = req;
    }

    const listsTimer = setInterval(() => {
      if (stopped || status.state !== 'ok') return;
      loadLists().then(() => broadcast('state', snapshot())).catch(() => { /* the next reconnect re-reads them */ });
    }, REFRESH_LISTS_MS);
    listsTimer.unref?.();
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

    if (target) {
      log(`one connection to ProdCom at ${target.origin}, shared by every dashboard`);
      connect();
    } else {
      log('no ProdCom server configured — set the endpoint in /admin');
    }

    current = {
      snapshot,
      streams,
      health() {
        if (status.state === 'ok') return { status: 'ok', message: `Live — ${channels.length} channel${channels.length === 1 ? '' : 's'}, ${entries.size} entries` };
        return { status: status.state === 'error' ? 'error' : 'connecting', message: status.message };
      },
    };

    return {
      stop() {
        stopped = true;
        generation += 1;
        clearTimeout(retryTimer);
        clearInterval(listsTimer);
        clearInterval(heartbeat);
        try { upstream?.destroy(); } catch { /* already gone */ }
        for (const res of streams) {
          try { res.end(); } catch { /* gone */ }
        }
        streams.clear();
        if (current?.streams === streams) current = null;
      },
      health: () => (current ? current.health() : { status: 'connecting', message: 'Restarting…' }),
    };
  },

  routes() {
    const sendJson = (res, code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    return {
      'GET /state': (req, res) => {
        if (!current) return sendJson(res, 503, { error: 'ProdCom module is restarting — try again' });
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
          res.write(`event: state\ndata: ${JSON.stringify({ status: { state: 'connecting', message: 'ProdCom module is restarting…' }, channels: [], groups: [], entries: [] })}\n\n`);
          return void res.end();
        }
        res.write(`event: state\ndata: ${JSON.stringify(current.snapshot())}\n\n`);
        try { req.socket.setKeepAlive(true, 15000); } catch { /* gone */ }
        current.streams.add(res);
        req.on('close', () => current && current.streams.delete(res));
      },
    };
  },
};
