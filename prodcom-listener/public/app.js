'use strict';

/* ProdCom Listener client — live transcript stream via SSE (proxied through
   this app's server at /prodcom/* to avoid CORS). */

const streamEl = document.getElementById('stream');
const entriesEl = document.getElementById('entries');
const emptyEl = document.getElementById('empty-state');
const dotEl = document.getElementById('status-dot');
const channelBtn = document.getElementById('channel-btn');
const channelMenu = document.getElementById('channel-menu');
const jumpBtn = document.getElementById('jump-latest');

const channels = new Map(); // channelId -> {name, color}
const groups = new Map();   // groupId -> {name, channelIds}
const entryEls = new Map(); // entryId -> element
let pinnedToBottom = true;

/* ── status ─────────────────────────────────────────────────────────── */

function setStatus(state, text) {
  dotEl.className = 'dot ' + state;
  dotEl.title = text;
}

/* ── menubar ────────────────────────────────────────────────────────── */

document.getElementById('menu-handle').addEventListener('click', () => {
  document.body.classList.toggle('menu-open');
});

/* ── font size ──────────────────────────────────────────────────────── */

let fontSize = Number(localStorage.getItem('entrySize')) || 17;
applyFontSize();

function applyFontSize() {
  fontSize = Math.min(48, Math.max(11, fontSize));
  document.documentElement.style.setProperty('--entry-size', fontSize + 'px');
  localStorage.setItem('entrySize', fontSize);
}
document.getElementById('font-inc').addEventListener('click', () => { fontSize += 2; applyFontSize(); });
document.getElementById('font-dec').addEventListener('click', () => { fontSize -= 2; applyFontSize(); });

/* ── timestamp reveal ───────────────────────────────────────────────── */

/* Timestamps live in a column off-viewport to the left. A horizontal
   swipe/scroll drags them into view and they snap back on release
   (like message timestamps on iOS/macOS). The clock button pins them. */

const timeToggle = document.getElementById('time-toggle');
let timesPinned = localStorage.getItem('timesPinned') === '1';
applyTimesPinned();

timeToggle.addEventListener('click', () => {
  timesPinned = !timesPinned;
  localStorage.setItem('timesPinned', timesPinned ? '1' : '0');
  applyTimesPinned();
});

function applyTimesPinned() {
  document.body.classList.toggle('show-times', timesPinned);
  timeToggle.classList.toggle('active', timesPinned);
  timeToggle.setAttribute('aria-pressed', String(timesPinned));
  entriesEl.style.transform = '';
}

function timeSlotPx() {
  // the wrapper's negative margin IS the slot width (see --time-slot in css)
  return -parseFloat(getComputedStyle(entriesEl).marginLeft) || 0;
}

function currentTranslateX() {
  const t = getComputedStyle(entriesEl).transform;
  if (t && t !== 'none') return new DOMMatrixReadOnly(t).m41;
  return 0;
}

let reveal = 0;
let wheelTimer = null;

function dragTo(px) {
  entriesEl.classList.add('dragging');
  entriesEl.style.transform = 'translateX(' + px + 'px)';
}

function snapBack() {
  reveal = 0;
  entriesEl.classList.remove('dragging');
  entriesEl.style.transform = ''; // animate back to the CSS resting position
}

streamEl.addEventListener('wheel', (e) => {
  if (timesPinned) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical scroll
  if (!entriesEl.classList.contains('dragging')) reveal = currentTranslateX();
  const next = Math.max(0, Math.min(timeSlotPx(), reveal - e.deltaX));
  if (next === reveal && reveal === 0) return;
  reveal = next;
  e.preventDefault();
  dragTo(reveal);
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(snapBack, 160);
}, { passive: false });

let touchStartX = 0;
let touchStartY = 0;
let touchMode = null; // 'h' | 'v'

streamEl.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchMode = null;
}, { passive: true });

streamEl.addEventListener('touchmove', (e) => {
  if (timesPinned) return;
  const t = e.touches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  if (!touchMode) touchMode = Math.abs(dx) > Math.abs(dy) + 4 ? 'h' : 'v';
  if (touchMode !== 'h') return;
  e.preventDefault();
  reveal = Math.max(0, Math.min(timeSlotPx(), dx));
  dragTo(reveal);
}, { passive: false });

streamEl.addEventListener('touchend', () => {
  if (touchMode === 'h') snapBack();
});

/* ── clear (local view only) ────────────────────────────────────────── */

document.getElementById('clear-btn').addEventListener('click', () => {
  entryEls.forEach((el) => el.remove());
  entryEls.clear();
  emptyEl.hidden = false;
});

/* ── channel visibility toggles ─────────────────────────────────────── */

/* Every channel is visible unless its id is in this set. Unknown channels
   (entries not matching the channel list) always show. */
