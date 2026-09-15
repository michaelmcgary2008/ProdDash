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

/* Standard :codes: arrive as their characters (the server swaps them); a
   custom emoji's :code: is still text here and becomes its image once the
   workspace's set is known. */
const CUSTOM_CODE_RE = /:([a-z0-9_+-]{1,100}):/gi;
function appendText(container, str) {
  if (!str) return;
  if (!emojiStore.ready() || !str.includes(':')) return void container.appendChild(document.createTextNode(str));
  let last = 0;
  for (const m of str.matchAll(CUSTOM_CODE_RE)) {
    if (!emojiStore.isCustom(m[1])) continue;
    if (m.index > last) container.appendChild(document.createTextNode(str.slice(last, m.index)));
    container.appendChild(emojiStore.node(m[1]));
    last = m.index + m[0].length;
  }
  if (last < str.length) container.appendChild(document.createTextNode(str.slice(last)));
}

function renderRich(container, text, depth = 0) {
  container.textContent = '';
  const s = String(text || '');
  let last = 0;
  if (depth < 3) {
    for (const m of s.matchAll(MARK_RE)) {
      if (m.index > last) appendText(container, s.slice(last, m.index));
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
  if (last < s.length) appendText(container, s.slice(last));
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

/* ── this module's API path, for <img src> (moduleApi.fetch covers the rest) ── */
const API_BASE = '/api/modules/slack';
const apiUrl = (path) => `${API_BASE}${path}`;

/* ── emoji: the shipped table plus the workspace's custom set, once per page ── */
const emojiStore = (() => {
  const bus = new EventTarget();
  let data = null;    // { standard: { code: char }, custom: { name: { url } | { char } }, version }
  let version = -1;
  let loading = null;
  let reverse = null; // char (variation selector stripped) → code
  const strip = (str) => String(str || '').replace(/️/g, '');
  const split = (code) => {
    const m = /^(.+?)(?:::(skin-tone-[2-6]))?$/.exec(String(code || '').replace(/^:|:$/g, ''));
    return m ? { base: m[1], tone: m[2] || '' } : { base: '', tone: '' };
  };
  function load(moduleApi) {
    if (!loading) {
      loading = moduleApi.fetch('/emoji')
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const body = await res.json();
          data = { standard: body.standard || {}, custom: body.custom || {}, version: Number(body.version) || 0 };
          version = data.version;
          reverse = null;
          bus.dispatchEvent(new Event('change'));
        })
        .catch(() => { /* the next state frame asks again */ })
        .finally(() => { loading = null; });
    }
    return loading;
  }
  return {
    ready: () => Boolean(data),
    on(fn) {
      bus.addEventListener('change', fn);
      return () => bus.removeEventListener('change', fn);
    },
    /** With every state frame: fetch the table the first time, again when the custom set changed. */
    sync(moduleApi, v) {
      if (!data || (v !== undefined && Number(v) !== version)) load(moduleApi);
    },
    isCustom: (code) => Boolean(data?.custom?.[split(code).base]),
    /** The character for a code — '' for a custom image or an unknown code. */
    charOf(code) {
      if (!data) return '';
      const { base, tone } = split(code);
      const ch = data.standard[base] || data.custom[base]?.char || '';
      if (!ch) return '';
      const t = tone ? data.standard[tone] || '' : '';
      return t ? strip(ch) + t : ch;
    },
    imageOf(code) {
      return data?.custom?.[split(code).base]?.url || '';
    },
    /** The code Slack knows a character by ('' if none) — a reaction needs the code. */
    nameOf(char) {
      if (!data) return '';
      if (!reverse) {
        reverse = new Map();
        for (const [code, ch] of Object.entries(data.standard)) {
          if (code.startsWith('skin-tone-')) continue;
          const key = strip(ch);
          if (!reverse.has(key)) reverse.set(key, code);
        }
      }
      const str = strip(char);
      const tone = /[\u{1F3FB}-\u{1F3FF}]$/u.exec(str);
      if (tone) {
        const base = reverse.get(str.slice(0, -tone[0].length));
        const toneCode = Object.keys(data.standard).find((c) => c.startsWith('skin-tone-') && data.standard[c] === tone[0]);
        return base && toneCode ? `${base}::${toneCode}` : '';
      }
      return reverse.get(str) || '';
    },
    /** A node drawing :code: — the character, or the custom image. */
    node(code) {
      const img = this.imageOf(code);
      if (img) {
        const i = el('img', 'sl-emoji');
        i.src = img;
        i.alt = `:${code}:`;
        i.title = `:${code}:`;
        i.loading = 'lazy';
        i.draggable = false;
        return i;
      }
      const span = el('span', 'sl-emoji-char', this.charOf(code) || `:${code}:`);
      span.title = `:${code}:`;
      return span;
    },
    /** Codes matching a search: custom ones first, names that start with it before the rest. */
    search(q, limit = 40) {
      const str = String(q || '').trim().toLowerCase().replace(/^:|:$/g, '').replace(/\s+/g, '_');
      if (!data || !str) return [];
      const out = [];
      const seen = new Set();
      const add = (code) => {
        if (!seen.has(code) && out.length < limit) {
          seen.add(code);
          out.push(code);
        }
      };
      const customs = Object.keys(data.custom);
      const standard = Object.keys(data.standard).filter((c) => !c.startsWith('skin-tone-'));
      for (const c of customs) if (c.startsWith(str)) add(c);
      for (const c of standard) if (c.startsWith(str)) add(c);
      for (const c of customs) if (c.includes(str)) add(c);
      for (const c of standard) if (c.includes(str)) add(c);
      return out;
    },
  };
})();

/* ── the unlock: one PIN entry serves every Slack tile on this page ── */
/* The same kind of thing as sendTarget — a fact about the whole page, not
   one tile: the operator has entered the PIN. It holds the server's unlock
   token in memory only (a reload asks again) so that unlocking Send message
   also unlocks Quick replies and lets a transcript react. */
const unlockStore = (() => {
  const bus = new EventTarget();
  let token = '';
  let expiresAt = 0;
  let reason = '';
  return {
    get() {
      return token && expiresAt > Date.now() ? token : '';
    },
    expiresAt: () => expiresAt,
    reason: () => reason,
    set(t, exp) {
      token = String(t || '');
      expiresAt = Number(exp) || 0;
      reason = '';
      bus.dispatchEvent(new Event('change'));
    },
    /** A send or reaction slid the server's expiry along. */
    touch(exp) {
      if (token && Number(exp) > 0) expiresAt = Number(exp);
    },
    clear(why = '') {
      if (!token) return;
      token = '';
      expiresAt = 0;
      reason = why;
      bus.dispatchEvent(new Event('change'));
    },
    on(fn) {
      bus.addEventListener('change', fn);
      return () => bus.removeEventListener('change', fn);
    },
  };
})();

/**
 * The PIN pad: 1–9, 0 and ⌫ under a row of dots, one per digit of the PIN.
 * It submits by itself once as many digits as the PIN has are in (the
 * server says how many, never which), or at eight. On success the page-wide
 * unlock is set and `onUnlocked` runs.
 */
function createPinPad({ moduleApi, heading = 'Enter PIN', subtitle, pinLength, onUnlocked }) {
  let pinBuf = '';
  let busy = false;
  let error = '';
  let note = '';
  const pad = el('div', 'sl-pad');
  const head = el('div', 'sl-pad-head');
  const sub = el('span', 'sl-pad-sub');
  head.append(el('b', '', heading), sub);
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
    });
    return b;
  };
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) keys.appendChild(key(d, '', () => press(d)));
  keys.appendChild(el('span', 'sl-key sl-key-blank'));
  keys.appendChild(key('0', '', () => press('0')));
  const back = key('⌫', 'sl-key-back', backspace, BACK_SVG);
  back.title = 'Backspace';
  keys.appendChild(back);
  const msg = el('div', 'sl-pad-msg');
  // Shown instead of the keys when the tile is too short for them (style.css).
  const hint = el('div', 'sl-pad-hint', 'Type the PIN, or make the tile taller for a keypad.');
  pad.append(head, dots, keys, hint, msg);

  const wanted = () => Math.min(8, Math.max(0, Math.trunc(Number(pinLength?.()) || 0)));

  function refresh() {
    const text = subtitle ? String(subtitle() || '') : '';
    sub.textContent = text ? ` · ${text}` : '';
    const n = Math.min(8, pinBuf.length);
    // One dot per digit of the PIN; while its length is unknown, 4 and one spare.
    const slots = wanted() || Math.max(4, n + (n < 8 ? 1 : 0));
    [...dots.children].forEach((d, i) => {
      d.classList.toggle('on', i < n);
      d.hidden = i >= slots;
    });
    pad.classList.toggle('is-busy', busy);
    msg.textContent = error || note;
    msg.classList.toggle('is-error', Boolean(error));
  }

  function press(d) {
    if (busy || pinBuf.length >= 8) return;
    pinBuf += d;
    error = '';
    refresh();
    const len = wanted();
    if ((len && pinBuf.length >= len) || pinBuf.length === 8) submit();
  }

  function backspace() {
    if (busy) return;
    pinBuf = pinBuf.slice(0, -1);
    error = '';
    refresh();
  }

  function shake(message) {
    error = message;
    note = '';
    pinBuf = '';
    refresh();
    pad.classList.remove('sl-shake');
    void pad.offsetWidth; // restart the animation
    pad.classList.add('sl-shake');
  }

  async function submit() {
    if (busy || pinBuf.length < 4) return;
    busy = true;
    refresh();
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
      pinBuf = '';
      error = '';
      note = '';
      unlockStore.set(body.token, Number(body.expiresAt) || Date.now() + 10 * 60000);
      onUnlocked?.(body);
    } catch {
      shake('ProdDash unreachable — try again');
    } finally {
      busy = false;
      refresh();
    }
  }

  /** Keyboard: digits, Backspace, Enter (submit early), Escape (clear). True when handled. */
  function onKey(e) {
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') backspace();
    else if (e.key === 'Enter') submit();
    else if (e.key === 'Escape') {
      pinBuf = '';
      error = '';
      refresh();
    } else return false;
    e.preventDefault();
    return true;
  }

  refresh();
  return {
    el: pad,
    refresh,
    onKey,
    setNote(text) {
      note = String(text || '');
      error = '';
      refresh();
    },
  };
}

