# ProdDash — Build Instructions

ProdDash is a flexible **production dashboard** web app for Waters Church. A
browser anywhere on the building network loads one page and composes its own
dashboard out of **modules** — independent tiles that each show one aspect of a
live service. Ships with two modules ported from the reference forks in this
repo: the live **ProdCom transcript** and the **ProPresenter Now/Next** display.

This document is the authority for the initial build. Where it is silent, match
the conventions of the reference code (`prodcom-listener/`,
`band-lineup-display/`).

## Goals

1. A dashboard shell where each browser independently enables, arranges, and
   resizes module tiles. Layouts persist in that browser's `localStorage` by
   default; named layouts can also be saved to the server and loaded from any
   browser.
2. An **admin page** where installed modules are configured (connection
   settings, credentials, enable/disable) once, server-side, for everyone.
3. A **module system** with a documented contract, so future modules can be
   developed and installed without touching the shell. Producing that guide
   (`docs/MODULE-GUIDE.md`) is part of this build, not an afterthought.

## Constraints and house style

- **Runtime:** Node.js server + browser client, plain HTTP on the LAN. No
  build step required to run (`node server.js` and it works), matching
  `prodcom-listener`. Windows + macOS.
- **Dependencies:** keep the zero/low-dependency ethos. Prefer no npm deps on
  the server. On the client, vanilla JS/CSS is preferred; if a grid library
  genuinely earns its place for drag/resize (e.g. gridstack), **vendor it into
  the repo** — no CDN loads, the app must work on a network with no internet.
- **Resilience first:** this runs during live services. Every module must
  survive its upstream (ProdCom, ProPresenter) disappearing and reconnect
  automatically, showing a clear degraded state — copy the reconnect patterns
  in `prodcom-listener/public/app.js` and `propresenter-core`.
- **Look:** dark, high-contrast, production-booth friendly. Reuse the visual
  language of `prodcom-listener/public/style.css` (its CSS variables, themed
  scrollbars). All module styling via shared CSS variables so modules look
  native.
- Installable as a PWA like prodcom-listener (manifest + service worker),
  nice-to-have, last.

## Architecture

```
ProdDash/
├── server.js                  shell server: static files, config store, layouts API,
│                              module discovery, mounts each module's server routes
├── config/
│   ├── proddash.json          port, admin passcode (optional), etc.
│   └── modules.json           per-module config + enabled flags (written by admin page)
├── public/                    dashboard shell client (index.html, shell.js, style.css)
│   └── admin/                 admin page client
├── modules/                   installed modules, one folder each (see contract)
│   ├── prodcom-transcript/
│   └── propresenter-now-next/
├── docs/MODULE-GUIDE.md       how to build and install a module (deliverable)
├── prodcom-listener/          reference fork — read-only, not served
└── band-lineup-display/       reference fork — read-only, not served
```

Server responsibilities:

- Discover modules by scanning `modules/*/module.json` at startup.
- Serve each module's client assets at `/modules/<id>/...`.
- Call each enabled module's server entry (if it has one) and mount its routes
  under `/api/modules/<id>/...`, passing that module's config object.
- Shell API: `GET /api/modules` (installed+enabled manifests for the client),
  layouts CRUD (`GET/PUT /api/layouts`, named layouts as JSON on disk under
  `config/layouts/`), admin config API.
- Config changes from the admin page take effect without a manual restart
  where practical (re-init the affected module); a clean restart is acceptable
  for v1 if flagged in the admin UI.

Client shell responsibilities:

- Grid of tiles: add module (from enabled list), drag to move, drag to resize,
  remove. Multiple instances of the same module are allowed (e.g. two
  transcript tiles filtered to different channels).
- **Per-instance settings** (e.g. transcript channel filter, font size) are
  chosen in the tile and stored with the layout — distinct from admin config,
  which is server-wide (URLs, ports, API keys).
- Layout (tiles, positions, sizes, per-instance settings) autosaves to
  `localStorage`. A layout menu offers: Save as named layout (to server), Load
  named layout, Reset. Loading a named layout copies it into local state; it
  does not live-link browsers together.
- Each browser is fully independent — no shared runtime state between viewers.

## Admin page

