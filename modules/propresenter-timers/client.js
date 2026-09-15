/* Timers — client part.

   The server part follows every source (ProPresenter, the LTC listener, the
   time of day, other modules offering timers) and streams one merged state
   object here over SSE: sources, each with its health and its timers as the
   module guide's standard timer objects. This tile renders every timer from
   every source it has switched on, grouped under the source's heading, as
   auto-sized cards — label, the big time, a status line, a detail line.

   The time is derived LOCALLY. A snapshot says what a timer's value was at
   its source's updatedAt; a running card counts on from there with this
   browser's clock, offset-corrected against the server's, so digits tick
   smoothly between snapshots and a slow provider never needs a fast poll.
   The LTC card counts individual frames the same way (see the SMPTE math).

   Per-tile choices: the gear popover's static switches (whole sources,
   headings, status lines, the clock's format, the state colours) and the
   "Timers ▾" header menu, which hides any single timer — keyed `source:id`
   and saved with the layout via saveInstanceSettings. The header can be
   hidden by the user, so the static switches stay the primary controls.
   A solo tile's gear carries only the settings its one card can use (the
   picker entry's own schema — see tiles() in server.js), so a setting may
   simply be absent here: every read goes through pref(), which falls back
   to DEFAULTS rather than to whatever schema the tile happens to have.

   Feedback — the state colours, and the thresholds behind them:
     running elapsed, no planned length            running
     running elapsed with a planned length         warning within
         WARN_FLOOR_MS or WARN_FRACTION of the length (whichever is larger,
         but never more than half the length — a 20 s countdown warns
         under 10 s, a 25 min one under 2:30) of the end; overrun past it
     running countdown                             warning with that much
         left; overrun at zero and below
     stopped countdown at zero ("complete")        warning
     paused / idle / stopped                       idle (muted)
     the wall clock                                plain text colour
     LTC                                           running = running colour,
         stopped = idle, no signal = idle digits + blinking warning line
   The colours are the tile's Running / Warning / Overrun / Idle settings,
   set as custom properties on the tile root so they win over the dashboard
   theme; left at their defaults they follow the theme's variables. */

/** Which instance switch governs a source kind. */
/** Colour settings → custom property, and the schema default (module.json) that means "follow the theme". */
const COLOR_SETTINGS = [
  ['runningColor', '--tm-ok', '#2ee59a'],
  ['warningColor', '--tm-warn', '#f0b429'],
  ['overrunColor', '--tm-danger', '#f4433c'],
  ['idleColor', '--tm-muted', '#8b98a5'],
];

/** Warning thresholds (see the header comment). */
const WARN_FLOOR_MS = 60000;
const WARN_FRACTION = 0.1;

/** How often running digits are repainted. Whole seconds, so 5×/s is plenty. */
const PAINT_MS = 200;

const LTC_KEY = 'ltc:ltc';

/** What the tile assumes for a setting its schema doesn't carry (a solo
    tile offers only what applies to its card) or that was never saved. The
    switches default to on, the clock to 24-hour with seconds and no date —
    the same values module.json gives the full "All timers" schema. */
const DEFAULTS = {
  showNames: true,
  groupBySource: false,
  showHeadings: true,
  showStatus: true,
  showDetail: true,
  showSeconds: true,
  leadingZeros: false,
  clock24h: true,
  clockSeconds: true,
  clockDate: false,
  dateShortDay: false,
  dateShortMonth: false,
};

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

/* ── timer math (module-scope, exported for tests) ──────────────────── */

/**
 * A timer's value at server time `now`: remaining ms for a countdown,
 * elapsed ms otherwise, or null when the snapshot can't say. The values as
 * of the snapshot (`elapsedMs` / `remainingMs`) are preferred and carried
 * forward while running; `startedAt` is the fallback when they are absent.
 */
export function valueAt(timer, sourceUpdatedAt, now) {
  const running = timer.state === 'running';
  const at = Number(sourceUpdatedAt) || now;
  const dt = running ? Math.max(0, now - at) : 0;
  const has = (v) => v !== null && v !== undefined && Number.isFinite(v);
  if (timer.kind === 'countdown') {
    if (has(timer.remainingMs)) return timer.remainingMs - dt;
    if (has(timer.targetMs) && has(timer.elapsedMs)) return timer.targetMs - timer.elapsedMs - dt;
    if (running && has(timer.targetMs) && has(timer.startedAt)) return timer.targetMs - (now - timer.startedAt);
    return null;
  }
  if (has(timer.elapsedMs)) return timer.elapsedMs + dt;
  if (running && has(timer.startedAt)) return now - timer.startedAt;
  return null;
}

