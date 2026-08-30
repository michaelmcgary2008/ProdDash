'use strict';

/* ------------------------------------------------------------------ *
 * ProPresenter 7 / 20 integration core                                *
 *                                                                     *
 * Shared by two programs:                                             *
 *   1. the Band Lineup Electron app (main.js, via IPC to its renderer) *
 *   2. propresenter-app — the standalone Now/Next display for studios  *
 *                                                                     *
 * Everything here is plain Node: global fetch only, no Electron, no    *
 * npm dependencies. All ProPresenter HTTP lives in this module so no   *
 * browser ever has to deal with CORS or a CSP exception. We poll the   *
 * basic REST endpoints (works on every ProPresenter 7+ version) and    *
 * hand callers a small, stable view-model.                             *
 * ------------------------------------------------------------------ */

/** Default ProPresenter network API port (user-configurable in ProPresenter ▸ Preferences ▸ Network). */
const DEFAULT_PP_PORT = 1025;
/** How often to poll ProPresenter for playlist/slide changes while connected. */
const DEFAULT_POLL_MS = 600;
/** Slower retry cadence when ProPresenter is unreachable. */
const DEFAULT_RETRY_MS = 2500;

/** Normalize a stored/entered connection config into the shape the client expects. */
function normalizeConfig(entry) {
  const host = String(entry?.host || '').trim();
  const portNum = Number.parseInt(String(entry?.port ?? ''), 10);
  const port = Number.isFinite(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 0;
  return {
    enabled: Boolean(entry?.enabled) && Boolean(host) && Boolean(port),
    host,
    port,
    playlistUuid: String(entry?.playlistUuid || ''),
    playlistName: String(entry?.playlistName || ''),
  };
}

/** The internal polling state, before it is projected into a view-model. */
function emptyPollState() {
  return {
    reachable: false,
    lastError: '',
    playlistUuid: '',
    playlistName: '',
    items: [],
    activeUuid: '',
    activeName: '',
    activeIndex: -1,
    currentSlide: 0,
    livePresentationUuid: '',
    livePresentationSlideTotal: 0,
    /** 'playlist' | 'group' | 'unknown' | 'none' — what ProPresenter pointed us at. */
    playlistKind: 'none',
    itemsRetryAt: 0,
    /** From /v1/status/layers: is the slide layer actually on screen right now? */
    slideLayerLive: false,
  };
}

/**
 * The "nothing connected" view-model. Consumers render this after a disconnect so
 * the display clears instead of freezing on the last live slide.
 */
function clearedViewModel() {
  return {
    enabled: false,
    reachable: false,
    lastError: '',
    needsPlaylist: false,
    playlistName: '',
    items: [],
    activeIndex: -1,
    activePresentationName: '',
    currentSlide: 0,
    currentSlideTotal: 0,
  };
}

/** Flatten the /v1/playlists tree (groups → playlists) into a flat list a picker can show. */
function flattenPlaylists(nodes, groupName, out) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const id = node?.id || {};
    const uuid = String(id.uuid || node?.uuid || '');
    const name = String(id.name || node?.name || '');
    const fieldType = String(node?.field_type || node?.type || '');
    if (fieldType === 'playlist' || (!fieldType && uuid && !Array.isArray(node?.children))) {
      if (uuid) out.push({ uuid, name, group: groupName });
    }
    if (Array.isArray(node?.children) && node.children.length) {
      flattenPlaylists(node.children, fieldType === 'group' ? name : groupName, out);
    }
  }
  return out;
}

/** Parse a /v1/playlist/{uuid} response into our item shape, tolerating ProPresenter version differences. */
function parsePlaylistItems(data) {
  const list = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.children)
      ? data.children
      : Array.isArray(data)
        ? data
        : [];
  return list.map((item) => {
    const id = item?.id || {};
    return {
      uuid: String(id.uuid || item?.uuid || ''),
      name: String(id.name || item?.name || ''),
      type: String(item?.type || item?.field_type || 'presentation'),
      isHidden: Boolean(item?.is_hidden ?? item?.isHidden),
      isPco: Boolean(item?.is_pco ?? item?.isPco),
      slideCount: null,
    };
  });
}

/** Depth-first search the /v1/playlists tree for a playlist by uuid; returns its index path + name. */
function findPlaylistPath(nodes, targetUuid, prefix) {
  if (!Array.isArray(nodes)) return null;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const id = node?.id || {};
    const uuid = String(id.uuid || node?.uuid || '');
    const idx = Number.isInteger(id.index) ? id.index : i;
    const here = [...prefix, idx];
    if (uuid && uuid === targetUuid) {
      return {
        path: here,
        name: String(id.name || node?.name || ''),
        fieldType: String(node?.field_type || node?.type || ''),
      };
    }
    const deeper = findPlaylistPath(node?.children, targetUuid, here);
    if (deeper) return deeper;
  }
  return null;
}

