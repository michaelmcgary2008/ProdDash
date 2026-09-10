# ProdDash Module Guide

How to build, install and test a ProdDash module. Everything a module author
needs is on this page — you never have to read the shell's source.

A **module** is one kind of dashboard tile: the live transcript, the
Now/Next display, a clock. Users add any number of tiles of your module to
their own dashboards, move and resize them, and give each tile its own
per-tile settings. Your module renders inside the tile and talks to the
outside world only through the small API the shell hands it.

## Rules every module follows

These are not style preferences — the admin page, the installer and the
people running the booth depend on them.

1. **All settings live in the ProdDash admin page.** Server-wide settings go
   in `configSchema`, per-tile settings in `instanceSchema`. Never a separate
   setup page, wizard, config file the operator edits by hand, or environment
   variable.
2. **Dependencies ship inside the module folder.** Zero dependencies is the
   norm (the shell has none). Anything you genuinely need is vendored into
   the module — or fetched by your own `init()` on first start, with the
   admin health line saying what is happening. No `npm install`, no
   installer, no "run this first".
3. **Everything the module does runs inside the module.** No helper scripts,
   companion programs, daemons or services the operator has to start next to
   ProdDash. If your feature needs a listener, a decoder or a worker, your
   server entry owns it: start it in `init()`, stop it in `stop()`, report
   it in `health()`. A child process the module itself spawns and supervises
   is fine; a program someone launches by hand is not.
4. **Declare the ProdDash version you need** (`"proddash": ">=1.1.0"` in the
   manifest) and **bump your own `version`** whenever you change the module.
   The admin page refuses to install a module whose requirement the running
   shell doesn't meet, and it offers updates by comparing versions.

## The shape of a module

A module is one folder dropped into `modules/`:

```
modules/<id>/
├── module.json      manifest (required)
├── client.js        ES module, client entry (required)
├── server.js        server entry (optional — only if you need server code)
└── ... assets       (css, images…) served statically at /modules/<id>/
```

**Installation is exactly this:** in the admin page, open **Available
modules** and press **Install** — the module is downloaded from the ProdDash
repo into the server's data directory (`<data dir>/modules/<id>/`) and starts
immediately. Developing locally? Drop the folder into `modules/` (bundled
with the checkout) or into the data directory's `modules/` and restart. No
shell code changes, ever. Modules bundled with a checkout and modules
installed from the admin page live side by side; when both have the same id
the newer version runs. **Uninstall** in the admin page removes an installed
module's files (a bundled one is hidden instead, since its folder belongs to
the app); its settings are kept for a later reinstall.

## module.json

