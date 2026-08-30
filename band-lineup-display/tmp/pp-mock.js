/**
 * Mock ProPresenter 7 network API for verifying the Band Lineup integration
 * without a live ProPresenter. Serves the documented endpoint shapes and a
 * chunked /v1/status/updates stream that advances the active slide on a timer.
 *
 *   node tmp/pp-mock.js [port]      (default 1599)
 *
 * Every incoming request is logged so we can confirm what the app fetches.
 */
const http = require('http');

const PORT = Number.parseInt(process.argv[2] || '1599', 10);
const STEP_MS = Number.parseInt(process.env.PP_STEP_MS || '1500', 10);

// Playlist: header + presentations + a media item + a hidden item.
// `slides` = unique master slides returned by /v1/presentation/{uuid} (what ppCountSlides sees).
// `arr`    = cues the SELECTED arrangement actually plays (what slide_index + thumbnails respect).
// When arr > slides the arrangement repeats a section (e.g. a chorus) — this is the 43/41 case.
const ITEMS = [
  { uuid: 'I0', name: 'Pre-Service Loop', type: 'header', is_hidden: false, is_pco: false },
  { uuid: 'I1', name: 'Welcome', type: 'presentation', is_hidden: false, is_pco: false, slides: 3 },
  { uuid: 'I2', name: 'This Is The Day - [ Full ]', type: 'presentation', is_hidden: false, is_pco: false, slides: 41, arr: 43 },
  { uuid: 'I3', name: 'Sermon: Living Hope', type: 'presentation', is_hidden: false, is_pco: true, slides: 5 },
  { uuid: 'I4', name: 'Bumper Video', type: 'media', is_hidden: false, is_pco: false },
  { uuid: 'I5', name: 'Closing Song', type: 'presentation', is_hidden: false, is_pco: false, slides: 8 },
  { uuid: 'IH', name: 'Hidden Cue', type: 'presentation', is_hidden: true, is_pco: false, slides: 4 },
  { uuid: 'I6', name: 'Benediction', type: 'presentation', is_hidden: false, is_pco: false, slides: 2 },
];
/** Arrangement-expanded cue count for an item (defaults to its master slide count). */
function arrLen(item) {
  return item && item.arr ? item.arr : (item && item.slides ? item.slides : 1);
}
const PLAYLIST = { uuid: 'PL1', name: 'Sunday AM — June 1', index: 0 };

// Only presentation items can be "active". Start on Amazing Grace.
const PRESENTATIONS = ITEMS.filter((it) => it.type === 'presentation');
let activePresIdx = PRESENTATIONS.findIndex((it) => it.uuid === 'I2');
let slide = 0;

function activeItem() {
  return PRESENTATIONS[activePresIdx];
}
function playlistIndexOfActive() {
  return ITEMS.findIndex((it) => it.uuid === activeItem().uuid);
}
function slideIndexPayload() {
  // PP20 shape: top-level `presentation_index`.
  const item = activeItem();
  return {
    presentation_index: {
      index: slide,
      presentation_id: { uuid: item.uuid, name: item.name, index: playlistIndexOfActive() },
    },
  };
}
function presentationPayload(uuid) {
  // PP20 shape: details wrapped under `presentation`.
  const item = ITEMS.find((it) => it.uuid === uuid);
  const n = item && item.slides ? item.slides : 0;
  const slides = Array.from({ length: n }, (_s, i) => ({
    enabled: true,
    notes: '',
    text: `${item ? item.name : ''} — slide ${i + 1}`,
    image: '',
    label: '',
    color: { red: 0, green: 0, blue: 0, alpha: 0 },
  }));
  return {
    presentation: {
      id: { uuid, name: item ? item.name : '', index: 0 },
      name: item ? item.name : '',
      index: 0,
      groups: [{ name: 'Group', color: {}, slides }],
      has_timeline: false,
    },
  };
}
function playlistItemsPayload() {
  // ProPresenter 20 style: items carry id{uuid,name,index} + field_type.
  return {
    id: PLAYLIST,
    items: ITEMS.map((it, index) => ({
      id: { uuid: it.uuid, name: it.name, index },
      field_type: it.type,
      is_hidden: it.is_hidden,
      is_pco: it.is_pco,
    })),
  };
}

