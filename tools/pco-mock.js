/**
 * Mock Planning Center Services API for developing the pco-plan module
 * without a Planning Center account.
 *
 *   node tools/pco-mock.js [port]            (default 24700)
 *   PCO_PLAN_API_BASE=http://127.0.0.1:24700 node server.js
 *
 * Serves JSON:API shapes matching api.planningcenteronline.com/services/v2:
 *   GET /services/v2/folders                     nested folders (parent rel)
 *   GET /services/v2/folders/{id}
 *   GET /services/v2/service_types               every service type, with its
 *                                                parent folder relationship
 *   GET /services/v2/service_types/{id}
 *   GET /services/v2/service_types/{id}/plans    ?filter=future|past, order,
 *                                                per_page — today's plan,
 *                                                next week's and last week's
 *   GET …/plans/{id}
 *   GET …/plans/{id}/plan_times                  rehearsal + two services; the
 *                                                first service starts 90 s
 *                                                after the mock boots so the
 *                                                "Starts in" state is visible
 *   GET …/plans/{id}/items?include=…             items + Song / Arrangement /
 *                                                ItemNote compound documents
 *
 * Item titles deliberately match band-lineup-display/tmp/pp-mock.js's
 * playlist, so running both mocks exercises the ProPresenter matching.
 *
 * Any request without an Authorization header (Basic or Bearer) gets a
 * Planning-Center-style 401, so a missing/blank credential shows up the way
 * it would in production. Every request is logged.
 */
'use strict';

const http = require('http');

const PORT = Number.parseInt(process.argv[2] || '24700', 10);
const bootedAt = Date.now();

/* ── data ───────────────────────────────────────────────────────────── */

const FOLDERS = [
  { id: '100', name: 'Campuses', parentId: '' },
  { id: '110', name: 'North Campus', parentId: '100' },
  { id: '120', name: 'Downtown', parentId: '100' },
  { id: '200', name: 'Archive', parentId: '' },
];

const SERVICE_TYPES = [
  { id: '1001', name: 'Sunday Service', frequency: 'Every week', parentId: '110' },
  { id: '1002', name: 'Wednesday Night', frequency: 'Every week', parentId: '110' },
  { id: '1003', name: 'Downtown Sunday', frequency: 'Every week', parentId: '120' },
  { id: '1004', name: 'Christmas Eve 2024', frequency: 'Every 12 months', parentId: '200' },
  { id: '1005', name: 'Youth Night', frequency: 'Every 2 weeks', parentId: '' },
];

function iso(ms) {
  return new Date(ms).toISOString();
}

function longDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function shortDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const DAY = 86400000;
const firstServiceStart = bootedAt + 90 * 1000;

/** Plans for service type 1001: last week, today, next week. */
function plansFor(stId) {
  if (stId !== '1001' && stId !== '1003') return [];
  const mk = (id, serviceStart, title, series) => ({
    id,
    serviceTypeId: stId,
    title,
    series,
    sortDate: serviceStart,
    times: [
      { id: `${id}-r`, name: 'Rehearsal', type: 'rehearsal', start: serviceStart - 60 * 60000, end: serviceStart - 15 * 60000 },
      { id: `${id}-s1`, name: 'First Service', type: 'service', start: serviceStart, end: serviceStart + 75 * 60000 },
      { id: `${id}-s2`, name: 'Second Service', type: 'service', start: serviceStart + 120 * 60000, end: serviceStart + 195 * 60000 },
    ],
  });
  return [
    mk(`${stId}-P1`, firstServiceStart - 7 * DAY, 'Part 1', 'Living Hope'),
    mk(`${stId}-P2`, firstServiceStart, 'Part 2', 'Living Hope'),
    mk(`${stId}-P3`, firstServiceStart + 7 * DAY, 'Part 3', 'Living Hope'),
  ];
}

function planRecord(p) {
  const items = ITEMS.filter((it) => it.type !== 'header');
  return {
    type: 'Plan',
    id: p.id,
    attributes: {
      title: p.title,
      series_title: p.series,
      dates: longDate(p.sortDate),
      short_dates: shortDate(p.sortDate),
      sort_date: iso(p.sortDate),
      total_length: items.reduce((s, it) => s + it.length, 0),
      items_count: ITEMS.length,
      plan_notes_count: 0,
      planning_center_url: `https://services.planningcenteronline.com/plans/${p.id}`,
    },
    relationships: { service_type: { data: { type: 'ServiceType', id: p.serviceTypeId } } },
    links: { self: `/services/v2/service_types/${p.serviceTypeId}/plans/${p.id}` },
  };
}