```json
{
  "id": "my-module",
  "name": "My Module",
  "version": "1.0.0",
  "proddash": ">=1.1.0",
  "description": "One line shown in the Add-tile picker and the admin page",
  "client": "client.js",
  "server": "server.js",
  "style": "style.css",
  "minSize": { "w": 2, "h": 2 },
  "defaultSize": { "w": 4, "h": 3 },
  "configSchema": {
    "upstreamUrl": { "type": "string", "label": "Upstream URL", "default": "http://10.0.0.5:1234" },
    "apiKey":      { "type": "password", "label": "API key", "default": "" }
  },
  "instanceSchema": {
    "channel": { "type": "string", "label": "Channel filter", "default": "" }
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Must equal the folder name. Lowercase, dashes. |
| `name` | yes | Human name shown on the tile header and in menus. |
| `version` | yes | Your module's version (`x.y.z`). Bump it on every change — the admin page offers updates when the repo's copy is newer than the installed one. |
| `proddash` | yes | The ProdDash versions this module works with: `">=1.1.0"`, `"^1.1.0"`, `">=1.1.0 <2.0.0"`, or `"*"`. A module whose requirement the running shell doesn't meet is listed in the admin page but never loaded, and can't be installed from the catalog. |
| `description` | no | Shown in the admin page / picker. |
| `client` | yes | Client entry file, loaded as an ES module. |
| `server` | no | Server entry file (CommonJS), loaded with `require()`. |
| `style` | no | A stylesheet the shell injects once per module. |
| `minSize`, `defaultSize` | no | Tile size in grid cells (12 columns wide; rows are ~72 px). Defaults: min 1×1, default 4×3. |
| `configSchema` | no | **Admin config** — server-wide settings (URLs, ports, keys) edited once at `/admin` for everyone. |
| `instanceSchema` | no | **Per-tile settings** — chosen in each tile's gear menu and stored with that browser's layout (filters, text sizes, display options). |
| `tiles` | no | Fixed multi-tile list for client-only modules; server modules export a dynamic `tiles()` instead. See **Presenting multiple tiles**. |

Both schemas map field names to specs:

```
{ "type": "string" | "number" | "boolean" | "switch" | "select" | "password" | "endpoint",
  "label": "Shown next to the field",
  "default": <value>,
  "group": "Section heading",                         // optional; see below
  "showWhen": "<other boolean/switch key>",           // optional; see below
  "options": [ { "value": "a", "label": "A" }, … ],  // "select" only
  "optionsRoute": "/devices"                          // "select" only, admin config only
}
```

`boolean` renders as a checkbox; `switch` is the same true/false value shown
as a toggle (use it for a feature on/off that other fields depend on).

`group` gathers consecutive fields under a labeled subsection in the admin
page, so a module with several distinct concerns (e.g. a ProPresenter
connection and an LTC audio input) reads as clearly separated blocks. Fields
with no `group` render loose, before/after the grouped ones in schema order.

`showWhen: "<key>"` hides a field until the boolean/`switch` field named
`<key>` is on — e.g. the audio device and channel appear only once the LTC
listener switch is enabled. The hidden field still keeps its stored value.

A `select` whose choices are only knowable at runtime (audio devices, serial
ports, discovered sources) sets `optionsRoute` instead of — or as a fallback
refresh of — static `options`: the admin page GETs
`/api/modules/<id><optionsRoute>` and expects `{ "options": [ { "value",
"label" }, … ] }` from one of the module's own server routes. The saved value
stays selectable even when the route is down or the option has vanished. (See
`propresenter-timers`' "Audio device" for a worked example.)

`password` fields are admin-config only in practice: their values are stored
in the server's `modules.json` (in the per-machine data directory, see the
README), handed to your *server* entry, and **never sent to browsers** — not in `/api/modules`, and never echoed back into the admin
form. Anything upstream that needs the secret must go through your server
routes.

### Connection settings: use `endpoint`

Anything that points at a device or service on the network — ProPresenter,
ProdCom, a camera, a mixer — must be **one `endpoint` field**, so every
module's connection is entered the same way. The admin page renders an
endpoint as a single "Host / IP : Port" control; the value is stored and
handed to your server as an object:

```json
"propresenter": {
  "type": "endpoint",
  "label": "ProPresenter",
  "default": { "host": "", "port": 1025 }
}
```

```js
// in your server entry
const { host, port } = config.propresenter;
const base = `http://${host}:${port}`;
```

Do **not** split host and port into separate `string`/`number` fields, and
do **not** ask for a full `http://…` URL unless the setting genuinely is a
web address where protocol or path matter (a page to embed, a webhook).
Endpoints belong in admin config, not per-tile settings — connections are
server-wide by design.

Admin config lives in `modules.json` inside the server's data directory
(written by the admin page — your module never touches that file, and it
survives updates of the app folder). Per-tile settings live inside each
browser's layout.

## Client entry (`client.js`)

An ES module whose **default export is a factory**. The shell calls it once
per tile:

```js
export default function create({ root, moduleApi }) {
  return {
    start() {},            // begin rendering / connecting
    stop() {},             // tear down EVERYTHING (timers, streams, observers)
    onResize(w, h) {},     // optional; tile was resized (w, h in grid cells)
    onConfigChange(cfg) {} // optional; admin config was saved
  };
}
```

- `root` — the tile's body element. **The module owns everything inside it
  and must never touch DOM outside it.**
- All four methods are optional, but a module without `stop()` will leak
  timers when its tile is removed. `stop()` must leave nothing running.

### moduleApi

