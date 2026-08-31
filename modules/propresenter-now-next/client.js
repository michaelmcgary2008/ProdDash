/* ProPresenter Now / Next — client part.

   Ported from band-lineup-display/propresenter-app/public/app.js into the
   ProdDash module contract: the server part does all the ProPresenter
   talking and streams the view-model here over SSE. Connection setup lives
   in /admin; the tile only renders. */

export default function create({ root, moduleApi }) {
  let state = null;
  let feedOffline = false;
  let stream = null;
  let resizeObserver = null;

  /* ── DOM skeleton ───────────────────────────────────────────────── */

  root.innerHTML = `
    <div class="nn-screen">
      <header class="nn-top">
        <div class="nn-playlist"></div>
        <div class="nn-live"><span class="nn-live-dot"></span><span class="nn-live-text">Connecting…</span></div>
      </header>
      <section class="nn-now">
        <div class="nn-label">Now</div>
        <div class="nn-title-box"><div class="nn-title is-waiting">Connecting…</div></div>
        <div class="nn-meta"></div>
        <div class="nn-progress" hidden><div class="nn-progress-fill"></div></div>
      </section>
      <section class="nn-next-wrap">
        <div class="nn-next-label" hidden>Next</div>
        <div class="nn-next-list"></div>
        <div class="nn-next-more" hidden></div>
      </section>
    </div>`;

  const screenEl = root.querySelector('.nn-screen');
  const topRow = root.querySelector('.nn-top');
  const playlistNameEl = root.querySelector('.nn-playlist');
  const liveEl = root.querySelector('.nn-live');
  const liveTextEl = root.querySelector('.nn-live-text');
  const nowEl = root.querySelector('.nn-now');
  const nowTitleBox = root.querySelector('.nn-title-box');
  let nowTitleEl = root.querySelector('.nn-title');
  const nowMetaEl = root.querySelector('.nn-meta');
  const progressEl = root.querySelector('.nn-progress');
  const progressFillEl = root.querySelector('.nn-progress-fill');
  const nextLabelEl = root.querySelector('.nn-next-label');
  const nextListEl = root.querySelector('.nn-next-list');
  const nextMoreEl = root.querySelector('.nn-next-more');

  function prefs() {
    return moduleApi.instanceSettings; // showPlaylist / showProgress / cleanTitles
  }

  /* ── title tidying (same rule as propresenter-core.cleanItemName) ─ */

  function cleanItemName(raw) {
    const original = String(raw || '').trim();
    let s = original;
    s = s.replace(/[[({][^\])}]*[\])}]/g, ' ');        // drop [..], (..), {..} tags
    s = s.replace(/^\s*\d{6,8}\b[\s\-–—:.]*/, '');       // drop a leading 6–8 digit date code
    s = s.replace(/\s[-–—]+\s/g, ' ');                   // drop " - " style separators
    s = s.replace(/^[\s\-–—:.]+|[\s\-–—:.]+$/g, '');     // trim edge dashes/colons/dots/space
    s = s.replace(/\s{2,}/g, ' ').trim();                // collapse runs of whitespace
    return s || original; // never blank out a title (e.g. a name that was only a tag)
  }

  function displayName(raw) {
    return prefs().cleanTitles ? cleanItemName(raw) : String(raw || '').trim();
  }

  function itemTypeTag(type) {
    switch (type) {
      case 'media': return 'Media';
      case 'audio': return 'Audio';
      case 'livevideo': return 'Live';
      case 'placeholder': return 'PCO';
      default: return '';
    }
  }

  /* ── rendering ──────────────────────────────────────────────────── */

  /** The items after the live one, hidden entries dropped. */
  function upcomingItems() {
    const items = Array.isArray(state?.items) ? state.items : [];
    // Presenting from the playlist → everything after the live item.
    // Presenting from the Library (activeIndex < 0) → the whole list is still ahead.
    const from = state && state.activeIndex >= 0 ? state.activeIndex + 1 : 0;
    const out = [];
    for (let i = from; i < items.length; i += 1) {
      if (!items[i].isHidden) out.push(items[i]);
    }
    return out;
  }

  /**
   * Hand the browser a brand-new title element whenever the text changes —
   * on some GPUs a large text element keeps a stale compositor backing
   * store, ghosting the previous song under the new one. A fresh node has
   * no old backing store. (Carried over from the wall display.)
   */
  let lastTitleText = null;
  function setNowTitle(text) {
    if (text === lastTitleText && nowTitleEl.isConnected) return;
    lastTitleText = text;
    const fresh = document.createElement('div');
    fresh.className = 'nn-title';
    fresh.textContent = text;
    nowTitleEl.replaceWith(fresh);
    nowTitleEl = fresh;
  }

  /**
   * Size the NOW title as large as fits without ever breaking a word:
   * with word-breaking forbidden, an over-wide word overflows and the same
   * fit test that guards height rejects that size too; binary search lands
   * on the biggest size where whole words fit. Hysteresis stops ±1px flap.
   */
  function fitNowTitle() {
    if (nowTitleEl.classList.contains('is-waiting')) return;
    const boxHeight = nowTitleBox.clientHeight;
    const boxWidth = nowTitleBox.clientWidth;
    const MIN = 11;

    nowTitleEl.style.whiteSpace = 'normal';
    nowTitleEl.style.overflowWrap = 'normal';
    nowTitleEl.style.wordBreak = 'normal';
    nowTitleEl.style.hyphens = 'none';

    if (boxHeight < MIN || !boxWidth) {
      nowTitleEl.style.fontSize = `${MIN}px`;
      return;
    }

    const fits = (size) => {
      nowTitleEl.style.fontSize = `${size}px`;
      return nowTitleEl.scrollWidth <= nowTitleBox.clientWidth + 1
        && nowTitleEl.scrollHeight <= nowTitleBox.clientHeight + 1;
    };

    const max = Math.max(MIN, Math.floor(boxHeight));
    let best = MIN;
    if (fits(max)) {
      best = max;
    } else {
      let lo = MIN;
      let hi = max;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
    }
    const currentSize = parseFloat(nowTitleEl.style.fontSize) || 0;
    // Hold the current size only if it still genuinely fits (a plain ±1px
    // band can straddle the line-wrap threshold and stick on the
    // overflowing side).
    if (currentSize && Math.abs(currentSize - best) <= 1 && fits(currentSize)) {
      nowTitleEl.style.fontSize = `${currentSize}px`;
      return;
    }
    nowTitleEl.style.fontSize = `${best}px`;

    // Last resort: one word so long it can't fit even at MIN — allow it to
    // break rather than overflow the card.
    if (best === MIN && nowTitleEl.scrollWidth > nowTitleBox.clientWidth + 1) {
      nowTitleEl.style.overflowWrap = 'anywhere';
      nowTitleEl.style.wordBreak = 'break-word';
    }
  }

  /**
   * Hide the NEXT rows past the bottom of the list and count them into
   * "+ N more". Rows are hidden, never removed, so the list's height stays
   * fixed and the layout can't ratchet.
   */
  function markNextOverflow() {
    const rows = Array.from(nextListEl.children);
    for (const row of rows) row.style.visibility = '';
    let hidden = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      const listRect = nextListEl.getBoundingClientRect();
      if (listRect.height <= 0) return;
      let changed = 0;
      for (const row of rows) {
        if (row.style.visibility === 'hidden') continue;
        if (row.getBoundingClientRect().bottom > listRect.bottom + 1) {
          row.style.visibility = 'hidden';
          changed += 1;
        }
      }
      hidden += changed;
      if (hidden > 0) {
        nextMoreEl.hidden = false;
        nextMoreEl.textContent = `+ ${hidden} more`;
      }
      if (changed === 0) break;
    }
    if (hidden === 0) {
      nextMoreEl.hidden = true;
      nextMoreEl.textContent = '';
    }
  }

  function renderLive() {
    liveEl.classList.remove('is-live', 'is-down');
    if (feedOffline) {
      liveEl.classList.add('is-down');
      liveTextEl.textContent = 'Feed offline';
      moduleApi.setStatus('error', 'ProdDash server unreachable — reconnecting…');
      return;
    }
    if (!state) {
      liveTextEl.textContent = 'Connecting…';
      moduleApi.setStatus('connecting', 'Connecting…');
      return;
    }
    if (!state.enabled) {
      liveTextEl.textContent = 'Not set up';
      moduleApi.setStatus('error', 'No ProPresenter host configured — set one in Admin');
      return;
    }
    if (state.reachable) {
      liveEl.classList.add('is-live');
      liveTextEl.textContent = 'Live';
      moduleApi.setStatus('ok', 'Following ProPresenter');
      return;
    }
    liveEl.classList.add('is-down');
    liveTextEl.textContent = 'Reconnecting…';
    moduleApi.setStatus('error', 'ProPresenter unreachable — reconnecting…');
  }

  function renderNow() {
    const activeItem = state && state.activeIndex >= 0 ? state.items[state.activeIndex] : null;
    const rawName = activeItem?.name || state?.activePresentationName || '';

    for (const stale of nowEl.querySelectorAll('.nn-hint, .nn-stale')) stale.remove();

    if (feedOffline) {
      setNowTitle(rawName ? `Last shown: ${displayName(rawName)}` : 'Feed offline');
      nowTitleEl.classList.add('is-waiting');
      nowTitleEl.style.fontSize = '';
      nowMetaEl.textContent = '';
      progressEl.hidden = true;
      const staleEl = document.createElement('div');
      staleEl.className = 'nn-stale';
      staleEl.textContent = 'Not receiving updates from the ProdDash server.';
      nowEl.appendChild(staleEl);
      return;
    }

    if (!rawName) {
      // A status message is not a song title — keep its CSS size instead of
      // the fill-the-box fit.
      let hint = '';
      if (!state?.enabled) {
        setNowTitle('No ProPresenter connection');
        hint = 'Set the ProPresenter host and port in Admin.';
      } else {
        // Connected with nothing live is normal (output cleared) — say it
        // plainly so nobody goes hunting for a broken connection.
        setNowTitle(state?.reachable ? 'Nothing on screen' : 'Reconnecting…');
        hint = state?.reachable
          ? 'Connected to ProPresenter — waiting for a slide to go live.'
          : 'Trying to reach ProPresenter.';
      }
      nowTitleEl.classList.add('is-waiting');
      nowTitleEl.style.fontSize = '';
      nowMetaEl.textContent = '';
      progressEl.hidden = true;
      if (hint) {
        const hintEl = document.createElement('div');
        hintEl.className = 'nn-hint';
        hintEl.textContent = hint;
        nowEl.appendChild(hintEl);
      }
      return;
    }

    setNowTitle(displayName(rawName));
    nowTitleEl.classList.remove('is-waiting');
    fitNowTitle();
    // Re-fit after layout settles: on the first render the box may not have
    // its final height, and a too-tall fit would overflow for a frame.
    requestAnimationFrame(() => {
      if (!nowTitleEl.classList.contains('is-waiting')) fitNowTitle();
    });

    // An empty NEXT list looks broken unless the tile says why it is empty.
    if (!upcomingItems().length) {
      const kind = state?.playlistKind;
      let why = '';
      if (kind === 'group' || kind === 'none') {
        why = 'Presenting from the library — no playlist open.';
      } else if (kind === 'unknown') {
        why = 'ProPresenter did not return this playlist’s items.';
      } else if (Array.isArray(state?.items) && state.items.length) {
        why = 'Last item in the playlist.';
      }
      if (why) {
        const note = document.createElement('div');
        note.className = 'nn-hint';
        note.textContent = why;
        nowEl.appendChild(note);
      }
    }

    const total = state.currentSlideTotal || activeItem?.slideCount || 0;
    const current = state.currentSlide || 0;
    if (total > 0 && current > 0) {
      const remaining = Math.max(0, total - current);
      nowMetaEl.textContent = `Slide ${current} / ${total} · ${remaining} left`;
    } else if (total > 0) {
      nowMetaEl.textContent = `${total} slides`;
    } else if (current > 0) {
      nowMetaEl.textContent = `Slide ${current}`;
    } else {
      nowMetaEl.textContent = '';
    }

    if (prefs().showProgress && total > 0) {
      progressEl.hidden = false;
      const pct = current > 0 ? Math.max(0, Math.min(100, (current / total) * 100)) : 0;
      progressFillEl.style.width = `${pct}%`;
    } else {
      progressEl.hidden = true;
    }
  }

  function renderNext() {
    nextListEl.innerHTML = '';
    const upcoming = upcomingItems();
    screenEl.classList.toggle('no-upcoming', upcoming.length === 0);

    for (const item of upcoming) {
      const row = document.createElement('div');
      const nameEl = document.createElement('div');
      nameEl.className = 'nn-next-name';

      if (item.type === 'header') {
        row.className = 'nn-next-item is-header';
        nameEl.textContent = displayName(item.name || '');
        row.appendChild(nameEl);
        nextListEl.appendChild(row);
        continue;
      }

      row.className = 'nn-next-item';
      nameEl.textContent = displayName(item.name) || '(untitled)';
      row.appendChild(nameEl);

      if (item.type === 'presentation' && Number.isInteger(item.slideCount)) {
        const chip = document.createElement('div');
        chip.className = 'nn-count-chip';
        chip.textContent = String(item.slideCount);
        row.appendChild(chip);
      } else {
        const tag = itemTypeTag(item.type);
        if (tag) {
          const tagEl = document.createElement('div');
          tagEl.className = 'nn-type-tag';
          tagEl.textContent = tag;
          row.appendChild(tagEl);
        }
      }
      nextListEl.appendChild(row);
    }

    nextLabelEl.hidden = upcoming.length === 0;
    nextMoreEl.hidden = true;
    markNextOverflow();
    requestAnimationFrame(markNextOverflow);
  }

  function render() {
    screenEl.classList.toggle('is-offline', feedOffline);
    const showTop = prefs().showPlaylist || feedOffline || !state?.reachable || !state?.enabled;
    topRow.classList.toggle('hidden-row', !showTop);
    playlistNameEl.textContent = prefs().showPlaylist ? state?.playlistName || '' : '';
    renderLive();
    renderNow();
    renderNext();
  }

  /* ── sizing: --unit scales the whole card to the tile ───────────── */

  function applyUnit() {
    const unit = Math.max(6.5, Math.min(20, root.clientHeight * 0.032));
    screenEl.style.setProperty('--unit', unit.toFixed(2) + 'px');
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
      applyUnit();
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

      // Re-fit on any size change; guard against reacting to our own DOM
      // writes by only re-rendering when a watched box actually changed.
      let lastW = 0;
      let lastH = 0;
      let pending = false;
      resizeObserver = new ResizeObserver(() => {
        const w = Math.round(root.clientWidth);
        const h = Math.round(root.clientHeight);
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          applyUnit();
          fitNowTitle();
          markNextOverflow();
        });
      });
      resizeObserver.observe(root);
      render();
    },
    stop() {
      stream?.close();
      stream = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      root.innerHTML = '';
    },
    onResize() {
      applyUnit();
      fitNowTitle();
      markNextOverflow();
    },
  };
}
