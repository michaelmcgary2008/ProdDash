/* ProdDash shell client.

   Owns the tile grid: adding, dragging, resizing and removing module tiles,
   plus layout persistence. The layout (tiles, positions, sizes, per-instance
   settings) autosaves to this browser's localStorage — every browser is fully
   independent. Modules render inside tile bodies and never touch the shell.  */

const COLS = 12;
const LS_LAYOUT = 'proddash:layout';

const grid = document.getElementById('grid');
const gridwrap = document.getElementById('gridwrap');
const emptyEl = document.getElementById('empty-state');
const toastEl = document.getElementById('toast');

/* ── tiny helpers ───────────────────────────────────────────────────── */

let toastTimer = null;
function toast(msg, isError = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

const modalBackdrop = document.getElementById('modal-backdrop');
const modalEl = document.getElementById('modal');

/** Minimal prompt dialog; resolves with the string or null on cancel. */
function promptModal({ title, placeholder = '', value = '', okLabel = 'Save' }) {
  return new Promise((resolve) => {
    modalEl.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = title;
    const field = document.createElement('div');
    field.className = 'field';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.value = value;
    field.appendChild(input);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.className = 'btn primary';
    ok.textContent = okLabel;
    actions.append(cancel, ok);
    modalEl.append(h, field, actions);
    modalBackdrop.hidden = false;
    input.focus();
    const done = (result) => {
      modalBackdrop.hidden = true;
      modalEl.innerHTML = '';
      resolve(result);
    };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', () => done(input.value.trim() || null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim() || null);
      if (e.key === 'Escape') done(null);
    });
    modalBackdrop.addEventListener('click', (e) => {
      if (e.target === modalBackdrop) done(null);
    }, { once: true });
  });
}

/* ── dropdown menus ─────────────────────────────────────────────────── */

function wireDropdown(btnId, menuId, rebuild) {
  const btn = document.getElementById(btnId);
  const menu = document.getElementById(menuId);
  btn.addEventListener('click', async () => {
    if (menu.hidden) await rebuild(menu);
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !e.target.closest('#' + btnId) && !e.target.closest('#' + menuId)) {
      menu.hidden = true;
    }
  });
  return menu;
}

function menuItem(label, onClick, { sub = '', danger = false } = {}) {
  const item = document.createElement('button');
  item.className = 'menu-item' + (danger ? ' danger' : '');
  const span = document.createElement('span');
  span.textContent = label;
  if (sub) {
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = sub;
    span.appendChild(s);
  }
  item.appendChild(span);
  item.addEventListener('click', onClick);
  return item;
}

/* ── module registry ────────────────────────────────────────────────── */

let registry = new Map(); // module id -> manifest from GET /api/modules

/** Refresh the enabled-module list. On failure the last known list is kept
    (the server may just be restarting mid-service). Returns true on success. */
async function loadRegistry() {
  try {
    const res = await fetch('/api/modules');
    if (!res.ok) throw new Error('modules ' + res.status);
    const body = await res.json();
    registry = new Map((body.modules || []).map((m) => [m.id, m]));
    return true;
  } catch {
    return false;
  }
}

/* ── layout state ───────────────────────────────────────────────────── */

/** @type {{id:string,module:string,x:number,y:number,w:number,h:number,settings:object}[]} */
let tiles = [];
const tileEls = new Map(); // tile id -> { el, body, dot, titleEl, instance }

function saveLayout() {
  try {
    localStorage.setItem(LS_LAYOUT, JSON.stringify({ v: 1, tiles }));
  } catch { /* private mode / full — layout just won't persist */ }
}

function loadLayoutFromStorage() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_LAYOUT) || 'null');
    if (raw && Array.isArray(raw.tiles)) return raw.tiles;
  } catch { /* corrupted — start fresh */ }
  return [];
}

function sanitizeTile(t) {
  const w = Math.max(1, Math.min(COLS, Number(t.w) || 3));
  return {
    id: String(t.id || newId()),
    module: String(t.module || ''),
    x: Math.max(0, Math.min(COLS - w, Number(t.x) || 0)),
    y: Math.max(0, Number(t.y) || 0),
    w,
    h: Math.max(1, Number(t.h) || 2),
    settings: (t.settings && typeof t.settings === 'object') ? t.settings : {},
  };
}

