#!/usr/bin/env node
/**
 * ProdCom Listener — serves the web UI and proxies requests to the ProdCom API
 * so any browser on the network can connect without CORS issues.
 *
 * Zero dependencies. Configure via config.json or env vars:
 *   PRODCOM_URL  (default: value in config.json)
 *   PORT         (default: value in config.json)
 *   PRODCOM_API_KEY  (only needed if PSK auth is enabled in ProdCom)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, 'config.json');
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.warn('config.json not found or invalid, using defaults/env vars');
}

const PRODCOM_URL = process.env.PRODCOM_URL || cfg.prodcomUrl || 'http://10.3.11.152:24480';
const PORT = Number(process.env.PORT || cfg.port || 24481);
const API_KEY = process.env.PRODCOM_API_KEY || cfg.apiKey || '';

const target = new URL(PRODCOM_URL);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Hop-by-hop headers that must not be forwarded
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function proxy(req, res) {
  const upstreamPath = req.url.slice('/prodcom'.length) || '/';
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = target.host;
  delete headers['accept-encoding']; // keep SSE unbuffered and simple
  if (API_KEY) headers.authorization = 'Bearer ' + API_KEY;

  const preq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: upstreamPath,
      method: req.method,
      headers,
    },
    (pres) => {
      const outHeaders = {};
      for (const [k, v] of Object.entries(pres.headers)) {
        if (!HOP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
      }
      res.writeHead(pres.statusCode, outHeaders);
      // Flush immediately — SSE streams may send no bytes for a while, and
      // the browser needs the headers to consider the stream open.
      res.flushHeaders();
      pres.pipe(res);
      // If ProdCom dies mid-stream, pipe() unpipes on error without ending
      // the browser's response, leaving SSE clients hanging on a dead
      // stream. Destroy it so they notice immediately and reconnect.
      pres.on('close', () => {
        if (!res.writableEnded) res.destroy();
      });
    }
  );

  preq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'ProdCom unreachable', detail: e.code || String(e) }));
  });

  // Tear down the upstream connection when the browser disconnects
  res.on('close', () => preq.destroy());
  req.pipe(preq);
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    // Icons can cache; everything else must always revalidate so UI updates
    // reach installed web apps immediately.
    const noCache = ext !== '.png' && ext !== '.ico' && ext !== '.svg';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/prodcom/')) return proxy(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    return res.end('Method not allowed');
  }
  serveStatic(req, res);
});

// Never time out long-lived SSE connections
server.requestTimeout = 0;

server.listen(PORT, '0.0.0.0', () => {
  console.log('ProdCom Listener running');
  console.log('  ProdCom API : ' + PRODCOM_URL);
  console.log('  Local       : http://localhost:' + PORT);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log('  Network     : http://' + iface.address + ':' + PORT);
      }
    }
  }
});