// Titles match pp-mock's playlist: Welcome, This Is The Day, Sermon: Living
// Hope, Bumper Video, Closing Song, Benediction.
const ITEMS = [
  { id: 'i1', type: 'header', title: 'Pre-Service', pos: 'pre', length: 0 },
  { id: 'i2', type: 'media', title: 'Countdown', pos: 'pre', length: 300, desc: 'Start 5 min before', notes: [['Video', 'Loop the countdown from 8:55']] },
  { id: 'i3', type: 'header', title: 'Worship', pos: 'during', length: 0 },
  { id: 'i4', type: 'song', title: 'This Is The Day', pos: 'during', length: 270, key: 'G', song: { id: 's1', title: 'This Is The Day', author: 'Fred Hammond' }, arr: 'Default Arrangement', notes: [['Audio', 'Lead vocal: Sarah'], ['Lighting', 'Bright — house at 40%']] },
  { id: 'i5', type: 'song', title: 'Goodness of God', pos: 'during', length: 320, key: 'A', song: { id: 's2', title: 'Goodness of God', author: 'Bethel Music', ccli: '7117726' }, arr: 'Acoustic', notes: [['ProPresenter', 'Use the [ Full ] arrangement']] },
  { id: 'i6', type: 'item', title: 'Welcome', pos: 'during', length: 180, desc: 'Pastor Mike — mention Fall Kickoff', notes: [['Audio', 'Handheld 2 hot']] },
  { id: 'i7', type: 'media', title: 'Bumper Video', pos: 'during', length: 60, notes: [['Video', 'Program to Playback A']] },
  { id: 'i8', type: 'header', title: 'Message', pos: 'during', length: 0 },
  { id: 'i9', type: 'item', title: 'Sermon: Living Hope', pos: 'during', length: 2100, desc: '1 Peter 1:3-9', notes: [['ProPresenter', 'Sermon slides from PCO'], ['Lighting', 'Stage wash, house at 20%']] },
  { id: 'i10', type: 'song', title: 'Closing Song', pos: 'during', length: 240, key: 'D', song: { id: 's3', title: 'Build My Life', author: 'Housefires' }, arr: 'Default Arrangement' },
  { id: 'i11', type: 'item', title: 'Benediction', pos: 'during', length: 90 },
  { id: 'i12', type: 'header', title: 'Post-Service', pos: 'post', length: 0 },
  { id: 'i13', type: 'media', title: 'Walk-out Loop', pos: 'post', length: 600, notes: [['Video', 'Announcements loop until the room clears']] },
];

function itemsDocument(planId, include) {
  const wants = new Set(String(include || '').split(',').map((s) => s.trim()).filter(Boolean));
  const data = [];
  const included = [];
  ITEMS.forEach((it, index) => {
    const relationships = {};
    if (it.song) {
      relationships.song = { data: { type: 'Song', id: it.song.id } };
      if (wants.has('song')) {
        included.push({ type: 'Song', id: it.song.id, attributes: { title: it.song.title, author: it.song.author, ccli_number: it.song.ccli ? Number(it.song.ccli) : null } });
      }
      if (it.arr) {
        const arrId = `${it.song.id}-arr`;
        relationships.arrangement = { data: { type: 'Arrangement', id: arrId } };
        if (wants.has('arrangement')) included.push({ type: 'Arrangement', id: arrId, attributes: { name: it.arr } });
      }
    }
    const noteRefs = (it.notes || []).map((n, i) => ({ type: 'ItemNote', id: `${it.id}-n${i}` }));
    relationships.item_notes = { data: noteRefs };
    if (wants.has('item_notes')) {
      (it.notes || []).forEach(([category, content], i) => {
        included.push({ type: 'ItemNote', id: `${it.id}-n${i}`, attributes: { category_name: category, content } });
      });
    }
    data.push({
      type: 'Item',
      id: `${planId}-${it.id}`,
      attributes: {
        title: it.title,
        sequence: index + 1,
        item_type: it.type,
        length: it.length,
        service_position: it.pos,
        description: it.desc || '',
        html_details: '',
        key_name: it.key || null,
      },
      relationships,
    });
  });
  return { data, included, meta: { total_count: data.length, count: data.length } };
}

/* ── JSON:API plumbing ──────────────────────────────────────────────── */