function newId() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ── grid geometry & collision ──────────────────────────────────────── */

function cellMetrics() {
  const style = getComputedStyle(grid);
  const gap = parseFloat(style.columnGap) || 10;
  const cw = (grid.clientWidth - gap * (COLS - 1)) / COLS;
  const ch = parseFloat(style.gridAutoRows) || 72;
  return { cw, ch, gap };
}

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function isFree(rect, excludeId) {
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > COLS) return false;
  return !tiles.some((t) => t.id !== excludeId && overlaps(rect, t));
}

/** First free spot scanning top-to-bottom, left-to-right. */
function findSpot(w, h) {
  for (let y = 0; y < 200; y += 1) {
    for (let x = 0; x <= COLS - w; x += 1) {
      if (isFree({ x, y, w, h })) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

function applyRect(tile) {
  const entry = tileEls.get(tile.id);
  if (!entry) return;
  entry.el.style.gridColumn = `${tile.x + 1} / span ${tile.w}`;
  entry.el.style.gridRow = `${tile.y + 1} / span ${tile.h}`;
}

function minSizeOf(tile) {
  const man = registry.get(tile.module);
  return {
    w: Math.max(1, man?.minSize?.w || 1),
    h: Math.max(1, man?.minSize?.h || 1),
  };
}

/* ── tile DOM ───────────────────────────────────────────────────────── */

const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8.4-2.1.1-1.4-.1-1.4 1.7-1.3-1.6-2.8-2 .7a7.9 7.9 0 0 0-2.4-1.4l-.3-2.1H11l-.3 2.1a7.9 7.9 0 0 0-2.4 1.4l-2-.7L4.7 9.3 6.4 10.6l-.1 1.4.1 1.4-1.7 1.3 1.6 2.8 2-.7a7.9 7.9 0 0 0 2.4 1.4l.3 2.1h2.8l.3-2.1a7.9 7.9 0 0 0 2.4-1.4l2 .7 1.6-2.8-1.7-1.3Z"/></svg>';

function buildTile(tile) {
  const man = registry.get(tile.module);

  const el = document.createElement('section');
  el.className = 'tile';
  el.dataset.tileId = tile.id;
  if (man) el.dataset.module = man.id;

  const head = document.createElement('div');
  head.className = 'tile-head';

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.title = '';

  const title = document.createElement('span');
  title.className = 'tile-title';
  title.textContent = man ? man.name : tile.module + ' (not installed)';

  head.append(dot, title);

  const hasSettings = man && man.instanceSchema && Object.keys(man.instanceSchema).length;
  if (hasSettings) {
    const gear = document.createElement('button');
    gear.className = 'tile-btn';
    gear.title = 'Tile settings (this tile only)';
    gear.innerHTML = GEAR_SVG;
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSettingsPopover(tile, el);
    });
    head.appendChild(gear);
  }

  const close = document.createElement('button');
  close.className = 'tile-btn close';
  close.title = 'Remove this tile';
  close.textContent = '✕';
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    removeTile(tile.id);
  });
  head.appendChild(close);

  const body = document.createElement('div');
  body.className = 'tile-body';

  const resize = document.createElement('div');
  resize.className = 'tile-resize';
  resize.title = 'Drag to resize';

  el.append(head, body, resize);
  grid.appendChild(el);

  const entry = { el, body, dot, titleEl: title, instance: null };
  tileEls.set(tile.id, entry);
  applyRect(tile);

  wireDrag(tile, el, head);
  wireResize(tile, el, resize);

  mountModule(tile);
  return entry;
}

function refreshEmptyState() {
  emptyEl.hidden = tiles.length > 0;
}

/* ── drag to move ───────────────────────────────────────────────────── */