let hiddenChannels = new Set();
try { hiddenChannels = new Set(JSON.parse(localStorage.getItem('hiddenChannels') || '[]')); } catch {}

channelBtn.addEventListener('click', () => {
  channelMenu.hidden = !channelMenu.hidden;
});

document.addEventListener('click', (e) => {
  if (!channelMenu.hidden && !e.target.closest('#channel-dd')) channelMenu.hidden = true;
});

function applyFilter(el) {
  el.classList.toggle('hidden-by-filter', hiddenChannels.has(el.dataset.channelId));
}

function toggleChannel(id) {
  if (hiddenChannels.has(id)) hiddenChannels.delete(id);
  else hiddenChannels.add(id);
  localStorage.setItem('hiddenChannels', JSON.stringify([...hiddenChannels]));
  rebuildChannelMenu();
  entryEls.forEach((el) => applyFilter(el));
  if (pinnedToBottom) scrollToBottom();
}

/* Show exactly this group's channels, hide the rest */
function applyGroup(g) {
  hiddenChannels = new Set([...channels.keys()].filter((cid) => !g.channelIds.includes(cid)));
  localStorage.setItem('hiddenChannels', JSON.stringify([...hiddenChannels]));
  rebuildChannelMenu();
  entryEls.forEach((el) => applyFilter(el));
  if (pinnedToBottom) scrollToBottom();
}

function groupIsActive(g) {
  const members = g.channelIds.filter((cid) => channels.has(cid));
  if (!members.length) return false;
  return [...channels.keys()].every((cid) =>
    members.includes(cid) ? !hiddenChannels.has(cid) : hiddenChannels.has(cid)
  );
}

function rebuildChannelMenu() {
  channelMenu.innerHTML = '';

  // group presets first
  if (groups.size) {
    for (const g of groups.values()) {
      const on = groupIsActive(g);
      const item = document.createElement('button');
      item.className = 'channel-item group-item' + (on ? ' on' : '');
      item.setAttribute('role', 'menuitemradio');
      item.setAttribute('aria-checked', String(on));

      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = g.name;

      item.append(check, name);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        applyGroup(g);
      });
      channelMenu.appendChild(item);
    }
    const divider = document.createElement('div');
    divider.className = 'menu-divider';
    channelMenu.appendChild(divider);
  }

  let visibleCount = 0;
  for (const [id, info] of channels) {
    const on = !hiddenChannels.has(id);
    if (on) visibleCount++;
    const item = document.createElement('button');
    item.className = 'channel-item' + (on ? ' on' : '');
    item.setAttribute('role', 'menuitemcheckbox');
    item.setAttribute('aria-checked', String(on));

    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = '✓';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = info.name;
    name.style.color = info.color;

    item.append(check, name);
    item.addEventListener('click', (e) => {
      // keep the menu open: the rebuild detaches this item, which would make
      // the document-level outside-click handler think we clicked outside
      e.stopPropagation();
      toggleChannel(id);
    });
    channelMenu.appendChild(item);
  }
  channelBtn.textContent = visibleCount === channels.size
    ? 'Channels ▾'
    : 'Channels (' + visibleCount + '/' + channels.size + ') ▾';
}

/* ── scrolling ──────────────────────────────────────────────────────── */

streamEl.addEventListener('scroll', () => {
  const nearBottom = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 60;
  pinnedToBottom = nearBottom;
  if (nearBottom) jumpBtn.hidden = true;
});

jumpBtn.addEventListener('click', () => {
  pinnedToBottom = true;
  jumpBtn.hidden = true;
  scrollToBottom();
});

function scrollToBottom() {
  streamEl.scrollTop = streamEl.scrollHeight;
}

function afterInsert(el) {
  const visible = !el.classList.contains('hidden-by-filter');
  if (!visible) return;
  if (pinnedToBottom) scrollToBottom();
  else jumpBtn.hidden = false;
}

/* ── entry rendering ────────────────────────────────────────────────── */

function channelInfo(entry) {
  const known = channels.get(entry.channelId);
  return {
    name: (known && known.name) || entry.channelName || 'Unknown',
    color: (known && known.color) || '#8b98a5',
  };
}

function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour12: false });
}

function upsertEntry(entry) {
  if (!entry || typeof entry.text !== 'string') return;
  const id = entry.id || entry.channelId + '|' + entry.date;

  let el = entryEls.get(id);
  if (!el) {
    emptyEl.hidden = true;
    el = document.createElement('div');
    el.className = 'entry';
    el.dataset.channelId = entry.channelId || '';
    el.style.setProperty('--ch', channelInfo(entry).color);

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = fmtTime(entry.date);

    const info = channelInfo(entry);

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.style.color = info.color;
    avatar.style.background = info.color + '2b'; // ~17% alpha tint
    avatar.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="12" cy="8.5" r="3.2"/>' +
      '<path d="M5.5 19c1.6-3.2 3.9-4.8 6.5-4.8s4.9 1.6 6.5 4.8"/></svg>';

    const ch = document.createElement('span');
    ch.className = 'channel';
    ch.textContent = info.name;
    ch.style.color = info.color;

    const text = document.createElement('span');
    text.className = 'text';

    const body = document.createElement('div');
    body.className = 'body';
    body.append(ch, text);

    el.append(time, avatar, body);
    entryEls.set(id, el);
    applyFilter(el);
    entriesEl.appendChild(el);
    updateEntryEl(el, entry);
    afterInsert(el);
  } else {
    updateEntryEl(el, entry);
    if (pinnedToBottom && !el.classList.contains('hidden-by-filter')) scrollToBottom();
  }
}