| Member | What it is |
| --- | --- |
| `id` | Your module id. |
| `instanceId` | Unique per tile — two tiles of the same module get different ids. Handy for keying anything per-tile. |
| `variant` | For multi-tile modules: the id of the tile-list entry this tile was added as, `''` otherwise (see **Presenting multiple tiles**). |
| `config` | Admin (server-wide) config, read-only, always current. Password fields are absent — they never reach the client. |
| `instanceSettings` | This tile's settings: your `instanceSchema` defaults overlaid with whatever this tile has saved. Read it fresh whenever you render — don't cache it. |
| `saveInstanceSettings(patch)` | Merge `patch` into this tile's settings and persist them with the layout. No restart happens — you made the change, you already know. Use it for state the user sets *inside* your tile (a toggled filter, a chosen tab). |
| `fetch(path, opts)` | `fetch` scoped to your server routes: `fetch('/state')` hits `/api/modules/<id>/state`. |
| `sse(path, handlers)` | An `EventSource` scoped the same way, **with auto-reconnect** (see below). Returns a handle with `close()`. |
| `setStatus(state, msg)` | Drives the tile's status dot: `'ok'`, `'connecting'` or `'error'`, plus a hover message. Call it honestly — during a live service the dot is how an operator spots a dead feed. |
| `header.addButton(…)` | Put a small button in the tile's own title bar (see below). |
| `header.addMenu(…)` | Put a dropdown menu button there (see below). |

### Title-bar controls

Modules don't build their own toolbars — actions live in the tile's title
bar, next to the shell's gear/close buttons:

```js
const btn = moduleApi.header.addButton({
  icon: '<svg …>…</svg>',   // inline SVG string, and/or
  label: 'A+',              // short text
  title: 'Larger text',     // hover tooltip
  onClick() { … },
});
btn.classList.add('active'); // toggle styling for on/off buttons

const menu = moduleApi.header.addMenu({
  label: 'Channels ▾',
  title: 'Choose visible channels',
  build(menuEl) {
    // called on every open with an emptied menu element — fill it with
    // buttons (give them your scoped classes; the container is styled and
    // fixed-positioned by the shell, so the tile's overflow can't clip it)
  },
});
menu.setLabel('Channels (2/4) ▾'); // update the button text any time
```

Everything you add is removed automatically when your instance stops, so a
remount never duplicates controls. Keep them compact (icon buttons, short
labels): the title bar is 32 px tall and shared with the tile's name.

One more thing to know: the user can hide the whole title bar with the
small notch on its bottom edge (a clean-view mode for wall displays). Your
controls disappear with it, so nothing essential — status, reconnects,
live data — may exist *only* as a header control.

`sse(path, handlers)` handlers:

```js
const stream = moduleApi.sse('/stream', {
  open(e)    {},                 // (re)connected
  error(e)   {},                 // connection lost — say so via setStatus
  message(e) {},                 // unnamed "data:" events
  events: { state(e) {} },       // named events by name
});
// later: stream.close()
```

Browsers' `EventSource` retries transient drops itself but gives up for good
when a retry gets a completed non-SSE response — which is what a proxy's 502
looks like while the upstream is down. The shell's `sse()` recreates closed
streams on a 3-second timer until they work again, so **reconnect logic is
free**: handle `open` (refresh/backfill your state; you may have missed
events) and `error` (report degraded status), and you're resilient. Streams
you forget to close are force-closed when the tile unmounts — but close your
own in `stop()` anyway.

### Lifecycle you must expect

- **Any number of instances.** Two transcript tiles with different filters
  is a feature. Keep all state inside `create()`'s closure — no module-level
  mutable state in `client.js`.
- **Remounts are routine.** When the user edits the tile's gear settings the
  shell calls `stop()` and starts a fresh instance. When admin config
  changes, the shell calls your `onConfigChange(cfg)` if you export one,
  otherwise it remounts you. Either way you must come back cleanly.
- **The tile can be removed at any moment.** `stop()` is your only notice.

### Rules for the client

1. **Never touch DOM outside `root`. Never define global CSS.** Scope every
   rule in your stylesheet with the attribute the shell puts on your tiles:

   ```css
   [data-module="my-module"] .my-thing { … }
   ```

   (Shadow DOM works too, if you prefer full isolation.)

2. **Style with the shell's CSS variables — no hardcoded colors.** The
   palette: `--bg` (page), `--panel` (tile), `--border`, `--text`,
   `--muted`, `--accent`, `--danger`, `--warn`. Derive tints with
   `color-mix(in srgb, var(--accent) 20%, transparent)`. This is what makes
   every module look native on the dark, high-contrast booth theme.

3. **No external network calls from the client.** Browsers talk only to
   ProdDash. Anything upstream (your device, service, API) goes through your
   module's server routes — same reasoning as the reference apps: no CORS,
   no per-browser credentials, one place that owns the connection.