At `/admin` (link from the shell's menu):

- Lists every installed module with name, version, description, and status
  (enabled/disabled, connected/erroring if the module reports health).
- Per-module config form **generated from the `configSchema` in its manifest**
  (text, number, boolean, select, password fields). Saving writes
  `config/modules.json` and re-inits the module.
- Enable/disable toggle per module — disabled modules don't appear in the
  shell's picker and their server routes are not mounted.
- Manage named layouts (list, rename, delete).
- Protect with a single shared passcode if `adminPasscode` is set in
  `config/proddash.json`; no accounts, no sessions beyond a cookie. Plain HTTP
  LAN tool — keep it simple.

## Module contract (v1)

A module is a folder in `modules/` containing:

```
modules/<id>/
├── module.json      manifest (required)
├── client.js        ES module, client entry (required)
├── server.js        server entry (optional)
└── ... assets (css, images) served statically at /modules/<id>/
```

`module.json`:

```json
{
  "id": "prodcom-transcript",
  "name": "ProdCom Transcript",
  "version": "1.0.0",
  "description": "Live ProdCom transcript stream",
  "client": "client.js",
  "server": "server.js",
  "minSize": { "w": 2, "h": 2 },
  "defaultSize": { "w": 4, "h": 3 },
  "configSchema": {
    "prodcomUrl": { "type": "string", "label": "ProdCom URL", "default": "http://10.3.11.152:24480" },
    "apiKey":     { "type": "password", "label": "API key (if PSK auth enabled)", "default": "" }
  },
  "instanceSchema": {
    "channel": { "type": "string", "label": "Channel filter", "default": "" }
  }
}
```

Client entry (`client.js`) default-exports a factory:

```js
export default function create({ root, moduleApi }) {
  // root: the tile's DOM element (module owns everything inside it)
  // moduleApi: {
  //   id, instanceId,
  //   config,                          // admin (server-wide) config, read-only
  //   instanceSettings, saveInstanceSettings(patch),  // per-tile, persisted in layout
  //   fetch(path, opts),               // fetch scoped to /api/modules/<id>/
  //   sse(path, handlers),             // EventSource scoped the same way, with auto-reconnect
  //   setStatus('ok'|'connecting'|'error', msg)  // drives the tile's status dot
  // }
  return {
    start() {},            // begin rendering / connecting
    stop() {},             // tear down everything (timers, streams, listeners)
    onResize(w, h) {},     // optional; CSS should handle most of it
    onConfigChange(cfg) {} // optional; admin config was updated
  };
}
```

Server entry (`server.js`, optional) exports:

```js
module.exports = {
  init({ config, log }) { /* return handle with stop() */ },
  routes({ config, log }) {
    // return { 'GET /state': handler, 'GET /stream': sseHandler, ... }
    // mounted under /api/modules/<id>/
  }
};
```

Rules for modules (enforce these in the guide):

- Never touch DOM outside `root`; never define global CSS (scope with a
  `[data-module="<id>"]` prefix or shadow DOM).
- Style with the shell's CSS variables; no hardcoded colors.
- No external network calls from the client — anything upstream goes through
  the module's server routes (same proxy reasoning as prodcom-listener: no
  CORS, browsers never need to reach ProdCom/ProPresenter directly).
- Handle upstream loss: reconnect with backoff, report via `setStatus`.
- Installation = drop the folder into `modules/`, restart ProdDash, configure
  in `/admin`. No shell code changes.

`docs/MODULE-GUIDE.md` must document all of the above from a module author's
point of view, with a complete minimal example module (e.g. a clock) that can
be copy-pasted as a starter, and a testing section.

## Initial modules

### 1. `prodcom-transcript`

Port `prodcom-listener/` into the module system:

- Server part: the `/prodcom/*` proxy from `prodcom-listener/server.js`
  (including SSE passthrough), driven by admin config instead of its own
  `config.json`.
- Client part: the transcript UI from `prodcom-listener/public/` — history
  load, live SSE, in-place updates of in-progress speech, channel colors,
  auto-scroll with "↓ New messages", channel visibility toggles.
- Admin config: `prodcomUrl`, `apiKey`. Instance settings: channel filter,
  text size.

### 2. `propresenter-now-next`

Port the Now/Next feature using `band-lineup-display/propresenter-core/`
**as-is** (copy it into the module; it has no deps and holds every
ProPresenter 7/20 quirk — do not re-implement it):

- Server part: connect/poll ProPresenter via propresenter-core, expose current
  state at `GET /state` and push changes over `GET /stream` (SSE).
- Client part: the Now/Next display, based on the page in
  `band-lineup-display/propresenter-app/public/`.
- Admin config: ProPresenter host, port. Instance settings: display options
  the existing page already supports.
- Must work against the mock: `node band-lineup-display/tmp/pp-mock.js 1599`
  with host `127.0.0.1`, port `1599` — including the arrangement-repeat case
  it simulates.

## Milestones (build in this order, each independently verifiable)

1. **Shell:** server + dashboard grid with a placeholder tile; add/move/
   resize/remove; layout survives reload via localStorage.
2. **Module system:** discovery, client loader, module API; placeholder
   becomes a real trivial module (clock) proving the contract end-to-end.
3. **prodcom-transcript** module, verified against a live or mocked ProdCom.
4. **propresenter-now-next** module, verified against `pp-mock.js`.
5. **Admin page:** schema-driven config forms, enable/disable, persisted to
   `config/modules.json`.
6. **Named layouts:** save to server, load from another browser.
7. **Docs:** `docs/MODULE-GUIDE.md` + README rewrite (run instructions in the
   style of the prodcom-listener README).

## Definition of done

- `node server.js` on a clean clone starts everything; the printed URL works
  from another device on the LAN.
- Two different browsers hold different layouts simultaneously; a named layout
  saved in one loads in the other.
- Kill and restart ProdCom / the ProPresenter mock while tiles are open: tiles
  show degraded status and recover on their own.
- A new module can be added by following MODULE-GUIDE.md alone, without
  reading shell source.