function countSlides(presentationData) {
  // PP20 wraps details under `presentation`; older shapes are flat.
  const presentation = presentationData?.presentation || presentationData;
  const groups = Array.isArray(presentation?.groups) ? presentation.groups : [];
  let count = 0;
  for (const group of groups) {
    const slides = Array.isArray(group?.slides) ? group.slides : [];
    // Count ALL slides including disabled — slide_index.index counts disabled slides too,
    // so the total must match that same sequence or "Slide X / Y" will be inconsistent.
    count += slides.length;
  }
  return count;
}

/**
 * Tidy an item name for display only (the raw name is kept for ProPresenter matching).
 * Strips arrangement/section tags in brackets ([ Full ], ( TAG ), { ... }), a leading date
 * code (e.g. "260607 "), separator dashes, and any leftover edge punctuation/whitespace so the
 * card reads as cleanly as possible — "260607 Taking Thoughts Captive - [ Full ]" → "Taking Thoughts Captive".
 *
 * Exported for Node-side consumers; the browser UIs keep their own copy of this pure
 * function because they load as plain scripts with no module loader.
 */
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

/**
 * Create a ProPresenter polling client.
 *
 * @param {object} [options]
 * @param {(view: object) => void} [options.onData] Called with a view-model on every poll tick.
 * @param {number} [options.pollMs] Poll cadence while reachable.
 * @param {number} [options.retryMs] Poll cadence while unreachable.
 */
