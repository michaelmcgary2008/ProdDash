#!/usr/bin/env node
/**
 * ProdDash — modular production dashboard for Waters Church.
 *
 * Shell server: serves the dashboard client from public/, discovers modules
 * in modules/, mounts each enabled module's server routes under
 * /api/modules/<id>/, and stores server-side module config + named layouts
 * in a per-machine data directory (see DATA_DIR below) so that updating the
 * checkout never loses them.
 *
 * Zero dependencies — Node built-ins only (Node 18+ for global fetch).
 * Configure via config/proddash.json (defaults, in the repo), an optional
 * proddash.json in the data directory (this machine's overrides), or env vars:
 *   PORT               (default: value in proddash.json, else 24500)
 *   PRODDASH_PASSCODE  (overrides adminPasscode in proddash.json)
 *   PRODDASH_DATA_DIR  (where module config + layouts are kept; see below)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUNDLED_MODULES_DIR = path.join(ROOT, 'modules'); // modules that ship with the checkout
/** Checked-in defaults (proddash.json) — and where runtime state used to live. */
const REPO_CONFIG_DIR = path.join(ROOT, 'config');

/* ── data directory ─────────────────────────────────────────────────── */

/**
 * Everything the app writes — module config (connection settings, API keys,
 * enabled flags) and named layouts — lives in a per-machine data directory
 * OUTSIDE the checkout. Pulling, re-cloning or resetting the app folder from
 * main therefore never touches it, and nothing has to be re-entered in /admin.
 *
 *   PRODDASH_DATA_DIR   overrides the location. A relative path resolves
 *                       against the app folder ("config" = the old in-repo spot).
 *   default             Windows  %APPDATA%\ProdDash
 *                       macOS    ~/Library/Application Support/ProdDash
 *                       other    $XDG_CONFIG_HOME/proddash, else ~/.config/proddash
 *
 * If the directory cannot be created or written, the server says so and
 * falls back to the in-repo config/ folder rather than refusing to start.
 */
function defaultDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ProdDash');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ProdDash');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'proddash');
}

function resolveDataDir() {
  const fromEnv = String(process.env.PRODDASH_DATA_DIR || '').trim();
  const dir = fromEnv ? path.resolve(ROOT, fromEnv) : defaultDataDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch (err) {
    console.warn(`[proddash] cannot use data directory ${dir} (${err.message}) — falling back to ${REPO_CONFIG_DIR}`);
    return REPO_CONFIG_DIR;
  }
}

const DATA_DIR = resolveDataDir();
const MODULES_CONFIG_PATH = path.join(DATA_DIR, 'modules.json');
const LAYOUTS_DIR = path.join(DATA_DIR, 'layouts');
const INSTALLED_MODULES_DIR = path.join(DATA_DIR, 'modules'); // modules installed from the admin page

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

/**
 * One-time move-in. Earlier versions kept modules.json and layouts/ inside the
 * repo's config/ folder; if the data directory has none yet and those files
 * exist, copy them across (the originals are left alone).
 */
