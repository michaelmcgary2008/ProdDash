# ProdDash

A new web application, built on lessons and code from two existing Waters Church
production tools, which are included here as reference forks:

```
ProdDash/
├── prodcom-listener/      fork of ProdCom Listener — live transcript web app
│                          (zero-dependency Node server + SSE proxy to the ProdCom API)
└── band-lineup-display/   fork of BandLineupDisplay — backstage stage-lineup Electron app,
                           plus the shared ProPresenter 7/20 client (propresenter-core/)
                           and the standalone Now/Next display (propresenter-app/)
```

The new application will live at the repo root as it takes shape; the two
reference folders are snapshots (build output and `node_modules` excluded) and
are not wired into a build.

## Reference apps at a glance

- **prodcom-listener** — serves a web UI and proxies `/prodcom/*` to the ProdCom
  API, including the Server-Sent Events transcript stream, so browsers never
  talk to ProdCom directly. See [prodcom-listener/README.md](prodcom-listener/README.md).
- **band-lineup-display** — Electron app for the backstage screen showing stage
  lineup photos with mic/pack labels. Carries the ProPresenter **Now / Next**
  feature; `propresenter-core/` is the single home for every ProPresenter
  quirk. See [band-lineup-display/README.md](band-lineup-display/README.md).
