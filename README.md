# ProdDash

A modular **production dashboard** for Waters Church. Any browser on the
building network opens one page and composes its own dashboard out of
**modules** — independent tiles that each show one aspect of a live service.
Ships with the live **ProdCom transcript**, the **ProPresenter Now / Next**
display, and a booth **clock**; new modules drop into `modules/` without
touching the shell (see [docs/MODULE-GUIDE.md](docs/MODULE-GUIDE.md)).

## How it works

`server.js` (zero dependencies, just Node.js) does four things:

1. Serves the dashboard shell (`public/`) and the admin page (`/admin`).
2. Discovers modules in `modules/` and serves each one's client at
   `/modules/<id>/`.
3. Mounts each enabled module's server routes under `/api/modules/<id>/` —
   that's where module servers proxy ProdCom, poll ProPresenter, and stream
   live updates over SSE, so browsers never talk to production gear
   directly (no CORS, and API keys never leave the server).
4. Stores server-wide module config and named layouts in a per-machine data
   directory outside the app folder, so updating ProdDash never loses them.

Each browser arranges its own tiles (add, drag, resize, remove, per-tile
settings); the layout autosaves to that browser's `localStorage`. Named
layouts can also be saved to the server and loaded from any other browser.
Every module survives its upstream disappearing: tiles show a red status dot
and a clear degraded state, then recover on their own.

## Run it

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
node server.js
```

Or double-click **Start ProdDash.command** (macOS) / **start.bat** (Windows).

Then open the URL it prints — `http://localhost:24500` on this machine, or
the `http://<this-machine's-IP>:24500` address from any other device on the
network.

## Configure

Server-wide module settings (ProdCom URL, ProPresenter host, API keys,
enable/disable) live in the **admin page** — open **Admin** from the
dashboard's top bar, or go to `/admin`. Saving re-initialises the module
immediately; open tiles reconnect on their own.

### Where settings are kept

Everything you enter in the admin page (module connection settings, API keys,
enabled/disabled flags) and every named layout is written to a **data
directory on the machine running the server** — not into the app folder:

| OS | Data directory |
| --- | --- |
| Windows | `%APPDATA%\ProdDash` (e.g. `C:\Users\<you>\AppData\Roaming\ProdDash`) |
| macOS | `~/Library/Application Support/ProdDash` |
| Linux | `$XDG_CONFIG_HOME/proddash`, else `~/.config/proddash` |

Because it lives outside the checkout, you can `git pull`, re-clone, or reset
the app folder from `main` and start the new version with everything still
configured. The admin page shows the exact path in use, and the server prints
it at startup (`Settings : …`).

The directory holds `modules.json` (module config) and `layouts/` (named
layouts), both written by the app itself. It may also hold a `proddash.json`
with this machine's shell settings — the same keys as the checked-in
[config/proddash.json](config/proddash.json), which supplies the defaults:

| Key | Meaning |
| --- | --- |
| `port` | Port ProdDash serves on (default `24500`) |
| `adminPasscode` | If set, the admin page asks for this shared passcode. Leave `""` for none — it's a plain-HTTP LAN tool. |

Environment variables override both files: `PORT`, `PRODDASH_PASSCODE`, and
`PRODDASH_DATA_DIR` to put the data directory somewhere else (a relative path
is taken from the app folder; `PRODDASH_DATA_DIR=config` restores the old
in-repo location). If the default directory can't be created, the server says
so and falls back to the app's `config/` folder.

**Upgrading from an earlier version:** the first start copies an existing
`config/modules.json` and `config/layouts/` from the app folder into the data
directory, so nothing has to be re-entered. The old files are left in place and
ignored from then on.

## Using the dashboard

- **＋** — add any enabled module; multiple tiles of the same module are
  fine (e.g. two transcripts filtered to different channels).
- Drag a tile by its **title bar** to move it; drag either **bottom
  corner** to resize; **✕** removes it. Hover a tile and a small pill
  appears on its **bottom edge** — drag it to change just the height. If
  another tile sits directly below, the pill moves the shared edge instead,
  trading rows between the two so the column keeps its total height. Tiles
  sit flush — when two share a vertical edge, hover the seam and the same
  kind of pill appears; drag it to trade width (macOS split-view style).
