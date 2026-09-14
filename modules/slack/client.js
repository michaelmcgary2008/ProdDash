/* Slack — client part.

   Tiles from one module (moduleApi.variant / the tile's `view` setting pick):
   one channel transcript per configured channel, a PIN-gated free-text sender
   and a PIN-gated grid of preset replies. The two senders post to the channel
   of whichever transcript was clicked last (see the send target below).
   Everything lives inside the tile's root; all traffic goes through the
   module's server routes (the token and the PIN never reach a browser).
   Nothing here uses innerHTML with data — every string from Slack lands in
   a text node. */

/* ── shared helpers ─────────────────────────────────────────────────── */

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/* Inline marks the server left in the text: ```code``` `code` *bold*
   _italic_ ~strike~. Openers must not sit inside a word (snake_case_names
   and 5 * 3 * 2 stay as they are). Built with DOM nodes, so any character
   in a message is safe. */
const MARK_RE = /(```[\s\S]*?```|`[^`\n]+`|(?<![\w*])\*(?!\s)[^*\n]*?(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)[^_\n]*?(?<!\s)_(?![\w_])|(?<![\w~])~(?!\s)[^~\n]*?(?<!\s)~(?![\w~]))/g;

function renderRich(container, text, depth = 0) {
  container.textContent = '';
  const s = String(text || '');
  let last = 0;
  if (depth < 3) {
    for (const m of s.matchAll(MARK_RE)) {
      if (m.index > last) container.appendChild(document.createTextNode(s.slice(last, m.index)));
      const tok = m[0];
      let node;
      if (tok.startsWith('```')) {
        node = el('span', 'sl-code sl-block', tok.slice(3, -3).replace(/^\n+|\n+$/g, ''));
      } else if (tok.startsWith('`')) {
        node = el('code', 'sl-code', tok.slice(1, -1));
      } else {
        node = el(tok.startsWith('*') ? 'b' : tok.startsWith('_') ? 'i' : 's');
        renderRich(node, tok.slice(1, -1), depth + 1);
      }
      container.appendChild(node);
      last = m.index + tok.length;
    }
  }
  if (last < s.length) container.appendChild(document.createTextNode(s.slice(last)));
}

