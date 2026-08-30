/* ProdCom Transcript — client part.

   Ported from prodcom-listener/public/app.js into the ProdDash module
   contract: everything lives inside the tile's root, per-tile state
   (hidden channels, timestamps, text size) persists in instance settings,
   and all network traffic goes through moduleApi (the module's server
   proxy at /prodcom/*). */

export default function create({ root, moduleApi }) {
  /* ── per-instance state ─────────────────────────────────────────── */

  const channels = new Map(); // channelId -> {name, color}
  const groups = new Map();   // groupId -> {name, channelIds}
  const entryEls = new Map(); // entryId -> element
  let pinnedToBottom = true;
  let hiddenChannels = new Set(moduleApi.instanceSettings.hiddenChannels || []);
  let stream = null;          // moduleApi.sse handle
  let bootTimer = null;
  let stopped = false;

  /* ── DOM skeleton ───────────────────────────────────────────────── */

  root.innerHTML = `
    <div class="pt-wrap">
      <div class="pt-bar">
        <div class="pt-dd">
          <button class="pt-btn pt-channels-btn" title="Choose visible channels">Channels ▾</button>
          <div class="pt-menu" hidden></div>
        </div>
        <span class="pt-spacer"></span>
        <button class="pt-btn pt-clear" title="Clear this tile (does not affect ProdCom)">Clear</button>
      </div>
      <div class="pt-stream">
        <div class="pt-empty">Waiting for transcript…</div>
        <div class="pt-entries"></div>
      </div>
      <button class="pt-jump" hidden>↓ New messages</button>
    </div>`;

  const wrap = root.querySelector('.pt-wrap');
  const streamEl = root.querySelector('.pt-stream');
  const entriesEl = root.querySelector('.pt-entries');
  const emptyEl = root.querySelector('.pt-empty');
  const jumpBtn = root.querySelector('.pt-jump');
  const channelBtn = root.querySelector('.pt-channels-btn');
  const channelMenu = root.querySelector('.pt-menu');

  function applyInstanceSettings() {
    const s = moduleApi.instanceSettings;
    const size = Math.min(48, Math.max(10, Number(s.textSize) || 15));
    wrap.style.setProperty('--pt-size', size + 'px');
    wrap.classList.toggle('show-times', Boolean(s.showTimes));
  }
  applyInstanceSettings();

  /* ── channel filter (instance setting) ──────────────────────────── */

  function channelFilter() {
    return String(moduleApi.instanceSettings.channel || '').trim().toLowerCase();
  }

  /** Entry hidden by the hard per-tile filter (settings.channel)? */
  function filteredOut(channelId, channelName) {
    const want = channelFilter();
    if (!want) return false;
    const known = channels.get(channelId);
    const name = ((known && known.name) || channelName || '').toLowerCase();
    return name !== want && String(channelId).toLowerCase() !== want;
  }

  /* ── channel visibility toggles ─────────────────────────────────── */

  function persistHidden() {
    moduleApi.saveInstanceSettings({ hiddenChannels: [...hiddenChannels] });
  }

  function applyFilter(el) {
    const hidden = hiddenChannels.has(el.dataset.channelId)
      || filteredOut(el.dataset.channelId, el.dataset.channelName);
    el.classList.toggle('hidden-by-filter', hidden);
  }

  function toggleChannel(id) {
    if (hiddenChannels.has(id)) hiddenChannels.delete(id);
    else hiddenChannels.add(id);
    persistHidden();
    rebuildChannelMenu();
    entryEls.forEach((el) => applyFilter(el));
    if (pinnedToBottom) scrollToBottom();
  }

  /** Show exactly this group's channels, hide the rest */
  function applyGroup(g) {
    hiddenChannels = new Set([...channels.keys()].filter((cid) => !g.channelIds.includes(cid)));
    persistHidden();
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

    if (groups.size) {
      for (const g of groups.values()) {
        const on = groupIsActive(g);
        const item = document.createElement('button');
        item.className = 'pt-channel-item pt-group-item' + (on ? ' on' : '');
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
      divider.className = 'pt-menu-divider';
      channelMenu.appendChild(divider);
    }

    let visibleCount = 0;
    for (const [id, info] of channels) {
      const on = !hiddenChannels.has(id);
      if (on) visibleCount++;
      const item = document.createElement('button');
      item.className = 'pt-channel-item' + (on ? ' on' : '');
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
        // keep the menu open: the rebuild detaches this item, which would
        // make the outside-click handler think we clicked outside
        e.stopPropagation();
        toggleChannel(id);
      });
      channelMenu.appendChild(item);
    }
    channelBtn.textContent = visibleCount === channels.size
      ? 'Channels ▾'
      : `Channels (${visibleCount}/${channels.size}) ▾`;
  }

  channelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    channelMenu.hidden = !channelMenu.hidden;
  });
  const onDocClick = (e) => {
    if (!channelMenu.hidden && !e.target.closest('.pt-dd')) channelMenu.hidden = true;
  };
  document.addEventListener('click', onDocClick);

  /* ── clear (local view only) ────────────────────────────────────── */

  root.querySelector('.pt-clear').addEventListener('click', () => {
    entryEls.forEach((el) => el.remove());
    entryEls.clear();
    emptyEl.hidden = false;
  });

  /* ── scrolling ──────────────────────────────────────────────────── */

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
    if (el.classList.contains('hidden-by-filter')) return;
    if (pinnedToBottom) scrollToBottom();
    else jumpBtn.hidden = false;
  }

  /* ── entry rendering ────────────────────────────────────────────── */

  function channelInfo(entry) {
    const known = channels.get(entry.channelId);
    return {
      name: (known && known.name) || entry.channelName || 'Unknown',
      color: (known && known.color) || 'var(--muted)',
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
      el.className = 'pt-entry';
      el.dataset.channelId = entry.channelId || '';
      el.dataset.channelName = entry.channelName || '';
      const info = channelInfo(entry);
      el.style.setProperty('--ch', info.color);

      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = fmtTime(entry.date);

      const avatar = document.createElement('span');
      avatar.className = 'avatar';
      avatar.style.color = info.color;
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

  /* ── SSE event parsing ──────────────────────────────────────────── */

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

  /* ── data loading (all via the module's proxy) ──────────────────── */

  async function loadChannels() {
    const res = await moduleApi.fetch('/prodcom/api/v1/channels');
    if (!res.ok) throw new Error('channels ' + res.status);
    const body = await res.json();
    channels.clear();
    for (const ch of body.data || []) {
      channels.set(ch.id, { name: ch.name, color: ch.color || '#8b98a5' });
    }
    rebuildChannelMenu();
  }

  async function loadGroups() {
    const res = await moduleApi.fetch('/prodcom/api/v1/groups');
    if (!res.ok) throw new Error('groups ' + res.status);
    const body = await res.json();
    groups.clear();
    for (const g of body.data || []) {
      groups.set(g.id, { name: g.name, channelIds: g.channelIds || [] });
    }
    rebuildChannelMenu();
  }

  async function loadHistory() {
    const res = await moduleApi.fetch('/prodcom/api/v1/transcript?limit=100');
    if (!res.ok) throw new Error('transcript ' + res.status);
    const body = await res.json();
    const entries = (body.data || []).slice();
    entries.sort((a, b) => new Date(a.date) - new Date(b.date));
    entries.forEach(upsertEntry);
  }

  /* ── live stream ────────────────────────────────────────────────── */

  const SSE_EVENT_NAMES = [
    'transcript', 'transcript.new', 'transcript.updated', 'transcript.update',
    'transcript.completed', 'transcript.complete', 'entry', 'new', 'update',
    'updated', 'complete', 'completed',
  ];

  function connect() {
    const onEvent = (ev) => handleEventData(ev.data);
    const events = {};
    for (const name of SSE_EVENT_NAMES) events[name] = onEvent;

    stream = moduleApi.sse('/prodcom/api/v1/transcript/stream', {
      open() {
        moduleApi.setStatus('ok', 'Live');
        // refresh channels/groups and backfill entries missed while
        // disconnected (upsertEntry dedupes by id, so this is harmless)
        loadChannels().catch(() => {});
        loadGroups().catch(() => {});
        loadHistory().catch(() => {});
      },
      error() {
        moduleApi.setStatus('error', 'ProdCom unreachable — reconnecting…');
      },
      message: onEvent,
      events,
    });
  }

  /* ── lifecycle ──────────────────────────────────────────────────── */

  async function boot() {
    if (stopped) return;
    moduleApi.setStatus('connecting', 'Connecting to ProdCom…');
    try {
      await loadChannels();
      await loadGroups().catch(() => {}); // groups are optional
      await loadHistory();
    } catch {
      moduleApi.setStatus('error', 'ProdCom unreachable — retrying…');
      bootTimer = setTimeout(boot, 5000);
      return;
    }
    scrollToBottom();
    connect();
  }

  return {
    start() {
      boot();
    },
    stop() {
      stopped = true;
      clearTimeout(bootTimer);
      stream?.close();
      document.removeEventListener('click', onDocClick);
      root.innerHTML = '';
    },
    onResize() {
      if (pinnedToBottom) scrollToBottom();
    },
  };
}
