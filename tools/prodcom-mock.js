/**
 * Mock ProdCom API for verifying the prodcom-transcript module without a
 * live ProdCom. Serves the endpoints the module uses — channels, groups,
 * transcript history and the SSE stream — and simulates live speech:
 * entries appear in progress, grow word by word (same id, in-place update),
 * then complete.
 *
 *   node tools/prodcom-mock.js [port]      (default 24480)
 *
 * Point the module's admin config at http://127.0.0.1:<port>. Kill and
 * restart this process while tiles are open to watch them degrade and
 * recover on their own.
 */
'use strict';

const http = require('http');

const PORT = Number.parseInt(process.argv[2] || '24480', 10);
const STEP_MS = Number.parseInt(process.env.PRODCOM_STEP_MS || '700', 10);

const CHANNELS = [
  { id: 'ch-stage', name: 'Stage', color: '#e0645c' },
  { id: 'ch-foh', name: 'FOH', color: '#5c9de0' },
  { id: 'ch-video', name: 'Video', color: '#5cd08c' },
  { id: 'ch-light', name: 'Lighting', color: '#e0b45c' },
];

const GROUPS = [
  { id: 'g-band', name: 'Band', channelIds: ['ch-stage', 'ch-foh'] },
  { id: 'g-tech', name: 'Tech', channelIds: ['ch-video', 'ch-light'] },
];

const PHRASES = [
  'Standby for the walk-in loop.',
  'Vocals are hot on channel two, trim it down a touch please.',
  'Camera three, give me a slow push on the worship leader.',
  'House to half, stage wash up for the next song.',
  'That was the last chorus, transition cue is next.',
  'Confidence monitor is frozen, refreshing it now.',
  'Great job everyone, that transition was clean.',
  'Pastor is walking up in thirty seconds.',
];

let history = []; // completed + in-progress entries, oldest first
// Unique across mock restarts, so a reconnecting client's dedupe-by-id
// treats post-restart entries as new (like real ProdCom ids would be).
const RUN = Date.now().toString(36);
let nextId = 1;
const streams = new Set();

/** The one in-progress utterance, or null. */
let speaking = null; // { entry, words, at }

function broadcast(entry) {
  const frame = 'data: ' + JSON.stringify({ type: entry.inProgress ? 'transcript.update' : 'transcript.completed', entry }) + '\n\n';
  for (const res of streams) {
    try { res.write(frame); } catch { streams.delete(res); }
  }
}

function stepSimulation() {
  if (!speaking) {
    const channel = CHANNELS[Math.floor(Math.random() * CHANNELS.length)];
    const words = PHRASES[Math.floor(Math.random() * PHRASES.length)].split(' ');
    const entry = {
      id: 'e' + RUN + '-' + nextId++,
      channelId: channel.id,
      channelName: channel.name,
      text: words[0],
      date: new Date().toISOString(),
      inProgress: true,
    };
    speaking = { entry, words, at: 1 };
    history.push(entry);
    if (history.length > 200) history.shift();
    broadcast(entry);
    return;
  }
  const { entry, words } = speaking;
  if (speaking.at < words.length) {
    entry.text = words.slice(0, ++speaking.at).join(' ');
    broadcast(entry);
  } else {
    entry.inProgress = false;
    broadcast(entry);
    console.log(`[prodcom-mock] ${entry.channelName}: ${entry.text}`);
    speaking = null;
  }
}

setInterval(stepSimulation, STEP_MS);

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://x.invalid`);
  const p = url.pathname;

  if (p === '/api/v1/channels') return sendJson(res, { data: CHANNELS });
  if (p === '/api/v1/groups') return sendJson(res, { data: GROUPS });
  if (p === '/api/v1/transcript') {
    const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100;
    return sendJson(res, { data: history.slice(-limit) });
  }
  if (p === '/api/v1/transcript/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    streams.add(res);
    console.log(`[prodcom-mock] stream client connected (${streams.size})`);
    res.on('close', () => {
      streams.delete(res);
      console.log(`[prodcom-mock] stream client left (${streams.size})`);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[prodcom-mock] ProdCom mock API on http://127.0.0.1:${PORT} (step ${STEP_MS}ms)`);
});