function folderRecord(f) {
  return {
    type: 'Folder',
    id: f.id,
    attributes: { name: f.name, container: f.parentId ? 'Folder' : 'Organization' },
    relationships: { parent: { data: f.parentId ? { type: 'Folder', id: f.parentId } : null } },
  };
}

function serviceTypeRecord(st) {
  return {
    type: 'ServiceType',
    id: st.id,
    attributes: { name: st.name, frequency: st.frequency, sequence: Number(st.id) },
    relationships: { parent: { data: st.parentId ? { type: 'Folder', id: st.parentId } : null } },
  };
}

function planTimeRecord(t) {
  return {
    type: 'PlanTime',
    id: t.id,
    attributes: { name: t.name, time_type: t.type, starts_at: iso(t.start), ends_at: iso(t.end), live_starts_at: null, live_ends_at: null },
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/vnd.api+json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function collection(res, records, url) {
  send(res, 200, {
    links: { self: url.pathname + url.search },
    data: records,
    included: [],
    meta: { total_count: records.length, count: records.length },
  });
}

function notFound(res) {
  send(res, 404, { errors: [{ code: 'not_found', title: 'Not Found', status: '404', detail: 'The resource you requested could not be found' }] });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  console.log(`[pco-mock] ${req.method} ${url.pathname}${url.search}`);

  if (!/^(Basic|Bearer) \S+/.test(String(req.headers.authorization || ''))) {
    return send(res, 401, { errors: [{ code: 'unauthorized', title: 'Unauthorized', status: '401', detail: 'This request could not be authenticated.' }] });
  }

  const parts = url.pathname.replace(/^\/services\/v2\/?/, '').split('/').filter(Boolean);
  if (!url.pathname.startsWith('/services/v2')) return notFound(res);

  // /folders[/{id}]
  if (parts[0] === 'folders') {
    if (parts.length === 1) return collection(res, FOLDERS.map(folderRecord), url);
    const f = FOLDERS.find((x) => x.id === parts[1]);
    if (!f) return notFound(res);
    if (parts.length === 2) return send(res, 200, { data: folderRecord(f) });
    if (parts[2] === 'folders') return collection(res, FOLDERS.filter((x) => x.parentId === f.id).map(folderRecord), url);
    if (parts[2] === 'service_types') return collection(res, SERVICE_TYPES.filter((x) => x.parentId === f.id).map(serviceTypeRecord), url);
    return notFound(res);
  }

  // /service_types[/{id}[/plans[/{pid}[/plan_times|items]]]]
  if (parts[0] === 'service_types') {
    if (parts.length === 1) return collection(res, SERVICE_TYPES.map(serviceTypeRecord), url);
    const st = SERVICE_TYPES.find((x) => x.id === parts[1]);
    if (!st) return notFound(res);
    if (parts.length === 2) return send(res, 200, { data: serviceTypeRecord(st) });
    if (parts[2] !== 'plans') return notFound(res);
    const plans = plansFor(st.id);
    if (parts.length === 3) {
      const filter = url.searchParams.get('filter') || '';
      const now = Date.now();
      let list = plans.slice();
      if (filter === 'future') list = list.filter((p) => p.sortDate >= new Date(now).setHours(0, 0, 0, 0));
      else if (filter === 'past') list = list.filter((p) => p.sortDate < now);
      const order = url.searchParams.get('order') || 'sort_date';
      list.sort((a, b) => (order.startsWith('-') ? b.sortDate - a.sortDate : a.sortDate - b.sortDate));
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page')) || 25));
      return collection(res, list.slice(0, perPage).map(planRecord), url);
    }
    const plan = plans.find((p) => p.id === parts[3]);
    if (!plan) return notFound(res);
    if (parts.length === 4) return send(res, 200, { data: planRecord(plan) });
    if (parts[4] === 'plan_times') return collection(res, plan.times.map(planTimeRecord), url);
    if (parts[4] === 'items') {
      const doc = itemsDocument(plan.id, url.searchParams.get('include'));
      doc.links = { self: url.pathname + url.search };
      return send(res, 200, doc);
    }
    return notFound(res);
  }

  notFound(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[pco-mock] Planning Center mock on http://127.0.0.1:${PORT}/services/v2`);
  console.log(`[pco-mock] today's plan "${plansFor('1001')[1].title}" — first service starts at ${new Date(firstServiceStart).toLocaleTimeString()}`);
  console.log('[pco-mock] run ProdDash with: PCO_PLAN_API_BASE=http://127.0.0.1:%d node server.js', PORT);
});
