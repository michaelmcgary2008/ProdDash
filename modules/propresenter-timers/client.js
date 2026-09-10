/* ProPresenter Timers — client part.

   The server part does all the ProPresenter talking and streams one merged
   state object here over SSE. Each tile renders whichever timers (and/or the
   LTC timecode) it has enabled, as auto-sized cards in a responsive grid.
   Which items a tile shows is per-tile state, picked in a "Timers ▾" header
   menu and persisted with the layout — the timer list is dynamic, so a
   static instanceSchema field can't list them (same approach as the ProdCom
   module's channels menu). Timers this tile has never seen default to
   enabled: only explicit un-ticks are stored. */

const LTC_KEY = '__ltc__';

/* ── SMPTE timecode math (module-scope, exported for tests) ─────────
   The server anchors us ~4×/s with { time, fps, df, ageMs }; the card
   counts every frame in between locally. That needs exact frame↔timecode
   conversion, including 29.97 drop-frame (frames 00 and 01 don't exist at
   the top of a minute, except every tenth minute). */

export function parseTc(str) {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{1,2})$/.exec(String(str || '').trim());
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]), s: Number(m[3]), f: Number(m[4]) };
}

export function tcToFrames(tc, nominal, df) {
  let n = (tc.h * 3600 + tc.m * 60 + tc.s) * nominal + tc.f;
  if (df) {
    const mins = tc.h * 60 + tc.m;
    n -= 2 * (mins - Math.floor(mins / 10));
  }
  return n;
}

