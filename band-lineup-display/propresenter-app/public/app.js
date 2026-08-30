'use strict';

/* Stage Now / Next — display client.
   Receives the live view-model over SSE from server.js (which does all the
   ProPresenter talking) and renders it. Also owns the settings panel: the
   connection lives on the server and is shared by every screen, while the
   look-and-feel options are per-device in localStorage. */

const el = (id) => document.getElementById(id);

const screenEl = el('screen');
const topRow = el('top');
const playlistNameEl = el('playlist-name');
const liveEl = el('live');
const liveTextEl = el('live-text');
const nowTitleBox = el('now-title-box');
let nowTitleEl = el('now-title');
const nowMetaEl = el('now-meta');
const progressEl = el('progress');
const progressFillEl = el('progress-fill');
const nextLabelEl = el('next-label');
const nextListEl = el('next-list');
const nextMoreEl = el('next-more');

const gearBtn = el('gear');
const panel = el('panel');
const panelBackdrop = el('panel-backdrop');
const panelClose = el('panel-close');
const panelStatus = el('panel-status');
const hostInput = el('host');
const portInput = el('port');
const passwordInput = el('password');
const btnConnect = el('btn-connect');
const btnDisconnect = el('btn-disconnect');
const btnFullscreen = el('btn-fullscreen');
const scaleRow = el('scale-row');
const optPlaylist = el('opt-playlist');
const optProgress = el('opt-progress');
const optClean = el('opt-clean');
const urlList = el('url-list');
const aboutLine = el('about-line');
const connectionSection = el('connection-section');
const managedSection = el('managed-section');
const managedNote = el('managed-note');

const PREFS_KEY = 'ppDisplay:prefs';
/**
 * How long the settings gear stays visible after the last pointer/key activity.
 * On a wall tablet the first tap wakes the gear and the second opens it, so this
 * needs to be long enough for someone to reach across and press it.
 */
const CHROME_IDLE_MS = 6000;

let state = null;
let status = null;
let chromeTimer = null;
let lastErrorShown = '';
/** The live SSE connection, retained so it can be torn down and re-opened on demand. */
let stream = null;
/** True while we have no feed from the host at all (as opposed to ProPresenter being down). */
let feedOffline = false;
/** Host build this page was loaded from. When it changes, the host was updated → reload. */
let loadedHostVersion = null;

/* ---------------- per-device preferences ---------------- */

const defaultPrefs = { scale: 1, showPlaylist: true, showProgress: true, cleanTitles: true };
let prefs = { ...defaultPrefs };

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    prefs = { ...defaultPrefs, ...saved };
  } catch {
    prefs = { ...defaultPrefs };
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode / storage full — the display still works, just won't remember */
  }
}

function applyPrefs() {
  document.documentElement.style.setProperty('--scale', String(prefs.scale));
  for (const chip of scaleRow.querySelectorAll('.chip')) {
    chip.classList.toggle('is-on', Number(chip.dataset.scale) === Number(prefs.scale));
  }
  optPlaylist.checked = prefs.showPlaylist;
  optProgress.checked = prefs.showProgress;
  optClean.checked = prefs.cleanTitles;
  render();
}

/* ---------------- title tidying ----------------
   Same rule as the Band Lineup app's Now/Next column. Duplicated here on purpose:
   this page loads as a plain script and can't require ../propresenter-core, and the
   raw name is still what the server matches ProPresenter items on. */

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
  return prefs.cleanTitles ? cleanItemName(raw) : String(raw || '').trim();
}

function itemTypeTag(type) {
  switch (type) {
    case 'media':
      return 'Media';
    case 'audio':
      return 'Audio';
    case 'livevideo':
      return 'Live';
    case 'placeholder':
      return 'PCO';
    default:
      return '';
  }
}

/* ---------------- rendering ---------------- */

/** The items after the live one, hidden entries dropped. Shared by NOW's note and NEXT. */
function upcomingItems() {
  const items = Array.isArray(state?.items) ? state.items : [];
  // Presenting from the playlist → everything after the live item. Presenting from the
  // Library (activeIndex < 0) → the whole list is still ahead.
  const from = state && state.activeIndex >= 0 ? state.activeIndex + 1 : 0;
  const out = [];
  for (let i = from; i < items.length; i += 1) {
    if (!items[i].isHidden) out.push(items[i]);
  }
  return out;
}

