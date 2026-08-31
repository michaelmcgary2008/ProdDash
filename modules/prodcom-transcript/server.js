'use strict';

/**
 * ProdCom Transcript — server part.
 *
 * One wildcard route that proxies /prodcom/* (including the SSE transcript
 * stream) to the ProdCom API configured in the admin page, so browsers never
 * talk to ProdCom directly (no CORS, and the API key never reaches clients).
 * Ported from prodcom-listener/server.js.
 */

const http = require('http');

// Hop-by-hop headers that must not be forwarded
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** Health shown in the admin page: outcome of the most recent proxied request. */
let health = { status: 'connecting', message: 'No traffic yet' };

function proxy(req, res, target, apiKey) {
  const upstreamPath = (req.wildcard || '/') + (req.search || '');
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  headers.host = target.host;
  delete headers['accept-encoding']; // keep SSE unbuffered and simple
  if (apiKey) headers.authorization = 'Bearer ' + apiKey;

  const preq = http.request(
    {
      hostname: target.hostname,
      port: target.port || 80,
      path: upstreamPath,
      method: req.method,
      headers,
    },
    (pres) => {
      health = { status: 'ok', message: `ProdCom reachable (last: HTTP ${pres.statusCode})` };
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
    health = { status: 'error', message: 'ProdCom unreachable: ' + (e.code || String(e)) };
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'ProdCom unreachable', detail: e.code || String(e) }));
  });

  // Tear down the upstream connection when the browser disconnects
  res.on('close', () => preq.destroy());
  req.pipe(preq);
}

module.exports = {
  init({ config }) {
    health = config.prodcomUrl
      ? { status: 'connecting', message: 'No traffic yet' }
      : { status: 'error', message: 'No ProdCom URL configured' };
    return {
      stop() { /* nothing persistent to tear down — streams die with their sockets */ },
      health: () => health,
    };
  },

  routes({ config, log }) {
    // An invalid URL throws here, which surfaces as a mount error in /admin.
    const target = new URL(config.prodcomUrl || 'http://10.3.11.152:24480');
    log(`proxying /prodcom/* → ${target.origin}`);
    return {
      '* /prodcom/*': (req, res) => proxy(req, res, target, config.apiKey || ''),
    };
  },
};