- **Fullscreen** (the ⛶ button) is a viewing mode: the menu bar hides, the
  occupied columns stretch to the full width, and every column runs to the
  bottom of the screen — the last tile in each column is stretched to end
  there. A short tile like the clock is never stretched into a ribbon: under
  another tile it slides to the bottom edge and the tile above grows into the
  gap; alone in its columns it stays as it is. Nothing is saved — the layout
  reverts when you leave fullscreen. A layout deeper than the screen keeps
  its normal row height and scrolls.
- A tile's actions (menus, text size, clear…) live in its **title bar**;
  the small **notch** on the bar's bottom edge hides/shows the whole bar
  for a clean wall-display look.
- The **gear** on a tile holds per-tile settings (filters, text size,
  display options) — these belong to this browser's layout, not the server.
- The **grid icon** — save the current arrangement to the server under a
  name, load a named layout (it becomes a local copy — browsers are never
  linked), or reset this browser's dashboard.
- Every tile has a **status dot**: green = live, amber = connecting,
  red = upstream unreachable (hover it for details). Tiles reconnect
  automatically.

## Included modules

- **ProdCom** — live transcript stream with in-place updates of in-progress
  speech, channel colors, per-tile channel visibility toggles and group
  presets, timestamps, text size and jump-to-latest in the title bar.
  Admin config: ProdCom server (host : port), API key.
- **ProPresenter** — what's live and what's next, with slide progress,
  driven by the shared `propresenter-core` client (ProPresenter 7/20).
  Admin config: ProPresenter endpoint (host : port), password.
- **Timers** — live ProPresenter timers (countdown, countdown-to-time,
  elapsed) and LTC timecode as auto-sized cards. The ＋ picker lists every
  discovered timer (and the LTC card) as its own tile, or add "All timers"
  and pick a selection via the tile's "Timers ▾" menu; overruns are
  unmistakably red. Read-only — no start/stop controls. Admin config:
  ProPresenter endpoint (host : port), password.
- **Clock** — a big booth clock; also the smallest possible module and the
  reference for module authors.

To develop modules against mocks instead of real gear:
`node tools/prodcom-mock.js` (ProdCom on `127.0.0.1:24480`),
`node band-lineup-display/tmp/pp-mock.js 1599` (ProPresenter slides on
`127.0.0.1:1599`) and `node tools/pp-timers-mock.js 1600` (ProPresenter
timers + timecode on `127.0.0.1:1600`). See the testing section of the
[module guide](docs/MODULE-GUIDE.md).

## Install as a desktop web app

Open the page in a browser first, then:

- **macOS — Safari**: File → **Add to Dock…**
- **macOS/Windows — Chrome**: click the install icon in the address bar, or
  ⋮ menu → Cast, save and share → **Install page as app…**
- **Windows — Edge**: ⋯ menu → Apps → **Install this site as an app**

Note: Chrome only offers the one-click PWA install on `http://localhost` (a
"secure context"). When opening from *another* machine over plain HTTP, use
Edge's "Install this site as an app" or Chrome's ⋮ → Cast, save and share →
"Create shortcut…" (check "Open as window") — same result: a dock/taskbar
app in its own window.

## Repository layout

```
ProdDash/
├── server.js                  shell server: static files, module discovery/mounting,
│                              admin + layouts APIs
├── public/                    dashboard shell client (index.html, shell.js, style.css)
│   └── admin/                 admin page client
├── modules/                   installed modules, one folder each
│   ├── clock/
│   ├── prodcom-transcript/
│   └── propresenter-now-next/ (carries its own copy of propresenter-core)
├── config/                    proddash.json defaults (runtime state lives in the
│                              per-machine data directory — see "Configure")
├── docs/MODULE-GUIDE.md       how to build and install a module
├── tools/prodcom-mock.js      mock ProdCom API for development
├── prodcom-listener/          reference fork — read-only, not served
└── band-lineup-display/       reference fork — read-only, not served
```

The two reference folders are snapshots of the apps ProdDash grew out of;
they are not wired into anything (but `band-lineup-display/tmp/pp-mock.js`
is handy for testing).