function migrateLegacyState() {
  if (DATA_DIR === REPO_CONFIG_DIR) return;
  const moved = [];
  const oldModules = path.join(REPO_CONFIG_DIR, 'modules.json');
  if (!fs.existsSync(MODULES_CONFIG_PATH) && fs.existsSync(oldModules)) {
    try {
      fs.copyFileSync(oldModules, MODULES_CONFIG_PATH);
      moved.push('modules.json');
    } catch (err) {
      console.warn(`[proddash] could not copy ${oldModules} into the data directory: ${err.message}`);
    }
  }
  const oldLayouts = path.join(REPO_CONFIG_DIR, 'layouts');
  let oldFiles = [];
  try {
    oldFiles = fs.readdirSync(oldLayouts).filter((f) => f.endsWith('.json'));
  } catch { /* none to move */ }
  let haveLayouts = false;
  try {
    haveLayouts = fs.readdirSync(LAYOUTS_DIR).some((f) => f.endsWith('.json'));
  } catch { /* no layouts dir yet */ }
  if (oldFiles.length && !haveLayouts) {
    try {
      fs.mkdirSync(LAYOUTS_DIR, { recursive: true });
      for (const f of oldFiles) fs.copyFileSync(path.join(oldLayouts, f), path.join(LAYOUTS_DIR, f));
      moved.push(`${oldFiles.length} layout${oldFiles.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.warn(`[proddash] could not copy layouts into the data directory: ${err.message}`);
    }
  }
  if (moved.length) {
    console.log(`[proddash] moved ${moved.join(' and ')} from ${REPO_CONFIG_DIR} into ${DATA_DIR}`);
  }
}
migrateLegacyState();

/** Shell settings: checked-in defaults, then this machine's overrides on top. */
const shellConfig = {
  ...readJson(path.join(REPO_CONFIG_DIR, 'proddash.json'), {}),
  ...readJson(path.join(DATA_DIR, 'proddash.json'), {}),
};
const PORT = Number(process.env.PORT || shellConfig.port || 24500);

/* ── shell version & version ranges ─────────────────────────────────── */

/** The shell's own version, from package.json. Modules declare the range
    they need in their manifest ("proddash": ">=1.1.0"). */
const SHELL_VERSION = String(readJson(path.join(ROOT, 'package.json'), {}).version || '0.0.0');

function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

/** -1 / 0 / 1 like a comparator; unparseable versions sort lowest. */
function compareVersions(a, b) {
  const pa = parseVersion(a) || [-1, 0, 0];
  const pb = parseVersion(b) || [-1, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Does `version` satisfy `range`? Ranges are deliberately small: "" or "*"
 * (anything), "1.2.0" (exact), ">=1.2.0", ">1.2.0", "<=…", "<…",
 * "^1.2.0" (same major, at least that), "~1.2.0" (same minor, at least
 * that), and space-separated combinations such as ">=1.1.0 <2.0.0".
 */
function satisfiesVersion(version, range) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  const v = parseVersion(version);
  if (!v) return false;
  return r.split(/[\s,]+/).filter(Boolean).every((part) => {
    const m = part.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+)\.(\d+)(?:\.(\d+))?$/);
    if (!m) return false;
    const t = [Number(m[2]), Number(m[3]), Number(m[4] || 0)];
    const c = compareVersions(v.join('.'), t.join('.'));
    switch (m[1] || '=') {
      case '>=': return c >= 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      case '<': return c < 0;
      case '^': return v[0] === t[0] && c >= 0;
      case '~': return v[0] === t[0] && v[1] === t[1] && c >= 0;
      default: return c === 0;
    }
  });
}

function requirementNote(range) {
  return `Requires ProdDash ${range} — this is ${SHELL_VERSION}`;
}

/** Per-module server-wide state: { "<id>": { enabled: bool, config: {…} } } */
let modulesConfig = readJson(MODULES_CONFIG_PATH, {});

/* ── module discovery ───────────────────────────────────────────────── */

/** @type {Map<string, object>} module id -> manifest (with .dir added) */
const manifests = new Map();

/** Read every valid manifest in one modules folder. */
function readManifests(baseDir, source) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  } catch {
    return out; // folder missing — fine
  }
  for (const dir of dirs) {
    const manifestPath = path.join(baseDir, dir, 'module.json');
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
    man.dir = path.join(baseDir, dir);
    man.source = source;
    man.requires = String(man.proddash || '').trim();
    // A module built for a newer shell is listed (so admin can explain) but never loaded.
    man.incompatible = satisfiesVersion(SHELL_VERSION, man.requires) ? '' : requirementNote(man.requires);
    out.push(man);
  }
  return out;
}

/**
 * Modules come from two places: the ones bundled with this checkout
 * (modules/) and the ones installed from the admin page (the data
 * directory's modules/). Same id in both → the newer version runs; a
 * downloaded copy the bundled one has since overtaken is removed. A bundled
 * module the admin page "uninstalled" stays on disk (it belongs to the app
 * folder) but is left out here.
 */
function discoverModules() {
  manifests.clear();
  const bundled = new Map(readManifests(BUNDLED_MODULES_DIR, 'bundled').map((m) => [m.id, m]));
  const installed = new Map(readManifests(INSTALLED_MODULES_DIR, 'installed').map((m) => [m.id, m]));
  for (const [id, man] of bundled) {
    if (isUninstalled(id)) continue;
    const copy = installed.get(id);
    if (copy && compareVersions(copy.version, man.version) >= 0) continue; // the copy wins, below
    if (copy) {
      console.log(`[proddash] ${id}: bundled v${man.version} supersedes the installed v${copy.version} — removing that copy`);
      try { fs.rmSync(copy.dir, { recursive: true, force: true }); } catch { /* it just stays unused */ }
      installed.delete(id);
    }
    manifests.set(id, man);
  }
  for (const [id, man] of installed) {
    if (manifests.has(id)) continue;
    man.bundledVersion = String(bundled.get(id)?.version || '');
    manifests.set(id, man);
  }
}

function isUninstalled(id) {
  return moduleState(id).uninstalled === true;
}

function moduleState(id) {
  const s = modulesConfig[id];
  return s && typeof s === 'object' ? s : {};
}

function isEnabled(id) {
  return moduleState(id).enabled !== false; // newly dropped modules default to enabled
}

/** Enabled and runnable on this shell version — what dashboards may load. */
function isActive(id) {
  const man = manifests.get(id);
  return Boolean(man) && isEnabled(id) && !man.incompatible;
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
 *   tiles({ config, log })  -> optional, sync or async: the tiles this module
 *                              presents in the Add-tile picker, e.g.
 *                              [{ id, name, description, settings, minSize,
 *                                 defaultSize }]. Called on every picker load,
 *                              so the list may be dynamic (discovered timers,
 *                              admin-configured pages). Omitted or empty →
 *                              the module appears once, as before.
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
  if (man.incompatible) {
    entry.error = man.incompatible;
    return;
  }
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
    if (typeof mod.tiles === 'function') {
      entry.tiles = () => mod.tiles({ config, log });
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

/** One entry of a module's tile list, with everything untrusted dropped. */
function sanitizeTileEntry(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id || !raw.name) return null;
  const out = {
    id: String(raw.id),
    name: String(raw.name),
    description: raw.description ? String(raw.description) : '',
    settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
  };
  for (const key of ['minSize', 'defaultSize']) {
    const size = raw[key];
    if (size && Number(size.w) > 0 && Number(size.h) > 0) {
      out[key] = { w: Number(size.w), h: Number(size.h) };
    }
  }
  return out;
}

/**
 * The tiles a module presents in the picker. A module's tiles() runs on every
 * picker load so the list can be live data — but a hung or throwing module
 * must never stall the picker, so it gets a short deadline and any failure
 * falls back to the classic single entry (empty list).
 */
async function moduleTiles(id) {
  const man = manifests.get(id);
  const entry = mounted.get(id);
  let list = Array.isArray(man.tiles) ? man.tiles : []; // static, for client-only modules
  if (entry?.tiles) {
    try {
      const dynamic = await Promise.race([
        Promise.resolve(entry.tiles()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('tiles() timed out')), 2000).unref()),
      ]);
      if (Array.isArray(dynamic)) list = dynamic;
    } catch (err) {
      console.error(`[proddash] module "${id}" tiles() failed:`, err?.message || err);
      list = [];
    }
  }
  return list.map(sanitizeTileEntry).filter(Boolean).slice(0, 100);
}

/** Manifest as sent to the dashboard client (enabled modules only). */
async function clientManifest(id) {
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
    instanceGroups: man.instanceGroups && typeof man.instanceGroups === 'object' ? man.instanceGroups : {},
    hasServer: Boolean(man.server),
    config: clientConfig(id),
    tiles: await moduleTiles(id),
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

/* ── the repo: module catalog and shell updates ──────────────────────── */

/* The admin page installs modules from, and updates the shell against, the
   ProdDash repository on GitHub — one small tar.gz of the branch, fetched at
   most every few minutes, parsed here with no dependencies. Nothing is
   contacted unless someone opens the admin page or the periodic update
   check runs; every failure is recorded and shown, never thrown at a page. */

function parseRepoSetting(value, fallbackBranch) {
  const m = String(value || '').trim().match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#([\w./-]+))?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], branch: m[3] || fallbackBranch || 'main' };
}

const REPO = parseRepoSetting(process.env.PRODDASH_REPO || shellConfig.repo, shellConfig.branch)
  || parseRepoSetting('michaelmcgary2008/ProdDash', 'main');
/** Where branch archives come from; tests point this at a local mock. */
const ARCHIVE_BASE = String(process.env.PRODDASH_ARCHIVE_BASE || 'https://codeload.github.com').replace(/\/+$/, '');
const REMOTE_TTL_MS = 10 * 60 * 1000;
const REMOTE_CHECK_MS = 6 * 60 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;

function tarballUrl() {
  return `${ARCHIVE_BASE}/${REPO.owner}/${REPO.repo}/tar.gz/${encodeURIComponent(REPO.branch)}`;
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function safeJson(buf) {
  try { return buf ? JSON.parse(buf.toString('utf8')) : null; } catch { return null; }
}

/** A relative path that can only land inside the folder it is joined to. */
function safeRelPath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.includes('\0')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/* — a minimal tar reader: regular files, GNU long names, pax headers — */

function cstr(buf, start, len) {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul === -1 ? len : nul).toString('utf8');
}

/** pax records look like "27 path=some/long/name\n" (length counts itself). */
function parsePaxRecords(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    const sp = buf.indexOf(0x20, pos);
    if (sp === -1) break;
    const len = parseInt(buf.subarray(pos, sp).toString(), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.subarray(sp + 1, pos + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    pos += len;
  }
  return out;
}

function parseTar(buf) {
  const files = new Map();
  let comment = '';
  let pendingName = null;
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break; // end-of-archive blocks
    const size = parseInt(cstr(h, 124, 12).trim() || '0', 8) || 0;
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const prefix = cstr(h, 257, 6).startsWith('ustar') ? cstr(h, 345, 155) : '';
    const shortName = prefix ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { pendingName = cstr(data, 0, size); continue; }        // GNU long name
    if (type === 'g' || type === 'x') {                                          // pax headers
      const rec = parsePaxRecords(data);
      if (rec.comment && !comment) comment = String(rec.comment).trim();       // GitHub: the commit sha
      if (type === 'x' && rec.path) pendingName = rec.path;
      continue;
    }
    const name = pendingName || shortName;
    pendingName = null;
    if (type === '0') files.set(name, Buffer.from(data));
  }
  return { files, comment };
}

/** Download the branch archive → { files: Map<relative path, Buffer>, sha }. */
async function fetchArchive() {
  const res = await fetch(tarballUrl(), {
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': `ProdDash/${SHELL_VERSION}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${REPO.owner}/${REPO.repo}@${REPO.branch}`);
  const gz = Buffer.from(await res.arrayBuffer());
  if (gz.length > MAX_ARCHIVE_BYTES) throw new Error('archive is unexpectedly large');
  const { files, comment } = parseTar(zlib.gunzipSync(gz));
  const stripped = new Map(); // drop the archive's single top-level folder
  for (const [p, data] of files) {
    const i = p.indexOf('/');
    if (i > 0 && i < p.length - 1) stripped.set(p.slice(i + 1), data);
  }
  return { files: stripped, sha: /^[0-9a-f]{7,40}$/.test(comment) ? comment : '' };
}

/** What we last learned about the repo. */
let remote = { checkedAt: 0, checking: null, error: '', sha: '', version: '', modules: new Map(), files: null };

async function refreshRemote(force = false) {
  const fresh = remote.checkedAt && Date.now() - remote.checkedAt < REMOTE_TTL_MS;
  if (!force && fresh && !remote.error) return remote;
  if (remote.checking) return remote.checking;
  const job = (async () => {
    try {
      const { files, sha } = await fetchArchive();
      const pkg = safeJson(files.get('package.json'));
      const modules = new Map();
      for (const [p, data] of files) {
        const m = p.match(/^modules\/([^/]+)\/(.+)$/);
        if (!m) continue;
        const entry = modules.get(m[1]) || { id: m[1], manifest: null, files: new Map() };
        entry.files.set(m[2], data);
        modules.set(m[1], entry);
      }
      for (const [id, entry] of modules) {
        const man = safeJson(entry.files.get('module.json'));
        if (!man || typeof man !== 'object' || (man.id && man.id !== id) || !man.client) {
          modules.delete(id);
          continue;
        }
        entry.manifest = { ...man, id };
      }
      remote = { checkedAt: Date.now(), checking: null, error: '', sha, version: String(pkg?.version || ''), modules, files };
    } catch (err) {
      remote = { ...remote, checkedAt: Date.now(), checking: null, error: err?.message || String(err) };
    }
    return remote;
  })();
  remote.checking = job;
  return job;
}

/* — this checkout — */

function git(args, timeout = 15000) {
  // fileMode=false: a chmod (e.g. making the launcher executable) is not a local change
  return execFileSync('git', ['-c', 'core.fileMode=false', ...args], { cwd: ROOT, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function localGitInfo() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return { isGit: false, sha: '', branch: '', dirty: false, error: '' };
  try {
    const porcelain = git(['status', '--porcelain']).split('\n').filter((l) => l && !l.startsWith('??'));
    return { isGit: true, sha: git(['rev-parse', 'HEAD']), branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: porcelain.length > 0, error: '' };
  } catch (err) {
    return { isGit: true, sha: '', branch: '', dirty: false, error: (err?.message || String(err)).split('\n')[0] };
  }
}

function shellStatus() {
  const local = localGitInfo();
  const versionCmp = remote.version ? compareVersions(remote.version, SHELL_VERSION) : 0;
  const versionBehind = versionCmp > 0;
  const sameCommit = !local.sha || !remote.sha || local.sha.startsWith(remote.sha) || remote.sha.startsWith(local.sha);
  const commitsBehind = !sameCommit && versionCmp >= 0;
  let blocker = '';
  if (local.isGit) {
    if (local.error) blocker = `git is not usable here (${local.error})`;
    else if (local.branch !== REPO.branch) blocker = `this checkout is on branch "${local.branch}", not "${REPO.branch}"`;
    else if (local.dirty) blocker = 'this checkout has local changes — commit or discard them first';
  }
  const gh = `https://github.com/${REPO.owner}/${REPO.repo}`;
  return {
    version: SHELL_VERSION,
    repo: `${REPO.owner}/${REPO.repo}`,
    branch: REPO.branch,
    local: { isGit: local.isGit, sha: local.sha, branch: local.branch, dirty: local.dirty },
    remote: { version: remote.version, sha: remote.sha, checkedAt: remote.checkedAt, error: remote.error },
    updateAvailable: versionBehind || commitsBehind,
    versionBehind,
    method: local.isGit ? 'git' : 'archive',
    updateBlocker: blocker,
    changesUrl: local.sha && remote.sha
      ? `${gh}/compare/${local.sha.slice(0, 12)}...${remote.sha.slice(0, 12)}`
      : `${gh}/commits/${REPO.branch}`,
  };
}

/* — the catalog: what could be installed or updated — */

function catalogView() {
  const available = [];
  const updates = [];
  const hiddenBundled = readManifests(BUNDLED_MODULES_DIR, 'bundled').filter((m) => isUninstalled(m.id));
  const seen = new Set();
  for (const [id, entry] of remote.modules) {
    const man = entry.manifest;
    seen.add(id);
    const requires = String(man.proddash || '').trim();
    const compatible = satisfiesVersion(SHELL_VERSION, requires);
    const base = {
      id,
      name: String(man.name || id),
      version: String(man.version || ''),
      description: String(man.description || ''),
      requires,
      compatible,
      reason: compatible ? '' : requirementNote(requires),
    };
    const installed = manifests.get(id);
    if (installed) {
      if (compareVersions(man.version, installed.version) > 0) {
        updates.push({ ...base, installedVersion: String(installed.version || ''), source: 'repo' });
      }
    } else {
      const hidden = hiddenBundled.find((m) => m.id === id);
      const useBundled = hidden && compareVersions(hidden.version, man.version) >= 0;
      available.push({ ...base, source: useBundled ? 'bundled' : 'repo' });
    }
  }
  for (const m of hiddenBundled) {
    if (seen.has(m.id)) continue;
    available.push({
      id: m.id, name: String(m.name || m.id), version: String(m.version || ''), description: String(m.description || ''),
      requires: m.requires, compatible: !m.incompatible, reason: m.incompatible, source: 'bundled',
    });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { available: available.sort(byName), updates: updates.sort(byName) };
}

/** Install (or update) a module from the repo, or bring back a bundled one. */
async function installModule(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw httpError(400, 'Bad module id.');
  await refreshRemote(false);
  const remoteEntry = remote.modules.get(id) || null;
  const bundledMan = readManifests(BUNDLED_MODULES_DIR, 'bundled').find((m) => m.id === id) || null;
  const installedMan = readManifests(INSTALLED_MODULES_DIR, 'installed').find((m) => m.id === id) || null;
  if (!remoteEntry && !bundledMan && !installedMan) {
    throw httpError(404, remote.error
      ? `"${id}" is not here and the repo could not be reached: ${remote.error}`
      : `"${id}" is not in ${REPO.owner}/${REPO.repo}.`);
  }
  // End up with the newest copy: what the repo offers vs what is already here.
  const haveVersion = installedMan?.version || bundledMan?.version || '';
  const download = Boolean(remoteEntry) && (!(bundledMan || installedMan) || compareVersions(remoteEntry.manifest.version, haveVersion) > 0);
  const man = download ? remoteEntry.manifest : (installedMan || bundledMan);
  const requires = String(man.proddash || '').trim();
  if (!satisfiesVersion(SHELL_VERSION, requires)) {
    throw httpError(409, `${man.name || id} ${requirementNote(requires).replace('Requires', 'requires')}. Update ProdDash first.`);
  }
  if (download) {
    const staging = path.join(INSTALLED_MODULES_DIR, `.${id}.installing`);
    fs.rmSync(staging, { recursive: true, force: true });
    for (const [rel, data] of remoteEntry.files) {
      if (!safeRelPath(rel)) continue;
      const target = path.join(staging, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    const dest = path.join(INSTALLED_MODULES_DIR, id);
    unmountModule(id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  }
  const state = { ...moduleState(id) };
  delete state.uninstalled;
  modulesConfig[id] = state;
  writeJson(MODULES_CONFIG_PATH, modulesConfig);
  discoverModules();
  remountModule(id);
  broadcastShellEvent('modules-changed', { id });
  const now = manifests.get(id);
  console.log(`[proddash] ${download ? 'installed' : 'restored'} module "${id}" v${now?.version || '?'} (${now?.source || 'unknown'})`);
  return { id, version: String(now?.version || ''), source: now?.source || '', downloaded: download };
}

/** Remove a module: an installed copy is deleted; a bundled one is switched
    off and hidden (its folder belongs to the app). Settings are kept so a
    later reinstall picks them up again. */
function uninstallModule(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw httpError(400, 'Bad module id.');
  const installedDir = path.join(INSTALLED_MODULES_DIR, id);
  const hadInstalled = fs.existsSync(path.join(installedDir, 'module.json'));
  const hasBundled = fs.existsSync(path.join(BUNDLED_MODULES_DIR, id, 'module.json'));
  if (!manifests.has(id) && !hadInstalled && !hasBundled) throw httpError(404, `No module "${id}" is installed.`);
  unmountModule(id);
  if (hadInstalled) fs.rmSync(installedDir, { recursive: true, force: true });
  modulesConfig[id] = { ...moduleState(id), uninstalled: true };
  writeJson(MODULES_CONFIG_PATH, modulesConfig);
  discoverModules();
  broadcastShellEvent('modules-changed', { id });
  console.log(`[proddash] uninstalled module "${id}"${hadInstalled ? ' (files removed)' : ''}${hasBundled ? ' (bundled copy hidden)' : ''}`);
  return { id, removedFiles: hadInstalled, bundled: hasBundled };
}

/* — updating the shell itself — */

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/**
 * Bring the app folder up to the repo's branch. A git checkout gets
 * `git pull --ff-only`; anything else has the archive unpacked over it
 * (runtime state and .git are never touched). The caller restarts.
 */
async function updateShell() {
  await refreshRemote(true);
  if (remote.error) throw httpError(502, `Couldn't reach ${REPO.owner}/${REPO.repo}: ${remote.error}`);
  const status = shellStatus();
  if (status.updateBlocker) throw httpError(409, `Can't update from here: ${status.updateBlocker}.`);
  if (!status.updateAvailable) throw httpError(409, 'Already up to date.');
  if (status.local.isGit) {
    const out = git(['pull', '--ff-only', 'origin', REPO.branch], 120000);
    console.log('[proddash] git pull:', out.split('\n').filter(Boolean).slice(-2).join(' | '));
  } else {
    const keep = (rel) => rel === 'config/modules.json' || rel.startsWith('config/layouts/') || rel.startsWith('.git/');
    const staging = path.join(ROOT, '.proddash-update');
    fs.rmSync(staging, { recursive: true, force: true });
    for (const [rel, data] of remote.files) {
      if (!safeRelPath(rel) || keep(rel)) continue;
      const target = path.join(staging, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    if (!fs.existsSync(path.join(staging, 'server.js'))) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw httpError(502, 'The downloaded archive does not look like ProdDash (no server.js).');
    }
    copyTree(staging, ROOT);
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { from: SHELL_VERSION, to: remote.version || '', method: status.method };
}

/**
 * Exit so the new code runs. Exit code 75 tells a launcher loop to start us
 * again; when nothing is supervising (PRODDASH_LAUNCHER unset) we start our
 * own replacement, which waits for this port to free up.
 */
function restartServer(reason) {
  console.log(`[proddash] ${reason} — restarting ProdDash`);
  for (const id of [...mounted.keys()]) unmountModule(id);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (!process.env.PRODDASH_LAUNCHER) {
      try {
        const child = spawn(process.execPath, process.argv.slice(1), {
          cwd: process.cwd(), env: process.env, detached: true, stdio: 'inherit',
        });
        child.unref();
      } catch (err) {
        console.error('[proddash] could not start the new ProdDash — start it by hand:', err?.message || err);
      }
    }
    process.exit(75);
  };
  server.close(finish);
  setTimeout(finish, 1500).unref();
}

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
    source: man.source || 'bundled',
    requires: man.requires || '',
    incompatible: man.incompatible || '',
    enabled: isEnabled(id),
    configSchema: man.configSchema || {},
    configGroups: man.configGroups && typeof man.configGroups === 'object' ? man.configGroups : {},
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
    else if (type === 'boolean' || type === 'switch') value = Boolean(value);
    else if (type === 'endpoint') {
      const src = value && typeof value === 'object' ? value : {};
      value = {
        host: String(src.host ?? '').trim(),
        port: Math.max(0, Math.min(65535, Math.trunc(Number(src.port)) || 0)),
      };
    } else value = value === undefined || value === null ? '' : String(value);
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
      version: SHELL_VERSION,
      dataDir: DATA_DIR,
      modules: [...manifests.keys()].sort().map(adminModuleView),
    });
  }

  if (urlPath === '/api/admin/catalog' && req.method === 'GET') {
    if (!isAuthed(req)) return sendJson(res, 401, { authRequired: true, authed: false });
    const refresh = new URL(req.url, 'http://proddash.invalid').searchParams.get('refresh') === '1';
    await refreshRemote(refresh);
    return sendJson(res, 200, { shell: shellStatus(), ...catalogView() });
  }

  if (urlPath === '/api/admin/update' && req.method === 'POST') {
    if (refuseAdminWrite(req, res)) return;
    try {
      const result = await updateShell();
      sendJson(res, 200, { ok: true, ...result, restarting: true });
      setTimeout(() => restartServer(`updated ${result.from} → ${result.to || 'latest'} via ${result.method}`), 400);
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.message || String(err) });
    }
    return;
  }

  const install = urlPath.match(/^\/api\/admin\/modules\/([^/]+)\/install$/);
  if (install && req.method === 'POST') {
    if (refuseAdminWrite(req, res)) return;
    try {
      return sendJson(res, 200, { ok: true, ...(await installModule(decodeURIComponent(install[1]))) });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || String(err) });
    }
  }

  const remove = urlPath.match(/^\/api\/admin\/modules\/([^/]+)$/);
  if (remove && req.method === 'DELETE') {
    if (refuseAdminWrite(req, res)) return;
    try {
      return sendJson(res, 200, { ok: true, ...uninstallModule(decodeURIComponent(remove[1])) });
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message || String(err) });
    }
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
    try {
      if (m[2] === 'config') {
        applyConfigPatch(id, body.config);
      } else {
        modulesConfig[id] = { ...moduleState(id), enabled: Boolean(body.enabled) };
        writeJson(MODULES_CONFIG_PATH, modulesConfig);
      }
    } catch (err) {
      return sendJson(res, 500, { error: `Could not save ${MODULES_CONFIG_PATH}: ${err?.message || err}` });
    }
    // Config changes take effect without a manual restart; a toggle mounts when
    // enabled and unmounts (only) otherwise.
    remountModule(id);
    broadcastShellEvent('modules-changed', { id });
    return sendJson(res, 200, { ok: true, module: adminModuleView(id) });
  }

  sendJson(res, 404, { error: 'Unknown admin endpoint.' });
}

