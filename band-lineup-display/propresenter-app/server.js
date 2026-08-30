'use strict';

/**
 * The ProPresenter Now / Next display server.
 *
 * Runs in two modes:
 *
 *  STANDALONE — `node server.js`. Owns its own ProPresenter connection, stored in
 *  config.json, configurable from any browser that opens the page.
 *
 *  EMBEDDED — the Band Lineup app passes in the client it is already polling with
 *  (`createDisplayServer({ client })`). One poll loop feeds Band Lineup's own column and
 *  every screen in the building, the band app's UI is the only place the connection is
 *  configured, and this server touches no config file at all. In this mode it must never
 *  stop or reconfigure the client it was handed — doing so would kill the backstage display
 *  mid-service.
 *
 * Either way, browsers get the live view-model over Server-Sent Events, so one install
 * can drive every screen: studios, hallway TVs, green-room tablets.
 *
 * Zero npm dependencies: Node built-ins only (needs Node 18+ for global fetch).
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createProPresenterClient, clearedViewModel, DEFAULT_PP_PORT } = require('../propresenter-core');
const {
  resolveDataDir,
  configPath,
  loadConfig,
  saveConfig,
  viewerAddresses,
  defaultRouteAddress,
} = require('./config');
const { createMdnsResponder } = require('./mdns');

const DEFAULT_PORT = 7654;
const PUBLIC_DIR = path.join(__dirname, 'public');
/** SSE comment ping cadence — keeps idle connections alive through proxies and sleepy Wi-Fi. */
const HEARTBEAT_MS = 15000;
/** Cap on remembered viewer-facing local addresses, so a hostile client can't grow it forever. */
const MAX_OBSERVED = 16;
/**
 * Per-viewer write buffer we tolerate before dropping them. A tablet that locks or a PC that
 * enters modern standby keeps the TCP connection open but stops reading, and res.write()
 * returns false rather than throwing — so without this every frame queues in the main
 * process forever (measured: ~78 MB RSS after two hours of polling for one dead viewer).
 * A healthy screen is brought straight back by the page's own reconnect logic.
 */
const MAX_VIEWER_BACKLOG = 256 * 1024;
/**
 * Caps on live viewers. A building has a dozen screens at most; without a limit anyone who
 * can open sockets can pile up connections inside the Electron main process (300 were
 * accepted before this). Excess connections are REFUSED — an established screen is never
 * dropped to make room for a new one, because the established one is the one someone is
 * watching.
 */
