'use strict';

/**
 * ProPresenter Now / Next — server part.
 *
 * Owns the one ProPresenter connection (via propresenter-core, copied here
 * unchanged — it holds every ProPresenter 7/20 quirk) and fans the live
 * view-model out to every tile over SSE. Browsers never talk to
 * ProPresenter directly.
 *
 *   GET /state   → { state: <view-model> }   (instant paint for new tiles)
 *   GET /stream  → SSE, `state` events       (change-detected, heartbeated)
 */

const { createProPresenterClient, clearedViewModel } = require('./propresenter-core');

/** SSE comment ping cadence — keeps idle connections alive through sleepy Wi-Fi. */
const HEARTBEAT_MS = 15000;

/** Set by init(), read by the routes — both are rebuilt together on remount. */
let current = null;

module.exports = {
  init({ config, log }) {
    const streams = new Set();
    // Endpoint config. Legacy flat host/port keys (saved before the endpoint
    // field existed) can only still be present until the admin form is
    // re-saved, so when they exist they win over the endpoint's default.
    const ep = config.propresenter && typeof config.propresenter === 'object' ? config.propresenter : {};
    const host = String(config.host ?? ep.host ?? '');
    const port = Number(config.port ?? ep.port) || 1025;
    const enabled = Boolean(host && port);
    let latest = clearedViewModel();
    let lastFrame = '';

    const client = createProPresenterClient({
      onData(view) {
        latest = view;
        if (!streams.size) return;
        let frame;
        try {
          frame = JSON.stringify(view);
        } catch {
          return;
        }
        // The poll loop emits every tick whether anything changed or not.
        // Broadcasting only real changes keeps idle tiles genuinely idle.
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
      },
    });

    client.configure({
      enabled,
      host,
      port,
      password: String(config.password || ''),
    });

    if (enabled) {
      client.start();
      log(`following ProPresenter at ${host}:${port}`);
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
        clearInterval(heartbeat);
        client.stop();
        for (const res of streams) {
          try { res.end(); } catch { /* already gone */ }
        }
        streams.clear();
        if (current && current.streams === streams) current = null;
      },
      health() {
        if (!enabled) return { status: 'error', message: 'No ProPresenter host configured' };
        if (latest.reachable) return { status: 'ok', message: `Following ${host}:${port}` };
        return {
          status: 'error',
          message: latest.lastError
            ? `ProPresenter unreachable: ${latest.lastError}`
            : 'Trying to reach ProPresenter…',
        };
      },
    };
  },

  routes() {
    return {
      'GET /state': (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ state: current ? current.getLatest() : clearedViewModel() }));
      },

      'GET /stream': (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 3000\n\n');
        const view = current ? current.getLatest() : clearedViewModel();
        res.write(`event: state\ndata: ${JSON.stringify(view)}\n\n`);
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