4. **Handle upstream loss.** Reconnect with backoff (or lean on `sse()`),
   and report honestly via `setStatus`. Tiles run unattended during live
   services; a module that silently freezes is worse than one that says
   it's down.

## Server entry (`server.js`)

Optional — only needed when your module talks to something upstream or keeps
server-side state. CommonJS, Node built-ins only (keep the zero-dependency
ethos; Node 18+ so global `fetch` is available). Exports either or both of:

```js
module.exports = {
  init({ config, log }) {
    // Called on startup / re-init, BEFORE routes(). Start your upstream
    // connection here. Return a handle:
    return {
      stop() {},                                  // tear everything down
      health() { return { status: 'ok', message: '' }; }  // optional
    };
  },

  routes({ config, log }) {
    // Route table, mounted under /api/modules/<id>/
    return {
      'GET /state':     (req, res) => { … },
      'GET /stream':    (req, res) => { … },      // SSE — see notes
      'POST /command':  (req, res) => { … },
      'GET /proxy/*':   (req, res) => { … },      // trailing /* = prefix route
      '* /anything/*':  (req, res) => { … },      // * method = any method
    };
  },
};
```

- `config` is your admin config: `configSchema` defaults overlaid with what
  the admin page saved — **including password fields**.
- `log(...)` prefixes output with your module id.
- Handlers get plain Node `(req, res)`. On a prefix route, `req.wildcard` is
  the matched remainder (leading `/` included) and `req.search` is the query
  string (with `?`, or `''`) — so a proxy rebuilds the upstream path as
  `req.wildcard + req.search`.
- Exact routes match the path exactly; prefix routes (`/x/*`) match `/x` and
  everything under it. First declared match wins.
- **Re-init instead of restart:** when the admin page saves your config, the
  shell calls your handle's `stop()`, then `init()` and `routes()` again
  with the new config. Keep module-level state inside `init()`'s closure (or
  reset it there) so a re-init starts clean. Disabling a module unmounts its
  routes entirely (clients get 404).
- `health()` feeds the admin page's status line — report your upstream's
  reachability (`status: 'ok' | 'connecting' | 'error'`), not just "running".
- A throw from `init()`/`routes()` marks the module as failed: the error
  shows in `/admin`, and API calls answer 502 until a config fix re-inits
  it. Validate config early so bad input fails loudly there.

### Presenting multiple tiles

By default a module is one entry in the ＋ Add-tile picker. A module can
instead present a **list of tiles** — one picker entry each, grouped under
the module's name. This is how a module whose content is naturally plural
works: one tile per ProPresenter timer, one tile per admin-configured page.

Export `tiles` from your server entry (sync or async):

```js
module.exports = {
  init({ config, log }) { … },
  routes({ config, log }) { … },

  tiles({ config, log }) {
    // e.g. derived from admin config, or discovered from your upstream
    return config.pages.map((page) => ({
      id: page.name,                    // stable id, stored with the tile
      name: page.name,                  // picker label AND the tile's title
      description: page.url,            // optional line under the label
      settings: { page: page.name },    // preset instance settings
      defaultSize: { w: 4, h: 3 },      // optional per-entry size overrides
      minSize: { w: 2, h: 2 },
    }));
  },
};
```

- `tiles()` runs on **every picker load**, so the list may be live data —
  keep it fast (answer from state you already hold; don't fetch upstream on
  demand). A throw or a hang (>2 s) falls back to the classic single entry,
  so a dead upstream can't break the picker.
- When the user adds an entry, its `settings` overlay your `instanceSchema`
  defaults in that tile's instance settings, the entry's `name` becomes the
  tile's title, and `moduleApi.variant` carries its `id`.
- The tile keeps its variant id and title even if the entry later vanishes
  from your list (a timer deleted in ProPresenter, a page removed in admin).
  **Your client decides what that means** — show a clear "no longer
  configured" state rather than erroring.
- A client-only module can declare a fixed list as a `tiles` array in
  `module.json` instead (same entry shape).
- An empty list (or no `tiles` at all) keeps today's behavior: one picker
  entry, no preset.

### Server-Sent Events from a module

For live data, expose a `/stream` route and let clients use
`moduleApi.sse('/stream', …)`:

