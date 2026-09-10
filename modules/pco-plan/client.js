/* PCO Plan — client part.

   The server part reads Planning Center and (optionally) follows the
   ProPresenter module's live item; this tile only renders the plan it is
   streamed. What is shown is this tile's own choice (gear menu →
   moduleApi.instanceSettings: show/hide checklist, top-bar template,
   colors, text size); /admin only holds the connection settings. */

const REFRESH_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

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

  /** This tile's display settings (gear menu) — read fresh on every render. */
  const cfg = () => moduleApi.instanceSettings || {};
  const on = (key) => cfg()[key] !== false; // unset = shown
  const tilePrefs = cfg;
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
    const size = Number(tilePrefs().textSize) || 14;
    moduleApi.saveInstanceSettings({ textSize: Math.min(40, Math.max(9, size + delta)) });
    applyPrefs();
  }
  moduleApi.header.addButton({ label: 'A−', title: 'Smaller text', onClick: () => bumpTextSize(-1) });
  moduleApi.header.addButton({ label: 'A+', title: 'Larger text', onClick: () => bumpTextSize(1) });

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
      default: return '';
    }
  }

  function plannedLength() {
    return (state?.items || [])
      .filter((it) => it.servicePosition === 'during')
      .reduce((sum, it) => sum + (it.length || 0), 0);
  }

  /* ── which items to show ────────────────────────────────────────── */

  function visibleItems() {
    const items = Array.isArray(state?.items) ? state.items : [];
    return items.filter((it) => {
      if (it.itemType === 'header' && !on('showHeaders')) return false;
      if (it.servicePosition === 'pre' && !on('showPreService')) return false;
      if (it.servicePosition === 'post' && !on('showPostService')) return false;
      return true;
    });
  }

  function noteFilter() {
    const raw = String(cfg().noteCategories || '');
    const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return wanted.length ? (note) => wanted.includes(String(note.category || '').toLowerCase()) : () => true;
  }

  /* ── status dot ─────────────────────────────────────────────────── */

  function renderStatus() {
    if (feedOffline) return moduleApi.setStatus('error', 'ProdDash server unreachable — reconnecting…');
    if (!state) return moduleApi.setStatus('connecting', 'Connecting…');
    if (!state.configured) return moduleApi.setStatus('error', 'No Planning Center credentials — add them in Admin');
    if (!state.serviceTypeSet) return moduleApi.setStatus('error', 'No service type selected — pick one in Admin');
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

  /* ── top bar: admin template with placeholders ──────────────────── */

  const DEFAULT_TEMPLATE = '{series} • {part} | {serviceType} • {date}';

  /** Placeholder → text; a hidden or empty value resolves to '' and drops its segment. */
  function templateValues() {
    const plan = state?.plan || {};
    const items = state?.items || [];
    const planned = plannedLength();
    return {
      series: on('showSeries') ? plan.seriesTitle || '' : '',
      part: on('showPart') ? plan.title || '' : '',
      title: on('showPart') ? plan.title || '' : '',
      servicetype: on('showServiceType') ? state?.serviceType?.name || '' : '',
      date: on('showDate') ? plan.dates || '' : '',
      shortdate: on('showDate') ? plan.shortDates || plan.dates || '' : '',
      time: on('showServiceTime') && plan.serviceStartsAt
        ? `${plan.serviceName && plan.serviceName !== 'Service' ? `${plan.serviceName} ` : ''}${fmtClock(plan.serviceStartsAt)}`
        : '',
      length: on('showTotalLength') && planned ? fmtMinutes(planned) : '',
      items: items.filter((it) => it.itemType !== 'header').length ? String(items.filter((it) => it.itemType !== 'header').length) : '',
    };
  }

  /**
   * "{series} • {part} | {serviceType} • {date}" → up to two lines. Within a
   * line, • (or ·) separates segments; a segment whose placeholders all came
   * out empty is dropped, so a plan with no series just reads "Wk 2".
   */
  function renderTemplate(template, values) {
    const lines = String(template || DEFAULT_TEMPLATE).split('|').slice(0, 2);
    return lines.map((line) => {
      const segments = line.split(/\s*[•·]\s*/);
      const kept = [];
      for (const seg of segments) {
        let sawVar = false;
        let allEmpty = true;
        const text = seg.replace(/\{([a-zA-Z]+)\}/g, (m, name) => {
          sawVar = true;
          const v = values[name.toLowerCase()];
          if (v) allEmpty = false;
          return v || '';
        }).trim();
        if (sawVar && allEmpty) continue;
        if (text) kept.push(text);
      }
      return kept.join(' • ');
    });
  }

  function renderHead() {
    const plan = state?.plan;
    const show = on('showTopBar') && plan;
    headEl.hidden = !show;
    if (!show) return;
    const [line1, line2] = renderTemplate(cfg().headerTemplate, templateValues());
    planTitleEl.textContent = line1 || line2 || state.serviceType?.name || 'Plan';
    planSubEl.textContent = line1 ? line2 || '' : '';
    planSubEl.hidden = !planSubEl.textContent;
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
    if (on('showRunningClock') && live.following && live.serviceStartedAt) {
      clockLabelEl.textContent = 'Running';
      clockValueEl.textContent = fmtDur((now - live.serviceStartedAt) / 1000);
      // Ahead of / behind the plan: elapsed minus what the completed items were planned to take.
      const done = state.items.filter((it) => live.history?.[it.id]?.endedAt);
      const planned = done.reduce((sum, it) => sum + (it.length || 0), 0);
      const actual = done.reduce((sum, it) => sum + (live.history[it.id].endedAt - live.history[it.id].startedAt) / 1000, 0);
      const drift = actual - planned;
      if (planned && Math.abs(drift) >= 30) {
        clockLabelEl.textContent = `Running · ${drift > 0 ? 'behind' : 'ahead'} ${fmtDur(Math.abs(drift))}`;
        clockValueEl.classList.add(drift > 0 ? 'is-behind' : 'is-ahead');
      }
      return;
    }
    if (on('showCountdown') && plan.serviceStartsAt && plan.serviceStartsAt > now) {
      clockLabelEl.textContent = 'Starts in';
      clockValueEl.textContent = fmtDur((plan.serviceStartsAt - now) / 1000);
      return;
    }
    if (on('showRunningClock') && plan.serviceStartsAt) {
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
        hint: 'Enter the Planning Center credentials under PCO Plan in Admin.',
        link: { href: '/admin', text: 'Open Admin' },
      };
    }
    if (!state.serviceTypeSet) {
      return {
        title: 'No service type selected',
        hint: 'Pick the service type to follow from the list under PCO Plan in Admin.',
        link: { href: '/admin', text: 'Open Admin' },
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
    if (!visibleItems().length) return { title: 'Nothing to show', hint: 'Every item is hidden by this tile’s settings (gear menu).' };
    return null;
  }

  function buildRow(item, number, notesWanted) {
    const row = document.createElement('div');
    row.className = 'pp-row';
    row.dataset.id = item.id;
    if (item.itemType === 'header') row.classList.add('is-header');
    else row.classList.add(`is-${item.itemType === 'song' || item.itemType === 'media' ? item.itemType : 'item'}`);
    if (item.servicePosition !== 'during') row.classList.add(`is-${item.servicePosition}`);
    const isHeader = item.itemType === 'header';

    if (on('showItemNumbers')) {
      const numCol = document.createElement('div');
      numCol.className = 'pp-col-num';
      numCol.textContent = isHeader ? '' : String(number);
      row.appendChild(numCol);
    }

    if (on('showStartTimes')) {
      const timeCol = document.createElement('div');
      timeCol.className = 'pp-col-time';
      timeCol.textContent = item.startsAt && !isHeader ? fmtClock(item.startsAt) : '';
      row.appendChild(timeCol);
    }

    const main = document.createElement('div');
    main.className = 'pp-col-main';
    const titleLine = document.createElement('div');
    titleLine.className = 'pp-title-line';
    const titleEl = document.createElement('span');
    titleEl.className = 'pp-title';
    titleEl.textContent = item.title || item.song?.title || '(untitled)';
    titleLine.appendChild(titleEl);
    if (!isHeader) {
      // Order after the title: key, NOW, type badge, arrangement.
      if (on('showKey') && item.keyName) {
        const key = document.createElement('span');
        key.className = 'pp-key';
        key.textContent = item.keyName;
        titleLine.appendChild(key);
      }
      if (on('showNowIndicator')) {
        const nowTag = document.createElement('span');
        nowTag.className = 'pp-now-tag';
        nowTag.textContent = 'Now';
        titleLine.appendChild(nowTag);
      }
      if (on('showItemType') && typeLabel(item.itemType)) {
        const badge = document.createElement('span');
        badge.className = `pp-badge is-${item.itemType}`;
        badge.textContent = typeLabel(item.itemType);
        titleLine.appendChild(badge);
      }
      if (on('showArrangement') && item.arrangement) {
        const arr = document.createElement('span');
        arr.className = 'pp-arr';
        arr.textContent = item.arrangement;
        titleLine.appendChild(arr);
      }
    }
    main.appendChild(titleLine);

    if (!isHeader && on('showSongAuthor') && item.song && (item.song.author || item.song.ccli)) {
      const author = document.createElement('div');
      author.className = 'pp-author';
      author.textContent = [item.song.author, item.song.ccli ? `CCLI ${item.song.ccli}` : ''].filter(Boolean).join(' · ');
      main.appendChild(author);
    }
    if (on('showDescription') && item.description) {
      const desc = document.createElement('div');
      desc.className = 'pp-desc';
      desc.textContent = item.description;
      main.appendChild(desc);
    }
    if (on('showNotes') && item.notes?.length) {
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

    const wantRuntime = on('showItemRuntime') && state?.live?.following;
    if (on('showLength') || wantRuntime) {
      const lenCol = document.createElement('div');
      lenCol.className = 'pp-col-len';
      if (!isHeader) {
        if (on('showLength')) {
          const len = document.createElement('div');
          len.className = 'pp-len';
          len.textContent = item.length ? fmtDur(item.length) : '';
          lenCol.appendChild(len);
        }
        if (wantRuntime) {
          const el = document.createElement('div');
          el.className = 'pp-elapsed';
          lenCol.appendChild(el);
        }
      }
      row.appendChild(lenCol);
    }
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

    // Rebuild rows only when the plan content or the display settings
    // changed; live highlighting and timers are applied in place.
    const key = JSON.stringify([state.plan.id, state.items, cfg(), state.live?.following]);
    if (key !== lastListKey) {
      lastListKey = key;
      listEl.innerHTML = '';
      const notesWanted = noteFilter();
      let number = 0;
      for (const item of visibleItems()) {
        if (item.itemType !== 'header') number += 1;
        listEl.appendChild(buildRow(item, number, notesWanted));
      }
      lastCurrentId = null; // force the highlight + scroll pass
    }
    renderLiveMarks();
  }

  /** Current / done classes and the elapsed timers, without rebuilding rows. */
  function renderLiveMarks() {
    const live = state?.live || {};
    const now = serverNow();
    const currentId = live.following ? live.currentItemId || '' : '';
    const history = live.history || {};
    const byId = new Map(state.items.map((it) => [it.id, it]));
    // Everything before the current item counts as done, matched or not.
    const doneIds = new Set();
    if (currentId) {
      for (const it of state.items) {
        if (it.id === currentId) break;
        if (it.itemType !== 'header') doneIds.add(it.id);
      }
    }
    const showNow = on('showNowIndicator');
    for (const row of listEl.querySelectorAll('.pp-row')) {
      const id = row.dataset.id;
      const item = byId.get(id);
      row.classList.toggle('is-current', showNow && id === currentId);
      row.classList.toggle('is-done', on('dimCompleted') && doneIds.has(id));
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
    if (currentId !== lastCurrentId) {
      lastCurrentId = currentId;
      if (currentId && tilePrefs().autoScroll !== false && Date.now() - userScrolledAt > 8000) {
        const row = listEl.querySelector(`.pp-row[data-id="${CSS.escape(currentId)}"]`);
        row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  /* ── footer: what ProPresenter is doing ─────────────────────────── */

  function renderFoot() {
    const live = state?.live;
    const show = on('showLiveFooter') && live?.following && state?.plan;
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
    wrap.classList.toggle('tint-types', Boolean(cfg().tintByType));
    const keyColor = String(cfg().keyColor || '').trim();
    wrap.style.setProperty('--pp-key', /^[#a-zA-Z0-9(),.%\s-]+$/.test(keyColor) ? keyColor : '#4ea1ff');
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
    const size = Math.min(40, Math.max(9, Number(tilePrefs().textSize) || 14));
    wrap.style.setProperty('--pp-size', `${size}px`);
    lastListKey = '';
    render();
  }

  function tick() {
    if (!state?.plan) return;
    renderClock();
    if (state.live?.following && on('showItemRuntime')) renderLiveMarks();
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
      // Admin holds only connection settings; the server re-inits and its
      // stream re-sends the state. Nothing cached here to refresh.
    },
  };
}
