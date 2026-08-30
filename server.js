#!/usr/bin/env node
/**
 * ProdDash — modular production dashboard for Waters Church.
 *
 * Shell server: serves the dashboard client from public/, discovers modules
 * in modules/, mounts each enabled module's server routes under
 * /api/modules/<id>/, and stores server-side config + named layouts under
 * config/.
 *
 * Zero dependencies — Node built-ins only (Node 18+ for global fetch).
 * Configure via config/proddash.json or env vars:
 *   PORT              (default: value in proddash.json, else 24500)
 *   PRODDASH_PASSCODE (overrides adminPasscode in proddash.json)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(ROOT, 'config');
const MODULES_DIR = path.join(ROOT, 'modules');
const MODULES_CONFIG_PATH = path.join(CONFIG_DIR, 'modules.json');

/* ── config files ───────────────────────────────────────────────────── */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file); // atomic-ish: never leave a half-written config
}

const shellConfig = readJson(path.join(CONFIG_DIR, 'proddash.json'), {});
const PORT = Number(process.env.PORT || shellConfig.port || 24500);

/** Per-module server-wide state: { "<id>": { enabled: bool, config: {…} } } */
let modulesConfig = readJson(MODULES_CONFIG_PATH, {});

/* ── module discovery ───────────────────────────────────────────────── */

/** @type {Map<string, object>} module id -> manifest (with .dir added) */
const manifests = new Map();

function discoverModules() {
  manifests.clear();
  let dirs = [];
  try {
    dirs = fs.readdirSync(MODULES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return; // no modules/ folder yet — the shell still runs
  }
  for (const dir of dirs) {
    const manifestPath = path.join(MODULES_DIR, dir, 'module.json');
    const man = readJson(manifestPath, null);
    if (!man || typeof man !== 'object') {
      if (fs.existsSync(manifestPath)) console.warn(`[proddash] ${dir}/module.json is invalid — skipped`);
      continue;
    }
    if (man.id && man.id !== dir) {
      console.warn(`[proddash] module "${dir}": manifest id "${man.id}" must match its folder name — skipped`);
      continue;
    }
    man.id = dir;
    if (!man.client) {
      console.warn(`[proddash] module "${dir}": manifest has no "client" entry — skipped`);
      continue;
    }
    man.dir = path.join(MODULES_DIR, dir);
    manifests.set(dir, man);
  }
}

function moduleState(id) {
  const s = modulesConfig[id];
  return s && typeof s === 'object' ? s : {};
}

function isEnabled(id) {
  return moduleState(id).enabled !== false; // newly dropped modules default to enabled
}

/** Admin config for a module: schema defaults overlaid with stored values. */
function effectiveConfig(id) {
  const man = manifests.get(id);
  const out = {};
  for (const [key, spec] of Object.entries(man?.configSchema || {})) {
    if (spec && 'default' in spec) out[key] = spec.default;
  }
  const stored = moduleState(id).config;
  if (stored && typeof stored === 'object') Object.assign(out, stored);
  return out;
}

/** Config as sent to browsers: password-typed fields never leave the server. */
function clientConfig(id) {
  const man = manifests.get(id);
  const cfg = effectiveConfig(id);
  const out = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (man?.configSchema?.[key]?.type === 'password') continue;
    out[key] = value;
  }
  return out;
}

/* ── module server mounting ─────────────────────────────────────────── */

/**
 * A module's optional server.js exports:
 *   init({ config, log })   -> handle with stop() (and optionally health())
 *   routes({ config, log }) -> { 'GET /state': handler, 'GET /stream': handler,
 *                                'GET /proxy/*': handler, '* /any/*': handler }
 * Routes are mounted under /api/modules/<id>/. A trailing "/*" makes a prefix
 * route; the matched remainder is passed as req.wildcard (req.search carries
 * the query string). init() runs before routes(), so routes can close over
 * state init created.
 */
const mounted = new Map(); // id -> { routes: [...], handle, error }

function makeLog(id) {
  return (...args) => console.log(`[${id}]`, ...args);
}

function parseRouteTable(table) {
  const routes = [];
  for (const [key, handler] of Object.entries(table || {})) {
    if (typeof handler !== 'function') continue;
    const sp = key.indexOf(' ');
    if (sp < 0) continue;
    const method = key.slice(0, sp).toUpperCase();
    let route = key.slice(sp + 1).trim();
    let wildcard = false;
    if (route.endsWith('/*')) {
      wildcard = true;
      route = route.slice(0, -2) || '';
    }
    if (!route.startsWith('/')) route = '/' + route;
    routes.push({ method, path: route, wildcard, handler });
  }
  return routes;
}