/**
 * Size the NOW title as large as it can be while (a) staying inside the box and (b) NEVER
 * breaking a word across lines. Wrapping is allowed only at spaces.
 *
 * The trick that makes it robust: with word-breaking forbidden (overflow-wrap/word-break
 * normal), a word wider than the box OVERFLOWS rather than splitting, so scrollWidth
 * exceeds the box — and the same fit test that guards height also rejects that size. Binary
 * search then lands on the biggest size where every whole word fits the width and the whole
 * title fits the height. No pixel-rounding fallback can sneak a mid-word break in, which was
 * the "Promis / ed Land" bug.
 */
/**
 * Hand the browser a brand-new title element whenever the text changes. On some GPUs (macOS
 * Chrome on an external display) a large text element keeps a stale compositor backing store
 * when its contents change, so the previous song stays painted under the new one — "AMAZING!"
 * ghosting behind "Alleluia". A screenshot looks clean (the DOM is right); only the physical
 * pixels are wrong, the signature of a layer that was never invalidated. A fresh node has no
 * old backing store, so the ghost cannot survive the swap. Runs only when the title changes.
 */
let lastTitleText = null;
function setNowTitle(text) {
  if (text === lastTitleText && nowTitleEl.isConnected) return;
  lastTitleText = text;
  const fresh = document.createElement('div');
  fresh.className = 'now-title';
  fresh.id = 'now-title';
  fresh.textContent = text;
  nowTitleEl.replaceWith(fresh);
  nowTitleEl = fresh;
}

function fitNowTitle() {
  // Status messages ("Nothing on screen") keep their CSS size. The resize observer calls
  // straight into here, so the guard has to live here too.
  if (nowTitleEl.classList.contains('is-waiting')) return;
  const boxHeight = nowTitleBox.clientHeight;
  const boxWidth = nowTitleBox.clientWidth;
  const MIN = 14;

  // Wrap only at spaces; never split a word.
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
    // +1 absorbs sub-pixel rounding; because word-breaking is off, an over-wide word shows
    // up here as horizontal overflow and is rejected rather than being split.
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
  // Hysteresis: keep the current size unless the new best differs by more than a pixel.
  // Sub-pixel box jitter (Windows fractional-DPI, a re-measured meta line) would otherwise
  // flap the size ±1px every render — the "bigger and smaller text" the operator sees.
  const current = parseFloat(nowTitleEl.style.fontSize) || 0;
  // Only HOLD the current size if it still genuinely fits. A plain 1px band can straddle the
  // line-wrap threshold (137px = one line fits, 138px = two lines overflow) and stick on the
  // overflowing side — which is exactly how the title spilled out of the box.
  if (current && Math.abs(current - best) <= 1 && fits(current)) {
    nowTitleEl.style.fontSize = `${current}px`;
    return;
  }
  nowTitleEl.style.fontSize = `${best}px`;

  // Last resort: a single word so long it cannot fit even at MIN (unlikely for a song
  // title). Rather than overflow the card, allow this one to break.
  if (best === MIN && nowTitleEl.scrollWidth > nowTitleBox.clientWidth + 1) {
    nowTitleEl.style.overflowWrap = 'anywhere';
    nowTitleEl.style.wordBreak = 'break-word';
  }
}

/**
 * Hide the NEXT rows that fall past the bottom of the list and report how many.
 *
 * Rows are hidden, never removed: NOW is a greedy flex item, so deleting rows would
 * shrink the NEXT block, let NOW grow into the freed space, and ratchet the list down
 * to nothing over successive renders. Keeping every row in the flow fixes the NEXT
 * block's height, and `visibility: hidden` keeps a half-cut row off the screen.
 */
