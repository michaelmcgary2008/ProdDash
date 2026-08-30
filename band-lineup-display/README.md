# Band Lineup

Stage lineup photos with mic/pack labels, for the backstage screen. Electron, packaged for Windows.

It also carries the ProPresenter **Now / Next** feature, which exists in two forms that share
one engine:

```
BandLineupDisplay/
├── main.js, preload.js, index.html, renderer.js, styles.css   the Band Lineup app
├── propresenter-core/     the shared ProPresenter 7/20 client — no deps, no Electron
└── propresenter-app/      the standalone Now/Next display + the page the band app serves
```

| Want | Do this |
| --- | --- |
| Run the backstage app | `npm start` |
| Show Now/Next on screens around the building | In the app: **People** panel → **Studio Displays** → **Turn On**, then bookmark the address it gives you |
| Host the display without the Band Lineup app | `cd propresenter-app && node server.js` |
| Build the Windows installer | `npm run dist` |

`propresenter-core` is the single home for every ProPresenter quirk — runtime route discovery on
PP20, arrangement-expanded slide totals, uuid-then-name matching for the live item. Fix a quirk
there and both programs get it.

Details on the display, the bookmark that survives DHCP, and the Windows firewall gotcha:
[propresenter-app/README.md](propresenter-app/README.md).

## Testing without ProPresenter

`tmp/pp-mock.js` is a mock of the ProPresenter network API that advances slides on a timer,
including the tricky case where an arrangement repeats a section (43 cues over 41 master slides):

```bash
node tmp/pp-mock.js 1599
```

Then point either program at `127.0.0.1` port `1599`.