function mountModule(id) {
  const man = manifests.get(id);
  if (!man) return;
  const entry = { routes: [], handle: null, error: '' };
  mounted.set(id, entry);
  if (!man.server) return;
  const log = makeLog(id);
  try {
    const serverPath = path.join(man.dir, man.server);
    // Re-require fresh config on every (re)mount; the module code itself stays cached.
    const mod = require(serverPath);
    const config = effectiveConfig(id);
    if (typeof mod.init === 'function') {
      entry.handle = mod.init({ config, log }) || null;
    }
    if (typeof mod.routes === 'function') {
      entry.routes = parseRouteTable(mod.routes({ config, log }));
    }
    log('mounted' + (entry.routes.length ? ` (${entry.routes.length} routes)` : ''));
  } catch (err) {
    entry.error = err instanceof Error ? err.message : String(err);
    console.error(`[proddash] module "${id}" failed to mount:`, err);
  }
}

function unmountModule(id) {
  const entry = mounted.get(id);
  if (!entry) return;
  try {
    entry.handle?.stop?.();
  } catch (err) {
    console.error(`[proddash] module "${id}" failed to stop cleanly:`, err);
  }
  mounted.delete(id);
}

/** Re-init a module after its config changed (admin page). */
function remountModule(id) {
  unmountModule(id);
  if (manifests.has(id) && isEnabled(id)) mountModule(id);
}

function mountAllModules() {
  for (const id of manifests.keys()) {
    if (isEnabled(id)) mountModule(id);
  }
}

/** Health of a mounted module, as reported by its own handle.health(). */
function moduleHealth(id) {
  const entry = mounted.get(id);
  if (!entry) return null;
  if (entry.error) return { status: 'error', message: entry.error };
  try {
    const h = entry.handle?.health?.();
    if (h && typeof h === 'object') return { status: String(h.status || 'ok'), message: String(h.message || '') };
  } catch { /* a bad health() must not break the admin page */ }
  return null;
}

/* ── shell API helpers ──────────────────────────────────────────────── */

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limitBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Manifest as sent to the dashboard client (enabled modules only). */
function clientManifest(id) {
  const man = manifests.get(id);
  return {
    id: man.id,
    name: String(man.name || man.id),
    version: String(man.version || ''),
    description: String(man.description || ''),
    client: String(man.client),
    style: man.style ? String(man.style) : '',
    minSize: man.minSize || { w: 1, h: 1 },
    defaultSize: man.defaultSize || { w: 4, h: 3 },
    instanceSchema: man.instanceSchema || {},
    hasServer: Boolean(man.server),
    config: clientConfig(id),
  };
}

/* ── shell events (SSE to every open dashboard/admin page) ──────────── */

const shellStreams = new Set();

function broadcastShellEvent(type, payload = {}) {
  if (!shellStreams.size) return;
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of shellStreams) {
    try {
      res.write(frame);
    } catch {
      shellStreams.delete(res);
    }
  }
}

setInterval(() => {
  for (const res of shellStreams) {
    try {
      res.write(': ping\n\n');
    } catch {
      shellStreams.delete(res);
    }
  }
}, 25000).unref();

/* ── admin API ──────────────────────────────────────────────────────── */

const ADMIN_PASSCODE = String(process.env.PRODDASH_PASSCODE || shellConfig.adminPasscode || '');
/** Session token: regenerating it every boot is fine — admins just re-enter the passcode. */
const adminToken = crypto.randomBytes(24).toString('hex');

function isAuthed(req) {
  if (!ADMIN_PASSCODE) return true;
  const cookies = String(req.headers.cookie || '');
  return cookies.split(';').some((c) => c.trim() === 'proddash_admin=' + adminToken);
}

/** Guard a state-changing admin route. Returns true when the request was refused. */
function refuseAdminWrite(req, res) {
  if (!isAuthed(req)) {
    sendJson(res, 401, { error: 'Enter the admin passcode first.', authRequired: true });
    return true;
  }
  // Requiring application/json forces a CORS preflight that a hostile page
  // on some other origin cannot pass (same reasoning as the reference apps).
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    sendJson(res, 415, { error: 'Send application/json.' });
    return true;
  }
  return false;
}