const MAX_STREAMS = 32;
const MAX_STREAMS_PER_IP = 6;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 64 * 1024) {
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

/**
 * Build the display server.
 * @param {object} [options]
 * @param {number} [options.port] TCP port to listen on.
 * @param {object} [options.client] An existing ProPresenter client to mirror (EMBEDDED mode).
 * @param {string} [options.hostKind] Machine-readable host id, e.g. 'band-lineup'.
 * @param {string} [options.hostLabel] Human phrase for the host, shown to viewers.
 * @param {string} [options.mdnsName] Bare label to publish over mDNS; '' disables it.
 * @param {string} [options.dataDir] Where config.json is read/written (standalone only).
 * @param {boolean} [options.readOnly] Refuse settings changes over HTTP.
 */
function createDisplayServer(options = {}) {
  const port = Number.parseInt(String(options.port ?? process.env.PORT ?? DEFAULT_PORT), 10) || DEFAULT_PORT;
  /** Presence of an injected client IS the mode switch. */
  const embedded = Boolean(options.client);
  const hostKind = String(options.hostKind || (embedded ? 'embedded' : 'standalone'));
  const hostLabel = String(options.hostLabel || (embedded ? 'the computer hosting this display' : 'the display server'));
  const mdnsName = options.mdnsName === undefined ? 'nownext' : String(options.mdnsName || '');
  // Embedded callers pass the host app's version; standalone reads its own package.json.
  const appVersion = String(options.appVersion || (() => {
    try {
      return require('./package.json').version || '';
    } catch {
      return '';
    }
  })());

  // Standalone owns a config file; embedded owns nothing on disk (the band app persists the
  // connection itself, so writing a second copy here would only invite the two to disagree).
  const dataDir = embedded ? null : resolveDataDir(options.dataDir);
  let config = embedded ? null : loadConfig(dataDir);

  const readOnly = embedded ? true : (options.readOnly ?? (process.env.PP_DISPLAY_READONLY === '1'));
  const readOnlyReason = embedded ? 'managed-by-host' : (readOnly ? 'locked' : '');

  /** Latest view-model, served to new viewers immediately so screens never start blank. */
  let latest = clearedViewModel();
  /** Serialized copy of the last frame actually broadcast, for change detection. */
  let lastStateFrame = '';
  /** @type {Set<import('http').ServerResponse>} */
  const streams = new Set();
  /** Local addresses that real (non-loopback) viewers actually reached us on. */
  const observed = new Set();
  /**
   * Whether any screen has connected since this server started. Latched HERE, where the
   * fact is known, not sampled by a UI poll — that poll is suppressed for the whole of
   * show mode, so a service where three studios watched for 90 minutes would otherwise
   * look like one where nothing ever connected.
   */
  let everHadViewer = false;
  let peakViewers = 0;
  let defaultRoute = '';
  let heartbeat = null;
  let listening = false;
  let lastServerError = '';
  let mdns = null;

  const client = embedded
    ? options.client
    : createProPresenterClient({
      onData: (view) => {
        publish(view);
      },
    });

  if (!embedded) client.configure(config);

  function broadcast(event, payload) {
    if (!streams.size) return;
    let frame;
    try {
      // Stringify OUTSIDE the per-client loop, and inside the guard: a serialization
      // failure must not escape into the caller (in embedded mode the caller is the poll
      // loop, and a throw there would end polling).
      frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    } catch (err) {
      lastServerError = err instanceof Error ? err.message : String(err);
      return;
    }
    for (const res of streams) {
      try {
        const backlog = res.writableLength || res.socket?.writableLength || 0;
        if (backlog > MAX_VIEWER_BACKLOG) {
          streams.delete(res);
          res.destroy();
          continue;
        }
        res.write(frame);
      } catch {
        streams.delete(res);
      }
    }
  }

  /**
   * Push a fresh view-model to every viewer. In embedded mode this is the ONLY writer of
   * `latest` — the band app calls it from the poll loop's onData. Never throws.
   */
  function publish(view) {
    try {
      latest = view;
      // The poll loop emits every tick whether anything changed or not (~100 frames a
      // minute). Sending only real changes saves each screen a steady few KB/s and keeps
      // idle viewers genuinely idle. New viewers still get `latest` on connect.
      let frame;
      try {
        frame = JSON.stringify(view);
      } catch (err) {
        lastServerError = err instanceof Error ? err.message : String(err);
        return;
      }
      if (frame === lastStateFrame) return;
      lastStateFrame = frame;
      broadcast('state', view);
    } catch (err) {
      lastServerError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Push a fresh connection status to every viewer. Call after anything changes it. */
  function publishStatus() {
    try {
      broadcast('status', publicStatus());
    } catch (err) {
      lastServerError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Ranked list of ways to reach this display, best first. */
  function addressList() {
    const out = [];
    if (mdns && mdns.isPublishing()) {
      out.push({
        url: `http://${mdns.name}:${port}`,
        kind: 'name',
        confirmed: false,
        detail: 'Best bookmark — survives an IP change.',
      });
    }
    for (const entry of viewerAddresses({ defaultRoute, observed: [...observed] })) {
      out.push({
        url: `http://${entry.address}:${port}`,
        kind: 'ip',
        confirmed: entry.confirmed,
        detail: entry.confirmed
          ? 'Confirmed working.'
          : `Network adapter: ${entry.iface}`,
      });
    }
    return out;
  }

  function publicStatus() {
    const info = client.getConfig();
    const addresses = addressList();
    return {
      host: info.host,
      port: info.port || '',
      enabled: info.enabled,
      hasPassword: info.hasPassword,
      reachable: latest.reachable,
      readOnly,
      readOnlyReason,
      hostKind,
      hostLabel,
      hostVersion: appVersion,
      // What to tell a viewer when ProPresenter is not connected. On a locked studio screen
      // "press the gear and type an IP" is advice nobody there can act on.
      setupHint: readOnly
        ? `Nobody needs to do anything here — the connection is set up on ${hostLabel}.`
        : 'Press the gear, then enter the IP address and port of the ProPresenter computer.',
      defaultProPresenterPort: DEFAULT_PP_PORT,
      // Deliberately not published to the network: the absolute config path and the host's
      // adapter names. The host app reads those in-process; a viewer has no use for them.
      configPath: null,
      viewers: streams.size,
      // Screens, not sockets. One machine can hold more than one connection — a reloaded
      // tab whose old stream has not been reaped yet, or two tabs of the same page — and
      // reporting sockets makes the app claim more screens than exist in the building.
      viewerDevices: new Set([...streams].map((res) => res.__viewerIp).filter(Boolean)).size,
      everHadViewer,
      peakViewers,
      displayPort: port,
      mdnsName: mdns && mdns.isPublishing() ? mdns.name : '',
      mdnsConflict: mdns ? mdns.getConflictHost() : '',
      addresses,
      // Kept for older callers/scripts that read a flat list.
      viewerUrls: addresses.filter((entry) => entry.kind === 'ip').map((entry) => entry.url),
    };
  }

  function startPolling() {
    if (embedded) throw new Error('startPolling() is not available in embedded mode.');
    client.configure(config);
    if (!client.start()) {
      publish(clearedViewModel());
      return false;
    }
    return true;
  }

  function stopPolling() {
    if (embedded) throw new Error('stopPolling() is not available in embedded mode.');
    client.stop();
    publish(clearedViewModel());
  }

  function serveStatic(req, res, urlPath) {
    let rel;
    try {
      rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }
    // Resolve inside PUBLIC_DIR only — never let a crafted path escape the web root.
    const target = path.resolve(PUBLIC_DIR, rel);
    if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
      return;
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        // no-store, not no-cache: a wall screen must never run a stale page after an update.
        // Paired with the page's own version-triggered reload, a new build reaches every
        // screen within a poll or two without anyone touching them.
        'Cache-Control': 'no-store, must-revalidate',
      });
      res.end(data);
    });
  }

  /** True if an address belongs to this machine. */
  function isOwnAddress(address) {
    if (!address) return false;
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.address === address) return true;
      }
    }
    return false;
  }

  /**
   * Remember the local address a real viewer reached us on — that beats every ranking
   * heuristic, because it is evidence rather than inference.
   *
   * Requests from this machine to its own LAN address do NOT count: they prove the socket
   * is bound, not that anything else on the network can get through the firewall to it.
   * Labelling those "confirmed working" would be exactly the false reassurance this is
   * meant to replace.
   */
  function noteViewerRoute(req) {
    try {
      const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      if (!remote || remote.startsWith('127.') || remote === '::1') return;
      if (isOwnAddress(remote)) return;
      const local = String(req.socket?.localAddress || '').replace(/^::ffff:/, '');
      if (!local || local.startsWith('127.') || local === '::1') return;
      if (!observed.has(local) && observed.size < MAX_OBSERVED) observed.add(local);
    } catch {
      /* socket already gone */
    }
  }

  /** Hosts we will accept a state-changing request for (blocks DNS-rebinding writes). */
  function hostAllowedForWrite(hostHeader) {
    const raw = String(hostHeader || '').trim().toLowerCase();
    if (!raw) return false;
    // Strip the port; reject anything that isn't a plain host[:port].
    const host = raw.replace(/:\d+$/, '');
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
    if (mdns && mdns.name && host === mdns.name.toLowerCase()) return true;
    return viewerAddresses({ defaultRoute, observed: [...observed] }).some((entry) => entry.address === host);
  }

  /**
   * Guard the two state-changing routes. Reads stay wide open — an unattended wall display
   * must never be gated — but a write has to look like it came from this app's own page.
   *
   * Without this, a plain cross-site form works with no JavaScript and no preflight: a
   * `<form enctype="text/plain">` can post a body that JSON.parse accepts, which is enough
   * to retarget or disconnect a standalone display from any page a volunteer happens to open.
   * Requiring application/json forces a CORS preflight that a hostile origin cannot pass.
   */
  function refuseUnsafeWrite(req, res) {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      sendJson(res, 415, { error: 'Send application/json.' });
      return true;
    }
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') {
      sendJson(res, 403, { error: 'Cross-site requests are not allowed.' });
      return true;
    }
    const origin = req.headers.origin;
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = 'invalid';
      }
      if (!hostAllowedForWrite(originHost)) {
        sendJson(res, 403, { error: 'Cross-site requests are not allowed.' });
        return true;
      }
    }
    if (!hostAllowedForWrite(req.headers.host)) {
      sendJson(res, 403, { error: 'Unrecognised host name for a settings change.' });
      return true;
    }
    return false;
  }

  async function handleApi(req, res, urlPath) {
    if (urlPath === '/api/stream' && req.method === 'GET') {
      const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      if (streams.size >= MAX_STREAMS) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '30' });
        res.end(JSON.stringify({ error: `This display is already serving ${streams.size} screens.` }));
        return true;
      }
      let sameIp = 0;
      for (const existing of streams) {
        if (existing.__viewerIp === remote) sameIp += 1;
      }
      if (sameIp >= MAX_STREAMS_PER_IP) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '30' });
        res.end(JSON.stringify({ error: 'Too many connections from this device.' }));
        return true;
      }
      res.__viewerIp = remote;
      // A browser that vanishes without closing the TCP connection (tab discarded, laptop
      // lid shut, Wi-Fi dropped) leaves a socket the kernel will happily hold for many
      // minutes, which inflates the count the operator reads. Keepalive probes make the
      // OS notice and tear it down.
      try {
        req.socket.setKeepAlive(true, 15000);
      } catch {
        /* socket already gone */
      }
      // Build both payloads BEFORE writing headers: a throw after writeHead becomes an
      // ERR_HTTP_HEADERS_SENT unhandled rejection, which in Electron takes the app down.
      const stateFrame = `event: state\ndata: ${JSON.stringify(latest)}\n\n`;
      const statusFrame = `event: status\ndata: ${JSON.stringify(publicStatus())}\n\n`;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(stateFrame);
      res.write(statusFrame);
      streams.add(res);
      everHadViewer = true;
      peakViewers = Math.max(peakViewers, streams.size);
      req.on('close', () => {
        streams.delete(res);
        // The viewer count changed; tell the remaining screens (and the host UI).
        publishStatus();
      });
      publishStatus();
      return true;
    }

    if (urlPath === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, { state: latest, status: publicStatus() });
      return true;
    }

    if (urlPath === '/api/status' && req.method === 'GET') {
      sendJson(res, 200, publicStatus());
      return true;
    }

    if (urlPath === '/api/playlists' && req.method === 'GET') {
      // The one route that had no guard. Nothing over HTTP needs it: the display page never
      // calls it, and the host app reads playlists in-process over IPC. Left open it hands
      // any unauthenticated client the entire ProPresenter library — not just today's order,
      // but every playlist name, including anything held back or staff-only.
      if (embedded || readOnly) {
        sendJson(res, 409, {
          error: `Playlists are managed on ${hostLabel}.`,
          readOnlyReason,
        });
        return true;
      }
      try {
        sendJson(res, 200, { playlists: await client.listPlaylists() });
      } catch (error) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : 'Could not list playlists.' });
      }
      return true;
    }

    if (urlPath === '/api/connect' && req.method === 'POST') {
      if (embedded) {
        // Hard refuse. Half-completing this would retarget — or silently stop — the poll
        // loop the backstage display itself depends on.
        sendJson(res, 409, {
          error: `This display follows ${hostLabel}. Change the ProPresenter connection there.`,
          readOnlyReason,
        });
        return true;
      }
      if (readOnly) {
        sendJson(res, 403, { error: 'This display is locked. Change the connection on the host machine.' });
        return true;
      }
      if (refuseUnsafeWrite(req, res)) return true;
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)) || '{}');
      } catch {
        sendJson(res, 400, { error: 'Malformed request.' });
        return true;
      }
      const host = String(payload.host || '').trim();
      const portNum = Number.parseInt(String(payload.port ?? ''), 10);
      const ppPort = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 0;
      // An omitted password field keeps the stored one; an empty string clears it.
      const password = payload.password === undefined ? config.password : String(payload.password);
      if (!host || !ppPort) {
        sendJson(res, 400, { error: 'Enter the ProPresenter host (IP) and port.' });
        return true;
      }

      // Test on a throwaway client: pointing the live one at an unverified address would
      // make every screen in the building flash "Reconnecting…" while an operator types.
      const probe = createProPresenterClient();
      probe.configure({ enabled: true, host, port: ppPort, password });
      try {
        await probe.testConnection();
      } catch (error) {
        sendJson(res, 502, { error: error instanceof Error ? error.message : 'Could not reach ProPresenter.' });
        return true;
      }

      config = saveConfig(dataDir, { enabled: true, host, port: ppPort, password });
      client.reset();
      client.stop();
      startPolling();
      publishStatus();
      sendJson(res, 200, { ok: true, status: publicStatus() });
      return true;
    }

    if (urlPath === '/api/disconnect' && req.method === 'POST') {
      if (embedded) {
        sendJson(res, 409, {
          error: `This display follows ${hostLabel}. Disconnect there instead.`,
          readOnlyReason,
        });
        return true;
      }
      if (readOnly) {
        sendJson(res, 403, { error: 'This display is locked. Change the connection on the host machine.' });
        return true;
      }
      if (refuseUnsafeWrite(req, res)) return true;
      stopPolling();
      client.reset();
      // Keep host/port on disk for an easy reconnect; drop the password.
      config = saveConfig(dataDir, { enabled: false, host: config.host, port: config.port, password: '' });
      client.configure({ ...config, password: '' });
      publishStatus();
      sendJson(res, 200, { ok: true, status: publicStatus() });
      return true;
    }

    if (urlPath === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, viewers: streams.size, reachable: latest.reachable });
      return true;
    }

    return false;
  }

  const server = http.createServer((req, res) => {
    // Everything in here runs inside the Electron main process when embedded, so a single
    // unhandled throw would take the whole band app down with it.
    try {
      noteViewerRoute(req);

      let urlPath;
      try {
        // A malformed Host header makes the URL constructor throw. Don't trust it.
        urlPath = new URL(req.url, 'http://display.invalid').pathname;
      } catch {
        sendJson(res, 400, { error: 'Bad request.' });
        return;
      }

      if (urlPath.startsWith('/api/')) {
        handleApi(req, res, urlPath)
          .then((handled) => {
            if (!handled) sendJson(res, 404, { error: 'Unknown endpoint.' });
          })
          .catch((error) => {
            lastServerError = error instanceof Error ? error.message : String(error);
            if (!res.headersSent) {
              sendJson(res, 500, { error: 'Server error.' });
            } else {
              try { res.end(); } catch { /* already gone */ }
            }
          });
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
        return;
      }
      serveStatic(req, res, urlPath);
    } catch (error) {
      lastServerError = error instanceof Error ? error.message : String(error);
      try {
        if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
        else res.end();
      } catch { /* already gone */ }
    }
  });

  // Post-listen errors (a dropped interface, an ECONNRESET storm) must be handled or Node
  // treats them as uncaught. This has to be a persistent handler, not the one-shot reject
  // used by listen(), which is already settled by then.
  server.on('error', (error) => {
    lastServerError = error instanceof Error ? error.message : String(error);
  });
  server.on('clientError', (error, socket) => {
    lastServerError = error instanceof Error ? error.message : String(error);
    try { socket.destroy(); } catch { /* already gone */ }
  });

  async function listen() {
    defaultRoute = await defaultRouteAddress();

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 0.0.0.0 on purpose: the whole point is other screens in the building can open this.
      // NOTE on Windows: this bind is what triggers the Defender Firewall prompt — not the
      // first remote connection. localhost keeps working either way, so the host machine
      // can look perfectly healthy while every studio times out.
      server.listen(port, '0.0.0.0');
    });

    listening = true;
    heartbeat = setInterval(() => {
      for (const res of streams) {
        try {
          if ((res.writableLength || res.socket?.writableLength || 0) > MAX_VIEWER_BACKLOG) {
            streams.delete(res);
            res.destroy();
            continue;
          }
          res.write(': ping\n\n');
        } catch {
          streams.delete(res);
        }
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    if (mdnsName) {
      mdns = createMdnsResponder({
        name: mdnsName,
        getAddresses: () => viewerAddresses({ defaultRoute, observed: [...observed] }).map((entry) => entry.address),
      });
      await mdns.start().catch(() => ({ ok: false }));
    }

    if (embedded) {
      // Seed from the client we were handed so the first viewer sees the live service
      // immediately instead of a blank card.
      latest = client.getViewModel();
    } else if (config.enabled) {
      startPolling();
    }

    return { port, addresses: addressList(), mdnsName: mdns && mdns.isPublishing() ? mdns.name : '' };
  }

  async function close() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (mdns) {
      mdns.stop();
      mdns = null;
    }
    // EMBEDDED: never touch the injected client. Stopping it here would silently kill the
    // backstage Now/Next column every time hosting is switched off or the app quits.
    if (!embedded) client.stop();
    for (const res of streams) {
      try { res.end(); } catch { /* already gone */ }
    }
    streams.clear();
    if (!listening) return;
    listening = false;
    await new Promise((resolve) => {
      // server.close() waits for every connection that isn't *idle* to finish, and a socket
      // that connected without ever completing a request never becomes idle — which is
      // exactly what browser speculative preconnect leaves behind (Safari on iPad, Chrome
      // and Edge on the studio PCs all do it). close() would then never call back, wedging
      // the caller: a port change would stop the old server and never start the new one.
      // Node also cancels its own header/request timeouts during close, so nothing else
      // reaps those sockets. Tear them down ourselves, with a hard bound as a backstop.
      const bail = setTimeout(resolve, 2000);
      bail.unref?.();
      server.close(() => {
        clearTimeout(bail);
        resolve();
      });
      // Safe here: every SSE response was already ended above, so viewers see a clean
      // stream end and reconnect on their own.
      server.closeAllConnections?.();
    });
  }

  return {
    server,
    listen,
    close,
    port,
    dataDir,
    readOnly,
    embedded,
    status: publicStatus,
    addresses: addressList,
    publish,
    publishStatus,
    viewers: () => streams.size,
    isListening: () => listening,
    getLastError: () => lastServerError,
    client,
  };
}

module.exports = { createDisplayServer, DEFAULT_PORT };

// Run directly: node server.js
if (require.main === module) {
  const display = createDisplayServer();
  display
    .listen()
    .then(({ port, addresses, mdnsName }) => {
      const status = display.status();
      console.log(`Stage Now / Next display on http://localhost:${port}`);
      if (mdnsName) console.log(`  bookmark this: http://${mdnsName}:${port}`);
      for (const entry of addresses) console.log(`  ${entry.url}${entry.confirmed ? '  (confirmed working)' : ''}`);
      console.log(`  config: ${display.dataDir ? configPath(display.dataDir) : '(none)'}`);
      console.log(
        status.enabled
          ? `  following ProPresenter at ${status.host}:${status.port}`
          : '  no ProPresenter connection saved yet — open the page and press the gear to set one up',
      );
      if (status.readOnly) console.log('  settings are LOCKED (PP_DISPLAY_READONLY=1)');
    })
    .catch((error) => {
      console.error(`Could not start the display server: ${error.message}`);
      process.exit(1);
    });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      display.close().then(() => process.exit(0));
    });
  }
}