/* ── named layouts (JSON files under <data dir>/layouts/) ───────────── */

/** Names double as file names — keep them boring on purpose. */
function layoutNameOk(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _()-]{0,39}$/.test(name);
}

function layoutPath(name) {
  return path.join(LAYOUTS_DIR, name + '.json');
}

/** Keep only the fields a layout is made of; everything else is dropped. */
function sanitizeLayout(raw) {
  const tiles = Array.isArray(raw?.tiles) ? raw.tiles.slice(0, 100) : [];
  return {
    tiles: tiles.map((t) => ({
      id: String(t?.id || ''),
      module: String(t?.module || ''),
      x: Number(t?.x) || 0,
      y: Number(t?.y) || 0,
      w: Number(t?.w) || 1,
      h: Number(t?.h) || 1,
      settings: t?.settings && typeof t.settings === 'object' ? t.settings : {},
    })),
  };
}

async function handleLayoutsApi(req, res, urlPath) {
  if (urlPath === '/api/layouts' && req.method === 'GET') {
    let files = [];
    try {
      files = fs.readdirSync(LAYOUTS_DIR).filter((f) => f.endsWith('.json'));
    } catch { /* no layouts dir yet */ }
    const layouts = [];
    for (const file of files.sort()) {
      const name = file.slice(0, -5);
      const data = readJson(path.join(LAYOUTS_DIR, file), null);
      if (!data) continue;
      let updated = null;
      try { updated = fs.statSync(path.join(LAYOUTS_DIR, file)).mtime.toISOString(); } catch { /* fine */ }
      layouts.push({ name, tiles: Array.isArray(data.tiles) ? data.tiles.length : 0, updated });
    }
    return sendJson(res, 200, { layouts });
  }

  const m = urlPath.match(/^\/api\/layouts\/([^/]+)(\/rename)?$/);
  if (!m) return sendJson(res, 404, { error: 'Unknown endpoint.' });
  let name;
  try {
    name = decodeURIComponent(m[1]);
  } catch {
    return sendJson(res, 400, { error: 'Bad layout name.' });
  }
  if (!layoutNameOk(name)) {
    return sendJson(res, 400, { error: 'Layout names can use letters, numbers, spaces, dashes and parentheses (max 40).' });
  }

  if (!m[2] && req.method === 'GET') {
    const data = readJson(layoutPath(name), null);
    if (!data) return sendJson(res, 404, { error: `No layout named "${name}".` });
    return sendJson(res, 200, { name, layout: sanitizeLayout(data) });
  }

  // Saving is open to every dashboard (volunteers save their booth setups);
  // renaming and deleting are admin actions.
  if (!m[2] && req.method === 'PUT') {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      return sendJson(res, 415, { error: 'Send application/json.' });
    }
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Malformed request.' });
    }
    const layout = sanitizeLayout(body.layout);
    if (!layout.tiles.length) return sendJson(res, 400, { error: 'Refusing to save an empty layout.' });
    try {
      writeJson(layoutPath(name), layout);
    } catch (err) {
      return sendJson(res, 500, { error: `Could not save ${layoutPath(name)}: ${err?.message || err}` });
    }
    return sendJson(res, 200, { ok: true, name });
  }

  if (!m[2] && req.method === 'DELETE') {
    if (!isAuthed(req)) return sendJson(res, 401, { error: 'Enter the admin passcode first.', authRequired: true });
    try {
      fs.unlinkSync(layoutPath(name));
    } catch {
      return sendJson(res, 404, { error: `No layout named "${name}".` });
    }
    return sendJson(res, 200, { ok: true });
  }

  if (m[2] && req.method === 'POST') {
    if (refuseAdminWrite(req, res)) return;
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return sendJson(res, 400, { error: 'Malformed request.' });
    }
    const next = String(body.name || '').trim();
    if (!layoutNameOk(next)) {
      return sendJson(res, 400, { error: 'Layout names can use letters, numbers, spaces, dashes and parentheses (max 40).' });
    }
    if (!fs.existsSync(layoutPath(name))) return sendJson(res, 404, { error: `No layout named "${name}".` });
    if (next !== name && fs.existsSync(layoutPath(next))) {
      return sendJson(res, 409, { error: `A layout named "${next}" already exists.` });
    }
    try {
      fs.renameSync(layoutPath(name), layoutPath(next));
    } catch (err) {
      return sendJson(res, 500, { error: 'Rename failed: ' + (err?.message || err) });
    }
    return sendJson(res, 200, { ok: true, name: next });
  }

  sendJson(res, 405, { error: 'Method not allowed.' });
}