/** Signed ms → "M:SS" / "H:MM:SS" (whole seconds, floor of the magnitude). */
/**
 * A duration as digits. `seconds: false` shows minutes only — a countdown
 * rounds up (3:59 left reads "4", 0:30 over reads "-1"), an elapsed timer
 * rounds down; `zeros` pads the leading field to two digits ("05:07").
 */
export function fmtDuration(ms, { seconds = true, zeros = false, up = false } = {}) {
  const sign = ms < 0 ? '-' : '';
  const total = Math.abs(ms) / 1000;
  const pad = (v) => String(v).padStart(2, '0');
  if (!seconds) {
    const mins = up ? Math.ceil(total / 60) : Math.floor(total / 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${sign}${zeros ? pad(h) : h}:${pad(m)}` : `${sign}${zeros ? pad(m) : m}`;
  }
  const s = Math.floor(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${sign}${zeros ? pad(h) : h}:${pad(m)}:${pad(sec)}` : `${sign}${zeros ? pad(m) : m}:${pad(sec)}`;
}

function warnWindow(targetMs) {
  if (!targetMs) return WARN_FLOOR_MS;
  return Math.min(Math.max(WARN_FLOOR_MS, targetMs * WARN_FRACTION), targetMs / 2);
}

/** The state colour for a (non-clock) timer given its current value. */
export function toneFor(timer, value) {
  if (timer.state === 'running') {
    if (value === null) return 'ok';
    if (timer.kind === 'countdown') {
      if (value <= 0) return 'danger';
      if (value <= warnWindow(timer.targetMs)) return 'warn';
      return 'ok';
    }
    if (timer.targetMs !== null && timer.targetMs !== undefined && Number.isFinite(timer.targetMs)) {
      if (value >= timer.targetMs) return 'danger';
      if (value >= timer.targetMs - warnWindow(timer.targetMs)) return 'warn';
    }
    return 'ok';
  }
  if (timer.state === 'stopped' && timer.kind === 'countdown' && value !== null && value <= 0) return 'warn';
  return 'muted';
}

function defaultStatus(timer, value, tone) {
  if (timer.state === 'running') return tone === 'danger' ? 'Overrun' : 'Running';
  if (timer.state === 'paused') return 'Paused';
  if (timer.state === 'idle') return 'Ready';
  return timer.kind === 'countdown' && value !== null && value <= 0 ? 'Complete' : 'Stopped';
}

/* ── the tile ─────────────────────────────────────────────────────────── */

export default function create({ root, moduleApi }) {
  let state = null;
  let feedOffline = false;
  let stream = null;
  let resizeObserver = null;
  let paintTimer = null;
  /** Date.now() minus the server's clock, refined from every snapshot. */
  let clockOffset = NaN;
  let needFit = true;

  const settings = () => moduleApi.instanceSettings;
  /** One setting, resolved here: what this tile saved, else DEFAULTS — never
      whatever its (possibly slimmer) schema would or wouldn't default. */
  const pref = (key) => {
    const v = settings()[key];
    if (v !== undefined && v !== null) return v;
    // A layout from before the 24-hour switch chose a "clockFormat".
    if (key === 'clock24h' && settings().clockFormat === '12h') return false;
    return DEFAULTS[key];
  };
  const keyOf = (source, timer) => `${source.id}:${timer.id}`;

  /* Per-tile hidden timers, keyed source:id. Layouts saved by the earlier
     ProPresenter-only tile stored `hiddenItems` (uuids, and __ltc__ for the
     timecode) — read those too, and write them back in the new key. */
  const hidden = new Set(Array.isArray(settings().hiddenTimers) ? settings().hiddenTimers.map(String) : []);
  for (const old of Array.isArray(settings().hiddenItems) ? settings().hiddenItems : []) {
    hidden.add(old === '__ltc__' ? LTC_KEY : `propresenter:${old}`);
  }

  /* Which picker entry this tile was added as (the module's tiles() list):
     '' or 'all' = every timer, selectable via the Timers ▾ menu;
     'solo:<source>:<id>' = exactly one card, no menu, no headings. The
     earlier entries 'timer:<uuid>' and 'ltc' map onto the new keys. */
  const variant = String(moduleApi.variant || '');
  const solo = variant === 'ltc' ? LTC_KEY
    : variant.startsWith('timer:') ? `propresenter:${variant.slice('timer:'.length)}`
      : variant.startsWith('solo:') ? variant.slice('solo:'.length)
        : '';
  /** Last label seen for a solo timer, so its card stays labeled if the timer is later deleted upstream. */
  let lastSoloLabel = '';

  /* ── DOM skeleton ───────────────────────────────────────────────── */

  root.innerHTML = `
    <div class="tm-wrap">
      <div class="tm-banner" hidden></div>
      <div class="tm-hint" hidden></div>
      <div class="tm-groups"></div>
    </div>`;

  const wrap = root.querySelector('.tm-wrap');
  const bannerEl = root.querySelector('.tm-banner');
  const hintEl = root.querySelector('.tm-hint');
  const groupsEl = root.querySelector('.tm-groups');

  /** key → { key, el, nameEl, timeEl, statusEl, detailEl, item, chars, cls } */
  const cards = new Map();
  /** group id (source id) → { el, headEl, titleEl, noteEl, emptyEl, gridEl, count } */
  const groupEls = new Map();

  /** The tile's colour settings → custom properties (only when changed from the theme-following default). */
  function applyColors() {
    const s = settings();
    for (const [key, prop, fallback] of COLOR_SETTINGS) {
      const v = String(s[key] || '').trim().toLowerCase();
      if (/^#[0-9a-f]{6}$/.test(v) && v !== fallback) wrap.style.setProperty(prop, v);
      else wrap.style.removeProperty(prop);
    }
  }

  /* ── server clock ───────────────────────────────────────────────── */

  function noteServerClock(serverNow) {
    if (!Number.isFinite(serverNow)) return;
    const sample = Date.now() - serverNow;
    // A step (first sample, a resumed laptop) snaps; jitter is smoothed.
    if (!Number.isFinite(clockOffset) || Math.abs(sample - clockOffset) > 1000) clockOffset = sample;
    else clockOffset += (sample - clockOffset) * 0.2;
  }

  const serverNow = () => Date.now() - (Number.isFinite(clockOffset) ? clockOffset : 0);

  /* ── title-bar menu: hide / show individual timers ──────────────── */

  let menuEl = null; // the open menu's element (filled on each open)
  const itemsMenu = solo ? null : moduleApi.header.addMenu({
    label: 'Timers ▾',
    title: 'Choose timers',
    build(menu) {
      // the shell hands over an emptied element on every open
      menu.classList.add('tm-menu');
      menuEl = menu;
      rebuildMenu(true);
    },
  });

  function menuRows() {
    const rows = [];
    for (const source of state?.sources || []) {
      for (const t of source.timers) rows.push({ key: keyOf(source, t), text: `${source.label} › ${t.label}` });
    }
    return rows;
  }

  function persistHidden() {
    // `hiddenItems` was the old key: clearing it keeps a layout from
    // re-hiding something the user has since re-enabled here.
    moduleApi.saveInstanceSettings({ hiddenTimers: [...hidden], hiddenItems: undefined });
  }

  function toggleTimer(key) {
    if (hidden.has(key)) hidden.delete(key);
    else hidden.add(key);
    persistHidden();
    rebuildMenu();
    render();
  }

  function updateMenuLabel() {
    if (!itemsMenu) return;
    const rows = menuRows();
    const visible = rows.filter((r) => !hidden.has(r.key)).length;
    itemsMenu.setLabel(visible === rows.length ? 'Timers ▾' : `Timers (${visible}/${rows.length}) ▾`);
  }

  let menuSignature = '';
  function rebuildMenu(force = false) {
    updateMenuLabel();
    if (!menuEl) return; // menu not opened yet — the label is enough
    const rows = menuRows();
    // Snapshots arrive several times a second; rebuilding the open menu's
    // rows each time would replace them under the user's finger. Only a
    // changed row set (or a toggled switch) is worth touching the DOM for.
    const signature = JSON.stringify(rows.map((r) => [r.key, r.text, hidden.has(r.key)]));
    if (!force && signature === menuSignature && menuEl.childElementCount) return;
    menuSignature = signature;
    menuEl.innerHTML = '';
    if (!rows.length) {
      const note = document.createElement('div');
      note.className = 'tm-menu-note';
      note.textContent = 'No timers known yet';
      menuEl.appendChild(note);
    }
    for (const row of rows) {
      const on = !hidden.has(row.key);
      const item = document.createElement('button');
      item.className = 'tm-menu-item' + (on ? ' on' : '');
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', String(on));
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.text;
      const sw = document.createElement('span');
      sw.className = 'tm-switch';
      item.append(name, sw);
      item.addEventListener('click', (e) => {
        // keep the menu open: the rebuild detaches this item, which would
        // make the shell's outside-click handler think we clicked outside
        e.stopPropagation();
        toggleTimer(row.key);
      });
      menuEl.appendChild(item);
    }
  }

  /* ── state → what this tile shows ───────────────────────────────── */

  /** [{ id, source, items: [{ key, source, timer } | { key, missing }] }] */
  function visibleGroups() {
    if (!state) return [];
    if (solo) {
      for (const source of state.sources) {
        for (const timer of source.timers) {
          if (keyOf(source, timer) !== solo) continue;
          lastSoloLabel = timer.label;
          return [{ id: source.id, source, items: [{ key: solo, source, timer }] }];
        }
      }
      // The timer this tile was added for isn't offered (yet, or any more) —
      // keep a clearly-labeled card up rather than erroring.
      const sourceId = solo.slice(0, solo.indexOf(':'));
      const source = state.sources.find((s) => s.id === sourceId) || null;
      return [{ id: 'missing', source, items: [{ key: solo, missing: true, source }] }];
    }
    const groups = [];
    for (const source of state.sources) {
      const items = [];
      for (const timer of source.timers) {
        const key = keyOf(source, timer);
        if (!hidden.has(key)) items.push({ key, source, timer });
      }
      // Every timer of a live source hidden on purpose: nothing to say.
      if (!items.length && source.timers.length) continue;
      groups.push({ id: source.id, source, items });
    }
    if (pref('groupBySource') === true) return groups;
    // Grouping off: every timer in one grid, filled row by row. A source in
    // trouble is still named, in one line above the cards.
    const trouble = groups.filter((g) => g.source && g.source.status !== 'ok');
    return [{
      id: 'all',
      source: null,
      flat: true,
      items: groups.flatMap((g) => g.items),
      status: trouble.length ? 'error' : 'ok',
      message: trouble.map((g) => `${g.source.label}: ${g.source.message || 'unavailable'}`).join(' · '),
    }];
  }

  /* ── cards ──────────────────────────────────────────────────────── */

  function makeCard(item) {
    const el = document.createElement('div');
    el.className = 'tm-card';
    const nameEl = document.createElement('div');
    nameEl.className = 'tm-name';
    const labelEl = document.createElement('span');
    labelEl.className = 'tm-label';
    nameEl.appendChild(labelEl);
    const timeEl = document.createElement('div');
    timeEl.className = 'tm-time';
    const statusEl = document.createElement('div');
    statusEl.className = 'tm-status';
    const detailEl = document.createElement('div');
    detailEl.className = 'tm-detail';
    el.append(nameEl, timeEl, statusEl, detailEl);
    return { key: item.key, el, nameEl, labelEl, timeEl, statusEl, detailEl, item, chars: 5, cls: '' };
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setCardClass(card, cls) {
    if (card.cls === cls) return;
    card.cls = cls;
    card.el.className = cls;
  }

  /** The parts of a card that only change with the snapshot (label, kind). */
  function updateCard(card, item) {
    card.item = item;
    card.isClock = !item.missing && item.source?.kind === 'clock';
    const isLtc = item.source?.kind === 'ltc';
    const badge = card.nameEl.querySelector('.tm-ltc-badge');
    if (isLtc && !badge) {
      const b = document.createElement('span');
      b.className = 'tm-ltc-badge';
      b.textContent = 'LTC';
      card.nameEl.prepend(b);
    } else if (!isLtc && badge) {
      badge.remove();
    }
    const label = item.missing ? (lastSoloLabel || 'Timer') : card.isClock ? '' : item.timer.label;
    if (card.labelEl.textContent !== label) {
      setText(card.labelEl, label);
      needFit = true; // the title's size follows its length
    }
  }

  function updateMissingCard(card) {
    const source = card.item.source;
    setText(card.timeEl, '—');
    card.chars = 5;
    let note;
    if (!source) note = 'Source not available — check Admin';
    else if (source.status === 'ok') note = `Not offered by ${source.label}`;
    else note = '—';
    setText(card.statusEl, note);
    card.statusEl.hidden = false;
    card.statusEl.className = 'tm-status is-note';
    card.statusEl.dataset.tone = source && source.status === 'ok' ? 'warn' : 'muted';
    card.detailEl.hidden = true;
    setCardClass(card, 'tm-card is-muted is-missing');
  }

  /* ── clocks ─────────────────────────────────────────────────────── */

  function clockOptions() {
    const h12 = pref('clock24h') === false;
    return {
      hour12: h12,
      hour: h12 ? 'numeric' : '2-digit',
      minute: '2-digit',
      ...(pref('clockSeconds') !== false ? { second: '2-digit' } : {}),
    };
  }

  function wallClockText() {
    return new Date().toLocaleTimeString([], clockOptions());
  }

  /** The date as the day and the rest — the break, when one is needed, falls between them. */
  function dateParts() {
    const d = new Date();
    return {
      day: d.toLocaleDateString([], { weekday: pref('dateShortDay') ? 'short' : 'long' }),
      rest: d.toLocaleDateString([], { month: pref('dateShortMonth') ? 'short' : 'long', day: 'numeric' }),
    };
  }

  /**
   * The clock's date under its digits: one line when it fits the card,
   * otherwise a line break after the day and a size that fits the longer
   * half. Re-done only when the text or the card width changes.
   */
  function renderDate(card, d) {
    const cw = lastFit.cw;
    const lineSize = lastFit.meta * LINE_SCALE;
    const whole = `${d.day}, ${d.rest}`;
    const key = `${whole}|${Math.round(cw)}|${lineSize}`;
    if (card.dateKey === key) return;
    card.dateKey = key;
    let px = lineSize;
    let wrapIt = false;
    if (textWidth(whole, lineSize, 0.1) > cw) {
      wrapIt = true;
      const widest = Math.max(textWidth(`${d.day},`, lineSize, 0.1), textWidth(d.rest, lineSize, 0.1));
      px = Math.max(8, Math.floor(lineSize * Math.min(1, cw / widest)));
    }
    const el = card.statusEl;
    el.textContent = '';
    const a = document.createElement('span');
    a.textContent = `${d.day},`;
    const b = document.createElement('span');
    b.textContent = d.rest;
    el.append(a, document.createTextNode(' '), b);
    el.style.fontSize = px === lineSize ? '' : `${px}px`;
    card.dateCls = wrapIt ? ' is-date is-wrap' : ' is-date';
  }

  /** A provider's kind:"clock" timer carries an ISO time in status.text as of its snapshot. */
  function providerClockText(timer, source, now) {
    const raw = String(timer.status?.text || '');
    const d = new Date(raw);
    if (!raw || Number.isNaN(d.getTime())) return raw || '—';
    const dt = timer.state === 'running' ? Math.max(0, now - (Number(source.updatedAt) || now)) : 0;
    return new Date(d.getTime() + dt).toLocaleTimeString([], clockOptions());
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

  function ltcTimer() {
    const source = state?.sources.find((s) => s.kind === 'ltc');
    return source ? source.timers.find((t) => t.id === 'ltc') || null : null;
  }

  function updateLtcAnchor() {
    const l = ltcTimer()?.ltc;
    // The listener is extrapolatable — it knows the frame rate.
    const live = l && l.status === 'running' && l.fps > 0;
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
      rAF loop (smooth, per-frame, on visible tabs) and by paint() at the
      anchor rate — so a throttled/backgrounded tab, where rAF is paused,
      still advances instead of freezing. */
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

  /* ── painting the numbers (every PAINT_MS, and on every snapshot) ── */

  function paint() {
    if (!state) return;
    const now = serverNow();
    const showStatus = pref('showStatus') !== false;
    const showDetail = pref('showDetail') !== false;
    const digits = { seconds: pref('showSeconds') !== false, zeros: pref('leadingZeros') === true };
    let charsChanged = false;
    for (const card of cards.values()) {
      const { item } = card;
      if (item.missing) {
        updateMissingCard(card);
        continue;
      }
      const { source, timer } = item;
      let text;
      let tone;
      let statusText = '';
      let statusTone = '';
      let detailText = '';
      let extra = '';
      let date = null;
      if (timer.kind === 'clock') {
        if (source.kind === 'ltc') {
          const l = timer.ltc || {};
          text = l.time || timer.status?.text || '—';
          if (timer.state === 'running') tone = 'ok';
          else if (timer.state === 'stopped') tone = 'muted';
          else {
            tone = 'muted';
            extra = l.status === 'nosignal' ? ' is-nosignal' : ' is-unavailable';
          }
          statusText = timer.detail || '';
          statusTone = timer.status?.tone || (tone === 'ok' ? 'ok' : extra ? 'warn' : 'muted');
        } else if (source.kind === 'clock') {
          text = wallClockText();
          tone = 'plain';
          date = pref('clockDate') ? dateParts() : null;
          statusText = date ? `${date.day}, ${date.rest}` : '';
          statusTone = 'muted';
        } else {
          text = providerClockText(timer, source, now);
          tone = timer.state === 'running' ? 'plain' : 'muted';
          statusText = timer.detail || '';
          statusTone = timer.status?.tone || 'muted';
        }
      } else {
        const value = valueAt(timer, source.updatedAt, now);
        text = value === null ? '—' : fmtDuration(value, { ...digits, up: timer.kind === 'countdown' });
        tone = toneFor(timer, value);
        statusText = timer.status?.text || defaultStatus(timer, value, tone);
        statusTone = timer.status?.tone || tone;
        detailText = timer.detail || '';
        if (tone === 'danger' && timer.state === 'running') extra = ' is-overrun';
      }
      // The LTC card's digits belong to the frame counter while an anchor is live.
      if (!(card.key === LTC_KEY && ltcAnchor)) setText(card.timeEl, text);
      else paintLtcFrame();
      const chars = Math.max(5, text.length);
      if (chars !== card.chars) {
        card.chars = chars;
        charsChanged = true;
      }
      // Notes that must survive the compact look: an unavailable LTC input.
      const isNote = extra === ' is-unavailable';
      setText(card.statusEl, statusText); // a no-op over the date's two spans: same text
      card.statusEl.hidden = !statusText || (!showStatus && !isNote);
      if (date && !card.statusEl.hidden) renderDate(card, date);
      else if (card.dateCls) {
        card.dateCls = '';
        card.dateKey = '';
        card.statusEl.style.fontSize = '';
      }
      card.statusEl.className = 'tm-status' + (isNote ? ' is-note' : '') + (card.dateCls || '');
      card.statusEl.dataset.tone = statusTone;
      setText(card.detailEl, detailText);
      card.detailEl.hidden = !detailText || !showDetail;
      const kindCls = source.kind === 'ltc' ? ' tm-card-ltc' : source.kind === 'clock' ? ' tm-card-clock' : '';
      const stale = source.status === 'error' ? ' is-stale' : '';
      setCardClass(card, `tm-card is-${tone}${extra}${kindCls}${stale}`);
    }
    if (charsChanged) fit();
  }

  /* ── status dot + degraded banner ───────────────────────────────── */

  function renderStatus() {
    wrap.classList.toggle('is-feed-down', feedOffline);
    if (feedOffline) {
      bannerEl.hidden = false;
      bannerEl.textContent = 'Not receiving updates from the ProdDash server.';
      moduleApi.setStatus('error', 'ProdDash server unreachable — reconnecting…');
      return;
    }
    bannerEl.hidden = true;
    if (!state) {
      moduleApi.setStatus('connecting', 'Connecting…');
      return;
    }
    const groups = visibleGroups();
    const shown = groups.map((g) => g.source).filter(Boolean);
    const say = (list) => list.map((s) => `${s.label}: ${s.message}`).join(' · ');
    const bad = shown.filter((s) => s.status === 'error');
    if (bad.length) {
      moduleApi.setStatus('error', say(bad));
      return;
    }
    const waiting = shown.filter((s) => s.status === 'connecting');
    if (waiting.length) {
      moduleApi.setStatus('connecting', say(waiting));
      return;
    }
    const n = groups.reduce((a, g) => a + g.items.filter((i) => !i.missing).length, 0);
    moduleApi.setStatus('ok', `${n} timer${n === 1 ? '' : 's'} from ${shown.length} source${shown.length === 1 ? '' : 's'}`);
  }

  /* ── main render: diff groups and cards, update in place ────────── */

  function makeGroup(id) {
    const el = document.createElement('section');
    el.className = 'tm-group';
    el.dataset.source = id;
    const headEl = document.createElement('div');
    headEl.className = 'tm-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'tm-title';
    const noteEl = document.createElement('span');
    noteEl.className = 'tm-note';
    headEl.append(titleEl, noteEl);
    const emptyEl = document.createElement('div');
    emptyEl.className = 'tm-empty';
    emptyEl.hidden = true;
    const gridEl = document.createElement('div');
    gridEl.className = 'tm-grid';
    el.append(headEl, emptyEl, gridEl);
    return { el, headEl, titleEl, noteEl, emptyEl, gridEl, count: 0 };
  }

  function render() {
    renderStatus();
    rebuildMenu();
    updateLtcAnchor();

    // Admin-chosen digit font. A font swap changes glyph metrics, so re-fit
    // the digit sizing when it actually changes.
    const mono = state?.timerFont === 'monospace';
    if (mono !== wrap.classList.contains('tm-mono')) {
      wrap.classList.toggle('tm-mono', mono);
      needFit = true;
    }
    // Headings belong to sections; without grouping there is one grid and no heading.
    const showHeadings = !solo && pref('groupBySource') === true && pref('showHeadings') !== false;
    wrap.classList.toggle('tm-headings', showHeadings);
    for (const [cls, on] of [
      ['tm-nostatus', pref('showStatus') === false],
      ['tm-nodetail', pref('showDetail') === false],
      ['tm-nonames', pref('showNames') === false],
    ]) {
      if (wrap.classList.contains(cls) !== on) {
        wrap.classList.toggle(cls, on);
        needFit = true;
      }
    }

    let hint = '';
    const groups = visibleGroups();
    if (state && !state.sources.length) hint = 'Every source is switched off — turn one on in Admin.';
    else if (state && !groups.length) hint = 'Nothing selected — switch a source on in this tile’s settings, or pick timers in the Timers ▾ menu.';
    hintEl.hidden = !hint;
    hintEl.textContent = hint;
    groupsEl.hidden = Boolean(hint);
    if (hint || !state) return;

    let structureChanged = false;
    const wantedKeys = new Set();
    const orderedGroups = [];
    for (const g of groups) {
      let ge = groupEls.get(g.id);
      if (!ge) {
        ge = makeGroup(g.id);
        groupEls.set(g.id, ge);
        structureChanged = true;
      }
      const source = g.source;
      const status = g.status ?? (source ? source.status : 'ok');
      const message = g.message ?? (source ? source.message : '');
      ge.headEl.hidden = !showHeadings;
      setText(ge.titleEl, source ? source.label : 'Timers');
      setText(ge.noteEl, status !== 'ok' ? message : g.items.length ? '' : 'no timers');
      // Without headings the source's trouble still has to be said somewhere.
      const emptyText = status !== 'ok' ? message : 'No timers';
      const showEmpty = !showHeadings && (status !== 'ok' || !g.items.length);
      ge.emptyEl.hidden = !showEmpty;
      setText(ge.emptyEl, showEmpty ? emptyText : '');
      ge.emptyEl.dataset.tone = showEmpty && status !== 'ok' ? 'warn' : '';
      // In the flat grid a card dims for its own source (paint), not the whole grid.
      ge.el.classList.toggle('is-down', !g.flat && status !== 'ok');
      ge.el.classList.toggle('is-stale', !g.flat && status === 'error' && g.items.length > 0);
      if (ge.gridEl.classList.contains('is-flow') !== Boolean(g.flat)) {
        ge.gridEl.classList.toggle('is-flow', Boolean(g.flat));
        structureChanged = true;
      }

      const els = [];
      for (const item of g.items) {
        let card = cards.get(item.key);
        if (!card) {
          card = makeCard(item);
          cards.set(item.key, card);
          structureChanged = true;
        }
        updateCard(card, item);
        wantedKeys.add(item.key);
        els.push(card.el);
      }
      if (ge.count !== els.length) structureChanged = true;
      ge.count = els.length;
      if (els.length !== ge.gridEl.children.length || els.some((el, i) => ge.gridEl.children[i] !== el)) {
        ge.gridEl.replaceChildren(...els);
        structureChanged = true;
      }
      orderedGroups.push(ge.el);
    }
    for (const [key, card] of cards) {
      if (wantedKeys.has(key)) continue;
      card.el.remove();
      cards.delete(key);
      structureChanged = true;
    }
    for (const [id, ge] of groupEls) {
      if (groups.some((g) => g.id === id)) continue;
      ge.el.remove();
      groupEls.delete(id);
      structureChanged = true;
    }
    if (orderedGroups.length !== groupsEl.children.length || orderedGroups.some((el, i) => groupsEl.children[i] !== el)) {
      groupsEl.replaceChildren(...orderedGroups);
      structureChanged = true;
    }
    paint();
    if (structureChanged || needFit) {
      needFit = false;
      fit();
    }
  }

  /* ── sizing: the column count that gives the biggest digits ─────── */

  /** Status and detail lines are drawn at this share of the label's size (style.css agrees). */
  const LINE_SCALE = 0.8;

  /* Text measured off-screen the way the CSS draws it (bold, uppercase,
     letter-spaced), so a title or the date can shrink before the card
     would cut it off. */
  const measurer = document.createElement('canvas').getContext('2d');
  let textFamily = '';
  function textWidth(text, px, spacingEm) {
    if (!textFamily) textFamily = getComputedStyle(root).fontFamily || 'sans-serif';
    measurer.font = `700 ${px}px ${textFamily}`;
    const t = String(text || '').toUpperCase();
    return measurer.measureText(t).width + spacingEm * px * Math.max(0, t.length - 1);
  }
  /** The last fit's card width and label size — what the date is fitted against. */
  let lastFit = { cw: 200, meta: 12 };
  function fitLabel(card, meta, avail) {
    if (card.isClock) return; // the clock has no label line
    const room = Math.max(24, avail - (card.nameEl.querySelector('.tm-ltc-badge') ? 34 : 0));
    const natural = textWidth(card.labelEl.textContent, meta, 0.08);
    const px = natural > room ? Math.max(8, Math.floor((meta * room) / natural)) : meta;
    card.labelEl.style.fontSize = px === meta ? '' : `${px}px`;
  }

  function fit() {
    const list = [...cards.values()];
    const n = list.length;
    const W = root.clientWidth;
    const H = root.clientHeight;
    if (!n || !W || !H) return;
    const PAD = H < 120 ? 4 : 10;
    const GAP = H < 120 ? 5 : 8;
    const CARD_PAD = 12; // a card's own vertical padding + borders
    const HEAD_H = 20; // a source heading line, margin included
    const groups = [...groupEls.values()].filter((g) => g.el.isConnected);
    const headings = wrap.classList.contains('tm-headings') ? groups.length : 0;
    const showStatus = !wrap.classList.contains('tm-nostatus');
    const showDetail = !wrap.classList.contains('tm-nodetail');
    const namesOn = !wrap.classList.contains('tm-nonames');
    // Lines under the digits: status, and detail if any card has one.
    const metaLines = (showStatus ? 1 : 0) + (showDetail && list.some((c) => !c.detailEl.hidden) ? 1 : 0);
    const date = showStatus && pref('clockDate') && list.some((c) => c.isClock) ? dateParts() : null;
    const dateWhole = date ? `${date.day}, ${date.rest}` : '';

    // For each column count, budget a card's full stack (label, digits,
    // lines) and score by the digit size it affords — the SMALLEST card's,
    // so no timer ends up unreadable. Cards too short for the full stack
    // drop to a compact look (label + digits, the colour carries the
    // state), but any layout with a readable full stack beats every
    // compact one. The clock has no label line, and its date may take two.
    const budgetFor = (c, ch, meta, mode, dateWrap) => {
      const nameLine = namesOn && !c.isClock ? 1.3 * meta : 0;
      if (mode === 'compact') return ch - nameLine;
      const lines = metaLines + (c.isClock && dateWrap ? 1 : 0);
      return ch - nameLine - lines * 1.3 * meta * LINE_SCALE;
    };
    let best = null;
    for (let cols = 1; cols <= n; cols += 1) {
      const rows = headings
        ? groups.reduce((a, g) => a + Math.max(1, Math.ceil(g.count / cols)), 0)
        : Math.ceil(n / cols);
      const cw = (W - PAD * 2 - GAP * (cols - 1)) / cols - 18;
      const ch = (H - PAD * 2 - headings * HEAD_H - GAP * (rows - 1) - (headings ? (headings - 1) * GAP : 0)) / rows - CARD_PAD;
      if (cw <= 0 || ch <= 0) continue;
      const meta = Math.max(9, Math.min(22, Math.floor(ch * 0.16)));
      const dateWrap = Boolean(dateWhole) && textWidth(dateWhole, meta * LINE_SCALE, 0.1) > cw;
      let full = Infinity;
      let compact = Infinity;
      for (const c of list) {
        const byWidth = (cw * 1.55) / c.chars;
        full = Math.min(full, byWidth, budgetFor(c, ch, meta, 'full', dateWrap));
        compact = Math.min(compact, byWidth, budgetFor(c, ch, meta, 'compact', dateWrap));
      }
      const mode = full >= 14 ? 'full' : 'compact';
      const size = mode === 'full' ? full : compact;
      const score = (mode === 'full' ? 1000 : 0) + size;
      if (!best || score > best.score) best = { cols, meta, mode, cw, ch, dateWrap, score };
    }
    if (!best) return;
    for (const g of groups) {
      g.gridEl.style.gridTemplateColumns = `repeat(${best.cols}, 1fr)`;
      g.gridEl.style.setProperty('--tm-cols', String(best.cols));
      // Space is shared in proportion to each group's rows, so a card is
      // the same height under every heading.
      g.el.style.flexGrow = String(Math.max(1, Math.ceil(g.count / best.cols)));
    }
    wrap.style.setProperty('--tm-pad', PAD + 'px');
    wrap.style.setProperty('--tm-gap', GAP + 'px');
    wrap.style.setProperty('--tm-meta-size', best.meta + 'px');
    wrap.classList.toggle('tm-compact', best.mode === 'compact');
    lastFit = { cw: best.cw, meta: best.meta };
    for (const c of list) {
      const budget = budgetFor(c, best.ch, best.meta, best.mode, best.dateWrap);
      const px = Math.max(11, Math.floor(Math.min((best.cw * 1.55) / c.chars, budget)));
      c.timeEl.style.fontSize = px + 'px';
      fitLabel(c, best.meta, best.cw);
      c.dateKey = ''; // the date re-fits to the new card width on the next paint
    }
  }

  /* ── live feed ──────────────────────────────────────────────────── */

  function takeState(next) {
    if (!next || typeof next !== 'object' || !Array.isArray(next.sources)) return;
    noteServerClock(Number(next.serverNow));
    state = next;
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
        // EventSource retries by itself (and the shell recreates closed
        // streams), but the tile must admit it is frozen meanwhile.
        feedOffline = true;
        render();
      },
      events: {
        state(ev) {
          let parsed;
          try {
            parsed = JSON.parse(ev.data);
          } catch {
            return;
          }
          takeState(parsed);
        },
      },
    });
  }

  /* ── lifecycle ──────────────────────────────────────────────────── */

  return {
    start() {
      applyColors();
      moduleApi.setStatus('connecting', 'Connecting…');
      // Instant paint from the snapshot, then live updates.
      moduleApi.fetch('/state')
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => {
          if (body && body.state && !state) takeState(body.state);
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
      paintTimer = setInterval(paint, PAINT_MS);
      render();
    },
    stop() {
      stream?.close();
      stream = null;
      clearInterval(paintTimer);
      paintTimer = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (ltcRaf) {
        cancelAnimationFrame(ltcRaf);
        ltcRaf = 0;
      }
      cards.clear();
      groupEls.clear();
      root.innerHTML = ''; // header controls are removed by the shell
    },
    onResize() {
      fit();
    },
  };
}