function textSizePx(moduleApi, fallback = 14) {
  return Math.min(48, Math.max(10, Number(moduleApi.instanceSettings.textSize) || fallback));
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

const NO_CHANNEL = 'No channel configured — pick channels in Admin → Slack → Channels';

const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const JUMP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
const BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 6H8l-5 6 5 6h13a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1z"/><path d="m18 9-6 6M12 9l6 6"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>';

/* ── the send target ────────────────────────────────────────────────── */

/* Deliberately module-level. The guide forbids module-level *per-instance*
   state — two tiles' closures must never leak into each other — and every
   piece of per-tile state in this file still lives inside its create(). This
   is a different kind of thing: one fact about the whole page, "which
   transcript did the operator click last", that Send message, Quick replies
   and every transcript tile on this dashboard have to agree on. It is UI
   state of this browser, not of the machine (another screen in the booth may
   be pointed at another channel), so it stays out of the server and lives
   here: an EventTarget plus the chosen channel id, mirrored in localStorage
   under proddash:slack:sendTarget so a reload keeps it. */
const SEND_TARGET_KEY = 'proddash:slack:sendTarget';

const sendTarget = (() => {
  const bus = new EventTarget();
  const transcripts = new Map(); // instanceId -> channel id, for every transcript tile on the page
  let id = '';
  try {
    id = String(localStorage.getItem(SEND_TARGET_KEY) || '');
  } catch { /* private mode or blocked storage — the choice lasts until reload */ }
  const emit = () => bus.dispatchEvent(new Event('change'));
  return {
    /** The channel the operator clicked last ('' if never). */
    get() {
      return id;
    },
    /** A transcript was clicked: remember it and tell every Slack tile. */
    select(channelId) {
      const next = String(channelId || '');
      if (next === id) return;
      id = next;
      try {
        localStorage.setItem(SEND_TARGET_KEY, id);
      } catch { /* fine — see above */ }
      emit();
    },
    /** Transcript tiles register, so the fallback rule can tell a selected channel whose tile is gone. */
    attach(instanceId, channelId) {
      if (transcripts.get(instanceId) === channelId) return;
      transcripts.set(instanceId, channelId);
      emit();
    },
    detach(instanceId) {
      if (transcripts.delete(instanceId)) emit();
    },
    hasTranscript(channelId) {
      for (const v of transcripts.values()) if (v === channelId) return true;
      return false;
    },
    /**
     * Where a send goes, given the configured channels in admin order: the
     * selection while it is still configured and its transcript is on the
     * page; otherwise the first configured channel.
     */
    resolve(configured) {
      const list = Array.isArray(configured) ? configured : [];
      if (!list.length) return '';
      if (id && list.includes(id) && this.hasTranscript(id)) return id;
      return list[0];
    },
    on(fn) {
      bus.addEventListener('change', fn);
      return () => bus.removeEventListener('change', fn);
    },
  };
})();

/* ── the factory ────────────────────────────────────────────────────── */

export default function create({ root, moduleApi }) {
  const variant = String(moduleApi.variant || '');
  // The entry's preset `view` is authoritative; a tile added under 1.0.0 has
  // the plain variant "transcript", a new one "transcript:<channel id>".
  const view = String(moduleApi.instanceSettings.view || (variant.startsWith('transcript') ? 'transcript' : variant) || 'transcript');
  if (view === 'send' || view === 'quick') return createSendTile({ root, moduleApi, mode: view });
  return createTranscriptTile({ root, moduleApi });
}

/* ── transcript ─────────────────────────────────────────────────────── */

function createTranscriptTile({ root, moduleApi }) {
  const entries = new Map(); // ts -> { el, sig, ... }
  // The channel this tile shows: preset by the picker entry; a tile from
  // 1.0.0 has none and follows the first configured channel.
  const pinnedChannel = String(moduleApi.instanceSettings.channel || '');
  let channelId = pinnedChannel;
  let lastState = null;
  let pinnedToLatest = true;
  let painted = false;
  let stream = null;
  let stopped = false;
  let targetTimer = null;

  root.innerHTML = `
    <div class="sl-wrap sl-transcript">
      <div class="sl-banner" hidden></div>
      <div class="sl-stream">
        <div class="sl-empty">Connecting to Slack…</div>
        <div class="sl-entries"></div>
      </div>
      <button class="sl-jump" hidden>↓ New messages</button>
    </div>`;
  const wrap = root.querySelector('.sl-wrap');
  const banner = root.querySelector('.sl-banner');
  const streamEl = root.querySelector('.sl-stream');
  const entriesEl = root.querySelector('.sl-entries');
  const emptyEl = root.querySelector('.sl-empty');
  const jumpBtn = root.querySelector('.sl-jump');

  /* title-bar controls */
  function bumpTextSize(delta) {
    moduleApi.saveInstanceSettings({ textSize: Math.min(48, Math.max(10, textSizePx(moduleApi) + delta)) });
    applyInstanceSettings();
  }
  moduleApi.header.addButton({ label: 'A−', title: 'Smaller text', onClick: () => bumpTextSize(-1) });
  moduleApi.header.addButton({ label: 'A+', title: 'Larger text', onClick: () => bumpTextSize(1) });
  moduleApi.header.addButton({
    icon: JUMP_SVG,
    title: 'Jump to latest',
    onClick() {
      pinnedToLatest = true;
      jumpBtn.hidden = true;
      scrollToLatest();
    },
  });

  function applyInstanceSettings() {
    const s = moduleApi.instanceSettings;
    wrap.style.setProperty('--sl-size', textSizePx(moduleApi) + 'px');
    wrap.classList.toggle('show-times', s.showTimes !== false);
    wrap.classList.toggle('show-names', s.showNames !== false);
    wrap.classList.toggle('show-system', s.showSystem !== false);
    if (pinnedToLatest) scrollToLatest();
  }
  applyInstanceSettings();

  /* scrolling */
  streamEl.addEventListener('scroll', () => {
    const near = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight < 60;
    pinnedToLatest = near;
    if (near) jumpBtn.hidden = true;
  });
  jumpBtn.addEventListener('click', () => {
    pinnedToLatest = true;
    jumpBtn.hidden = true;
    scrollToLatest();
  });
  function scrollToLatest() {
    streamEl.scrollTop = streamEl.scrollHeight;
  }

  /* the send target: a click anywhere in the body points the senders here */
  wrap.addEventListener('click', () => {
    if (!channelId || !lastState?.channels?.[channelId]) return; // not configured — can't be a target
    sendTarget.select(channelId);
  });
  const offTarget = sendTarget.on(() => {
    // Coalesce: a remount detaches and re-attaches within a few ms.
    clearTimeout(targetTimer);
    targetTimer = setTimeout(paintTarget, 50);
  });

  function isTarget() {
    return Boolean(channelId) && sendTarget.resolve(lastState?.channelOrder) === channelId;
  }

  function paintTarget() {
    if (stopped) return;
    const on = isTarget();
    if (on === wrap.classList.contains('is-target')) return;
    wrap.classList.toggle('is-target', on);
    if (lastState) reportStatus(lastState);
  }

  /* entries */
  function buildMeta(m) {
    const meta = el('div', 'sl-meta');
    meta.append(el('span', 'sl-name', m.name || ''), el('span', 'sl-time', fmtTime(m.time)));
    return meta;
  }

  function buildLine(m) {
    // A message or a thread reply: name + time, then the text.
    const line = el('div', m.parent ? 'sl-reply' : 'sl-msg');
    line.classList.toggle('sl-me', Boolean(m.me));
    line.classList.toggle('sl-bot', Boolean(m.bot));
    line.appendChild(buildMeta(m));
    const text = el('div', 'sl-text');
    renderRich(text, m.text);
    if (m.edited) text.appendChild(el('span', 'sl-edited', ' (edited)'));
    line.appendChild(text);
    return line;
  }

  function buildEntry(m) {
    const node = el('div', 'sl-entry');
    node.dataset.ts = m.ts;
    return { el: node, sig: '' };
  }

  function fillEntry(entry, m) {
    const sig = JSON.stringify(m);
    if (sig === entry.sig) return;
    entry.sig = sig;
    const node = entry.el;
    node.textContent = '';
    node.classList.toggle('sl-system', Boolean(m.system));
    node.classList.toggle('sl-me', Boolean(m.me));
    if (m.system) {
      const line = el('div', 'sl-sysline');
      line.append(el('span', 'sl-time', fmtTime(m.time)), el('span', 'sl-systext', m.text || ''));
      node.appendChild(line);
      return;
    }
    node.appendChild(buildLine(m));
    if (Array.isArray(m.replies)) {
      if (m.replies.length) {
        const list = el('div', 'sl-replies');
        for (const r of m.replies) list.appendChild(buildLine(r));
        node.appendChild(list);
      }
    } else if (m.replyCount > 0) {
      node.appendChild(el('div', 'sl-replycount', `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`));
    }
  }

  function renderMessages(list) {
    const seen = new Set();
    let prev = null;
    let added = 0;
    for (const m of list) {
      if (!m || !m.ts) continue;
      seen.add(m.ts);
      let entry = entries.get(m.ts);
      if (!entry) {
        entry = buildEntry(m);
        entries.set(m.ts, entry);
        if (painted) entry.el.classList.add('sl-new');
        added += 1;
      }
      fillEntry(entry, m);
      const node = entry.el;
      // Keep DOM order equal to list order without re-inserting settled nodes
      // (a move would replay the fade-in).
      if (prev ? node.previousElementSibling !== prev : node !== entriesEl.firstElementChild) {
        if (prev) prev.after(node);
        else entriesEl.prepend(node);
      }
      prev = node;
    }
    for (const [ts, entry] of entries) {
      if (seen.has(ts)) continue;
      entry.el.remove();
      entries.delete(ts);
    }
    if (pinnedToLatest) scrollToLatest();
    else if (added) jumpBtn.hidden = false;
  }

  /** The status dot, banner and empty-state text for the current state. */
  function reportStatus(s) {
    const ch = channelId && s.channels && typeof s.channels === 'object' ? s.channels[channelId] : null;
    const hasEntries = entries.size > 0;
    const who = s.identity?.name ? ` as ${s.identity.name}` : '';
    let problem = '';
    if (!channelId) problem = NO_CHANNEL;
    else if (!ch) problem = `#${channelId} is no longer one of this module's channels — pick it again in Admin → Slack → Channels, or remove this tile`;
    if (problem) {
      moduleApi.setStatus('error', problem);
      banner.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = problem;
      emptyEl.classList.add('is-error');
      return;
    }
    const chan = `#${ch.name || channelId}`;
    const st = ch.status || {};
    if (st.state === 'ok') {
      moduleApi.setStatus('ok', `Live — ${chan}${who}${isTarget() ? ' · sends go here' : ''}`);
      banner.hidden = true;
    } else {
      moduleApi.setStatus(st.state === 'error' ? 'error' : 'connecting', st.message || 'Connecting to Slack…');
      // With messages on screen the problem rides in a banner; with none,
      // the empty state says it, once.
      banner.textContent = st.message || 'Connecting to Slack…';
      banner.classList.toggle('is-error', st.state === 'error');
      banner.hidden = !hasEntries;
    }
    emptyEl.hidden = hasEntries;
    if (!hasEntries) {
      emptyEl.textContent = st.state !== 'ok' ? (st.message || 'Connecting to Slack…') : `No messages yet in ${chan}`;
      emptyEl.classList.toggle('is-error', st.state === 'error');
    }
  }

  function applyState(s) {
    if (stopped || !s || typeof s !== 'object') return;
    lastState = s;
    const order = Array.isArray(s.channelOrder) ? s.channelOrder.map(String) : [];
    channelId = pinnedChannel || order[0] || '';
    const ch = channelId && s.channels && typeof s.channels === 'object' ? s.channels[channelId] : null;
    // Registered while its channel is configured: that is what makes it a
    // possible send target (see sendTarget.resolve).
    if (ch) sendTarget.attach(moduleApi.instanceId, channelId);
    else sendTarget.detach(moduleApi.instanceId);
    renderMessages(ch && Array.isArray(ch.messages) ? ch.messages : []);
    wrap.classList.toggle('is-target', isTarget());
    reportStatus(s);
    painted = true;
  }

  async function loadState() {
    try {
      const res = await moduleApi.fetch('/state');
      if (!res.ok) throw new Error(String(res.status));
      applyState(await res.json());
    } catch {
      /* the stream's next frame paints; the error handler reports the outage */
    }
  }

  function connect() {
    stream = moduleApi.sse('/stream', {
      open() {
        // Tiles share one stream; a late joiner missed its first frame, and a
        // reconnect may have missed changes — a snapshot covers both.
        loadState();
      },
      error() {
        moduleApi.setStatus('error', 'ProdDash Slack module unreachable — reconnecting…');
        banner.textContent = 'ProdDash Slack module unreachable — reconnecting…';
        banner.classList.add('is-error');
        banner.hidden = entries.size === 0;
        if (!entries.size) {
          emptyEl.textContent = 'ProdDash Slack module unreachable — reconnecting…';
          emptyEl.classList.add('is-error');
        }
      },
      events: {
        state(e) {
          try {
            applyState(JSON.parse(e.data));
          } catch { /* a bad frame is skipped */ }
        },
      },
    });
  }

  return {
    start() {
      moduleApi.setStatus('connecting', 'Connecting to Slack…');
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(targetTimer);
      offTarget();
      sendTarget.detach(moduleApi.instanceId);
      stream?.close();
      root.innerHTML = ''; // header controls are removed by the shell
    },
    onResize() {
      if (pinnedToLatest) scrollToLatest();
    },
  };
}

/* ── send + quick replies ───────────────────────────────────────────── */

function createSendTile({ root, moduleApi, mode }) {
  let token = '';          // the unlock token — memory only; a remount shows the pad again
  let expiresAt = 0;
  let state = null;        // latest snapshot: sending flags, identity, channels, status
  let stream = null;
  let ticker = null;
  let stopped = false;
  let busy = false;
  let pinBuf = '';
  let gateNote = '';       // one line under the pad ("Locked after inactivity")
  let gateError = '';      // the server's refusal ("Wrong PIN", "locked for 30 s")
  let gateKind = '';       // what the gate currently shows, to avoid needless rebuilds
  let presets = null;
  let targetTimer = null;

  root.innerHTML = `
    <div class="sl-wrap sl-send" tabindex="0">
      <div class="sl-gate"></div>
      <div class="sl-compose" hidden></div>
    </div>`;
  const wrap = root.querySelector('.sl-wrap');
  const gate = root.querySelector('.sl-gate');
  const compose = root.querySelector('.sl-compose');

  const lockBtn = moduleApi.header.addButton({ icon: LOCK_SVG, title: 'Lock now', onClick: () => lock('Locked') });
  lockBtn.style.display = 'none';

  function applyInstanceSettings() {
    wrap.style.setProperty('--sl-size', textSizePx(moduleApi) + 'px');
  }
  applyInstanceSettings();

  /* ── where a send goes ── */
  function configured() {
    return Array.isArray(state?.channelOrder) ? state.channelOrder.map(String) : [];
  }

  function targetId() {
    return sendTarget.resolve(configured());
  }

  function targetName() {
    const id = targetId();
    if (!id) return '';
    const ch = state?.channels?.[id];
    return `#${ch?.name || id}`;
  }

  function sendingLine() {
    if (state && !configured().length) return NO_CHANNEL;
    const who = state?.sendingAs || '…';
    return `Sending as ${who} → ${targetName() || '…'}`;
  }

  function placeholder() {
    const name = targetName();
    return name ? `Message ${name}…` : 'Message…';
  }

  /** The selection changed somewhere on the page: every line that names the target follows. */
  function repaintTarget() {
    if (stopped || !state) return;
    if (token) {
      if (composeEls) {
        composeEls.line.textContent = sendingLine();
        if (composeEls.input) composeEls.input.placeholder = placeholder();
      }
    } else renderGate();
    moduleApi.setStatus(statusState(), `${statusMessage()} · ${token ? 'unlocked' : 'locked'}`);
  }
  const offTarget = sendTarget.on(() => {
    clearTimeout(targetTimer);
    targetTimer = setTimeout(repaintTarget, 50);
  });

  function authHeaders(extra = {}) {
    return { Authorization: `Bearer ${token}`, ...extra };
  }

  /* ── the gate: a PIN pad, or the reason there isn't one ── */
  function renderGate() {
    compose.hidden = true;
    gate.hidden = false;
    lockBtn.style.display = 'none';
    let kind;
    if (!state) kind = 'connecting';
    else if (!state.sending?.enabled) kind = 'off';
    else if (!state.sending?.pinSet) kind = 'nopin';
    else if (!configured().length) kind = 'nochannel';
    else kind = 'pad';
    if (kind !== gateKind) {
      gateKind = kind;
      gate.textContent = '';
      if (kind === 'pad') gate.appendChild(buildPad());
      else {
        const note = el('div', 'sl-note');
        note.textContent = kind === 'connecting' ? 'Connecting to ProdDash…'
          : kind === 'off' ? 'Sending is off — turn it on in Admin → Slack → Sending'
            : kind === 'nopin' ? 'Set a PIN in Admin → Slack → Sending'
              : NO_CHANNEL;
        gate.appendChild(note);
      }
    }
    if (kind === 'pad') refreshPad();
  }

  let padEls = null;
  function buildPad() {
    const pad = el('div', 'sl-pad');
    const head = el('div', 'sl-pad-head');
    head.append(el('b', '', 'Enter PIN'), el('span', 'sl-pad-sub'));
    const dots = el('div', 'sl-dots');
    for (let i = 0; i < 8; i += 1) dots.appendChild(el('span', 'sl-dot'));
    const keys = el('div', 'sl-keys');
    const key = (label, cls, onClick, html) => {
      const b = el('button', 'sl-key' + (cls ? ' ' + cls : ''));
      b.type = 'button';
      if (html) b.innerHTML = html; // our own SVG constants only
      else b.textContent = label;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        onClick();
        wrap.focus({ preventScroll: true });
      });
      return b;
    };
    for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) keys.appendChild(key(d, '', () => pressDigit(d)));
    const back = key('⌫', 'sl-key-back', () => { pinBuf = pinBuf.slice(0, -1); gateError = ''; refreshPad(); }, BACK_SVG);
    back.title = 'Backspace';
    keys.appendChild(back);
    keys.appendChild(key('0', '', () => pressDigit('0')));
    const ok = key('Unlock', 'sl-key-ok', submitPin, CHECK_SVG);
    ok.title = 'Unlock';
    keys.appendChild(ok);
    const msg = el('div', 'sl-pad-msg');
    pad.append(head, dots, keys, msg);
    padEls = { pad, sub: head.lastChild, dots, msg, ok };
    return pad;
  }

  function refreshPad() {
    if (!padEls) return;
    padEls.sub.textContent = ` · ${sendingLine().replace(/^Sending/, 'sending')}`;
    const n = Math.min(8, pinBuf.length);
    [...padEls.dots.children].forEach((d, i) => {
      d.classList.toggle('on', i < n);
      // Show as many slots as could still be typed: 4 minimum, up to 8.
      d.hidden = i >= Math.max(4, n + (n < 8 ? 1 : 0));
    });
    padEls.ok.disabled = pinBuf.length < 4 || busy;
    padEls.msg.textContent = gateError || gateNote;
    padEls.msg.classList.toggle('is-error', Boolean(gateError));
  }

  function pressDigit(d) {
    if (busy || pinBuf.length >= 8) return;
    pinBuf += d;
    gateError = '';
    refreshPad();
    if (pinBuf.length === 8) submitPin();
  }

  function shake(message) {
    gateError = message;
    gateNote = '';
    pinBuf = '';
    refreshPad();
    if (!padEls) return;
    padEls.pad.classList.remove('sl-shake');
    // restart the animation
    void padEls.pad.offsetWidth;
    padEls.pad.classList.add('sl-shake');
  }

  async function submitPin() {
    if (busy || pinBuf.length < 4) return;
    busy = true;
    refreshPad();
    try {
      const res = await moduleApi.fetch('/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pinBuf }),
      });
      const body = await readJson(res);
      if (!res.ok || !body.token) {
        shake(body.error || `Could not unlock (HTTP ${res.status})`);
        return;
      }
      token = String(body.token);
      expiresAt = Number(body.expiresAt) || Date.now() + 10 * 60000;
      pinBuf = '';
      gateError = '';
      gateNote = '';
      await showCompose();
    } catch {
      shake('ProdDash unreachable — try again');
    } finally {
      busy = false;
      refreshPad();
    }
  }

  wrap.addEventListener('keydown', (e) => {
    if (!gate.hidden && gateKind === 'pad') {
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pressDigit(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); pinBuf = pinBuf.slice(0, -1); gateError = ''; refreshPad(); }
      else if (e.key === 'Enter') { e.preventDefault(); submitPin(); }
      else if (e.key === 'Escape') { pinBuf = ''; gateError = ''; refreshPad(); }
    }
  });

  /* ── unlocked: compose or the preset grid ── */
  let composeEls = null;
  function buildCompose() {
    compose.textContent = '';
    const head = el('div', 'sl-compose-head');
    const line = el('span', 'sl-sending', sendingLine());
    const lockLink = el('button', 'sl-lock-link', 'Lock');
    lockLink.type = 'button';
    lockLink.title = 'Lock now';
    lockLink.addEventListener('click', () => lock('Locked'));
    head.append(line, lockLink);
    compose.appendChild(head);

    const foot = el('div', 'sl-compose-foot');
    const msg = el('div', 'sl-msg');
    const countdown = el('span', 'sl-countdown');
    countdown.hidden = true;
    let input = null;
    let sendBtn = null;
    let grid = null;

    if (mode === 'send') {
      input = el('textarea', 'sl-input');
      input.rows = 3;
      input.placeholder = placeholder();
      input.spellcheck = true;
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendText();
        }
      });
      compose.appendChild(input);
      sendBtn = el('button', 'sl-sendbtn', 'Send');
      sendBtn.type = 'button';
      sendBtn.addEventListener('click', sendText);
      foot.append(msg, countdown, sendBtn);
    } else {
      grid = el('div', 'sl-grid');
      compose.appendChild(grid);
      foot.append(msg, countdown);
    }
    compose.appendChild(foot);
    composeEls = { line, msg, countdown, input, sendBtn, grid };
  }

  async function showCompose() {
    buildCompose();
    gate.hidden = true;
    compose.hidden = false;
    lockBtn.style.display = '';
    moduleApi.setStatus(statusState(), `${statusMessage()} · unlocked`);
    if (mode === 'quick') await loadPresets();
    else composeEls.input?.focus();
    tickLock();
  }

  function flash(text) {
    if (!composeEls) return;
    composeEls.msg.textContent = text;
    composeEls.msg.className = 'sl-msg is-flash';
    clearTimeout(flash.timer);
    flash.timer = setTimeout(() => {
      if (composeEls && composeEls.msg.textContent === text) {
        composeEls.msg.textContent = '';
        composeEls.msg.className = 'sl-msg';
      }
    }, 1800);
  }

  function showError(text) {
    if (!composeEls) return;
    clearTimeout(flash.timer);
    composeEls.msg.textContent = text;
    composeEls.msg.className = 'sl-msg is-error';
  }

  async function sendText() {
    if (busy || !composeEls?.input) return;
    const text = composeEls.input.value.trim();
    if (!text) return;
    const channel = targetId();
    if (!channel) return void showError(NO_CHANNEL);
    busy = true;
    composeEls.sendBtn.disabled = true;
    try {
      const res = await moduleApi.fetch('/send', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text, channel }),
      });
      const body = await readJson(res);
      if (res.status === 401) return void lock(body.error || 'Locked — enter the PIN', true);
      if (!res.ok) return void showError(body.error || `Send failed (HTTP ${res.status})`);
      composeEls.input.value = '';
      if (body.expiresAt) expiresAt = Number(body.expiresAt);
      flash(`Sent to ${body.channel || targetName()} ✓`);
    } catch {
      showError('ProdDash unreachable — not sent');
    } finally {
      busy = false;
      if (composeEls?.sendBtn) {
        composeEls.sendBtn.disabled = false;
        composeEls.input?.focus();
      }
    }
  }

  async function loadPresets() {
    if (!composeEls?.grid) return;
    composeEls.grid.textContent = '';
    composeEls.grid.appendChild(el('div', 'sl-note', 'Loading…'));
    try {
      const res = await moduleApi.fetch('/quick', { headers: authHeaders() });
      const body = await readJson(res);
      if (res.status === 401) return void lock(body.error || 'Locked — enter the PIN', true);
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      presets = Array.isArray(body.presets) ? body.presets : [];
      if (body.expiresAt) expiresAt = Number(body.expiresAt);
      renderPresets();
    } catch (err) {
      composeEls.grid.textContent = '';
      const note = el('div', 'sl-note is-error', `Could not load quick replies — ${err.message}`);
      composeEls.grid.appendChild(note);
    }
  }

  function renderPresets() {
    if (!composeEls?.grid) return;
    const grid = composeEls.grid;
    grid.textContent = '';
    if (!presets.length) {
      grid.appendChild(el('div', 'sl-note', 'No quick replies yet — add some in Admin → Slack → Sending'));
      return;
    }
    for (const p of presets) {
      const b = el('button', 'sl-quick');
      b.type = 'button';
      b.appendChild(el('span', 'sl-quick-label', p.label));
      // A preset bound to its own channel says so — it ignores the selection.
      if (p.channel) b.appendChild(el('span', 'sl-quick-chan', `→ ${p.channel}`));
      b.addEventListener('click', () => sendQuick(p.index, b));
      grid.appendChild(b);
    }
  }

  async function sendQuick(index, btn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const channel = targetId();
      const res = await moduleApi.fetch('/quick', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(channel ? { index, channel } : { index }),
      });
      const body = await readJson(res);
      if (res.status === 401) return void lock(body.error || 'Locked — enter the PIN', true);
      if (!res.ok) return void showError(body.error || `Send failed (HTTP ${res.status})`);
      if (body.expiresAt) expiresAt = Number(body.expiresAt);
      if (composeEls) {
        composeEls.msg.textContent = '';
        composeEls.msg.className = 'sl-msg';
      }
      btn.classList.remove('is-busy');
      btn.classList.add('is-sent');
      const label = btn.querySelector('.sl-quick-label');
      const original = label.textContent;
      label.textContent = 'Sent ✓';
      flash(`Sent to ${body.channel || targetName()} ✓`);
      setTimeout(() => {
        if (!btn.isConnected) return;
        label.textContent = original;
        btn.classList.remove('is-sent');
      }, 1000);
    } catch {
      showError('ProdDash unreachable — not sent');
    } finally {
      busy = false;
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }

  /* ── locking ── */
  function lock(note, fromServer = false) {
    const had = token;
    token = '';
    expiresAt = 0;
    pinBuf = '';
    presets = null;
    composeEls = null;
    compose.textContent = '';
    if (had && !fromServer) {
      moduleApi.fetch('/lock', { method: 'POST', headers: { Authorization: `Bearer ${had}` } }).catch(() => {});
    }
    gateNote = note || '';
    gateError = '';
    gateKind = ''; // rebuild the pad fresh
    padEls = null;
    renderGate();
    moduleApi.setStatus(statusState(), `${statusMessage()} · locked`);
  }

  function tickLock() {
    if (!token) return;
    const left = expiresAt - Date.now();
    if (left <= 0) return void lock('Locked after inactivity');
    if (composeEls) {
      const cd = composeEls.countdown;
      if (left < 60000) {
        const s = Math.ceil(left / 1000);
        cd.textContent = `Locks in 0:${String(s).padStart(2, '0')}`;
        cd.hidden = false;
      } else cd.hidden = true;
    }
  }

  /* ── server state ── */
  function statusState() {
    const st = state?.status?.state;
    return st === 'ok' || st === 'connecting' || st === 'error' ? st : 'connecting';
  }
  function statusMessage() {
    if (state?.status?.state === 'ok') return sendingLine();
    return state?.status?.message || 'Connecting to Slack…';
  }

  function applyState(s) {
    if (stopped || !s || typeof s !== 'object') return;
    state = s;
    moduleApi.setStatus(statusState(), `${statusMessage()} · ${token ? 'unlocked' : 'locked'}`);
    if (token) {
      // Sending switched off or the PIN removed while unlocked: the server
      // will refuse the next send; say so now instead of on failure.
      if (!s.sending?.enabled || !s.sending?.pinSet) return void lock('');
      if (composeEls) {
        composeEls.line.textContent = sendingLine();
        if (composeEls.input) composeEls.input.placeholder = placeholder();
      }
    } else renderGate();
  }

  async function loadState() {
    try {
      const res = await moduleApi.fetch('/state');
      if (!res.ok) throw new Error(String(res.status));
      applyState(await res.json());
    } catch { /* the stream paints */ }
  }

  function connect() {
    stream = moduleApi.sse('/stream', {
      open() { loadState(); },
      error() {
        moduleApi.setStatus('error', 'ProdDash Slack module unreachable — reconnecting…');
      },
      events: {
        state(e) {
          try {
            applyState(JSON.parse(e.data));
          } catch { /* skip a bad frame */ }
        },
      },
    });
  }

  return {
    start() {
      moduleApi.setStatus('connecting', 'Connecting to Slack…');
      renderGate();
      connect();
      ticker = setInterval(tickLock, 1000);
    },
    stop() {
      stopped = true;
      clearInterval(ticker);
      clearTimeout(flash.timer);
      clearTimeout(targetTimer);
      offTarget();
      stream?.close();
      token = ''; // the unlock dies with the tile
      root.innerHTML = '';
    },
  };
}