function markNextOverflow() {
  const rows = Array.from(nextListEl.children);
  for (const row of rows) row.style.visibility = '';
  let hidden = 0;
  // Revealing the "+ N more" line takes height away from the list, which can push one
  // more row past the fold — so re-measure until it settles (bounded, only a few rows).
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
    liveTextEl.textContent = 'Display offline';
    return;
  }
  if (!status) {
    liveTextEl.textContent = 'Connecting…';
    return;
  }
  if (!status.enabled) {
    liveTextEl.textContent = 'Not set up';
    return;
  }
  if (state?.reachable) {
    liveEl.classList.add('is-live');
    liveTextEl.textContent = 'Live';
    return;
  }
  liveEl.classList.add('is-down');
  liveTextEl.textContent = 'Reconnecting…';
}

function renderNow() {
  const activeItem = state && state.activeIndex >= 0 ? state.items[state.activeIndex] : null;
  const rawName = activeItem?.name || state?.activePresentationName || '';

  // Clear anything a previous render appended below the progress bar.
  for (const stale of screenEl.querySelectorAll('.now-error, .now-hint, .stale-note')) stale.remove();

  if (feedOffline) {
    // We are showing whatever was last on screen, and it is not moving. Say so.
    setNowTitle(rawName ? `Last shown: ${displayName(rawName)}` : 'Display offline');
    nowTitleEl.classList.add('is-waiting');
    nowTitleEl.style.fontSize = '';
    nowTitleEl.style.whiteSpace = '';
    nowMetaEl.textContent = '';
    progressEl.hidden = true;
    const staleEl = document.createElement('div');
    staleEl.className = 'stale-note';
    staleEl.textContent = status?.hostLabel
      ? `Not receiving updates — ${status.hostLabel} may be closed or asleep.`
      : 'Not receiving updates from the display host.';
    el('now').appendChild(staleEl);
    return;
  }

  if (!rawName) {
    // A status message is not a song title — leave it at its CSS size instead of
    // running the fill-the-box fit, which would blow "No ProPresenter connection"
    // up across the whole screen.
    let hint = '';
    if (!status?.enabled) {
      setNowTitle('No ProPresenter connection');
      // On a locked studio screen, "press the gear and type an IP" is advice nobody
      // standing there can act on — the host supplies the right wording instead.
      hint = status?.setupHint || 'Waiting for the display host to connect to ProPresenter.';
    } else {
      // "Waiting for ProPresenter" reads as a fault. When we are connected and ProPresenter
      // simply has nothing live (it returns presentation_index: null with the output
      // cleared), say that plainly so nobody goes looking for a broken connection.
      setNowTitle(state?.reachable ? 'Nothing on screen' : 'Reconnecting…');
      hint = state?.reachable
        ? 'Connected to ProPresenter — waiting for a slide to go live.'
        : 'Trying to reach ProPresenter.';
    }
    nowTitleEl.classList.add('is-waiting');
    nowTitleEl.style.fontSize = '';
    nowTitleEl.style.whiteSpace = '';
    nowMetaEl.textContent = '';
    progressEl.hidden = true;
    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'now-hint';
      hintEl.textContent = hint;
      el('now').appendChild(hintEl);
    }
    // Raw fetch/socket error text is for whoever administers the connection, not for a
    // wall in a studio. It stays in the host app's own status line.
    return;
  }

  setNowTitle(displayName(rawName));
  nowTitleEl.classList.remove('is-waiting');
  fitNowTitle();
  // Re-fit once more after layout settles: on the first render after a navigation/resize the
  // title box may not have its final height yet, and fitting against a too-tall box would let
  // the title overflow for a frame. The ResizeObserver also covers this; this makes it instant.
  window.requestAnimationFrame(() => {
    if (!nowTitleEl.classList.contains('is-waiting')) fitNowTitle();
  });

  // An empty NEXT list looks broken unless the screen says why it is empty.
  if (!upcomingItems().length) {
    const kind = state?.playlistKind;
    let why = '';
    if (kind === 'group' || kind === 'none') {
      why = 'Presenting from the library — no playlist open, so there is nothing listed after this.';
    } else if (kind === 'unknown') {
      why = 'ProPresenter did not return this playlist\u2019s items, so the next list is unavailable.';
    } else if (Array.isArray(state?.items) && state.items.length) {
      why = 'Last item in the playlist.';
    }
    if (why) {
      const note = document.createElement('div');
      note.className = 'now-hint';
      note.textContent = why;
      el('now').appendChild(note);
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

  if (prefs.showProgress && total > 0) {
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
  // With nothing to list, NOW would otherwise grow into the entire screen and read as a
  // broken page; the class caps it so the card still looks deliberate.
  document.body.classList.toggle('no-upcoming', upcoming.length === 0);

  for (const item of upcoming) {
    const row = document.createElement('div');
    const nameEl = document.createElement('div');
    nameEl.className = 'next-name';

    if (item.type === 'header') {
      row.className = 'next-item is-header';
      nameEl.textContent = displayName(item.name || '');
      row.appendChild(nameEl);
      nextListEl.appendChild(row);
      continue;
    }

    row.className = 'next-item';
    nameEl.textContent = displayName(item.name) || '(untitled)';
    row.appendChild(nameEl);

    if (item.type === 'presentation' && Number.isInteger(item.slideCount)) {
      const chip = document.createElement('div');
      chip.className = 'count-chip';
      chip.textContent = String(item.slideCount);
      row.appendChild(chip);
    } else {
      const tag = itemTypeTag(item.type);
      if (tag) {
        const tagEl = document.createElement('div');
        tagEl.className = 'type-tag';
        tagEl.textContent = tag;
        row.appendChild(tagEl);
      }
    }
    nextListEl.appendChild(row);
  }

  nextLabelEl.hidden = upcoming.length === 0;
  nextMoreEl.hidden = true;
  // Measure synchronously so a half-visible row never reaches the screen; the extra frame
  // is a safety net for the first render, when layout height isn't known yet.
  markNextOverflow();
  window.requestAnimationFrame(markNextOverflow);
}

function render() {
  document.body.classList.toggle('is-offline', feedOffline);
  const showTop = prefs.showPlaylist || feedOffline || !state?.reachable || !status?.enabled;
  topRow.classList.toggle('hidden-row', !showTop);
  playlistNameEl.textContent = prefs.showPlaylist ? state?.playlistName || '' : '';
  renderLive();
  renderNow();
  renderNext();
}

/* ---------------- live feed ---------------- */

/**
 * Reload the page when the host app has been updated to a new build.
 *
 * These screens are bookmarks nobody tends — a tab left open keeps running the JavaScript it
 * first loaded, so a fixed display page would never reach the wall until someone walked over
 * and refreshed it. The host stamps its version into every status frame; when it changes from
 * what this tab loaded with, the host was reinstalled, so pick up its new page automatically.
 */
function checkForHostUpdate() {
  const version = status && status.hostVersion;
  if (!version) return;
  if (loadedHostVersion === null) {
    loadedHostVersion = version;
    return;
  }
  if (version !== loadedHostVersion) {
    // location.reload() refetches the page and its assets (served no-store), so the tab
    // comes back running the new build. loadedHostVersion resets on reload, so no loop.
    window.location.reload();
  }
}

function connectStream() {
  if (stream) {
    try { stream.close(); } catch { /* already closed */ }
    stream = null;
  }
  // Relative on purpose so the page works from any host, port, or mount path.
  const source = new EventSource('api/stream');
  stream = source;

  source.addEventListener('open', () => {
    feedOffline = false;
    render();
  });

  source.addEventListener('state', (event) => {
    let incoming;
    try {
      incoming = JSON.parse(event.data);
    } catch {
      return;
    }
    state = incoming;
    feedOffline = false;
    render();
  });

  source.addEventListener('status', (event) => {
    let incoming;
    try {
      incoming = JSON.parse(event.data);
    } catch {
      return;
    }
    status = incoming;
    feedOffline = false;
    checkForHostUpdate();
    syncPanelFromStatus();
    render();
  });

  source.addEventListener('error', () => {
    // EventSource retries by itself, but the screen must admit it is frozen meanwhile —
    // otherwise a stale lineup is indistinguishable from a live one.
    feedOffline = true;
    render();
  });
}

/**
 * Force a fresh connection. iPadOS suspends timers and sockets on a sleeping tab and does
 * not always resume an EventSource, which would leave a wall display frozen indefinitely.
 */
function reconnectStream() {
  // OPEN (1) or still CONNECTING (0) both mean a connection is already in flight. Opening
  // another would leave this page holding two streams, which the host then counts twice.
  if (stream && (stream.readyState === 0 || stream.readyState === 1)) return;
  connectStream();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') reconnectStream();
});
window.addEventListener('online', reconnectStream);
window.addEventListener('pageshow', reconnectStream);

/* ---------------- settings panel ---------------- */

function setPanelStatus(message, isError = false) {
  panelStatus.textContent = message;
  panelStatus.classList.toggle('is-error', Boolean(isError));
}

function syncPanelFromStatus() {
  if (!status) return;
  if (document.activeElement !== hostInput) hostInput.value = status.host || '';
  if (document.activeElement !== portInput) {
    portInput.value = status.port ? String(status.port) : String(status.defaultProPresenterPort || '');
  }
  passwordInput.placeholder = status.hasPassword ? 'Saved — leave blank to keep' : 'Leave blank if none';

  const locked = Boolean(status.readOnly);
  for (const control of [hostInput, portInput, passwordInput, btnConnect, btnDisconnect]) {
    control.disabled = locked;
  }
  // A row of dead grey fields invites people to keep poking at them. Replace the whole
  // section with a sentence saying where the connection actually lives.
  if (connectionSection) connectionSection.hidden = locked;
  if (managedSection) managedSection.hidden = !locked;
  if (managedNote) {
    managedNote.textContent = status.enabled
      ? `This screen follows ${status.hostLabel || 'the display host'}, which is connected to ProPresenter. Nothing to set up here.`
      : `This screen follows ${status.hostLabel || 'the display host'}. ${status.setupHint || ''}`.trim();
  }

  if (aboutLine) {
    const version = status.hostVersion ? `v${status.hostVersion}` : '';
    aboutLine.textContent = [
      'Stage Now / Next',
      version,
      status.hostLabel ? `served by ${status.hostLabel}` : '',
    ].filter(Boolean).join(' · ');
  }

  urlList.innerHTML = '';
  const addresses = Array.isArray(status.addresses) && status.addresses.length
    ? status.addresses
    : (Array.isArray(status.viewerUrls) ? status.viewerUrls : []).map((url) => ({ url, detail: '' }));
  if (!addresses.length) {
    const none = document.createElement('span');
    none.className = 'muted';
    none.textContent = 'No network address detected on this machine.';
    urlList.appendChild(none);
  }
  for (const entry of addresses) {
    const row = document.createElement('div');
    row.textContent = entry.url;
    urlList.appendChild(row);
    if (entry.detail) {
      const note = document.createElement('span');
      note.className = 'muted';
      note.textContent = entry.detail;
      urlList.appendChild(note);
    }
  }

  if (locked) {
    setPanelStatus('');
  } else if (status.enabled) {
    setPanelStatus(
      status.reachable
        ? `Following ProPresenter at ${status.host}:${status.port}.`
        : `Saved ${status.host}:${status.port} — trying to reach ProPresenter…`,
    );
  } else if (!lastErrorShown) {
    setPanelStatus('Not connected yet. Enter the ProPresenter IP and port.');
  }
}

function openPanel() {
  panel.classList.remove('hidden');
  panelBackdrop.classList.remove('hidden');
  syncPanelFromStatus();
  hostInput.focus();
}

function closePanel() {
  panel.classList.add('hidden');
  panelBackdrop.classList.add('hidden');
  passwordInput.value = '';
  lastErrorShown = '';
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

async function connectProPresenter() {
  const host = hostInput.value.trim();
  const port = portInput.value.trim();
  if (!host || !port) {
    lastErrorShown = 'missing';
    setPanelStatus('Enter the ProPresenter host and port.', true);
    return;
  }
  btnConnect.disabled = true;
  setPanelStatus('Connecting to ProPresenter…');
  try {
    // An untouched password field means "keep whatever is saved".
    const payload = { host, port };
    if (passwordInput.value !== '') payload.password = passwordInput.value;
    const data = await postJson('api/connect', payload);
    status = data.status;
    lastErrorShown = '';
    passwordInput.value = '';
    syncPanelFromStatus();
    setPanelStatus(`Connected. Every screen on this server is now following ${host}:${port}.`);
  } catch (error) {
    lastErrorShown = 'connect';
    setPanelStatus(error instanceof Error ? error.message : 'Could not connect to ProPresenter.', true);
  } finally {
    btnConnect.disabled = false;
  }
}

async function disconnectProPresenter() {
  btnDisconnect.disabled = true;
  try {
    const data = await postJson('api/disconnect');
    status = data.status;
    state = null;
    lastErrorShown = '';
    syncPanelFromStatus();
    setPanelStatus('Disconnected. Host and port are remembered for next time.');
    render();
  } catch (error) {
    setPanelStatus(error instanceof Error ? error.message : 'Could not disconnect.', true);
  } finally {
    btnDisconnect.disabled = false;
  }
}

/* ---------------- chrome auto-hide (the display stays clean) ---------------- */

function revealChrome() {
  document.body.classList.add('chrome-visible');
  if (chromeTimer) window.clearTimeout(chromeTimer);
  chromeTimer = window.setTimeout(() => {
    if (panel.classList.contains('hidden')) document.body.classList.remove('chrome-visible');
  }, CHROME_IDLE_MS);
}

/* ---------------- wiring ---------------- */

gearBtn.addEventListener('click', openPanel);
panelClose.addEventListener('click', closePanel);
panelBackdrop.addEventListener('click', closePanel);
btnConnect.addEventListener('click', () => void connectProPresenter());
btnDisconnect.addEventListener('click', () => void disconnectProPresenter());

btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.().catch(() => {});
  }
});