function createProPresenterClient(options = {}) {
  const pollMs = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : DEFAULT_POLL_MS;
  const retryMs = Number.isFinite(options.retryMs) && options.retryMs > 0 ? options.retryMs : DEFAULT_RETRY_MS;
  let onData = typeof options.onData === 'function' ? options.onData : null;

  /** @type {{ enabled: boolean, host: string, port: number, password: string, playlistUuid: string, playlistName: string }} */
  let config = { enabled: false, host: '', port: 0, password: '', playlistUuid: '', playlistName: '' };
  let state = emptyPollState();
  let pollTimer = null;
  let stopped = true;
  /** Monotonic token so a superseded poll loop can detect it should bail. */
  let runToken = 0;
  /** uuid -> master (document) slide count. Counts are stable during a service, so fetch once and reuse. */
  const slideCountCache = new Map();
  /**
   * uuid -> arrangement-expanded cue count (the total that matches slide_index.index).
   * slide_index counts the SELECTED arrangement's expanded cue sequence (repeated groups count
   * multiple times), while /v1/presentation/{uuid} only returns the unique master groups — so the
   * two disagree whenever an arrangement repeats a section. We recover the true total by probing the
   * thumbnail endpoint, whose index "respects the selected arrangement" (same space as slide_index).
   */
  const arrangementCountCache = new Map();
  /** Cached URL that successfully returned the current playlist's item list (PP20 renamed this route). */
  let itemsSourceUrl = '';
  let itemsForUuid = '';
  /** Index path of the playlist we last proved contains the live presentation. */
  let provenPlaylistPath = '';
  /** Name of that proven playlist, so the header doesn't blank when the hint disagrees. */
  let provenPlaylistName = '';
  /** Last playlist uuid ProPresenter HINTED at, for change detection. */
  let lastHintUuid = '';
  /** Poll ticks since the last tree-wide search, so it cannot run every 600ms. */
  let searchCooldown = 0;
  /** Monotonic tick count, so the heavy calls run on a slow secondary cadence. */
  let tick = 0;
  /** True when the last slide_index came back null. */
  let lastIndexWasNull = false;

  function url(target) {
    const built = new URL(`http://${config.host}:${config.port}${target}`);
    if (config.password) built.searchParams.set('password', config.password);
    return built;
  }

  async function requestJson(target, init) {
    const response = await fetch(url(target), {
      headers: { Accept: 'application/json' },
      ...init,
    });
    if (!response.ok) {
      throw new Error(`ProPresenter ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function slideCount(uuid) {
    if (!uuid) return null;
    if (slideCountCache.has(uuid)) return slideCountCache.get(uuid);
    try {
      const data = await requestJson(`/v1/presentation/${encodeURIComponent(uuid)}`);
      const count = countSlides(data);
      slideCountCache.set(uuid, count);
      return count;
    } catch {
      return null;
    }
  }

  /**
   * Probe the thumbnail endpoint to find how many cues the SELECTED arrangement actually plays.
   * The thumbnail index "respects the selected arrangement of cues" — the exact same index space
   * slide_index reports — and returns 404 once the index runs past the end. So the count of cues is
   * the smallest index that 404s. We only read the HTTP status (the JPEG body is cancelled), and do
   * an exponential-then-binary search so the whole probe is ~2·log2(N) tiny requests.
   * Returns the cue count, or null if the presentation can't be probed (auth error / unexpected status).
   */
  async function probeArrangementLength(uuid) {
    const CAP = 4000; // guard against a build that clamps instead of 404-ing — fall back rather than loop
    const exists = async (index) => {
      try {
        const res = await fetch(url(`/v1/presentation/${encodeURIComponent(uuid)}/thumbnail/${index}`), {
          headers: { Accept: 'image/jpeg' },
        });
        try { await res.body?.cancel?.(); } catch { /* body already consumed/closed */ }
        if (res.status === 200) return true;
        if (res.status === 404) return false;
        return null; // 403 or anything unexpected → can't trust the probe
      } catch {
        return null;
      }
    };

    const first = await exists(0);
    if (first === null) return null;
    if (first === false) return 0;

    // Exponential search for an index that is past the end (404).
    let lo = 0; // known valid
    let hi = 1; // candidate; grows until invalid
    while (true) {
      const r = await exists(hi);
      if (r === null) return null;
      if (r === false) break;
      lo = hi;
      hi *= 2;
      if (hi > CAP) return null;
    }
    // Binary search the boundary: lo valid, hi invalid.
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await exists(mid);
      if (r === null) return null;
      if (r) lo = mid; else hi = mid;
    }
    return lo + 1; // cue indices are 0-based, so the count is the last valid index + 1
  }

  /**
   * The slide TOTAL for the live presentation, in the same index space as slide_index.currentSlide.
   * Prefers the arrangement-expanded count (cached per uuid); falls back to the master slide count if
   * the thumbnail probe is unavailable. Always returns a value >= the live slide so "Slide X / Y" can
   * never show X > Y (a stale arrangement is re-probed when the live index outruns the cached total).
   */
  /** Pull the arrangement tag out of a playlist item name: "AMAZING! - [ Full ]" -> "full". */
  function arrangementTagFromName(name) {
    const m = String(name || '').match(/[[({]\s*([^\])}]+?)\s*[\])}]/);
    return m ? m[1].trim().toLowerCase() : '';
  }

  /**
   * The true slide total, in the SAME index space as slide_index — computed from the
   * presentation's arrangement structure rather than guessed.
   *
   * ProPresenter reports \`groups\` (each with slides), \`arrangements\` (each a flat ordered
   * list of group UUIDs, which REPEAT sections like choruses), and \`current_arrangement\`.
   * slide_index counts the selected arrangement's expanded sequence, so the correct total is
   * the sum of slide counts over that arrangement's group list. The old thumbnail probe
   * returned the MASTER count on this build (49 vs the real 64 for a [Full] arrangement),
   * which made the live slide overshoot the total and the counter read "63/63, 64/64…".
   *
   * @param arrangementHint arrangement name from the playlist item, used when
   *        current_arrangement is blank (this PP build often leaves it blank).
   */
  async function computePresentationTotal(uuid, arrangementHint) {
    let data;
    try {
      data = await requestJson(`/v1/presentation/${encodeURIComponent(uuid)}`);
    } catch {
      return null;
    }
    const pres = data?.presentation || data;
    const groups = Array.isArray(pres?.groups) ? pres.groups : [];
    const groupSlides = new Map();
    let master = 0;
    for (const g of groups) {
      const n = Array.isArray(g?.slides) ? g.slides.length : 0;
      master += n;
      const gu = String(g?.uuid || g?.id?.uuid || '');
      if (gu) groupSlides.set(gu, n);
    }
    const arrangements = Array.isArray(pres?.arrangements) ? pres.arrangements : [];
    if (!arrangements.length) return master || null;

    const currentUuid = String(pres?.current_arrangement || '');
    let chosen = currentUuid
      ? arrangements.find((a) => String(a?.id?.uuid || '') === currentUuid)
      : null;
    // current_arrangement is frequently blank on PP20 — fall back to the item's "[ tag ]".
    if (!chosen && arrangementHint) {
      chosen = arrangements.find((a) => String(a?.id?.name || '').trim().toLowerCase() === arrangementHint);
    }
    if (!chosen && arrangements.length === 1) chosen = arrangements[0];
    if (!chosen) return master || null;

    const refs = Array.isArray(chosen.groups) ? chosen.groups : [];
    let total = 0;
    for (const ref of refs) {
      const gu = typeof ref === 'string' ? ref : String(ref?.uuid || ref?.id?.uuid || '');
      total += groupSlides.get(gu) || 0;
    }
    return total > 0 ? total : (master || null);
  }

  async function liveSlideTotal(uuid, currentSlide, arrangementHint) {
    if (!uuid) return 0;
    if (!arrangementCountCache.has(uuid)) {
      const computed = await computePresentationTotal(uuid, arrangementHint);
      if (computed && computed > 0) {
        arrangementCountCache.set(uuid, computed);
      } else {
        // Last resort only if the structure was unreadable: the old probe, then master.
        const probed = await probeArrangementLength(uuid);
        const master = await slideCount(uuid);
        arrangementCountCache.set(uuid, (probed && probed > 0) ? probed : (master || 0));
      }
    }
    const total = arrangementCountCache.get(uuid);
    // If the live slide somehow exceeds the computed total, re-derive ONCE (an arrangement
    // switch mid-song). Never poison the cache by setting total = currentSlide — that is
    // exactly what produced the ever-climbing "X / X".
    if (currentSlide > total) {
      const recomputed = await computePresentationTotal(uuid, arrangementHint);
      if (recomputed && recomputed >= currentSlide) {
        arrangementCountCache.set(uuid, recomputed);
        return recomputed;
      }
      // Can't resolve a bigger real total — show the honest live index rather than X/(smaller).
      return currentSlide;
    }
    return total;
  }

  /**
   * How confident are we that this playlist item is the presentation that is live?
   *   3 = same uuid, 2 = same title, 1 = one title is a prefix of the other, 0 = no.
   *
   * Compared on TIDIED names, because ProPresenter reports the presentation as
   * "Covered By The Blood" while the playlist item carries the arrangement,
   * "Covered By The Blood - [ Full ]".
   *
   * Deliberately NOT a substring test. A loose "does either contain the other" matched a
   * pre-service playlist containing a song called "The Blood" and pointed the whole display
   * at the wrong running order — a plain substring is far too eager on a song library.
   */
  function matchStrength(item, liveName, liveUuid) {
    if (liveUuid && item.uuid && item.uuid === liveUuid) return 3;
    const itemName = cleanItemName(item.name || '').toLowerCase();
    const live = cleanItemName(liveName || '').toLowerCase();
    if (!itemName || !live) return 0;
    if (itemName === live) return 2;
    // A prefix relationship covers "… TAG" and "… (Reprise)" style siblings. Require a
    // meaningful stem so short titles can't latch onto anything.
    const stem = Math.min(itemName.length, live.length);
    if (stem >= 6 && (itemName.startsWith(live) || live.startsWith(itemName))) return 1;
    return 0;
  }

  function itemMatchesLive(item, liveName, liveUuid) {
    return matchStrength(item, liveName, liveUuid) > 0;
  }

  /** Every playlist in the tree, with the index path that /v1/playlist/{a}/{b} wants. */
  async function listAllPlaylists() {
    const out = [];
    let tree;
    try {
      tree = await requestJson('/v1/playlists');
    } catch {
      return out;
    }
    const nodes = Array.isArray(tree) ? tree : tree?.children || tree?.playlists || [];
    const walk = (ns, prefix) => {
      for (let i = 0; i < (Array.isArray(ns) ? ns.length : 0); i += 1) {
        const node = ns[i];
        const id = node?.id || {};
        const idx = Number.isInteger(id.index) ? id.index : i;
        const here = [...prefix, idx];
        const fieldType = String(node?.field_type || node?.type || '');
        if (fieldType === 'playlist') {
          out.push({ path: here.join('/'), name: String(id.name || ''), uuid: String(id.uuid || '') });
        }
        walk(node?.children, here);
      }
    };
    walk(nodes, []);
    return out;
  }

  /**
   * Find the playlist that actually contains what is on screen.
   *
   * Necessary because /v1/playlist/active reports null and /v1/playlist/focused reports
   * whatever the operator last clicked — which is frequently a GROUP, not the running order.
   * Trusting it meant the display showed no upcoming items all through a service that was
   * being run from a playlist the whole time. Searching by the live presentation is the only
   * signal that reflects what is genuinely being presented.
   */
  async function findPlaylistContainingLive(liveName, liveUuid) {
    const playlists = await listAllPlaylists();
    if (!playlists.length) return null;
    // Check the one we already proved first: while a service runs, that is a single request.
    playlists.sort((a, b) => (b.path === provenPlaylistPath ? 1 : 0) - (a.path === provenPlaylistPath ? 1 : 0));

    let best = null;
    for (const entry of playlists) {
      const url = `/v1/playlist/${entry.path}`;
      let items = [];
      try {
        items = parsePlaylistItems(await requestJson(url));
      } catch {
        continue;
      }
      if (!items.length) continue;
      let strength = 0;
      for (const item of items) {
        strength = Math.max(strength, matchStrength(item, liveName, liveUuid));
      }
      if (!strength) continue;
      if (!best || strength > best.strength) {
        best = { items, name: entry.name, uuid: entry.uuid, path: entry.path, strength };
      }
      // A uuid or exact-title hit is as good as it gets — stop walking the tree.
      if (strength >= 2) break;
    }
    if (!best) return null;
    provenPlaylistPath = best.path;
    itemsSourceUrl = `/v1/playlist/${best.path}`;
    itemsForUuid = best.uuid;
    return best;
  }

  function recomputeActiveIndex() {
    // 1. Try UUID match (works when presentation UUID === playlist item UUID).
    if (state.activeUuid) {
      const byUuid = state.items.findIndex((item) => item.uuid && item.uuid === state.activeUuid);
      if (byUuid >= 0) { state.activeIndex = byUuid; return; }
    }
    // 2. Fall back to name match. On PP20, slide_index gives the presentation document UUID
    //    which differs from the playlist item UUID, so UUID matching silently fails.
    //    Names always match because both the playlist item and the presentation share the same title.
    if (state.activeName) {
      const normalised = state.activeName.trim().toLowerCase();
      const byName = state.items.findIndex(
        (item) => item.name && item.name.trim().toLowerCase() === normalised,
      );
      if (byName >= 0) { state.activeIndex = byName; return; }
      // Partial name match as a last resort (handles slight label differences).
      // Strongest match wins, rather than the first loose one — inside a long song list
      // several titles can look similar.
      let bestIndex = -1;
      let bestStrength = 0;
      for (let i = 0; i < state.items.length; i += 1) {
        const strength = matchStrength(state.items[i], state.activeName, state.livePresentationUuid);
        if (strength > bestStrength) {
          bestStrength = strength;
          bestIndex = i;
        }
      }
      state.activeIndex = bestIndex;
      return;
    }
    state.activeIndex = -1;
  }

  /**
   * ProPresenter 20 renamed the "list a playlist's items" route and didn't document it publicly.
   * Since this app runs on the same LAN as ProPresenter, we probe the plausible address formats
   * at runtime and use whichever returns a real item list, caching the winner.
   */
  async function discoverItems(playlistUuid) {
    if (!playlistUuid) return { items: [], kind: 'none' };
    const enc = encodeURIComponent;

    // Reuse a previously-working URL for this playlist.
    if (itemsSourceUrl && itemsForUuid === playlistUuid) {
      try {
        const items = parsePlaylistItems(await requestJson(itemsSourceUrl));
        if (items.length) return { items, kind: 'playlist' };
      } catch {
        /* re-discover below */
      }
    }

    let pathStr = [];
    let name = '';
    let fieldType = '';
    try {
      const tree = await requestJson('/v1/playlists');
      const nodes = Array.isArray(tree) ? tree : tree?.children || tree?.playlists || [];
      const found = findPlaylistPath(nodes, playlistUuid, []);
      if (found) {
        pathStr = found.path;
        name = found.name;
        fieldType = found.fieldType;
      }
    } catch {
      /* ignore */
    }

    // A GROUP holds playlists, not items, and ProPresenter's /v1/playlist/focused will
    // happily name one — which is what happens when the operator is presenting from the
    // Library rather than from a service playlist. Listing its items correctly returns
    // nothing, so say so instead of leaving the caller to guess from an empty array.
    if (fieldType === 'group') {
      return { items: [], kind: 'group' };
    }

    const candidates = [`/v1/playlist/${enc(playlistUuid)}`];
    if (name) candidates.push(`/v1/playlist/${enc(name)}`);
    if (pathStr.length) {
      candidates.push(
        `/v1/playlist/${pathStr.join('.')}`,
        `/v1/playlist/${pathStr.join(':')}`,
        `/v1/playlist/${pathStr.join('-')}`,
        `/v1/playlist/${pathStr.join('_')}`,
        `/v1/playlist/${pathStr.join(',')}`,
        `/v1/playlist/${enc(pathStr.join('/'))}`,
        `/v1/playlist/${pathStr[pathStr.length - 1]}`,
      );
    }

    for (const candidate of candidates) {
      try {
        const items = parsePlaylistItems(await requestJson(candidate));
        if (items.length) {
          itemsSourceUrl = candidate;
          itemsForUuid = playlistUuid;
          return { items, kind: 'playlist' };
        }
      } catch {
        /* try next candidate */
      }
    }
    return { items: [], kind: 'unknown' };
  }

  /**
   * Refresh which playlist we're in (for the item list).
   * Uses /v1/playlist/active then /v1/playlist/focused as fallback.
   * Does NOT set the active item — that comes from slide_index (see applySlideIndex).
   */
  async function refreshPlaylistContext() {
    let playlistUuid = '';
    let playlistName = '';

    try {
      const active = await requestJson('/v1/playlist/active');
      const pl = active?.presentation?.playlist;
      if (pl?.uuid) {
        playlistUuid = String(pl.uuid);
        playlistName = String(pl.name || '');
      }
    } catch { /* ignore */ }

    if (!playlistUuid) {
      try {
        const focused = await requestJson('/v1/playlist/focused');
        const pl = focused?.playlist;
        if (pl?.uuid) {
          playlistUuid = String(pl.uuid);
          playlistName = String(pl.name || '');
        }
      } catch { /* ignore */ }
    }

    // Compare against the previous HINT, not against the playlist we settled on. Otherwise
    // every poll looks like a change (the hint keeps naming a group while we hold the real
    // playlist) and re-probes ProPresenter twice a second for nothing.
    const changed = playlistUuid !== lastHintUuid;
    lastHintUuid = playlistUuid;

    if (playlistUuid && changed) {
      state.playlistUuid = playlistUuid;
      const found = await discoverItems(playlistUuid);
      state.playlistKind = found.kind;
      state.itemsRetryAt = 0;
      // Only REPLACE the list when we actually resolved one. During a rehearsal the operator
      // clicks around groups and library items, and ProPresenter reports each of those as the
      // focused "playlist"; overwriting with an empty list each time is what made the running
      // order keep vanishing off the screens.
      if (found.items.length) {
        state.items = found.items;
        await fillSlideCounts();
      }
    } else if (playlistUuid && !state.items.length && state.playlistKind !== 'group') {
      // Retry a discovery that came back empty. Item lookup depends on probing undocumented
      // routes, so a single failure used to be sticky for the whole service — the list would
      // stay blank until the operator happened to switch playlists.
      state.itemsRetryAt = (state.itemsRetryAt || 0) + 1;
      if (state.itemsRetryAt >= 20) {
        state.itemsRetryAt = 0;
        const found = await discoverItems(playlistUuid);
        state.items = found.items;
        state.playlistKind = found.kind;
        await fillSlideCounts();
      }
    } else if (!playlistUuid) {
      state.playlistUuid = '';
      state.items = [];
      state.playlistKind = 'none';
    }

    // Don't present a group's name as if it were a service playlist — "EVENTS" reads like a
    // running order when it is really just the folder the operator has open.
    state.playlistName = state.playlistKind === 'group' ? '' : playlistName;

    // The hint above is unreliable. What matters is whether the list we are holding actually
    // contains what is on screen; if it doesn't, go and find the playlist that does.
    const liveName = state.activeName;
    if (!liveName) return;
    const holdsLive = state.items.some((item) => itemMatchesLive(item, liveName, state.livePresentationUuid));
    if (holdsLive) {
      searchCooldown = 0;
      // Keep showing the playlist we proved, not the group the hint keeps naming.
      if (provenPlaylistName) state.playlistName = provenPlaylistName;
      return;
    }
    if (searchCooldown > 0) {
      searchCooldown -= 1;
      return;
    }
    const found = await findPlaylistContainingLive(liveName, state.livePresentationUuid);
    if (found) {
      state.items = found.items;
      state.playlistName = found.name;
      provenPlaylistName = found.name;
      state.playlistUuid = found.uuid || state.playlistUuid;
      state.playlistKind = 'playlist';
      await fillSlideCounts();
      recomputeActiveIndex();
    } else {
      // Nothing in the tree holds it — genuinely presenting outside a playlist. Back off so
      // a full tree walk cannot run on every poll.
      searchCooldown = 25;
    }
  }

  /**
   * Who is on screen when slide_index won't say. /v1/presentation/focused reports the
   * presentation ProPresenter has focused — including one opened straight from the Library,
   * which slide_index attributes to nothing. No slide number is available this way, so the
   * card shows the title and the total without a running count.
   */
  async function applyFocusedPresentation() {
    try {
      const focused = await requestJson('/v1/presentation/focused');
      const uuid = String(focused?.uuid || focused?.id?.uuid || '');
      const name = String(focused?.name || focused?.id?.name || '');
      if (!name && !uuid) return;
      if (uuid && uuid !== state.activeUuid) {
        state.activeUuid = uuid;
        state.livePresentationUuid = uuid;
        state.livePresentationSlideTotal = 0;
      }
      state.activeName = name || state.activeName;
      recomputeActiveIndex();
    } catch {
      /* leave the last known state alone */
    }
  }

  async function fillSlideCounts() {
    for (const item of state.items) {
      // Try a slide count for anything that isn't an explicit header; non-presentations
      // simply return null (their UUID has no presentation), which we render as "no count".
      if (item.uuid && item.type !== 'header' && item.slideCount === null) {
        item.slideCount = await slideCount(item.uuid);
      }
    }
  }

  function applySlideIndex(data) {
    // PP20 uses `presentation_index`; older versions used `presentation`.
    const node = data?.presentation_index || data?.presentation || null;
    if (!node) {
      // A null here does NOT mean the screen is empty. On ProPresenter 20 this endpoint
      // reports null whenever the live slide isn't attributed to a playlist presentation —
      // presenting from the Library is the common case — and it also blips to null between
      // triggers. Blanking on it is what made the display keep clearing itself during a
      // rehearsal. /v1/status/layers is the authority on whether anything is on screen:
      // while the slide layer is live, hold the last known item.
      if (state.slideLayerLive) return;
      state.currentSlide = 0;
      state.livePresentationUuid = '';
      state.activeUuid = '';
      state.activeName = '';
      recomputeActiveIndex();
      return;
    }
    const idx = Number.isInteger(node.index) ? node.index : null;
    state.currentSlide = idx !== null ? idx + 1 : 0;

    const presId = node?.presentation_id || node?.id || null;
    const uuid = presId ? String(presId.uuid || '') : '';
    state.livePresentationUuid = uuid;

    // Use this uuid as the active item — it's always accurate regardless of how slides advanced.
    if (uuid && uuid !== state.activeUuid) {
      state.activeUuid = uuid;
      state.livePresentationSlideTotal = 0; // reset so a fresh count is fetched this poll
      // Try to find the name from the item list; fall back to presentation_id.name.
      const match = state.items.find((item) => item.uuid === uuid);
      state.activeName = match ? match.name : String(presId?.name || '');
      recomputeActiveIndex();
    }
  }

  /** Project the internal poll state into the view-model both UIs render. */
  function getViewModel() {
    // Items the operator marked hidden in ProPresenter — cut songs, contingency cues,
    // staff-only slides — are REDACTED here, not removed. Both UIs already skip hidden
    // rows when rendering, but their names were still being published to every screen on
    // the network. Keeping the entries (minus their names) preserves the positions that
    // activeIndex and the "what's next" slice depend on, which dropping them would shift.
    const items = state.items.map((item) => (item.isHidden
      ? { uuid: '', name: '', type: item.type, isHidden: true, isPco: false, slideCount: null }
      : item));

    // Use the live count for the presentation that's actually on screen — it reflects the
    // arrangement playing right now, so it can never be stale or mismatched.
    return {
      enabled: config.enabled,
      reachable: state.reachable,
      lastError: state.lastError || '',
      needsPlaylist: false,
      playlistName: state.playlistName,
      playlistKind: state.playlistKind || 'none',
      items,
      activeIndex: state.activeIndex,
      activePresentationName: state.activeName,
      currentSlide: state.currentSlide,
      currentSlideTotal: state.livePresentationSlideTotal || 0,
    };
  }

  /** Last error thrown by a consumer's onData, for callers that want to surface it. */
  let lastEmitError = '';

  function emit() {
    if (!onData) return;
    // A consumer must never be able to stop the engine. emit() runs OUTSIDE pollTick's
    // try/catch and BEFORE the reschedule below it, so an unhandled throw here would end
    // polling for good — and with no unhandledRejection handler installed (Electron adds
    // none) it would take the whole process down. Swallow, record, keep polling.
    try {
      onData(getViewModel());
      lastEmitError = '';
    } catch (err) {
      lastEmitError = err instanceof Error ? err.message : String(err);
      console.error('[propresenter-core] onData consumer threw:', err);
    }
  }

  async function pollTick(token) {
    if (stopped || token !== runToken) return;

    try {
      tick += 1;

      // THE HOT PATH — one request, every tick, exactly like version 1. This is the live
      // slide counter, and it must not be starved by anything heavier sharing the loop:
      // ProPresenter's little HTTP server will start returning null for slide_index if it
      // is hammered, which is what stopped the counter from updating.
      const raw = await requestJson('/v1/presentation/slide_index');
      lastIndexWasNull = !(raw?.presentation_index || raw?.presentation);
      applySlideIndex(raw);
      state.reachable = true;
      state.lastError = '';

      // Slide TOTAL for the live presentation (cached per uuid — after the first probe this
      // costs nothing, so it can stay on the hot path).
      if (state.livePresentationUuid) {
        try {
          const activeItem = state.activeIndex >= 0 ? state.items[state.activeIndex] : null;
          const hint = arrangementTagFromName(activeItem?.name || state.activeName);
          state.livePresentationSlideTotal = await liveSlideTotal(
            state.livePresentationUuid,
            state.currentSlide,
            hint,
          );
        } catch {
          /* keep the last known total */
        }
      }

      // EVERYTHING BELOW is the slow lane — the calls I added that ProPresenter does not
      // need to answer on every slide. Run them roughly every 2.5s, or immediately when we
      // still have no idea what is on screen. Keeps steady-state load below version 1's.
      const slowTick = tick % 4 === 0;
      const needBootstrap = !state.items.length || (!state.activeName && lastIndexWasNull);

      if (slowTick || needBootstrap) {
        // Only ask about layers/focused when slide_index isn't naming the slide itself.
        if (lastIndexWasNull) {
          try {
            const layers = await requestJson('/v1/status/layers');
            if (layers && typeof layers.slide === 'boolean') state.slideLayerLive = layers.slide;
          } catch {
            /* older builds have no layer status; leave the last value */
          }
          if (state.slideLayerLive && !state.activeName) {
            await applyFocusedPresentation();
          }
        }
        await refreshPlaylistContext();
      }

      if (state.activeUuid) {
        const match = state.items.find((item) => item.uuid === state.activeUuid);
        if (match) state.activeName = match.name;
      }
      recomputeActiveIndex();
    } catch (err) {
      state.reachable = false;
      state.lastError = err instanceof Error ? err.message : String(err);
    }

    if (stopped || token !== runToken) return;
    emit();
    pollTimer = setTimeout(() => pollTick(token), state.reachable ? pollMs : retryMs);
  }

  function stop() {
    stopped = true;
    runToken += 1;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    state.reachable = false;
  }

  function start() {
    if (!config.enabled || !config.host || !config.port) return false;
    stopped = false;
    const token = (runToken += 1);
    pollTick(token);
    return true;
  }

  /** Restart the poll loop only if it was already running (used after a config tweak). */
  function restartIfRunning() {
    if (!stopped) {
      stop();
      start();
    }
  }

  /** Drop every cache + poll result. Call when the connection target changes. */
  function reset() {
    slideCountCache.clear();
    arrangementCountCache.clear();
    itemsSourceUrl = '';
    itemsForUuid = '';
    state = emptyPollState();
  }

  /**
   * Point the client at a ProPresenter instance. Does not start polling.
   * Accepts a partial config; omitted fields keep their current value.
   */
  function configure(next = {}) {
    const merged = {
      enabled: next.enabled ?? config.enabled,
      host: next.host ?? config.host,
      port: next.port ?? config.port,
      playlistUuid: next.playlistUuid ?? config.playlistUuid,
      playlistName: next.playlistName ?? config.playlistName,
    };
    const normalized = normalizeConfig(merged);
    config = {
      ...normalized,
      // enabled is only meaningful with a host+port, but callers may enable optimistically
      // before the reachability check; normalizeConfig already guards that.
      enabled: Boolean(merged.enabled) && Boolean(normalized.host) && Boolean(normalized.port),
      password: next.password ?? config.password,
    };
    return getConfig();
  }

  /** The current config, minus the password (callers get `hasPassword` instead). */
  function getConfig() {
    return {
      enabled: config.enabled,
      host: config.host,
      port: config.port,
      hasPassword: Boolean(config.password),
      playlistUuid: config.playlistUuid,
      playlistName: config.playlistName,
    };
  }

  /**
   * Hit /version to confirm the API is reachable and the password (if any) is accepted.
   * Resolves with ProPresenter's version payload, or throws a message worth showing a human.
   */
  async function testConnection() {
    if (!config.host || !config.port) {
      throw new Error('Enter the ProPresenter host (IP) and port.');
    }
    try {
      return await requestJson('/version');
    } catch {
      throw new Error(
        `Could not reach ProPresenter at ${config.host}:${config.port}. Check the IP and port, and that the API is enabled in ProPresenter ▸ Preferences ▸ Network.`,
      );
    }
  }

  /** Every playlist ProPresenter knows about, flattened for a picker. */
  async function listPlaylists() {
    if (!config.host || !config.port) return [];
    const data = await requestJson('/v1/playlists');
    const nodes = Array.isArray(data)
      ? data
      : Array.isArray(data?.playlists)
        ? data.playlists
        : Array.isArray(data?.children)
          ? data.children
          : [];
    return flattenPlaylists(nodes, '', []);
  }

  /** Remember a manually chosen playlist and force the next poll to refetch its items. */
  function selectPlaylist({ uuid = '', name = '' } = {}) {
    config.playlistUuid = String(uuid);
    config.playlistName = String(name);
    state.playlistUuid = '';
    state.items = [];
    state.activeIndex = -1;
    restartIfRunning();
    return getConfig();
  }

  return {
    configure,
    getConfig,
    setOnData(cb) { onData = typeof cb === 'function' ? cb : null; },
    start,
    stop,
    restartIfRunning,
    // NOTE: isRunning() is just !stopped — it says the loop was started, NOT that
    // ProPresenter is reachable or that data is flowing. Use getViewModel().reachable for health.
    isRunning: () => !stopped,
    getLastEmitError: () => lastEmitError,
    reset,
    getViewModel,
    testConnection,
    listPlaylists,
    selectPlaylist,
    requestJson,
  };
}

module.exports = {
  DEFAULT_PP_PORT,
  DEFAULT_POLL_MS,
  DEFAULT_RETRY_MS,
  createProPresenterClient,
  clearedViewModel,
  normalizeConfig,
  flattenPlaylists,
  parsePlaylistItems,
  findPlaylistPath,
  countSlides,
  cleanItemName,
};
