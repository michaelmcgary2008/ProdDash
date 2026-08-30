# ProdDash

New web application for Waters Church production, to be developed in this repo.
The stack and structure of the new app are not yet decided — build it at the
repo root (or in an `app/` folder if that stays cleaner).

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
