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

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(ROOT, 'config');

/* ── config ─────────────────────────────────────────────────────────── */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const shellConfig = readJson(path.join(CONFIG_DIR, 'proddash.json'), {});
const PORT = Number(process.env.PORT || shellConfig.port || 24500);

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

const server = http.createServer((req, res) => {
  // Everything is guarded: one throw must never take the dashboard down mid-service.
  try {
    let urlPath;
    try {
      urlPath = new URL(req.url, 'http://proddash.invalid').pathname;
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad request');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end('Method not allowed');
    }
    serveFile(res, PUBLIC_DIR, urlPath);
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
});
