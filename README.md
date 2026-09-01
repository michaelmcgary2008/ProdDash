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
4. Stores server-wide module config and named layouts under `config/`.

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

Shell settings live in [config/proddash.json](config/proddash.json):

| Key | Meaning |
| --- | --- |
| `port` | Port ProdDash serves on (default `24500`) |
| `adminPasscode` | If set, the admin page asks for this shared passcode. Leave `""` for none — it's a plain-HTTP LAN tool. |

Environment variables `PORT` and `PRODDASH_PASSCODE` override the file.
`config/modules.json` (module config) and `config/layouts/` (named layouts)
are written by the app itself.

## Using the dashboard

- **＋** — add any enabled module; multiple tiles of the same module are
  fine (e.g. two transcripts filtered to different channels).
- Drag a tile by its **title bar** to move it; drag the **corner handle**
  to resize; **✕** removes it. Tiles sit flush — when two share an edge,
  hover the seam and a small grab pill appears; drag it to trade width
  between the two tiles (macOS split-view style).
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
  ProPresenter endpoint (host : port), API password, stage display
  password, LTC reader token.

  LTC sources, best first (ProPresenter's HTTP API has no timecode route):
  1. **The LTC audio feed itself** — run `tools/ltc-reader.js` on any
     machine that can hear the LTC signal; it decodes the SMPTE frames from
     a PCM pipe (ffmpeg/sox one-liners in its header) and POSTs
     running/stopped/no-signal, the timecode, and the frame rate (incl.
     29.97 drop-frame) to the module's `/ltc` ingest route. `--selftest`
     checks the decoder; `--demo` feeds synthetic LTC end-to-end with no
     audio hardware.
  2. A stage-display layout field labeled "LTC", read over ProPresenter's
     stage websocket — value and freshness only, no frame rate.
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
├── config/                    proddash.json + state written by the app
├── docs/MODULE-GUIDE.md       how to build and install a module
├── tools/prodcom-mock.js      mock ProdCom API for development
├── prodcom-listener/          reference fork — read-only, not served
└── band-lineup-display/       reference fork — read-only, not served
```

The two reference folders are snapshots of the apps ProdDash grew out of;
they are not wired into anything (but `band-lineup-display/tmp/pp-mock.js`
is handy for testing).