/** Everything the admin page needs, per module. */
function adminModuleView(id) {
  const man = manifests.get(id);
  const cfg = effectiveConfig(id);
  const values = {};
  const passwordSet = {};
  for (const [key, spec] of Object.entries(man.configSchema || {})) {
    if (spec?.type === 'password') {
      passwordSet[key] = Boolean(cfg[key]);
      values[key] = ''; // never echo secrets back to a browser
    } else {
      values[key] = cfg[key];
    }
  }
  const entry = mounted.get(id);
  return {
    id,
    name: String(man.name || id),
    version: String(man.version || ''),
    description: String(man.description || ''),
    hasServer: Boolean(man.server),
    enabled: isEnabled(id),
    configSchema: man.configSchema || {},
    config: values,
    passwordSet,
    mountError: entry?.error || '',
    health: isEnabled(id) ? moduleHealth(id) : null,
  };
}

/** Coerce and store a config patch according to the module's schema.
    Empty password fields mean "keep what is stored". */
function applyConfigPatch(id, patch) {
  const man = manifests.get(id);
  const current = effectiveConfig(id);
  const next = {};
  for (const [key, spec] of Object.entries(man.configSchema || {})) {
    const type = spec?.type || 'string';
    let value = patch && typeof patch === 'object' && key in patch ? patch[key] : current[key];
    if (type === 'password' && (value === '' || value === undefined || value === null)) {
      value = current[key] || '';
    }
    if (type === 'number') value = Number(value) || 0;
    else if (type === 'boolean') value = Boolean(value);
    else value = value === undefined || value === null ? '' : String(value);
    next[key] = value;
  }
  modulesConfig[id] = { ...moduleState(id), enabled: isEnabled(id), config: next };
  writeJson(MODULES_CONFIG_PATH, modulesConfig);
}

async function handleAdminApi(req, res, urlPath) {
  if (urlPath === '/api/admin/login' && req.method === 'POST') {
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Malformed request.' });
    }
    if (!ADMIN_PASSCODE) return sendJson(res, 200, { ok: true, authRequired: false });
    if (String(body.passcode || '') !== ADMIN_PASSCODE) {
      return sendJson(res, 403, { error: 'Wrong passcode.' });
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `proddash_admin=${adminToken}; Path=/; SameSite=Lax; HttpOnly`,
      'Cache-Control': 'no-store',
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (urlPath === '/api/admin/state' && req.method === 'GET') {
    if (!isAuthed(req)) {
      return sendJson(res, 401, { authRequired: true, authed: false });
    }
    return sendJson(res, 200, {
      authRequired: Boolean(ADMIN_PASSCODE),
      authed: true,
      modules: [...manifests.keys()].sort().map(adminModuleView),
    });
  }

  const m = urlPath.match(/^\/api\/admin\/modules\/([^/]+)\/(config|enabled)$/);
  if (m && req.method === 'PUT') {
    const id = decodeURIComponent(m[1]);
    if (!manifests.has(id)) return sendJson(res, 404, { error: `No module "${id}" is installed.` });
    if (refuseAdminWrite(req, res)) return;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Malformed request.' });
    }
    if (m[2] === 'config') {
      applyConfigPatch(id, body.config);
      remountModule(id); // config changes take effect without a manual restart
    } else {
      const enabled = Boolean(body.enabled);
      modulesConfig[id] = { ...moduleState(id), enabled };
      writeJson(MODULES_CONFIG_PATH, modulesConfig);
      remountModule(id); // mounts when enabled, unmounts (only) otherwise
    }
    broadcastShellEvent('modules-changed', { id });
    return sendJson(res, 200, { ok: true, module: adminModuleView(id) });
  }

  sendJson(res, 404, { error: 'Unknown admin endpoint.' });
}

/* ── module API dispatch ────────────────────────────────────────────── */