```js
'GET /stream': (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  res.write(`event: state\ndata: ${JSON.stringify(latest)}\n\n`); // instant paint
  streams.add(res);
  req.on('close', () => streams.delete(res));
}
```

Broadcast only when the payload actually changed, send a `: ping\n\n`
comment every ~15 s so idle connections survive sleepy Wi-Fi, and wrap every
per-client `res.write` in try/catch (drop the client on failure). The
`propresenter-now-next` module is the reference implementation of this
pattern.

## Complete minimal example

A working clock — copy-paste this as your starter. (A slightly fancier
version ships in `modules/clock/`.)

`modules/hello-clock/module.json`

```json
{
  "id": "hello-clock",
  "name": "Hello Clock",
  "version": "1.0.0",
  "description": "Minimal example module",
  "client": "client.js",
  "style": "style.css",
  "minSize": { "w": 2, "h": 1 },
  "defaultSize": { "w": 3, "h": 2 },
  "instanceSchema": {
    "showSeconds": { "type": "boolean", "label": "Show seconds", "default": true }
  }
}
```

`modules/hello-clock/client.js`

```js
export default function create({ root, moduleApi }) {
  let timer = null;

  function tick() {
    const { showSeconds } = moduleApi.instanceSettings;
    root.querySelector('.hc-time').textContent = new Date().toLocaleTimeString(
      [], { hour: '2-digit', minute: '2-digit', ...(showSeconds ? { second: '2-digit' } : {}) }
    );
  }

  return {
    start() {
      root.innerHTML = '<div class="hc-time"></div>';
      tick();
      timer = setInterval(tick, 250);
      moduleApi.setStatus('ok', 'Ticking');
    },
    stop() {
      clearInterval(timer);
      root.innerHTML = '';
    },
  };
}
```

`modules/hello-clock/style.css`

```css
[data-module="hello-clock"] .hc-time {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 2.4em;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
```

Drop the folder in `modules/`, restart ProdDash, and “Hello Clock” appears
in the Add-tile picker (new modules are enabled by default; `/admin` can
disable them).

## Testing your module

**Run it:**

```bash
node server.js        # from the repo root — prints the LAN URL
```

The server logs each module it mounts (or why it refused to). `/admin`
shows mount errors and your `health()` line; the browser console shows
client-side failures (a tile that fails to start says so in the tile).

**Poke the pieces directly:**

- `GET /api/modules` — what the shell sees (your manifest + non-secret config).
- `GET /api/modules/<id>/...` — your routes, `curl`-able. For SSE:
  `curl -N http://localhost:24500/api/modules/<id>/stream`.
- `GET /api/admin/state` — enabled flags, health, mount errors.

**Mock upstreams** (so you can develop without the real gear):

- ProdCom: `node tools/prodcom-mock.js` (port 24480) — channels, groups,
  history, and a live stream with in-progress speech. Point the
  transcript module's ProdCom URL at `http://127.0.0.1:24480`.
- ProPresenter: `node band-lineup-display/tmp/pp-mock.js 1599` — playlists
  and an advancing slide index (including the arrangement-repeat case).
  Point the Now/Next module at host `127.0.0.1`, port `1599`.
- ProPresenter timers: `node tools/pp-timers-mock.js 1600` — running,
  overrunning, stopped and elapsed timers plus an LTC timecode that
  periodically drops to no-signal (`--no-ltc` serves a ProPresenter without
  a timecode API). Also serves the stage-display websocket with an
  LTC-labeled layout field (`--stage-pwd`, `--no-ltc-field` exercise its
  failure paths). Point the Timers module at host `127.0.0.1`, port `1600`.

**The resilience checklist** — every module must pass this before it's done:

1. Add your tile, then **kill the upstream** (or the mock). The status dot
   must go red (with a useful hover message) and the tile must show a clear
   degraded state, not a freeze.
2. **Restart the upstream.** The tile must recover by itself — no reload,
   no clicking.
3. **Restart ProdDash itself** with the tile open. Same expectation.
4. Add **two tiles of your module** with different per-tile settings — both
   must work independently.
5. **Remove your tile**, then check the browser console and server log: no
   errors, no timers still firing, no streams still open.
6. Change your admin config in `/admin` while the tile is open — the tile
   must pick it up (via `onConfigChange` or the automatic remount).
7. Reload the page — the tile comes back with its settings intact.
