/* PCO Plan — client part.

   The server part reads Planning Center and (optionally) follows the
   ProPresenter module's live item; this tile only renders the plan it is
   streamed. Which details show is a per-tile choice (gear menu). */

const REFRESH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
const SETUP_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 12h18M3 17h12"/><circle cx="19" cy="17" r="2.2"/></svg>';

export default function create({ root, moduleApi }) {
  let state = null;
  let skew = 0;               // server clock − local clock, ms
  let feedOffline = false;
  let stream = null;
  let ticker = null;
  let lastCurrentId = null;
  let lastListKey = '';
  let userScrolledAt = 0;

  root.innerHTML = `
    <div class="pp-wrap">
      <header class="pp-head">
        <div class="pp-plan">
          <div class="pp-plan-title"></div>
          <div class="pp-plan-sub"></div>
        </div>
        <div class="pp-clock">
          <div class="pp-clock-label"></div>
          <div class="pp-clock-value"></div>
        </div>
      </header>
      <div class="pp-list"></div>
      <footer class="pp-foot" hidden></footer>
    </div>`;

  const wrap = root.querySelector('.pp-wrap');
  const headEl = root.querySelector('.pp-head');
  const planTitleEl = root.querySelector('.pp-plan-title');
  const planSubEl = root.querySelector('.pp-plan-sub');
  const clockLabelEl = root.querySelector('.pp-clock-label');
  const clockValueEl = root.querySelector('.pp-clock-value');
  const listEl = root.querySelector('.pp-list');
  const footEl = root.querySelector('.pp-foot');

  const prefs = () => moduleApi.instanceSettings;
  const serverNow = () => Date.now() + skew;

  /* ── title-bar controls ─────────────────────────────────────────── */

  const refreshBtn = moduleApi.header.addButton({
    icon: REFRESH_SVG,
    title: 'Re-read the plan from Planning Center now',
    onClick() {
      refreshBtn.classList.add('active');
      moduleApi.fetch('/refresh', { method: 'POST' })
        .catch(() => { /* the stream reports the outcome */ })
        .finally(() => refreshBtn.classList.remove('active'));
    },
  });

  function bumpTextSize(delta) {
    const size = Number(prefs().textSize) || 14;
    moduleApi.saveInstanceSettings({ textSize: Math.min(40, Math.max(9, size + delta)) });
    applyPrefs();
  }
  moduleApi.header.addButton({ label: 'A−', title: 'Smaller text', onClick: () => bumpTextSize(-1) });
  moduleApi.header.addButton({ label: 'A+', title: 'Larger text', onClick: () => bumpTextSize(1) });

  moduleApi.header.addButton({
    icon: SETUP_SVG,
    title: 'Planning Center setup (choose the service type)',
    onClick() {
      window.open(`/modules/${moduleApi.id}/setup.html`, '_blank', 'noopener');
    },
  });

  /* ── formatting ─────────────────────────────────────────────────── */

  function fmtClock(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDur(totalSec, { signed = false } = {}) {
    const sign = totalSec < 0 ? '-' : (signed ? '+' : '');
    const s = Math.abs(Math.round(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h) return `${sign}${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${sign}${m}:${String(sec).padStart(2, '0')}`;
  }

  function fmtMinutes(totalSec) {
    const m = Math.round(totalSec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }

  function typeLabel(itemType) {
    switch (itemType) {
      case 'song': return 'Song';
      case 'media': return 'Media';
      case 'header': return '';
      default: return '';
    }
  }

  /* ── which items to show ────────────────────────────────────────── */

  function visibleItems() {
    const p = prefs();
    const items = Array.isArray(state?.items) ? state.items : [];
    return items.filter((it) => {
      if (it.itemType === 'header' && !p.showHeaders) return false;
      if (it.servicePosition === 'pre' && !p.showPreService) return false;
      if (it.servicePosition === 'post' && !p.showPostService) return false;
      return true;
    });
  }

  function noteFilter() {
    const raw = String(prefs().noteCategories || '');
    const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return wanted.length ? (note) => wanted.includes(String(note.category || '').toLowerCase()) : () => true;
  }

  /* ── status dot ─────────────────────────────────────────────────── */

  function renderStatus() {
    if (feedOffline) return moduleApi.setStatus('error', 'ProdDash server unreachable — reconnecting…');
    if (!state) return moduleApi.setStatus('connecting', 'Connecting…');
    if (!state.configured) return moduleApi.setStatus('error', 'No Planning Center credentials — add them in Admin');
    if (!state.serviceTypeSet) return moduleApi.setStatus('error', 'No service type selected — use the setup page');
    if (!state.reachable) {
      return moduleApi.setStatus(state.lastFetched ? 'error' : 'connecting', state.lastError || 'Reading the plan…');
    }
    const live = state.live || {};
    let extra = '';
    if (live.following) {
      extra = live.available
        ? (live.ppReachable ? ' · following ProPresenter' : ' · ProPresenter unreachable')
        : ` · ${live.reason || 'ProPresenter feed unavailable'}`;
    }
    moduleApi.setStatus('ok', `Plan read ${new Date(state.lastFetched).toLocaleTimeString()}${extra}`);
  }

  /* ── plan header ────────────────────────────────────────────────── */

  function renderHead() {
    const plan = state?.plan;
    const show = prefs().showPlanHeader && plan;
    headEl.hidden = !show;
    if (!show) return;
    const title = [plan.dates, plan.title || plan.seriesTitle].filter(Boolean).join(' · ');
    planTitleEl.textContent = title || (state.serviceType?.name || 'Plan');
    const bits = [];
    if (state.serviceType?.name) bits.push(state.serviceType.name);
    if (plan.title && plan.seriesTitle) bits.push(plan.seriesTitle);
    if (plan.serviceStartsAt) bits.push(`${plan.serviceName ? `${plan.serviceName} ` : ''}${fmtClock(plan.serviceStartsAt)}`);
    const planned = state.items.filter((it) => it.servicePosition === 'during').reduce((sum, it) => sum + (it.length || 0), 0);
    if (planned) bits.push(`planned ${fmtMinutes(planned)}`);
    planSubEl.textContent = bits.join(' · ');
    renderClock();
  }

  function renderClock() {
    const plan = state?.plan;
    const live = state?.live || {};
    clockLabelEl.textContent = '';
    clockValueEl.textContent = '';
    clockValueEl.className = 'pp-clock-value';
    if (!plan || headEl.hidden) return;
    const now = serverNow();
    if (prefs().showRuntime && live.serviceStartedAt) {
      clockLabelEl.textContent = 'Running';
      clockValueEl.textContent = fmtDur((now - live.serviceStartedAt) / 1000);
      // Ahead of / behind the plan: elapsed minus what the completed items were planned to take.
      const planned = state.items
        .filter((it) => live.history?.[it.id]?.endedAt)
        .reduce((sum, it) => sum + (it.length || 0), 0);
      const actual = state.items
        .filter((it) => live.history?.[it.id]?.endedAt)
        .reduce((sum, it) => sum + (live.history[it.id].endedAt - live.history[it.id].startedAt) / 1000, 0);
      const drift = actual - planned;
      if (planned && Math.abs(drift) >= 30) {
        clockLabelEl.textContent = `Running · ${drift > 0 ? 'behind' : 'ahead'} ${fmtDur(Math.abs(drift))}`;
        clockValueEl.classList.add(drift > 0 ? 'is-behind' : 'is-ahead');
      }
      return;
    }
    if (plan.serviceStartsAt && plan.serviceStartsAt > now) {
      clockLabelEl.textContent = 'Starts in';
      clockValueEl.textContent = fmtDur((plan.serviceStartsAt - now) / 1000);
      return;
    }
    if (plan.serviceStartsAt) {
      clockLabelEl.textContent = 'Since start';
      clockValueEl.textContent = fmtDur((now - plan.serviceStartsAt) / 1000);
    }
  }

  /* ── the list ───────────────────────────────────────────────────── */

  function emptyMessage() {
    if (feedOffline && !state) return { title: 'Feed offline', hint: 'Not receiving updates from the ProdDash server.' };
    if (!state) return { title: 'Connecting…', hint: '' };
    if (!state.configured) {
      return {
        title: 'Planning Center not connected',
        hint: 'Add a Planning Center Application ID and Secret (Personal Access Token) for PCO Plan in Admin.',
        link: { href: '/admin', text: 'Open Admin' },
      };
    }
    if (!state.serviceTypeSet) {
      return {
        title: 'No service type selected',
        hint: 'Browse your Planning Center folders and choose the service type to follow.',
        link: { href: `/modules/${moduleApi.id}/setup.html`, text: 'Open setup' },
      };
    }
    if (!state.reachable && !state.plan) {
      return { title: state.lastFetched ? 'Planning Center unavailable' : 'Reading the plan…', hint: state.lastError || '' };
    }
    if (!state.plan) {
      return {
        title: 'No plan found',
        hint: `${state.serviceType?.name || 'This service type'} has no upcoming or recent plans in Planning Center.`,
      };
    }
    if (!visibleItems().length) return { title: 'Nothing to show', hint: 'Every item is hidden by this tile’s settings.' };
    return null;
  }

  function buildRow(item, p, notesWanted) {
    const row = document.createElement('div');
    row.className = 'pp-row';
    row.dataset.id = item.id;
    if (item.itemType === 'header') row.classList.add('is-header');
    if (item.servicePosition !== 'during') row.classList.add(`is-${item.servicePosition}`);

    const timeCol = document.createElement('div');
    timeCol.className = 'pp-col-time';
    timeCol.textContent = p.showStartTimes && item.startsAt && item.itemType !== 'header' ? fmtClock(item.startsAt) : '';
    timeCol.hidden = !p.showStartTimes;
    row.appendChild(timeCol);

    const main = document.createElement('div');
    main.className = 'pp-col-main';
    const titleLine = document.createElement('div');
    titleLine.className = 'pp-title-line';
    const titleEl = document.createElement('span');
    titleEl.className = 'pp-title';
    titleEl.textContent = item.title || item.song?.title || '(untitled)';
    titleLine.appendChild(titleEl);
    if (item.itemType !== 'header') {
      const nowTag = document.createElement('span');
      nowTag.className = 'pp-now-tag';
      nowTag.textContent = 'Now';
      titleLine.appendChild(nowTag);
      if (p.showItemType && typeLabel(item.itemType)) {
        const badge = document.createElement('span');
        badge.className = `pp-badge is-${item.itemType}`;
        badge.textContent = typeLabel(item.itemType);
        titleLine.appendChild(badge);
      }
      if (p.showKey && item.keyName) {
        const key = document.createElement('span');
        key.className = 'pp-key';
        key.textContent = item.keyName;
        titleLine.appendChild(key);
      }
      if (p.showArrangement && item.arrangement) {
        const arr = document.createElement('span');
        arr.className = 'pp-arr';
        arr.textContent = item.arrangement;
        titleLine.appendChild(arr);
      }
    }
    main.appendChild(titleLine);

    if (p.showDescription && item.description) {
      const desc = document.createElement('div');
      desc.className = 'pp-desc';
      desc.textContent = item.description;
      main.appendChild(desc);
    }
    if (p.showNotes && item.notes?.length) {
      const notes = item.notes.filter(notesWanted);
      if (notes.length) {
        const notesEl = document.createElement('div');
        notesEl.className = 'pp-notes';
        for (const note of notes) {
          const n = document.createElement('div');
          n.className = 'pp-note';
          if (note.category) {
            const cat = document.createElement('span');
            cat.className = 'pp-note-cat';
            cat.textContent = note.category;
            n.appendChild(cat);
          }
          n.appendChild(document.createTextNode(note.content));
          notesEl.appendChild(n);
        }
        main.appendChild(notesEl);
      }
    }
    row.appendChild(main);

    const lenCol = document.createElement('div');
    lenCol.className = 'pp-col-len';
    if (item.itemType !== 'header') {
      if (p.showLength) {
        const len = document.createElement('div');
        len.className = 'pp-len';
        len.textContent = item.length ? fmtDur(item.length) : '';
        lenCol.appendChild(len);
      }
      if (p.showRuntime && state?.live?.following) {
        const el = document.createElement('div');
        el.className = 'pp-elapsed';
        lenCol.appendChild(el);
      }
    }
    lenCol.hidden = !p.showLength && !(p.showRuntime && state?.live?.following);
    row.appendChild(lenCol);
    return row;
  }

  function renderList() {
    const empty = emptyMessage();
    if (empty) {
      listEl.innerHTML = '';
      lastListKey = '';
      const box = document.createElement('div');
      box.className = 'pp-empty';
      const t = document.createElement('div');
      t.className = 'pp-empty-title';
      t.textContent = empty.title;
      box.appendChild(t);
      if (empty.hint) {
        const h = document.createElement('div');
        h.className = 'pp-empty-hint';
        h.textContent = empty.hint;
        box.appendChild(h);
      }
      if (empty.link) {
        const a = document.createElement('a');
        a.className = 'pp-empty-link';
        a.href = empty.link.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = empty.link.text;
        box.appendChild(a);
      }
      listEl.appendChild(box);
      return;
    }

    // Rebuild rows only when the plan content or the display prefs changed;
    // live highlighting and timers are applied in place.
    const p = prefs();
    const key = JSON.stringify([state.plan.id, state.items, p, state.live?.following]);
    if (key !== lastListKey) {
      lastListKey = key;
      listEl.innerHTML = '';
      const notesWanted = noteFilter();
      for (const item of visibleItems()) listEl.appendChild(buildRow(item, p, notesWanted));
      lastCurrentId = null; // force the highlight + scroll pass
    }
    renderLiveMarks();
  }

  /** Current / done classes and the elapsed timers, without rebuilding rows. */
  function renderLiveMarks() {
    const live = state?.live || {};
    const p = prefs();
    const now = serverNow();
    const currentId = live.following ? live.currentItemId || '' : '';
    const history = live.history || {};
    const byId = new Map(state.items.map((it) => [it.id, it]));
    const rows = listEl.querySelectorAll('.pp-row');
    // Everything before the current item counts as done, matched or not.
    let seenCurrent = !currentId;
    const doneIds = new Set();
    if (currentId) {
      for (const it of state.items) {
        if (it.id === currentId) break;
        if (it.itemType !== 'header') doneIds.add(it.id);
      }
    }
    for (const row of rows) {
      const id = row.dataset.id;
      const item = byId.get(id);
      const isCurrent = id === currentId;
      row.classList.toggle('is-current', isCurrent);
      row.classList.toggle('is-done', p.dimCompleted && doneIds.has(id));
      if (isCurrent) seenCurrent = true;
      const elapsedEl = row.querySelector('.pp-elapsed');
      if (!elapsedEl || !item) continue;
      const h = history[id];
      elapsedEl.className = 'pp-elapsed';
      if (!h) {
        elapsedEl.textContent = '';
        continue;
      }
      const elapsedSec = ((h.endedAt || now) - h.startedAt) / 1000;
      elapsedEl.textContent = fmtDur(elapsedSec);
      if (item.length) {
        const over = elapsedSec - item.length;
        if (over > item.length * 0.25 + 30) elapsedEl.classList.add('is-over-hard');
        else if (over > 0) elapsedEl.classList.add('is-over');
      }
      if (!h.endedAt) elapsedEl.classList.add('is-running');
    }
    void seenCurrent;
    if (currentId !== lastCurrentId) {
      lastCurrentId = currentId;
      if (currentId && p.autoScroll && Date.now() - userScrolledAt > 8000) {
        const row = listEl.querySelector(`.pp-row[data-id="${CSS.escape(currentId)}"]`);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  /* ── footer: what ProPresenter is doing ─────────────────────────── */

  function renderFoot() {
    const live = state?.live;
    const show = prefs().showLiveFooter && live?.following && state?.plan;
    footEl.hidden = !show;
    footEl.className = 'pp-foot';
    if (!show) return;
    if (!live.available) {
      footEl.classList.add('is-muted');
      footEl.textContent = live.reason || 'ProPresenter feed unavailable';
      return;
    }
    if (!live.ppEnabled) {
      footEl.classList.add('is-muted');
      footEl.textContent = 'ProPresenter module has no host configured';
      return;
    }
    if (!live.ppReachable) {
      footEl.classList.add('is-down');
      footEl.textContent = 'ProPresenter unreachable';
      return;
    }
    if (!live.activeName) {
      footEl.classList.add('is-muted');
      footEl.textContent = 'Nothing live in ProPresenter';
      return;
    }
    if (live.matched) {
      footEl.classList.add('is-live');
      footEl.textContent = `Live: ${live.activeName}`;
    } else {
      footEl.classList.add('is-unmatched');
      footEl.textContent = `Live: ${live.activeName} — not in the plan`;
    }
  }

  /* ── render + ticking ───────────────────────────────────────────── */

  function render() {
    wrap.classList.toggle('is-offline', feedOffline);
    renderStatus();
    if (!state) {
      headEl.hidden = true;
      renderList();
      footEl.hidden = true;
      return;
    }
    renderHead();
    renderList();
    renderFoot();
  }

  function applyPrefs() {
    const size = Math.min(40, Math.max(9, Number(prefs().textSize) || 14));
    wrap.style.setProperty('--pp-size', `${size}px`);
    lastListKey = '';
    render();
  }

  function tick() {
    if (!state?.plan) return;
    renderClock();
    if (state.live?.following && prefs().showRuntime) renderLiveMarks();
  }

  /* ── live feed ──────────────────────────────────────────────────── */

  function accept(payload) {
    if (!payload || typeof payload !== 'object' || !payload.state) return;
    state = payload.state;
    if (Number.isFinite(payload.now)) skew = payload.now - Date.now();
    feedOffline = false;
    render();
  }

  function connect() {
    stream = moduleApi.sse('/stream', {
      open() {
        feedOffline = false;
        render();
      },
      error() {
        feedOffline = true;
        render();
      },
      events: {
        state(ev) {
          try {
            accept(JSON.parse(ev.data));
          } catch { /* a bad frame is not fatal */ }
        },
      },
    });
  }

  function onUserScroll() {
    userScrolledAt = Date.now();
  }

  /* ── lifecycle ──────────────────────────────────────────────────── */

  return {
    start() {
      applyPrefs();
      moduleApi.setStatus('connecting', 'Connecting…');
      moduleApi.fetch('/state')
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => { if (body && !state) accept(body); })
        .catch(() => { /* the stream will cover it */ });
      connect();
      listEl.addEventListener('wheel', onUserScroll, { passive: true });
      listEl.addEventListener('touchmove', onUserScroll, { passive: true });
      ticker = setInterval(tick, 1000);
    },
    stop() {
      clearInterval(ticker);
      ticker = null;
      stream?.close();
      stream = null;
      listEl.removeEventListener('wheel', onUserScroll);
      listEl.removeEventListener('touchmove', onUserScroll);
      root.innerHTML = '';
    },
    onConfigChange() {
      // The server re-inits and its stream re-sends the state; nothing to cache here.
      lastListKey = '';
      render();
    },
  };
}