function dispatchModuleApi(req, res, id, subPath, search) {
  if (!manifests.has(id)) return sendJson(res, 404, { error: `No module "${id}" is installed.` });
  if (!isEnabled(id)) return sendJson(res, 404, { error: `Module "${id}" is disabled.` });
  const entry = mounted.get(id);
  if (!entry) return sendJson(res, 503, { error: `Module "${id}" is not mounted.` });
  if (entry.error) return sendJson(res, 502, { error: `Module "${id}" failed to start: ${entry.error}` });

  for (const route of entry.routes) {
    if (route.method !== '*' && route.method !== req.method) continue;
    if (route.wildcard) {
      if (subPath === route.path || subPath.startsWith(route.path + '/')) {
        req.wildcard = subPath.slice(route.path.length) || '/';
        req.search = search;
        try {
          route.handler(req, res);
        } catch (err) {
          console.error(`[${id}] route handler threw:`, err);
          if (!res.headersSent) sendJson(res, 500, { error: 'Module error.' });
          else try { res.end(); } catch { /* gone */ }
        }
        return;
      }
    } else if (subPath === route.path) {
      req.search = search;
      try {
        route.handler(req, res);
      } catch (err) {
        console.error(`[${id}] route handler threw:`, err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Module error.' });
        else try { res.end(); } catch { /* gone */ }
      }
      return;
    }
  }
  sendJson(res, 404, { error: `Module "${id}" has no route for ${req.method} ${subPath}` });
}

/* ── static files ───────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve a file from inside baseDir; urlPath is relative to it. */
function serveFile(res, baseDir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad request');
  }
  if (rel === '') rel = 'index.html';
  // Resolve inside baseDir only — never let a crafted path escape the web root.
  const target = path.resolve(baseDir, rel);
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.stat(target, (serr, stat) => {
    const file = !serr && stat.isDirectory() ? path.join(target, 'index.html') : target;
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      const ext = path.extname(file).toLowerCase();
      // Icons can cache; everything else must always revalidate so UI updates
      // reach open dashboards immediately.
      const noCache = ext !== '.png' && ext !== '.ico' && ext !== '.svg' && ext !== '.woff2';
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(data);
    });
  });
}

/* ── request routing ────────────────────────────────────────────────── */

function handleRequest(req, res) {
  let urlPath;
  let search = '';
  try {
    const u = new URL(req.url, 'http://proddash.invalid');
    urlPath = u.pathname;
    search = u.search || '';
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad request');
  }

  /* — shell API — */
  if (urlPath === '/api/modules' && req.method === 'GET') {
    const list = [...manifests.keys()].filter(isEnabled).map(clientManifest);
    return sendJson(res, 200, { modules: list });
  }

  /* — shell events: open dashboards learn about admin changes live — */
  if (urlPath === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    try { req.socket.setKeepAlive(true, 15000); } catch { /* gone */ }
    shellStreams.add(res);
    req.on('close', () => shellStreams.delete(res));
    return;
  }

  /* — admin API — */
  if (urlPath.startsWith('/api/admin/')) {
    handleAdminApi(req, res, urlPath).catch((err) => {
      console.error('[proddash] admin API error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
      else try { res.end(); } catch { /* gone */ }
    });
    return;
  }

  /* — module APIs: /api/modules/<id>/… (any method; modules decide) — */
  const apiMatch = urlPath.match(/^\/api\/modules\/([^/]+)(\/.*)?$/);
  if (apiMatch) {
    const id = decodeURIComponent(apiMatch[1]);
    const subPath = apiMatch[2] || '/';
    return dispatchModuleApi(req, res, id, subPath, search);
  }

  if (urlPath.startsWith('/api/')) {
    return sendJson(res, 404, { error: 'Unknown endpoint.' });
  }

  /* — static — */
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end('Method not allowed');
  }

  /* module client assets: /modules/<id>/… */
  const assetMatch = urlPath.match(/^\/modules\/([^/]+)(\/.*)?$/);
  if (assetMatch) {
    const id = decodeURIComponent(assetMatch[1]);
    const man = manifests.get(id);
    if (!man || !isEnabled(id)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    return serveFile(res, man.dir, assetMatch[2] || '/');
  }

  serveFile(res, PUBLIC_DIR, urlPath);
}

const server = http.createServer((req, res) => {
  // Everything is guarded: one throw must never take the dashboard down mid-service.
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('[proddash] request error:', err);
    try {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    } catch { /* connection already gone */ }
  }
});

// Never time out long-lived SSE connections.
server.requestTimeout = 0;

/* ── boot ───────────────────────────────────────────────────────────── */

discoverModules();
mountAllModules();

server.listen(PORT, '0.0.0.0', () => {
  console.log('ProdDash running');
  console.log('  Local       : http://localhost:' + PORT);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log('  Network     : http://' + iface.address + ':' + PORT);
      }
    }
  }
  const ids = [...manifests.keys()];
  console.log(ids.length
    ? '  Modules     : ' + ids.map((id) => id + (isEnabled(id) ? '' : ' (disabled)')).join(', ')
    : '  Modules     : none installed');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const id of [...mounted.keys()]) unmountModule(id);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