function wireDrag(tile, el, handle) {
  handle.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest('.tile-btn')) return;
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    ev.preventDefault();
    closeSettingsPopovers();
    handle.setPointerCapture(ev.pointerId);
    const m = cellMetrics();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const startX = tile.x;
    const startY = tile.y;
    let moved = false;

    const onMove = (e) => {
      const dCols = Math.round((e.clientX - sx) / (m.cw + m.gap));
      const dRows = Math.round((e.clientY - sy) / (m.ch + m.gap));
      if (!moved && (dCols || dRows)) {
        moved = true;
        el.classList.add('dragging');
      }
      const cand = {
        x: Math.max(0, Math.min(COLS - tile.w, startX + dCols)),
        y: Math.max(0, startY + dRows),
        w: tile.w,
        h: tile.h,
      };
      if ((cand.x !== tile.x || cand.y !== tile.y) && isFree(cand, tile.id)) {
        tile.x = cand.x;
        tile.y = cand.y;
        applyRect(tile);
      }
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      el.classList.remove('dragging');
      if (moved) saveLayout();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

/* ── drag to resize ─────────────────────────────────────────────────── */

function wireResize(tile, el, handle) {
  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    ev.preventDefault();
    ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
    const m = cellMetrics();
    const sx = ev.clientX;
    const sy = ev.clientY;
    const startW = tile.w;
    const startH = tile.h;
    const min = minSizeOf(tile);
    el.classList.add('resizing');
    let changed = false;

    const onMove = (e) => {
      const dCols = Math.round((e.clientX - sx) / (m.cw + m.gap));
      const dRows = Math.round((e.clientY - sy) / (m.ch + m.gap));
      const cand = {
        x: tile.x,
        y: tile.y,
        w: Math.max(min.w, Math.min(COLS - tile.x, startW + dCols)),
        h: Math.max(min.h, startH + dRows),
      };
      if ((cand.w !== tile.w || cand.h !== tile.h) && isFree(cand, tile.id)) {
        tile.w = cand.w;
        tile.h = cand.h;
        applyRect(tile);
        changed = true;
        notifyResize(tile);
      }
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      el.classList.remove('resizing');
      if (changed) saveLayout();
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

function notifyResize(tile) {
  const entry = tileEls.get(tile.id);
  try {
    entry?.instance?.onResize?.(tile.w, tile.h);
  } catch { /* module's problem, not the shell's */ }
}

/* ── add / remove tiles ─────────────────────────────────────────────── */

function addTile(moduleId) {
  const man = registry.get(moduleId);
  const size = {
    w: Math.max(1, Math.min(COLS, man?.defaultSize?.w || 4)),
    h: Math.max(1, man?.defaultSize?.h || 3),
  };
  const spot = findSpot(size.w, size.h);
  const settings = {};
  for (const [key, spec] of Object.entries(man?.instanceSchema || {})) {
    if (spec && 'default' in spec) settings[key] = spec.default;
  }
  const tile = { id: newId(), module: moduleId, ...spot, ...size, settings };
  tiles.push(tile);
  buildTile(tile);
  refreshEmptyState();
  saveLayout();
}

function removeTile(id) {
  const idx = tiles.findIndex((t) => t.id === id);
  if (idx < 0) return;
  unmountModule(tiles[idx]);
  tiles.splice(idx, 1);
  const entry = tileEls.get(id);
  if (entry) {
    entry.el.remove();
    tileEls.delete(id);
  }
  refreshEmptyState();
  saveLayout();
}

function clearAllTiles() {
  for (const tile of tiles) {
    unmountModule(tile);
    tileEls.get(tile.id)?.el.remove();
  }
  tiles = [];
  tileEls.clear();
  refreshEmptyState();
}

/* ── module mounting ────────────────────────────────────────────────── */

const clientModuleCache = new Map(); // module id -> Promise<ES module>

function loadClientModule(man) {
  if (!clientModuleCache.has(man.id)) {
    clientModuleCache.set(man.id, import(`/modules/${man.id}/${man.client || 'client.js'}`));
  }
  return clientModuleCache.get(man.id);
}

/** Inject a module's stylesheet once (shared by every instance of it). */
function ensureModuleStyle(man) {
  if (!man.style) return;
  const id = 'module-style-' + man.id;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `/modules/${man.id}/${man.style}`;
  document.head.appendChild(link);
}

function tileMessage(entry, text) {
  const msg = document.createElement('div');
  msg.className = 'tile-msg';
  msg.textContent = text;
  entry.body.appendChild(msg);
}

/**
 * The API handed to each module instance — the whole surface a module may
 * touch outside its root element. See docs/MODULE-GUIDE.md.
 */
function buildModuleApi(tile, man, entry) {
  const sseHandles = new Set();

  const api = {
    id: man.id,
    instanceId: tile.id,

    /** Admin (server-wide) config, read-only. Password fields never reach
        the client. Live: reflects the latest registry after admin saves. */
    get config() {
      return { ...((registry.get(man.id) || man).config || {}) };
    },

    /** Per-tile settings: schema defaults overlaid with what this tile saved. */
    get instanceSettings() {
      const out = {};
      for (const [key, spec] of Object.entries(man.instanceSchema || {})) {
        if (spec && 'default' in spec) out[key] = spec.default;
      }
      return Object.assign(out, tile.settings || {});
    },

    /** Persist per-tile settings into the layout (no remount — the module
        already knows, it made the change). */
    saveInstanceSettings(patch) {
      Object.assign(tile.settings, patch || {});
      saveLayout();
    },

    /** fetch scoped to this module's server routes. */
    fetch(subPath, opts) {
      return fetch('/api/modules/' + man.id + subPath, opts);
    },

    /**
     * EventSource scoped the same way, with auto-reconnect: EventSource
     * retries transient drops itself but gives up for good when a retry gets
     * a completed non-SSE response (a 502 while the upstream is down), so a
     * closed stream is recreated on a timer until it works again.
     * handlers: { open(e), error(e), message(e), events: { name: fn } }
     */
    sse(subPath, handlers = {}) {
      const url = '/api/modules/' + man.id + subPath;
      let es = null;
      let retryTimer = null;
      let closed = false;
      const connect = () => {
        if (closed) return;
        try { es?.close(); } catch { /* already closed */ }
        es = new EventSource(url);
        if (handlers.open) es.onopen = handlers.open;
        if (handlers.message) es.onmessage = handlers.message;
        for (const [name, fn] of Object.entries(handlers.events || {})) {
          es.addEventListener(name, fn);
        }
        es.onerror = (e) => {
          try { handlers.error?.(e); } catch { /* module's problem */ }
          if (es.readyState === EventSource.CLOSED) {
            clearTimeout(retryTimer);
            retryTimer = setTimeout(connect, 3000);
          }
        };
      };
      connect();
      const handle = {
        close() {
          closed = true;
          clearTimeout(retryTimer);
          try { es?.close(); } catch { /* already closed */ }
          sseHandles.delete(handle);
        },
      };
      sseHandles.add(handle);
      return handle;
    },

    /** Drive the tile's status dot: 'ok' | 'connecting' | 'error'. */
    setStatus(state, msg = '') {
      const cls = state === 'ok' || state === 'connecting' || state === 'error' ? state : '';
      entry.dot.className = 'dot ' + cls;
      entry.dot.title = msg;
    },

    /* shell-internal: safety net so a forgotten stream can't outlive the tile */
    _closeAll() {
      for (const handle of [...sseHandles]) handle.close();
    },
  };
  return api;
}

async function mountModule(tile) {
  const entry = tileEls.get(tile.id);
  if (!entry) return;
  const man = registry.get(tile.module);
  if (!man) {
    tileMessage(entry, `Module “${tile.module}” is not installed or is disabled. Check Admin.`);
    entry.dot.className = 'dot error';
    entry.dot.title = 'Module unavailable';
    return;
  }
  entry.dot.className = 'dot connecting';
  ensureModuleStyle(man);
  try {
    const mod = await loadClientModule(man);
    if (tileEls.get(tile.id) !== entry || entry.instance) return; // tile removed/remounted while loading
    const factory = mod.default;
    if (typeof factory !== 'function') throw new Error('client.js has no default-export factory');
    const api = buildModuleApi(tile, man, entry);
    const instance = factory({ root: entry.body, moduleApi: api }) || {};
    entry.instance = instance;
    entry.api = api;
    instance.start?.();
  } catch (err) {
    console.error(`[shell] module "${tile.module}" failed to start:`, err);
    entry.body.innerHTML = '';
    tileMessage(entry, `“${man.name}” failed to start: ${err?.message || err}`);
    entry.dot.className = 'dot error';
  }
}

function unmountModule(tile) {
  const entry = tileEls.get(tile.id);
  if (!entry) return;
  try {
    entry.instance?.stop?.();
  } catch { /* stopping is best-effort */ }
  try {
    entry.api?._closeAll();
  } catch { /* ditto */ }
  entry.instance = null;
  entry.api = null;
}

/* ── per-tile settings popover ──────────────────────────────────────── */

function closeSettingsPopovers() {
  document.querySelectorAll('.tile-settings').forEach((p) => p.remove());
}

function toggleSettingsPopover(tile, el) {
  const existing = el.querySelector('.tile-settings');
  closeSettingsPopovers();
  if (existing) return;
  const man = registry.get(tile.module);
  if (!man || !man.instanceSchema) return;

  const pop = document.createElement('div');
  pop.className = 'tile-settings';
  const inputs = new Map();

  for (const [key, spec] of Object.entries(man.instanceSchema)) {
    const type = spec?.type || 'string';
    const label = spec?.label || key;
    const current = key in (tile.settings || {}) ? tile.settings[key] : spec?.default;

    const field = document.createElement('label');
    field.className = 'field' + (type === 'boolean' ? ' check' : '');

    if (type === 'boolean') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(current);
      field.append(input, document.createTextNode(label));
      inputs.set(key, () => input.checked);
    } else if (type === 'select' && Array.isArray(spec.options)) {
      const span = document.createElement('span');
      span.textContent = label;
      const select = document.createElement('select');
      for (const opt of spec.options) {
        const o = document.createElement('option');
        o.value = String(typeof opt === 'object' ? opt.value : opt);
        o.textContent = String(typeof opt === 'object' ? (opt.label ?? opt.value) : opt);
        select.appendChild(o);
      }
      select.value = String(current ?? '');
      field.append(span, select);
      inputs.set(key, () => select.value);
    } else {
      const span = document.createElement('span');
      span.textContent = label;
      const input = document.createElement('input');
      input.type = type === 'number' ? 'number' : (type === 'password' ? 'password' : 'text');
      input.value = current === undefined || current === null ? '' : String(current);
      field.append(span, input);
      inputs.set(key, () => (type === 'number' ? Number(input.value) : input.value));
    }
    pop.appendChild(field);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.style.display = 'flex';
  actions.style.justifyContent = 'flex-end';
  actions.style.gap = '8px';
  const cancel = document.createElement('button');
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => pop.remove());
  const apply = document.createElement('button');
  apply.className = 'btn primary';
  apply.textContent = 'Apply';
  apply.addEventListener('click', () => {
    for (const [key, read] of inputs) tile.settings[key] = read();
    pop.remove();
    saveLayout();
    remountTile(tile);
  });
  actions.append(cancel, apply);
  pop.appendChild(actions);

  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  el.appendChild(pop);
}

/** Tear a tile's module down and start it again (settings changed). */
function remountTile(tile) {
  const entry = tileEls.get(tile.id);
  if (!entry) return;
  unmountModule(tile);
  entry.body.innerHTML = '';
  entry.dot.className = 'dot';
  mountModule(tile);
}

/* ── layout apply / reset ───────────────────────────────────────────── */

function renderLayout(list) {
  clearAllTiles();
  tiles = list.map(sanitizeTile);
  for (const tile of tiles) buildTile(tile);
  refreshEmptyState();
}

/* ── menus ──────────────────────────────────────────────────────────── */

wireDropdown('add-btn', 'add-menu', async (menu) => {
  await loadRegistry();
  menu.innerHTML = '';
  const manifests = [...registry.values()];
  if (!manifests.length) {
    const note = document.createElement('div');
    note.className = 'menu-note';
    note.textContent = 'No modules are enabled. Enable some in Admin.';
    menu.appendChild(note);
    return;
  }
  for (const man of manifests) {
    menu.appendChild(menuItem(man.name, () => {
      menu.hidden = true;
      addTile(man.id);
    }, { sub: man.description || '' }));
  }
});

wireDropdown('layout-btn', 'layout-menu', async (menu) => {
  menu.innerHTML = '';

  menu.appendChild(menuItem('Save as named layout…', async () => {
    menu.hidden = true;
    if (!tiles.length) {
      toast('Nothing to save — this dashboard is empty', true);
      return;
    }
    const name = await promptModal({
      title: 'Save this layout to the server',
      placeholder: 'e.g. FOH booth, Video world',
      okLabel: 'Save',
    });
    if (!name) return;
    try {
      const res = await fetch('/api/layouts/' + encodeURIComponent(name), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout: { tiles } }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Save failed (' + res.status + ')');
      toast(`Saved “${name}” — any browser can load it now`);
    } catch (e) {
      toast(e.message, true);
    }
  }, { sub: 'Share this arrangement with other browsers' }));

  const divider = document.createElement('div');
  divider.className = 'menu-divider';
  menu.appendChild(divider);

  // named layouts stored on the server
  let layouts = [];
  try {
    const res = await fetch('/api/layouts');
    if (res.ok) layouts = (await res.json()).layouts || [];
  } catch { /* server briefly away — the menu just shows none */ }
  if (layouts.length) {
    const title = document.createElement('div');
    title.className = 'menu-title';
    title.textContent = 'Load from server';
    menu.appendChild(title);
    for (const l of layouts) {
      menu.appendChild(menuItem(l.name, async () => {
        menu.hidden = true;
        try {
          const res = await fetch('/api/layouts/' + encodeURIComponent(l.name));
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || 'Load failed (' + res.status + ')');
          // Loading copies the layout into this browser's own state — it
          // does not live-link browsers together.
          renderLayout(body.layout.tiles || []);
          saveLayout();
          toast(`Loaded “${l.name}”`);
        } catch (e) {
          toast(e.message, true);
        }
      }, { sub: `${l.tiles} tile${l.tiles === 1 ? '' : 's'}` }));
    }
    menu.appendChild(divider.cloneNode());
  }

  menu.appendChild(menuItem('Reset layout', () => {
    menu.hidden = true;
    renderLayout([]);
    saveLayout();
    toast('Layout cleared');
  }, { danger: true, sub: 'Remove every tile from this browser' }));
});

/* ── live updates from the admin page ───────────────────────────────── */

/* The server broadcasts `modules-changed` on /api/events whenever admin
   config or enabled flags change. Tiles of a changed module get
   onConfigChange(cfg) if they implement it, otherwise a clean remount. */

let eventsSource = null;
let eventsRetry = null;

function subscribeEvents() {
  try { eventsSource?.close(); } catch { /* not open */ }
  eventsSource = new EventSource('/api/events');
  eventsSource.addEventListener('modules-changed', () => handleModulesChanged());
  eventsSource.onerror = () => {
    if (eventsSource.readyState === EventSource.CLOSED) {
      clearTimeout(eventsRetry);
      eventsRetry = setTimeout(subscribeEvents, 4000);
    }
  };
}

async function handleModulesChanged() {
  const before = registry;
  if (!(await loadRegistry())) return;
  for (const tile of [...tiles]) {
    const oldMan = before.get(tile.module);
    const newMan = registry.get(tile.module);
    if (!newMan !== !oldMan) {
      // enabled or disabled: rebuild the tile body (shows the module, or
      // an "unavailable" note)
      remountTile(tile);
      continue;
    }
    if (!newMan) continue;
    if (JSON.stringify(oldMan.config || {}) !== JSON.stringify(newMan.config || {})) {
      const entry = tileEls.get(tile.id);
      if (typeof entry?.instance?.onConfigChange === 'function') {
        try {
          entry.instance.onConfigChange({ ...newMan.config });
        } catch {
          remountTile(tile);
        }
      } else {
        remountTile(tile);
      }
    }
  }
}

/* ── boot ───────────────────────────────────────────────────────────── */

async function boot() {
  const ok = await loadRegistry();
  if (!ok) {
    toast('ProdDash server unreachable — retrying…', true);
    setTimeout(boot, 4000);
    return;
  }
  renderLayout(loadLayoutFromStorage());
  subscribeEvents();
}

boot();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