for (const input of [hostInput, portInput, passwordInput]) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void connectProPresenter();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closePanel();
    }
  });
}

scaleRow.addEventListener('click', (event) => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  prefs.scale = Number(chip.dataset.scale) || 1;
  savePrefs();
  applyPrefs();
});

optPlaylist.addEventListener('change', () => {
  prefs.showPlaylist = optPlaylist.checked;
  savePrefs();
  render();
});

optProgress.addEventListener('change', () => {
  prefs.showProgress = optProgress.checked;
  savePrefs();
  render();
});

optClean.addEventListener('change', () => {
  prefs.cleanTitles = optClean.checked;
  savePrefs();
  render();
});

for (const event of ['pointermove', 'pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(event, revealChrome, { passive: true });
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !panel.classList.contains('hidden')) closePanel();
  if (event.key === 'f' && !event.metaKey && !event.ctrlKey && panel.classList.contains('hidden')) {
    btnFullscreen.click();
  }
});

// Re-fit on any size change: window resize, fullscreen, rotation, or scale change.
if (typeof ResizeObserver !== 'undefined') {
  // Re-fit only when a watched box ACTUALLY changed size (window resize, rotation), never
  // just because the fitter or the overflow-marker wrote to the DOM. Without this guard the
  // observer reacts to its own effects and the title size oscillates every render.
  let lastTitleW = 0;
  let lastTitleH = 0;
  let lastListH = 0;
  let pending = false;
  const observer = new ResizeObserver(() => {
    const tw = Math.round(nowTitleBox.clientWidth);
    const th = Math.round(nowTitleBox.clientHeight);
    const lh = Math.round(nextListEl.clientHeight);
    if (tw === lastTitleW && th === lastTitleH && lh === lastListH) return;
    lastTitleW = tw; lastTitleH = th; lastListH = lh;
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(() => {
      pending = false;
      fitNowTitle();
      // markNextOverflow re-evaluates row visibility for the new size WITHOUT rebuilding the
      // list (a rebuild would flash and could re-enter this observer).
      markNextOverflow();
    });
  });
  observer.observe(nowTitleBox);
  observer.observe(nextListEl);
}

/** Best-effort: keep a dedicated display awake. Only granted in a secure context. */
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator)) return;
    let lock = await navigator.wakeLock.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && lock?.released !== false) {
        try {
          lock = await navigator.wakeLock.request('screen');
        } catch {
          /* denied — nothing to do */
        }
      }
    });
  } catch {
    /* not available over plain http, or refused — the page still works */
  }
}

loadPrefs();
applyPrefs();
revealChrome();
connectStream();
void keepAwake();