function updateEntryEl(el, entry) {
  el.querySelector('.text').textContent = entry.translatedText || entry.text;
  el.classList.toggle('in-progress', entry.inProgress === true);
}

/* ── SSE event parsing ──────────────────────────────────────────────── */

/* The stream sends JSON objects for new/updated/completed transcript
   entries. Be liberal about the envelope shape. */
function extractEntries(obj) {
  if (!obj || typeof obj !== 'object') return [];
  if (Array.isArray(obj)) return obj.flatMap(extractEntries);
  if (typeof obj.text === 'string' && (obj.id || obj.channelId)) return [obj];
  for (const key of ['data', 'payload', 'entry', 'entries', 'transcript']) {
    if (obj[key] && typeof obj[key] === 'object') {
      const found = extractEntries(obj[key]);
      if (found.length) return found;
    }
  }
  return [];
}

function handleEventData(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }

  const kind = String(obj.type || obj.event || '').toLowerCase();
  if (kind.includes('clear')) {
    entryEls.forEach((el) => el.remove());
    entryEls.clear();
    emptyEl.hidden = false;
    return;
  }
  extractEntries(obj).forEach(upsertEntry);
}

/* ── data loading ───────────────────────────────────────────────────── */

async function loadChannels() {
  const res = await fetch('/prodcom/api/v1/channels');
  if (!res.ok) throw new Error('channels ' + res.status);
  const body = await res.json();
  channels.clear();
  for (const ch of body.data || []) {
    channels.set(ch.id, { name: ch.name, color: ch.color || '#8b98a5' });
  }
  rebuildChannelMenu();
}

async function loadGroups() {
  const res = await fetch('/prodcom/api/v1/groups');
  if (!res.ok) throw new Error('groups ' + res.status);
  const body = await res.json();
  groups.clear();
  for (const g of body.data || []) {
    groups.set(g.id, { name: g.name, channelIds: g.channelIds || [] });
  }
  rebuildChannelMenu();
}

async function loadHistory() {
  const res = await fetch('/prodcom/api/v1/transcript?limit=100');
  if (!res.ok) throw new Error('transcript ' + res.status);
  const body = await res.json();
  const entries = (body.data || []).slice();
  entries.sort((a, b) => new Date(a.date) - new Date(b.date));
  entries.forEach(upsertEntry);
}

/* ── SSE connection ─────────────────────────────────────────────────── */

let es = null;
let reconnectTimer = null;

function connect() {
  if (es) es.close();
  es = new EventSource('/prodcom/api/v1/transcript/stream');

  es.onopen = () => {
    setStatus('connected', 'Live');
    // refresh channels/groups and backfill entries missed while disconnected
    // (upsertEntry dedupes by id, so re-fetching history is harmless)
    loadChannels().catch(() => {});
    loadGroups().catch(() => {});
    loadHistory().catch(() => {});
  };

  es.onerror = () => {
    setStatus('error', 'Reconnecting…');
    // EventSource auto-retries transient drops, but it gives up permanently
    // when a retry gets a completed non-SSE response — which is what our
    // proxy's 502 looks like while ProdCom is closed. Recreate the
    // connection on a timer until ProdCom is back.
    if (es.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    }
  };

  const handler = (ev) => handleEventData(ev.data);
  es.onmessage = handler;
  // Also listen for likely named event types (spec doesn't pin these down)
  [
    'transcript', 'transcript.new', 'transcript.updated', 'transcript.update',
    'transcript.completed', 'transcript.complete', 'entry', 'new', 'update',
    'updated', 'complete', 'completed',
  ].forEach((name) => es.addEventListener(name, handler));
}

/* ── boot ───────────────────────────────────────────────────────────── */

async function boot() {
  setStatus('', 'Connecting…');
  try {
    await loadChannels();
    await loadGroups().catch(() => {}); // groups are optional
    await loadHistory();
  } catch {
    setStatus('error', 'ProdCom unreachable — retrying…');
    setTimeout(boot, 5000);
    return;
  }
  scrollToBottom();
  connect();
}

boot();

// Expose for debugging/testing in the console
window.__prodcomListener = { upsertEntry, handleEventData, channels };

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