/* ── module API dispatch ────────────────────────────────────────────── */

function dispatchModuleApi(req, res, id, subPath, search) {
  if (!manifests.has(id)) return sendJson(res, 404, { error: `No module "${id}" is installed.` });
  if (!isEnabled(id)) return sendJson(res, 404, { error: `Module "${id}" is disabled.` });
  if (manifests.get(id).incompatible) return sendJson(res, 409, { error: manifests.get(id).incompatible });
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
    Promise.all([...manifests.keys()].filter(isActive).map(clientManifest))
      .then((list) => sendJson(res, 200, { modules: list }))
      .catch((err) => {
        console.error('[proddash] /api/modules failed:', err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
      });
    return;
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

  /* — named layouts — */
  if (urlPath === '/api/layouts' || urlPath.startsWith('/api/layouts/')) {
    handleLayoutsApi(req, res, urlPath).catch((err) => {
      console.error('[proddash] layouts API error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
      else try { res.end(); } catch { /* gone */ }
    });
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
    if (!man || !isActive(id)) {
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

server.on('listening', () => {
  console.log('ProdDash ' + SHELL_VERSION);
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
    ? '  Modules     : ' + ids.map((id) => id + (isEnabled(id) ? '' : ' (disabled)') + (manifests.get(id).incompatible ? ' (needs newer ProdDash)' : '')).join(', ')
    : '  Modules     : none installed');
  console.log('  Settings    : ' + DATA_DIR + (DATA_DIR === REPO_CONFIG_DIR ? '  (inside the app folder)' : ''));
  console.log('  Repo        : ' + REPO.owner + '/' + REPO.repo + '@' + REPO.branch);
});

// A restart hands the port over from the exiting ProdDash: wait for it.
let listenTries = 0;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && listenTries < 30) {
    listenTries += 1;
    if (listenTries === 1) console.log(`[proddash] port ${PORT} is busy — waiting for it (a previous ProdDash may still be shutting down)`);
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 500);
    return;
  }
  console.error('[proddash] cannot start:', err.message || err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0');

// Update check: shortly after boot, then every few hours (the admin page
// shows the result; nothing is installed without someone clicking).
if (!process.env.PRODDASH_NO_REMOTE_CHECK) {
  setTimeout(() => refreshRemote(false).catch(() => {}), 20000).unref();
  setInterval(() => refreshRemote(true).catch(() => {}), REMOTE_CHECK_MS).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const id of [...mounted.keys()]) unmountModule(id);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