export function framesToTc(n, nominal, df) {
  // 10 DF minutes hold 17982 frames (the first minute 1800, the rest 1798).
  const perDay = df ? 24 * 6 * 17982 : 24 * 3600 * nominal;
  n = ((n % perDay) + perDay) % perDay;
  if (df) {
    const d = Math.floor(n / 17982);
    const m10 = n % 17982;
    const extra = m10 < 1800 ? 0 : Math.floor((m10 - 1800) / 1798) + 1;
    const totalMin = d * 10 + extra;
    // Re-add the two dropped frames per dropped minute, then read as 30fps.
    n += 2 * (totalMin - Math.floor(totalMin / 10));
  }
  const f = n % nominal;
  const secs = Math.floor(n / nominal);
  const pad = (v) => String(v).padStart(2, '0');
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(f)}`;
}

export default function create({ root, moduleApi }) {
  let state = null;
  let feedOffline = false;
  let stream = null;
  let resizeObserver = null;
  let hiddenItems = new Set(moduleApi.instanceSettings.hiddenItems || []);

  // Which picker entry this tile was added as (the module's tiles() list):
  // '' or 'all' = every item, selectable via the Timers ▾ menu;
  // 'timer:<uuid>' or 'ltc' = exactly one card, no menu.
  const variant = String(moduleApi.variant || '');
  const soloKey = variant === 'ltc' ? LTC_KEY
    : variant.startsWith('timer:') ? variant.slice('timer:'.length)
      : '';
  /** Last name seen for a solo timer, so its card stays labeled if the
      timer is later deleted in ProPresenter. */
  let lastSoloName = '';

  /* ── DOM skeleton ───────────────────────────────────────────────── */

  root.innerHTML = `
    <div class="tm-wrap">
      <div class="tm-banner" hidden></div>
      <div class="tm-hint" hidden></div>
      <div class="tm-grid"></div>
    </div>`;

  const wrap = root.querySelector('.tm-wrap');
  const bannerEl = root.querySelector('.tm-banner');
  const hintEl = root.querySelector('.tm-hint');
  const gridEl = root.querySelector('.tm-grid');

  /** key (uuid or LTC_KEY) → { el, nameEl, timeEl, stateEl } */
  const cards = new Map();

  /* ── title-bar menu: pick which timers / LTC this tile shows ────── */

  let menuEl = null; // the open menu's element (filled on each open)
  const itemsMenu = soloKey ? null : moduleApi.header.addMenu({
    label: 'Timers ▾',
    title: 'Choose which timers this tile shows',
    build(menu) {
      menu.classList.add('tm-menu');
      menuEl = menu;
      rebuildMenu();
    },
  });

  function menuRows() {
    const rows = (state?.timers || []).map((t) => ({ key: t.uuid, name: t.name }));
    // No LTC row while the listener is off in Admin — the item shouldn't
    // even be offerable.
    if (state?.ltcEnabled) rows.push({ key: LTC_KEY, name: 'LTC timecode' });
    return rows;
  }

  function persistHidden() {
    moduleApi.saveInstanceSettings({ hiddenItems: [...hiddenItems] });
  }

  function toggleItem(key) {
    if (hiddenItems.has(key)) hiddenItems.delete(key);
    else hiddenItems.add(key);
    persistHidden();
    rebuildMenu();
    render();
  }

  function updateMenuLabel() {
    if (!itemsMenu) return;
    const rows = menuRows();
    const visible = rows.filter((r) => !hiddenItems.has(r.key)).length;
    itemsMenu.setLabel(visible === rows.length
      ? 'Timers ▾'
      : `Timers (${visible}/${rows.length}) ▾`);
  }

  function rebuildMenu() {
    updateMenuLabel();
    if (!menuEl) return; // menu not opened yet — the label is enough
    menuEl.innerHTML = '';
    const rows = menuRows();
    if (rows.length === 1) {
      const note = document.createElement('div');
      note.className = 'tm-menu-note';
      note.textContent = 'No timers discovered yet';
      menuEl.appendChild(note);
    }
    for (const row of rows) {
      const on = !hiddenItems.has(row.key);
      const item = document.createElement('button');
      item.className = 'tm-menu-item' + (on ? ' on' : '');
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', String(on));
      const check = document.createElement('span');
      check.className = 'check';
      check.textContent = '✓';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.name;
      item.append(check, name);
      item.addEventListener('click', (e) => {
        // keep the menu open: the rebuild detaches this item, which would
        // make the outside-click handler think we clicked outside
        e.stopPropagation();
        toggleItem(row.key);
      });
      menuEl.appendChild(item);
    }
  }

  /* ── state → cards ──────────────────────────────────────────────── */

  /** Map the API's state string onto our four looks. The spec's enum is
      stopped|running|complete|overrunning|overran, but its own response
      example says "overrun" — match the substring. */
  function classify(apiState) {
    const s = String(apiState || '').toLowerCase();
    if (s.includes('overr')) return 'overrun';
    if (s === 'running') return 'running';
    if (s === 'complete') return 'complete';
    return 'stopped';
  }

  const STATE_TEXT = { running: 'Running', stopped: 'Stopped', complete: 'Complete', overrun: 'Overrun' };

  /** Show the value the way ProPresenter reports it (sign included);
      only the ".00" hundredths some builds append are dropped for fit. */
  function displayTime(raw) {
    const s = String(raw || '').replace(/\.\d+$/, '');
    return s || '—';
  }

  function visibleItems() {
    const ltcState = state?.ltc || { supported: null, time: '', receiving: false };
    if (soloKey === LTC_KEY) return [{ key: LTC_KEY, ltc: ltcState }];
    if (soloKey) {
      const timer = (state?.timers || []).find((t) => t.uuid === soloKey);
      if (timer) {
        lastSoloName = timer.name;
        return [{ key: soloKey, timer }];
      }
      // The timer this tile was added for isn't in ProPresenter's list (yet,
      // or any more) — keep a clearly-labeled card up rather than erroring.
      return [{ key: soloKey, missing: true }];
    }
    const items = [];
    for (const t of state?.timers || []) {
      if (!hiddenItems.has(t.uuid)) items.push({ key: t.uuid, timer: t });
    }
    if (state?.ltcEnabled && !hiddenItems.has(LTC_KEY)) items.push({ key: LTC_KEY, ltc: ltcState });
    return items;
  }

  function makeCard(item) {
    const el = document.createElement('div');
    el.className = 'tm-card' + (item.ltc ? ' tm-card-ltc' : '');
    const nameEl = document.createElement('div');
    nameEl.className = 'tm-name';
    const timeEl = document.createElement('div');
    timeEl.className = 'tm-time';
    const stateEl = document.createElement('div');
    stateEl.className = 'tm-state';
    if (item.ltc) {
      const badge = document.createElement('span');
      badge.className = 'tm-ltc-badge';
      badge.textContent = 'LTC';
      nameEl.append(badge, document.createTextNode('Timecode'));
    }
    el.append(nameEl, timeEl, stateEl);
    return { el, nameEl, timeEl, stateEl };
  }

  /** A solo tile whose timer vanished from ProPresenter's list. While the
      server is unreachable the list is merely unknown — the banner already
      says so, so only claim "not in ProPresenter" when actually connected. */
  function updateMissingCard(card) {
    card.nameEl.textContent = lastSoloName || 'Timer';
    card.timeEl.textContent = '—';
    if (state?.reachable) {
      card.stateEl.textContent = 'Not in ProPresenter';
      card.el.className = 'tm-card is-missing';
    } else {
      card.stateEl.textContent = '—';
      card.el.className = 'tm-card is-stopped';
    }
  }

  function updateTimerCard(card, timer) {
    card.nameEl.textContent = timer.name;
    card.timeEl.textContent = displayTime(timer.time);
    const kind = classify(timer.state);
    card.stateEl.textContent = timer.state ? (STATE_TEXT[kind] || timer.state) : '—';
    card.el.className = `tm-card is-${kind}`;
  }

  /* ── real-time LTC: count every frame between server anchors ─────── */

  // The server anchors us ~4×/s with the decoded timecode, its rate and
  // how old it is (ageMs). Between anchors a requestAnimationFrame loop
  // advances the display at the LTC's own rate, so every frame paints —
  // without pushing 30 SSE messages a second at every dashboard.
  let ltcAnchor = null; // { frames, at, recvAt, rate, nominal, df }
  let ltcRaf = 0;
  let ltcShownFrames = -1;
  /** Anchors arrive ~every 250 ms while running. None for this long means
      the feed state is changing — hold rather than freewheel into phantom
      frames the next update would visibly rewind. */
  const ANCHOR_FRESH_MS = 350;

  function updateLtcAnchor() {
    const l = state?.ltc;
    // Only the audio sources are extrapolatable — they know the frame rate.
    const live = l && l.status === 'running' && l.fps > 0
      && (l.source === 'listener' || l.source === 'reader');
    const tc = live ? parseTc(l.time) : null;
    if (!tc) {
      ltcAnchor = null;
      ltcShownFrames = -1;
      if (ltcRaf) {
        cancelAnimationFrame(ltcRaf);
        ltcRaf = 0;
      }
      return;
    }
    const nominal = l.df ? 30 : Math.round(l.fps);
    ltcAnchor = {
      frames: tcToFrames(tc, nominal, l.df),
      at: performance.now() - (Number(l.ageMs) || 0),
      recvAt: performance.now(),
      rate: l.df ? 30000 / 1001 : nominal,
      nominal,
      df: l.df,
    };
    if (!ltcRaf) ltcRaf = requestAnimationFrame(ltcTick);
  }

  /** Paint the frame the anchor implies for right now. Called both by the
      rAF loop (smooth, per-frame, on visible tabs) and by render() at the
      4×/s anchor rate — so a throttled/backgrounded tab, where rAF is
      paused, still advances at the anchor rate instead of freezing. */
  function paintLtcFrame() {
    const a = ltcAnchor;
    const card = cards.get(LTC_KEY);
    if (!a || !card) return;
    const limit = Math.min(performance.now(), a.recvAt + ANCHOR_FRESH_MS);
    let n = a.frames + Math.round(((limit - a.at) / 1000) * a.rate);
    // Anchor jitter (±1 frame) must never tick the display backwards;
    // a genuine jump back (re-strike, seek) is far larger and passes.
    if (ltcShownFrames >= 0 && n < ltcShownFrames && ltcShownFrames - n <= 2) n = ltcShownFrames;
    if (n !== ltcShownFrames) {
      ltcShownFrames = n;
      card.timeEl.textContent = framesToTc(n, a.nominal, a.df);
    }
  }

  function ltcTick() {
    ltcRaf = 0;
    // No anchor, or the LTC card is hidden in this tile: stop — the next
    // server anchor (4×/s while running) re-arms the loop via render().
    if (!ltcAnchor || !cards.get(LTC_KEY)) return;
    paintLtcFrame();
    ltcRaf = requestAnimationFrame(ltcTick);
  }

  function updateLtcCard(card, ltc) {
    let mode;
    // Only the audio sources know the frame rate (decoded from the LTC
    // bits); a set drop-frame flag implies 29.97 whatever fps rounds to.
    const rate = ltc.df ? '29.97 DF' : ltc.fps ? `${ltc.fps} fps` : '';
    if (ltc.supported === false) {
      mode = 'unavailable';
      card.timeEl.textContent = '—';
      // The server says why when it knows (stage password rejected, no
      // stage field labeled LTC, reader offline, …) — surface that over
      // the generic line.
      card.stateEl.textContent = ltc.note || 'Timecode not available on this ProPresenter';
    } else if (ltc.supported === null) {
      mode = 'waiting';
      card.timeEl.textContent = displayTime(ltc.time);
      card.stateEl.textContent = 'Waiting for ProPresenter…';
    } else if (ltc.receiving) {
      mode = 'receiving';
      // With an anchor active, paint the frame it implies for now (this
      // keeps a throttled tab advancing at the 4×/s anchor rate); the rAF
      // loop refines it to every frame when the tab is visible. Without an
      // anchor (rate unknown), fall back to the raw anchor timecode.
      if (ltcAnchor) paintLtcFrame();
      else card.timeEl.textContent = displayTime(ltc.time);
      card.stateEl.textContent = rate ? `Running · ${rate}` : 'Running';
    } else if (ltc.status === 'stopped' || ltc.time) {
      // LTC ceased but we know where it stopped — hold the last frame.
      mode = 'stopped';
      card.timeEl.textContent = displayTime(ltc.time);
      card.stateEl.textContent = 'Stopped';
    } else {
      mode = 'nosignal';
      card.timeEl.textContent = '—';
      card.stateEl.textContent = 'No signal';
    }
    // The built-in listener and the remote reader are independent of
    // ProPresenter, so their card must not gray out with the rest when
    // only ProPresenter is unreachable.
    const live = ltc.source === 'reader' || ltc.source === 'listener' ? ' src-reader' : '';
    card.el.className = `tm-card tm-card-ltc is-ltc-${mode}${live}`;
  }

  /* ── status dot + degraded banners ──────────────────────────────── */

  function renderStatus() {
    wrap.classList.toggle('is-stale', feedOffline || (state ? !state.reachable && state.enabled : false));
    // The stale gray-out spares the reader-fed LTC card — unless the feed
    // from the ProdDash server itself is down, when everything is stale.
    wrap.classList.toggle('is-feed-down', feedOffline);
    if (feedOffline) {
      bannerEl.hidden = false;
      bannerEl.textContent = 'Not receiving updates from the ProdDash server.';
      moduleApi.setStatus('error', 'ProdDash server unreachable — reconnecting…');
      return;
    }
    if (!state) {
      bannerEl.hidden = true;
      moduleApi.setStatus('connecting', 'Connecting…');
      return;
    }
    if (!state.enabled) {
      bannerEl.hidden = true;
      // The LTC listener/reader feed us with or without ProPresenter — an
      // LTC-only setup is working, not broken.
      if (state.ltc?.supported) moduleApi.setStatus('ok', 'LTC only — no ProPresenter host configured');
      else moduleApi.setStatus('error', 'No ProPresenter host configured — set one in Admin');
      return;
    }
    if (!state.reachable) {
      bannerEl.hidden = false;
      bannerEl.textContent = 'ProPresenter unreachable — reconnecting…';
      moduleApi.setStatus('error', 'ProPresenter unreachable — reconnecting…');
      return;
    }
    bannerEl.hidden = true;
    moduleApi.setStatus('ok', 'Following ProPresenter timers');
  }

  /* ── main render: diff the card set, update in place ────────────── */

  function render() {
    renderStatus();
    rebuildMenu();
    updateLtcAnchor();

    let hint = '';
    if (state && !state.enabled && !state.ltc?.supported) {
      hint = 'No ProPresenter connection — set the host and port in Admin.';
    }
    const items = hint ? [] : visibleItems();
    if (!hint && state?.reachable && !items.length) {
      hint = 'Nothing selected — pick timers in the Timers ▾ menu.';
    }
    hintEl.hidden = !hint;
    hintEl.textContent = hint;
    gridEl.hidden = Boolean(hint);
    if (hint) return;

    const wanted = new Set(items.map((i) => i.key));
    let structureChanged = false;
    for (const [key, card] of cards) {
      if (!wanted.has(key)) {
        card.el.remove();
        cards.delete(key);
        structureChanged = true;
      }
    }
    for (const item of items) {
      let card = cards.get(item.key);
      if (!card) {
        card = makeCard(item);
        cards.set(item.key, card);
        structureChanged = true;
      }
      if (item.ltc) updateLtcCard(card, item.ltc);
      else if (item.missing) updateMissingCard(card);
      else updateTimerCard(card, item.timer);
    }
    // Keep DOM order in step with the state's order (config-list order).
    const orderedEls = items.map((i) => cards.get(i.key).el);
    if (structureChanged || orderedEls.some((el, i) => gridEl.children[i] !== el)) {
      gridEl.replaceChildren(...orderedEls);
      fit();
    }
  }

  /* ── sizing: pick the column count that gives the biggest digits ── */

  function fit() {
    const n = Math.max(1, gridEl.childElementCount);
    const W = root.clientWidth;
    const H = root.clientHeight;
    if (!W || !H) return;
    const PAD = H < 120 ? 4 : 10;
    const GAP = H < 120 ? 5 : 8;
    const CARD_PAD = 12; // a card's own vertical padding + borders

    // For each column count, budget a card's full stack (name line, digits,
    // state line) and score by the digit size it affords ("-00:00:00" ≈ 9
    // tabular chars wide). Cards too short for three readable lines drop to
    // a compact look — no state text, the card color carries the state —
    // but any layout with a readable full stack beats every compact one.
    let best = null;
    for (let cols = 1; cols <= n; cols += 1) {
      const rows = Math.ceil(n / cols);
      const cw = (W - PAD * 2 - GAP * (cols - 1)) / cols - 18;
      const ch = (H - PAD * 2 - GAP * (rows - 1)) / rows - CARD_PAD;
      if (cw <= 0 || ch <= 0) continue;
      const meta = Math.max(9, Math.min(22, Math.floor(ch * 0.16)));
      const byWidth = (cw * 1.55) / 9;
      const full = Math.min(byWidth, ch - 2.6 * meta);
      const compact = Math.min(byWidth, ch - 1.3 * meta);
      const mode = full >= 14 ? 'full' : 'compact';
      const size = mode === 'full' ? full : compact;
      const score = (mode === 'full' ? 1000 : 0) + size;
      if (!best || score > best.score) best = { cols, meta, mode, size, cw, score };
    }
    if (!best) return;
    gridEl.style.gridTemplateColumns = `repeat(${best.cols}, 1fr)`;
    wrap.style.setProperty('--tm-pad', PAD + 'px');
    wrap.style.setProperty('--tm-gap', GAP + 'px');
    wrap.classList.toggle('tm-compact', best.mode === 'compact');
    const timeSize = Math.max(11, Math.floor(best.size));
    // LTC digits ("00:00:00:00") are ~11.5 tabular chars wide in the same cell.
    const ltcSize = Math.max(11, Math.floor(Math.min((best.cw * 1.55) / 11.5, best.size)));
    wrap.style.setProperty('--tm-time-size', timeSize + 'px');
    wrap.style.setProperty('--tm-ltc-size', ltcSize + 'px');
    wrap.style.setProperty('--tm-meta-size', best.meta + 'px');
  }

  /* ── live feed ──────────────────────────────────────────────────── */

  function connect() {
    stream = moduleApi.sse('/stream', {
      open() {
        feedOffline = false;
        render();
      },
      error() {
        // EventSource retries by itself (and the shell recreates closed
        // streams), but the tile must admit it is frozen meanwhile.
        feedOffline = true;
        render();
      },
      events: {
        state(ev) {
          try {
            state = JSON.parse(ev.data);
          } catch {
            return;
          }
          feedOffline = false;
          render();
        },
      },
    });
  }

  /* ── lifecycle ──────────────────────────────────────────────────── */

  return {
    start() {
      moduleApi.setStatus('connecting', 'Connecting…');
      // Instant paint from the snapshot, then live updates.
      moduleApi.fetch('/state')
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (body && body.state && !state) {
            state = body.state;
            render();
          }
        })
        .catch(() => { /* the stream will cover it */ });
      connect();

      let lastW = 0;
      let lastH = 0;
      resizeObserver = new ResizeObserver(() => {
        const w = Math.round(root.clientWidth);
        const h = Math.round(root.clientHeight);
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        fit();
      });
      resizeObserver.observe(root);
      render();
    },
    stop() {
      stream?.close();
      stream = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (ltcRaf) {
        cancelAnimationFrame(ltcRaf);
        ltcRaf = 0;
      }
      root.innerHTML = ''; // header controls are removed by the shell
    },
    onResize() {
      fit();
    },
  };
}