function currentItemId() {
  const it = activeItem();
  return { uuid: it.uuid, name: it.name, index: ITEMS.findIndex((x) => x.uuid === it.uuid) };
}
// ProPresenter 20: what's live and what's focused (auto-follow sources).
function activePlaylistPayload() {
  return { presentation: { playlist: PLAYLIST, item: currentItemId() }, announcements: { playlist: null, item: null } };
}
function focusedPlaylistPayload() {
  return { playlist: PLAYLIST, item: currentItemId() };
}

// ProPresenter 20 /v1/playlists returns a tree of groups → playlists.
function playlistsTreePayload() {
  return [
    {
      id: { uuid: 'GRP-SERVICES', name: 'Services', index: 0 },
      field_type: 'group',
      children: [
        { id: { uuid: PLAYLIST.uuid, name: PLAYLIST.name, index: 0 }, field_type: 'playlist', children: [] },
        { id: { uuid: 'PL-OTHER', name: 'Speaker Pics', index: 1 }, field_type: 'playlist', children: [] },
      ],
    },
  ];
}

const subscribers = new Set();
let lastPollAt = 0; // updated when a client polls slide_index, so we also advance under polling clients
function broadcastSlideIndex() {
  const line = JSON.stringify({ url: 'presentation/slide_index', data: slideIndexPayload() }) + '\n';
  for (const res of subscribers) res.write(line);
}

// Advance: walk slides of the active presentation, then jump to the next presentation item.
// Only advance once something is subscribed, so REST snapshots before subscribing are deterministic.
setInterval(() => {
  if (subscribers.size === 0 && Date.now() - lastPollAt > 3000) return;
  const item = activeItem();
  slide += 1;
  if (slide >= arrLen(item)) {
    slide = 0;
    activePresIdx = (activePresIdx + 1) % PRESENTATIONS.length;
    console.log(`[mock] → now presenting "${activeItem().name}"`);
  }
  broadcastSlideIndex();
}, STEP_MS);

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  console.log(`[mock] ${req.method} ${p}`);

  if (p === '/version') return sendJson(res, { name: 'NA-ProP (mock)', platform: 'mac', host_description: 'ProPresenter 20.0.1', api_version: 'v1' });
  if (p === '/v1/playlists') return sendJson(res, playlistsTreePayload());
  if (p === '/v1/playlist/active') return sendJson(res, activePlaylistPayload());
  if (p === '/v1/playlist/focused') return sendJson(res, focusedPlaylistPayload());
  // Simulate PP20: the items list lives at a renamed route (uuid/dot/colon all 404).
  // Services group index 0, First Tuesday index 0 → dash-joined path "0-0".
  if (p === '/v1/playlist/0-0') return sendJson(res, playlistItemsPayload());
  if (p === '/v1/presentation/slide_index') { lastPollAt = Date.now(); return sendJson(res, slideIndexPayload()); }
  // Thumbnail probe: index "respects the selected arrangement" → valid for 0..arrLen-1, else 404.
  const thumb = p.match(/^\/v1\/presentation\/([^/]+)\/thumbnail\/(\d+)$/);
  if (thumb) {
    const item = ITEMS.find((it) => it.uuid === decodeURIComponent(thumb[1]));
    const index = Number.parseInt(thumb[2], 10);
    if (item && index >= 0 && index < arrLen(item)) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // tiny stub JPEG
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'index out of range' }));
  }
  if (p === '/v1/presentation/current' || p === '/v1/presentation/active') return sendJson(res, presentationPayload(activeItem().uuid));
  if (p.startsWith('/v1/presentation/')) {
    const uuid = decodeURIComponent(p.split('/').pop());
    return sendJson(res, presentationPayload(uuid));
  }

  if (p === '/v1/status/updates' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let urls = [];
      try { urls = JSON.parse(body); } catch { /* ignore */ }
      console.log(`[mock] status/updates subscribe: ${JSON.stringify(urls)}`);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      // initial snapshot for each subscribed url
      if (urls.includes('playlist/current')) res.write(JSON.stringify({ url: 'playlist/current', data: PLAYLIST }) + '\n');
      if (urls.includes('presentation/slide_index')) res.write(JSON.stringify({ url: 'presentation/slide_index', data: slideIndexPayload() }) + '\n');
      subscribers.add(res);
      res.on('close', () => subscribers.delete(res));
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] ProPresenter mock API on http://127.0.0.1:${PORT} (slide step ${STEP_MS}ms)`);
});
