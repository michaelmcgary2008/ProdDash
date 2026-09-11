# ProdDash

Modular production dashboard web app for Waters Church, developed in this repo.
The app lives at the repo root and is built: zero-dependency Node server
(`server.js`, Node 18+), dashboard shell client in `public/`, admin page at
`/admin`, modules in `modules/`, and a native macOS menu-bar launcher in
`launcher/macos/` (Swift, no dependencies — it supervises the server and owns
the macOS permissions modules declare; see its README). Runtime state (module
config, named layouts) is written to a per-machine data directory outside the
checkout (`PRODDASH_DATA_DIR` overrides; see README "Where settings are
kept") — never add code that writes runtime state into the repo folder.
[SPEC.md](SPEC.md) was the authority for the initial build;
[README.md](README.md) has run/configure/use instructions.

## Building a new module — read docs/MODULE-GUIDE.md first

**[docs/MODULE-GUIDE.md](docs/MODULE-GUIDE.md) is the authority on the module
contract** (manifest, client factory + moduleApi, optional server entry,
title-bar controls). The rules that matter most:

- A module is one self-contained folder in `modules/` — **never modify the
  shell** (`server.js`, `public/`) to add one. Installation = the admin page's
  Available modules (downloads from the repo into the data directory), or
  drop the folder and restart; configure in `/admin`.
- **All settings in the admin page** (`configSchema` / `instanceSchema`) —
  never a separate setup page, hand-edited file or env var. **Dependencies
  ship inside the module folder** (zero deps is the norm). **Everything the
  module does runs inside its server entry** — no helper scripts, companion
  programs or daemons the operator starts by hand; a listener or decoder is
  started in `init()` and stopped in `stop()`. Declare `"proddash": ">=x.y.z"`
  and bump the module's `version` on every change.
- Browsers never call upstream services directly; the module's server routes
  proxy everything (no CORS, secrets stay server-side).
- Style with the shell's CSS variables only, scoped under
  `[data-module="<id>"]`; survive upstream loss (reconnect + `setStatus`).
- Verify against the guide's testing section and resilience checklist. Mocks
  for the existing upstreams: `node tools/prodcom-mock.js` (ProdCom) and
  `node band-lineup-display/tmp/pp-mock.js 1599` (ProPresenter).

## Reference code (read-only forks — don't develop these here)

- `prodcom-listener/` — live ProdCom transcript web app. Zero-dependency Node
  `server.js` that serves `public/` and proxies `/prodcom/*` (including the SSE
  transcript stream) to the ProdCom API at `config.json → prodcomUrl`
  (default `http://10.3.11.152:24480`). Good reference for: SSE handling,
  reconnect logic, channel colors/filtering, PWA install.
- `band-lineup-display/` — backstage Electron app (stage lineup photos with
  mic/pack labels) plus ProPresenter Now/Next:
  - `band-lineup-display/propresenter-core/` — shared ProPresenter 7/20 client,
    no deps, no Electron. All ProPresenter quirks live here (PP20 runtime route
    discovery, arrangement-expanded slide totals, uuid-then-name live-item
    matching). Reuse this rather than re-implementing ProPresenter access.
  - `band-lineup-display/propresenter-app/` — standalone Now/Next web display.
  - `band-lineup-display/tmp/pp-mock.js` — mock ProPresenter API for testing
    without the real thing: `node tmp/pp-mock.js 1599`, then point at
    `127.0.0.1:1599`.

Upstream sources: ProdCom Listener lives at
`github.com/michaelmcgary2008/prodcom-listener`; BandLineupDisplay exists only
on the production machine. These folders are snapshots, not submodules.