/* ── the reaction menu: right-click a message, pick an emoji ── */
/* One for the page, on document.body so a tile's overflow can't clip it;
   `data-module="slack"` keeps the module's scoped styles applying to it. */
const emojiMenu = (() => {
  let menu = null;
  let ctx = null;
  let cleanup = null;

  function close() {
    if (!menu) return;
    cleanup?.();
    cleanup = null;
    menu.remove();
    menu = null;
    ctx = null;
  }

  function place(x, y) {
    const r = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function anchor() {
    return { x: parseFloat(menu.style.left) || 8, y: parseFloat(menu.style.top) || 8 };
  }

  /** Add (or remove) :code: on the message; resolves to '' or an error sentence. */
  async function perform(code, remove) {
    const { moduleApi, channel, ts } = ctx;
    const token = unlockStore.get();
    if (!token) return 'locked';
    try {
      const res = await moduleApi.fetch('/react', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, ts, name: code, remove: Boolean(remove) }),
      });
      const body = await readJson(res);
      if (res.status === 401) {
        unlockStore.clear(body.error || 'Locked — enter the PIN');
        return 'locked';
      }
      if (!res.ok) return body.error || `Could not react (HTTP ${res.status})`;
      unlockStore.touch(body.expiresAt);
      return '';
    } catch {
      return 'ProdDash unreachable — try again';
    }
  }

  async function pick(code, remove) {
    if (!menu || !ctx) return;
    menu.classList.add('is-busy');
    const err = await perform(code, remove);
    if (!menu) return;
    menu.classList.remove('is-busy');
    if (!err) return void close();
    if (err === 'locked') return void render();
    render(err);
  }

  function button(code) {
    const b = el('button', 'sl-emoji-btn');
    b.type = 'button';
    b.title = `:${code}:`;
    b.appendChild(emojiStore.node(code));
    b.addEventListener('click', () => pick(code, false));
    return b;
  }

  function render(error = '') {
    if (!menu || !ctx) return;
    const { x, y } = anchor();
    menu.textContent = '';
    menu.hidden = false;
    if (!unlockStore.get()) {
      // Locked: the PIN first. A pending toggle (a click on a reaction pill)
      // is carried out the moment the PIN is in.
      const pad = createPinPad({
        moduleApi: ctx.moduleApi,
        heading: 'Enter PIN to react',
        subtitle: () => (ctx?.sendingAs ? `as ${ctx.sendingAs}` : ''),
        pinLength: () => ctx?.pinLength || 0,
        onUnlocked() {
          if (!ctx) return;
          if (ctx.pending) {
            const { code, remove } = ctx.pending;
            ctx.pending = null;
            pick(code, remove);
          } else render();
        },
      });
      if (unlockStore.reason()) pad.setNote(unlockStore.reason());
      menu.appendChild(pad.el);
      menu.onkeydown = (e) => pad.onKey(e);
      menu.focus({ preventScroll: true });
      place(x, y);
      return;
    }
    menu.onkeydown = null;
    if (ctx.pending) {
      // Unlocked and asked for one toggle: do it without showing a picker.
      const { code, remove } = ctx.pending;
      ctx.pending = null;
      menu.hidden = true;
      pick(code, remove);
      return;
    }
    const head = el('div', 'sl-emoji-head', ctx.sendingAs ? `React as ${ctx.sendingAs}` : 'React');
    const quick = el('div', 'sl-emoji-quickrow');
    for (const q of Array.isArray(ctx.quick) ? ctx.quick : []) {
      const code = q.name || emojiStore.nameOf(q.char);
      if (code) quick.appendChild(button(code));
    }
    const search = el('input', 'sl-emoji-search');
    search.type = 'search';
    search.placeholder = 'Search all emoji…';
    search.autocomplete = 'off';
    search.spellcheck = false;
    const results = el('div', 'sl-emoji-results');
    const paint = () => {
      results.textContent = '';
      const q = search.value.trim();
      const list = q ? emojiStore.search(q, 40) : [];
      if (!list.length) {
        results.appendChild(el('div', 'sl-emoji-none', q ? 'Nothing by that name' : 'Type to search — names as in Slack'));
        return;
      }
      for (const code of list) results.appendChild(button(code));
    };
    search.addEventListener('input', paint);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        results.querySelector('.sl-emoji-btn')?.click();
      }
    });
    const msg = el('div', 'sl-emoji-msg' + (error ? ' is-error' : ''), error);
    menu.append(head, quick, search, results, msg);
    paint();
    place(x, y);
    search.focus({ preventScroll: true });
  }

  return {
    /**
     * Open at (x, y) for message `ts` in `channel`. `quick` is the admin's
     * quick emoji list; `pending` { code, remove } performs that one toggle
     * (a click on a reaction pill) instead of showing the picker.
     */
    open({ moduleApi, x, y, channel, ts, quick, sendingAs, pinLength, pending = null }) {
      close();
      ctx = { moduleApi, channel, ts, quick, sendingAs, pinLength, pending };
      menu = el('div', 'sl-emoji-menu');
      menu.dataset.module = 'slack';
      menu.tabIndex = -1;
      menu.setAttribute('role', 'dialog');
      menu.setAttribute('aria-label', 'React with an emoji');
      menu.style.left = `${Math.round(x)}px`;
      menu.style.top = `${Math.round(y)}px`;
      document.body.appendChild(menu);
      render();
      const onDown = (e) => { if (menu && !menu.contains(e.target)) close(); };
      const onKey = (e) => {
        if (e.key === 'Escape' && menu) {
          e.stopPropagation();
          close();
        }
      };
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('resize', close);
      cleanup = () => {
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', close);
      };
    },
    close,
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
    wrap.classList.toggle('hide-avatars', s.showAvatars === false);
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
  // Custom emoji images and reaction glyphs need the table: redraw once it is here (or changes).
  const offEmoji = emojiStore.on(() => {
    if (stopped) return;
    for (const e of entries.values()) e.sig = '';
    if (lastState) applyState(lastState);
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

  /* entries — laid out like the ProdCom transcript: a square picture on the
     left, then the name line with its time, the text, the reactions */
  const messagesByTs = new Map(); // ts → message (replies too), for the reaction menu

  function hueOf(name) {
    let h = 0;
    for (const c of String(name || '')) h = (h * 31 + c.codePointAt(0)) % 360;
    return h;
  }

  function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    const first = [...parts[0]][0] || '';
    const last = parts.length > 1 ? [...parts[parts.length - 1]][0] || '' : '';
    return (first + last).toUpperCase();
  }

  function buildAvatar(m) {
    const av = el('span', 'sl-avatar');
    av.style.setProperty('--sl-hue', String(hueOf(m.name)));
    if (m.avatarEmoji) {
      av.appendChild(el('span', 'sl-avatar-emoji', m.avatarEmoji));
      return av;
    }
    const initials = () => {
      av.textContent = '';
      av.appendChild(el('span', 'sl-avatar-initials', initialsOf(m.name)));
    };
    if (m.avatar) {
      const img = el('img', 'sl-avatar-img');
      img.alt = '';
      img.loading = 'lazy';
      img.draggable = false;
      img.addEventListener('error', initials, { once: true });
      img.src = apiUrl(`/avatar/${m.avatar}`);
      av.appendChild(img);
    } else initials();
    return av;
  }

  function buildMeta(m) {
    const meta = el('div', 'sl-meta');
    meta.append(el('span', 'sl-name', m.name || ''), el('span', 'sl-time', fmtTime(m.time)));
    return meta;
  }

  function buildReactions(m) {
    const row = el('div', 'sl-reactions');
    for (const r of m.reactions) {
      const pill = el('button', 'sl-reaction' + (r.me ? ' is-me' : ''));
      pill.type = 'button';
      pill.title = `:${r.name}: — ${r.me ? 'you reacted; click to take it back' : 'click to react too'}`;
      pill.append(emojiStore.node(r.name), el('span', 'sl-reaction-count', String(r.count)));
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = pill.getBoundingClientRect();
        openReactionMenu(m, rect.left, rect.bottom + 4, { code: r.name, remove: Boolean(r.me) });
      });
      row.appendChild(pill);
    }
    return row;
  }

  /** A message or a thread reply as one row; returns the row and its body (replies nest in the body). */
  function buildLine(m, reply = false) {
    const line = el('div', reply ? 'sl-reply' : 'sl-row');
    line.dataset.ts = m.ts;
    line.classList.toggle('sl-me', Boolean(m.me));
    line.classList.toggle('sl-bot', Boolean(m.bot));
    const body = el('div', 'sl-body');
    body.appendChild(buildMeta(m));
    const text = el('div', 'sl-text');
    renderRich(text, m.text);
    if (m.edited) text.appendChild(el('span', 'sl-edited', ' (edited)'));
    body.appendChild(text);
    if (Array.isArray(m.reactions) && m.reactions.length) body.appendChild(buildReactions(m));
    line.append(buildAvatar(m), body);
    return { line, body };
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
    const { line, body } = buildLine(m);
    node.appendChild(line);
    if (Array.isArray(m.replies)) {
      if (m.replies.length) {
        const list = el('div', 'sl-replies');
        for (const r of m.replies) list.appendChild(buildLine(r, true).line);
        body.appendChild(list);
      }
    } else if (m.replyCount > 0) {
      body.appendChild(el('div', 'sl-replycount', `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`));
    }
  }

  /* reactions: a right-click on a row, or a click on a pill, opens the menu */
  function openReactionMenu(m, x, y, pending = null) {
    if (!channelId || !lastState?.channels?.[channelId]) return;
    emojiMenu.open({
      moduleApi,
      x,
      y,
      channel: channelId,
      ts: m.ts,
      quick: lastState.quickEmojis || [],
      sendingAs: lastState.sendingAs || '',
      pinLength: Number(lastState.pinLength) || 0,
      pending,
    });
  }
  entriesEl.addEventListener('contextmenu', (e) => {
    const line = e.target.closest('.sl-row, .sl-reply');
    if (!line || !entriesEl.contains(line)) return;
    const m = messagesByTs.get(line.dataset.ts);
    if (!m) return;
    e.preventDefault();
    openReactionMenu(m, e.clientX, e.clientY);
  });

  function renderMessages(list) {
    const seen = new Set();
    let prev = null;
    let added = 0;
    messagesByTs.clear();
    for (const m of list) {
      if (!m || !m.ts) continue;
      seen.add(m.ts);
      messagesByTs.set(m.ts, m);
      if (Array.isArray(m.replies)) for (const r of m.replies) if (r?.ts) messagesByTs.set(r.ts, r);
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
    emojiStore.sync(moduleApi, s.emojiVersion);
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
      offEmoji();
      emojiMenu.close();
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
  let token = unlockStore.get(); // the page's unlock (unlockStore) — memory only, gone on reload
  let state = null;        // latest snapshot: sending flags, identity, channels, status
  let stream = null;
  let ticker = null;
  let stopped = false;
  let busy = false;
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
  // Another Slack tile (or the reaction menu) unlocked or locked the page.
  const offUnlock = unlockStore.on(() => {
    if (stopped) return;
    const t = unlockStore.get();
    if (t && t !== token) {
      token = t;
      gateNote = '';
      gateError = '';
      showCompose();
    } else if (!t && token) lock(unlockStore.reason() || 'Locked', true);
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
      if (kind === 'pad') {
        pinPad = createPinPad({
          moduleApi,
          subtitle: () => sendingLine().replace(/^Sending/, 'sending'),
          pinLength: () => Number(state?.pinLength) || 0,
          onUnlocked() {
            token = unlockStore.get();
            gateNote = '';
            gateError = '';
            showCompose();
          },
        });
        gate.appendChild(pinPad.el);
      } else {
        const note = el('div', 'sl-note');
        note.textContent = kind === 'connecting' ? 'Connecting to ProdDash…'
          : kind === 'off' ? 'Sending is off — turn it on in Admin → Slack → Sending'
            : kind === 'nopin' ? 'Set a PIN in Admin → Slack → Sending'
              : NO_CHANNEL;
        gate.appendChild(note);
      }
    }
    if (kind === 'pad' && pinPad) {
      pinPad.setNote(gateError || gateNote);
      pinPad.refresh();
    }
  }

  let pinPad = null;
  wrap.addEventListener('keydown', (e) => {
    if (!gate.hidden && gateKind === 'pad' && pinPad) pinPad.onKey(e);
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
      // The admin's quick emojis: one press sends one, no confirmation.
      const quick = el('div', 'sl-emoji-sendrow');
      for (const q of Array.isArray(state?.quickEmojis) ? state.quickEmojis : []) {
        const label = q.char || `:${q.name}:`;
        const b = el('button', 'sl-emoji-send');
        b.type = 'button';
        b.title = `Send ${label}`;
        b.setAttribute('aria-label', `Send ${label}`);
        b.appendChild(q.name && (!q.char || emojiStore.isCustom(q.name)) ? emojiStore.node(q.name) : el('span', 'sl-emoji-char', q.char));
        b.addEventListener('click', () => sendEmoji(q, b));
        quick.appendChild(b);
      }
      foot.append(msg, countdown, quick, sendBtn);
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

  /** POST one message to the selected channel; true when it landed. */
  async function postText(text, what) {
    const channel = targetId();
    if (!channel) {
      showError(NO_CHANNEL);
      return false;
    }
    try {
      const res = await moduleApi.fetch('/send', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ text, channel }),
      });
      const body = await readJson(res);
      if (res.status === 401) {
        lock(body.error || 'Locked — enter the PIN', true);
        return false;
      }
      if (!res.ok) {
        showError(body.error || `Send failed (HTTP ${res.status})`);
        return false;
      }
      unlockStore.touch(body.expiresAt);
      flash(`Sent ${what || ''}to ${body.channel || targetName()} ✓`);
      return true;
    } catch {
      showError('ProdDash unreachable — not sent');
      return false;
    }
  }

  async function sendText() {
    if (busy || !composeEls?.input) return;
    const text = composeEls.input.value.trim();
    if (!text) return;
    busy = true;
    composeEls.sendBtn.disabled = true;
    try {
      if (await postText(text)) composeEls.input.value = '';
    } finally {
      busy = false;
      if (composeEls?.sendBtn) {
        composeEls.sendBtn.disabled = false;
        composeEls.input?.focus();
      }
    }
  }

  /** A quick emoji: the character (or :code: for a custom one) as a message of its own. */
  async function sendEmoji(q, btn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const text = q.char || `:${q.name}:`;
      if (await postText(text, `${text} `)) {
        btn.classList.add('is-sent');
        setTimeout(() => btn.classList.remove('is-sent'), 900);
      }
    } finally {
      busy = false;
      btn.disabled = false;
      btn.classList.remove('is-busy');
      composeEls?.input?.focus();
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
      unlockStore.touch(body.expiresAt);
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
      unlockStore.touch(body.expiresAt);
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
    presets = null;
    composeEls = null;
    compose.textContent = '';
    if (had && !fromServer) {
      moduleApi.fetch('/lock', { method: 'POST', headers: { Authorization: `Bearer ${had}` } }).catch(() => {});
    }
    if (had) unlockStore.clear(note || 'Locked'); // every Slack tile on the page locks with this one
    gateNote = note || '';
    gateError = '';
    gateKind = ''; // rebuild the pad fresh
    pinPad = null;
    renderGate();
    moduleApi.setStatus(statusState(), `${statusMessage()} · locked`);
  }

  function tickLock() {
    if (!token) return;
    const left = unlockStore.expiresAt() - Date.now();
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
    emojiStore.sync(moduleApi, s.emojiVersion);
    moduleApi.setStatus(statusState(), `${statusMessage()} · ${token ? 'unlocked' : 'locked'}`);
    if (token) {
      // Sending switched off or the PIN removed while unlocked: the server
      // will refuse the next send; say so now instead of on failure.
      if (!s.sending?.enabled || !s.sending?.pinSet) return void lock('');
      if (!composeEls) return void showCompose(); // the page was unlocked before this tile appeared
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
      token = unlockStore.get();
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
      offUnlock();
      stream?.close();
      root.innerHTML = ''; // the page's unlock outlives a remount; a reload asks again
    },
  };
}
