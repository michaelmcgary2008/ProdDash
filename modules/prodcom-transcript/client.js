/* ProdCom Transcript — client part.

   Ported from prodcom-listener/public/app.js into the ProdDash module
   contract: everything lives inside the tile's root, per-tile state
   (hidden channels, channel icons, timestamps, text size, flow direction)
   persists in instance settings, and the data comes from the module's own
   server, which keeps one connection to ProdCom for every dashboard: a
   snapshot on connect (`state`), then each changed entry (`entry`). */

/* the text-size buttons: a drawn − and + at the icon size, like every other header icon */
const MINUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>';
const PLUS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

export default function create({ root, moduleApi }) {
  /* ── per-instance state ─────────────────────────────────────────── */

  const channels = new Map(); // channelId -> {name, color}
  const groups = new Map();   // groupId -> {name, channelIds}
  const entryEls = new Map(); // entryId -> element
  let pinnedToLatest = true;
  let hiddenChannels = new Set(moduleApi.instanceSettings.hiddenChannels || []);
  let stream = null;          // moduleApi.sse handle
  let stopped = false;

  /* ── DOM skeleton ───────────────────────────────────────────────── */

  root.innerHTML = `
    <div class="pt-wrap">
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

  /* ── title-bar controls ─────────────────────────────────────────── */

  const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  const JUMP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
  const CLEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>';
  const CHANNELS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16l-6 7.4V19l-4 2v-8.6z"/></svg>';
  // arrow shows where new messages land: down = oldest first, up = newest first
  const FLOW_DOWN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4v14"/><path d="m3 15 3 3 3-3"/><path d="M12 5h8"/><path d="M12 12h8"/><path d="M12 19h6"/></svg>';
  const FLOW_UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 20V6"/><path d="m3 9 3-3 3 3"/><path d="M12 5h8"/><path d="M12 12h8"/><path d="M12 19h6"/></svg>';

  let channelMenuEl = null; // the open menu's element (filled on each open)
  const channelsMenu = moduleApi.header.addMenu({
    icon: CHANNELS_SVG,
    title: 'Channels',
    build(menu) {
      menu.classList.add('pt-menu');
      channelMenuEl = menu;
      rebuildChannelMenu();
    },
  });
  channelsMenu.button.classList.add('pt-channels-btn');
  // the icon carries the label; a count rides alongside it while filtering
  const channelCountEl = document.createElement('span');
  channelCountEl.className = 'pt-count';
  channelCountEl.hidden = true;
  channelsMenu.button.appendChild(channelCountEl);

  let timeBtn = null;
  timeBtn = moduleApi.header.addButton({
    icon: CLOCK_SVG,
    title: 'Timestamps',
    onClick() {
      moduleApi.saveInstanceSettings({ showTimes: !moduleApi.instanceSettings.showTimes });
      applyInstanceSettings();
    },
  });

  function bumpTextSize(delta) {
    const current = Number(moduleApi.instanceSettings.textSize) || 15;
    moduleApi.saveInstanceSettings({ textSize: Math.min(48, Math.max(10, current + delta)) });
    applyInstanceSettings();
  }
  moduleApi.header.addButton({ icon: MINUS_SVG, title: 'Smaller text', onClick: () => bumpTextSize(-2) });
  moduleApi.header.addButton({ icon: PLUS_SVG, title: 'Larger text', onClick: () => bumpTextSize(2) });

  // icon and tooltip track the current direction — applyInstanceSettings sets both
  const flowBtn = moduleApi.header.addButton({
    icon: FLOW_DOWN_SVG,
    onClick() {
      moduleApi.saveInstanceSettings({ newestFirst: !moduleApi.instanceSettings.newestFirst });
      applyInstanceSettings();
      // the two directions have opposite "latest" ends — follow the flip
      if (pinnedToLatest) scrollToLatest();
    },
  });

  moduleApi.header.addButton({
    icon: JUMP_SVG,
    title: 'Latest',
    onClick() {
      pinnedToLatest = true;
      jumpBtn.hidden = true;
      scrollToLatest();
    },
  });

  const clearBtn = moduleApi.header.addButton({
    icon: CLEAR_SVG,
    title: 'Clear',
    onClick: clearView,
  });
  clearBtn.classList.add('pt-clear');

  function applyInstanceSettings() {
    const s = moduleApi.instanceSettings;
    const size = Math.min(48, Math.max(10, Number(s.textSize) || 15));
    wrap.style.setProperty('--pt-size', size + 'px');
    wrap.classList.toggle('show-times', Boolean(s.showTimes));
    wrap.classList.toggle('hide-avatars', s.showAvatars === false);
    timeBtn?.classList.toggle('active', Boolean(s.showTimes));

    const up = newestFirst();
    wrap.classList.toggle('newest-first', up);
    flowBtn.innerHTML = up ? FLOW_UP_SVG : FLOW_DOWN_SVG;
    flowBtn.classList.toggle('active', up);
    flowBtn.title = up ? 'Newest first' : 'Oldest first';
    jumpBtn.textContent = (up ? '↑' : '↓') + ' New messages';
  }
  applyInstanceSettings();

  /* ── channel visibility toggles ─────────────────────────────────── */

  function persistHidden() {
    moduleApi.saveInstanceSettings({ hiddenChannels: [...hiddenChannels] });
  }

  function applyFilter(el) {
    el.classList.toggle('hidden-by-filter', hiddenChannels.has(el.dataset.channelId));
  }

  function toggleChannel(id) {
    if (hiddenChannels.has(id)) hiddenChannels.delete(id);
    else hiddenChannels.add(id);
    persistHidden();
    rebuildChannelMenu();
    entryEls.forEach((el) => applyFilter(el));
    if (pinnedToLatest) scrollToLatest();
  }

  /** Show exactly this group's channels, hide the rest */
  function applyGroup(g) {
    hiddenChannels = new Set([...channels.keys()].filter((cid) => !g.channelIds.includes(cid)));
    persistHidden();
    rebuildChannelMenu();
    entryEls.forEach((el) => applyFilter(el));
    if (pinnedToLatest) scrollToLatest();
  }

  function groupIsActive(g) {
    const members = g.channelIds.filter((cid) => channels.has(cid));
    if (!members.length) return false;
    return [...channels.keys()].every((cid) =>
      members.includes(cid) ? !hiddenChannels.has(cid) : hiddenChannels.has(cid)
    );
  }

  /* The button is an icon, so the "some channels are hidden" state shows as
     an accent tint plus a compact count beside it. */
  function updateChannelsButton() {
    let visibleCount = 0;
    for (const id of channels.keys()) {
      if (!hiddenChannels.has(id)) visibleCount++;
    }
    const filtering = channels.size > 0 && visibleCount !== channels.size;
    channelCountEl.textContent = filtering ? `${visibleCount}/${channels.size}` : '';
    channelCountEl.hidden = !filtering;
    channelsMenu.button.classList.toggle('active', filtering);
    channelsMenu.button.title = filtering ? `Channels ${visibleCount}/${channels.size}` : 'Channels';
  }

  function rebuildChannelMenu() {
    updateChannelsButton();
    const channelMenu = channelMenuEl;
    if (!channelMenu) return; // menu not opened yet — the label is enough
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

    for (const [id, info] of channels) {
      const on = !hiddenChannels.has(id);
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
  }

  /* ── clear (local view only) ────────────────────────────────────── */

  function clearView() {
    entryEls.forEach((el) => el.remove());
    entryEls.clear();
    emptyEl.hidden = false;
  }

  /* ── scrolling ──────────────────────────────────────────────────── */

  /** Newest entry at the top (bottom-up) instead of at the bottom? */
  function newestFirst() {
    return Boolean(moduleApi.instanceSettings.newestFirst);
  }

  streamEl.addEventListener('scroll', () => {
    const near = newestFirst()
      ? streamEl.scrollTop < 60
      : streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 60;
    pinnedToLatest = near;
    if (near) jumpBtn.hidden = true;
  });

  jumpBtn.addEventListener('click', () => {
    pinnedToLatest = true;
    jumpBtn.hidden = true;
    scrollToLatest();
  });

  /** The latest entry is at the top when flipped, at the bottom otherwise. */
  function scrollToLatest() {
    streamEl.scrollTop = newestFirst() ? 0 : streamEl.scrollHeight;
  }

  function afterInsert(el) {
    if (el.classList.contains('hidden-by-filter')) return;
    if (pinnedToLatest) scrollToLatest();
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

      // channel name with its timestamp to the right; the clock button
      // only toggles the timestamp's visibility
      const chLine = document.createElement('span');
      chLine.className = 'channel-line';
      chLine.append(ch, time);

      const body = document.createElement('div');
      body.className = 'body';
      body.append(chLine, text);

      el.append(avatar, body);
      entryEls.set(id, el);
      applyFilter(el);
      entriesEl.appendChild(el);
      updateEntryEl(el, entry);
      afterInsert(el);
    } else {
      updateEntryEl(el, entry);
      if (pinnedToLatest && !el.classList.contains('hidden-by-filter')) scrollToLatest();
    }
  }

  function updateEntryEl(el, entry) {
    el.querySelector('.text').textContent = entry.translatedText || entry.text;
    el.classList.toggle('in-progress', entry.inProgress === true);
  }

  /* ── SSE event parsing ──────────────────────────────────────────── */

  /* The stream sends JSON objects for new/updated/completed transcript
     entries. Be liberal about the envelope shape. */
  /* ── the module's feed: one snapshot, then each change ─────────── */

  function applyStatus(st) {
    if (!st || typeof st !== 'object') return;
    if (st.state === 'ok') moduleApi.setStatus('ok', st.message || 'Live');
    else moduleApi.setStatus(st.state === 'error' ? 'error' : 'connecting', st.message || 'Connecting to ProdCom…');
  }

  function applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    channels.clear();
    for (const ch of snap.channels || []) channels.set(String(ch.id), { name: ch.name, color: ch.color || '#8b98a5' });
    groups.clear();
    for (const g of snap.groups || []) groups.set(String(g.id), { name: g.name, channelIds: g.channelIds || [] });
    rebuildChannelMenu();
    const list = (snap.entries || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    list.forEach(upsertEntry); // dedupes by id, so a snapshot after a reconnect is harmless
    applyStatus(snap.status);
  }

  async function loadState() {
    try {
      const res = await moduleApi.fetch('/state');
      if (!res.ok) throw new Error(String(res.status));
      applySnapshot(await res.json());
    } catch { /* the stream's own snapshot covers it */ }
  }

  function connect() {
    stream = moduleApi.sse('/stream', {
      open() {
        loadState(); // a late joiner, or a reconnect: catch up on what was missed
      },
      error() {
        moduleApi.setStatus('error', 'ProdDash ProdCom module unreachable — reconnecting…');
      },
      events: {
        state(ev) {
          try { applySnapshot(JSON.parse(ev.data)); } catch { /* a bad frame is skipped */ }
        },
        entry(ev) {
          try { upsertEntry(JSON.parse(ev.data)); } catch { /* skipped */ }
        },
        clear() {
          clearView();
        },
        status(ev) {
          try { applyStatus(JSON.parse(ev.data)); } catch { /* skipped */ }
        },
      },
    });
  }

  /* ── lifecycle ──────────────────────────────────────────────────── */

  return {
    start() {
      moduleApi.setStatus('connecting', 'Connecting to ProdCom…');
      connect();
    },
    stop() {
      stopped = true;
      stream?.close();
      root.innerHTML = ''; // header controls are removed by the shell
    },
    onResize() {
      if (pinnedToLatest) scrollToLatest();
    },
  };
}
