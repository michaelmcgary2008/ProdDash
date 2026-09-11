# ProdDash for macOS

The Mac application: a menu-bar app that carries the dashboard, its own Node
runtime, and the permissions its modules need. Installing it is dragging
**ProdDash** to Applications — nothing else has to be present on the machine,
and nothing can go missing from under it.

Build it with `./build.sh`. The app is native Swift with no dependencies of
its own; the Node it ships is fetched from nodejs.org at build time and
checksum-verified.

## What's in the bundle

```
ProdDash.app/Contents/
  MacOS/ProdDash            the launcher (Swift, ~1 MB)
  Resources/node/bin/node   the Node runtime ProdDash runs on
  Resources/app/            server.js, public/, modules/ — ProdDash itself
```

Everything mutable lives outside, in `~/Library/Application Support/ProdDash`:
module config, layouts, modules installed from the admin page — and `app/`,
the copy of ProdDash that actually runs.

**Why a copy, when the bundle already has one.** ProdDash updates itself: the
admin page's **Update now** downloads a new version and writes it over the app
folder. Nothing may write inside a signed `.app` without breaking its
signature, so the bundle carries a read-only baseline and the data directory
carries the copy that runs. Both routes to a new version work, and they don't
fight: installing a newer `.app` replaces the copy, while a copy that has
already updated itself past the bundle is left alone.

## Why it exists

**Permissions.** macOS grants privacy permissions to the *application* that
owns a process, and a child inherits its parent's identity. Started from here,
node — and the Timers module's `ltc-capture` — belong to this app bundle, so
the microphone and local-network prompts are asked, and remembered, as
ProdDash. Started over SSH or from a bare launchd job there is nobody to ask:
the permission is silently absent rather than refused, which is the "endless
zeroes, no error" failure `ltc-listener.js` warns about.

**Supervision.** The shell was built for this: with `PRODDASH_LAUNCHER=1` it
exits **75** instead of respawning itself when the admin page applies an
update, which the launcher reads as "start me again" rather than as a fault.
A crash gets a backed-off restart (1s, 2s, 5s, 10s); four in two minutes stops
the cycle rather than spinning forever.

## Build

```bash
./build.sh                 # build/ProdDash.app — the whole application
./build.sh --dmg           # …and build/ProdDash-<version>-arm64.dmg
./build.sh --install       # …and copy it to /Applications
./build.sh --run           # …and open it
./build.sh --notarize      # with --dmg: notarise and staple (Developer ID)
./build.sh --dev           # launcher only: no Node, no server — runs against
                           # the checkout. Seconds, for work on the launcher.
```

Needs the Xcode command line tools (`xcode-select --install`) and macOS 13 or
newer. The first build downloads Node (~50 MB) into `.cache/` and reuses it.
A full build takes about ten seconds and produces a 117 MB app, 43 MB
compressed in the disk image.

Builds for **Apple Silicon**. To change that, or to move to a newer Node, edit
`ARCH` and `NODE_VERSION` at the top of `build.sh` — the download is verified
against nodejs.org's published checksums either way.

The app icon is built from `public/icons/icon-512.png`, so ProdDash's own icon
is the app's icon. A module's native helper is compiled during the build
(`<name>.swift` beside a module's files becomes `<name>`), so the Mac running
ProdDash never needs a compiler.

## Signing

`build.sh` uses a **Developer ID Application** certificate when one is
installed, and signs ad-hoc when none is — which is fine on your own Macs, but
another Mac will refuse the app until someone approves it under System
Settings → Privacy & Security.

To sign properly you need the Apple Developer Program (paid) and a Developer
ID certificate — note this is not the same as the "Apple Development"
certificate Xcode creates for you:

1. Xcode → Settings → Accounts → your team → **Manage Certificates** →
   **+** → **Developer ID Application**. (Requires Account Holder or Admin
   on the team.) `security find-identity -v -p codesigning` should then
   list a `Developer ID Application: …` identity.
2. Store notarisation credentials once, with an app-specific password from
   [appleid.apple.com](https://appleid.apple.com):

   ```bash
   xcrun notarytool store-credentials proddash --apple-id you@example.com --team-id TEAMID
   ```

3. `./build.sh --notarize`

Then the disk image opens by double-click on any Mac, with no warnings.
`CODESIGN_IDENTITY` overrides the certificate; `NOTARY_PROFILE` overrides the
keychain profile name.

## Using it

The menu-bar icon is ProdDash's 2×2 tile mark; the accent tile is lit green
while the server runs, amber mid-move, red when something needs a person, and
hollow when it is stopped. Its menu has the whole app in it:

- **Open Dashboard** / **Open Admin** — the running server, in a browser.
- **Start / Stop / Restart ProdDash**.
- **Launcher…** — the window below.
- **Open at Login** — a login item, through the modern `SMAppService` API.
- **Quit ProdDash** — stops the server too, and asks first while it is
  running.

The window has the status, both addresses the dashboard answers on, and three
tabs:

- **Log** — everything the server prints, plus what the launcher did and why.
  Also written to `~/Library/Logs/ProdDash/proddash-<date>.log`, kept a week.
- **Settings** — the port, and how it starts (at login, server on open,
  restart on crash, open a browser, show this window). It also shows which
  copy of ProdDash is running, which node, and where settings are kept.
- **Permissions** — one line per permission: a status dot, its name, and the
  one thing you can do about it. See below.

### Port

The port belongs to ProdDash, not to the launcher, so it is written to
`proddash.json` in the data directory — the file the server already reads.
Set it here and ProdDash keeps that port however it is started next. Changing
it while the server runs restarts it.

### Permissions

What appears is what the installed modules declare in their manifests
(`"permissions": [ … ]` — see
[docs/MODULE-GUIDE.md](../../docs/MODULE-GUIDE.md)); hover a row to see which
module asked, and why.

- **Microphone** — asked for directly, with the status macOS reports.
- **Local Network** — macOS has no API that reports whether this was granted,
  so **Check Access** asks the network instead: it browses for Bonjour
  services (which is what raises the prompt) and tries every upstream the
  admin page is pointed at. Nothing answering, when the gear is on, means
  macOS is withholding access.
- **Notifications** — the launcher's own, so a server that stops while nobody
  is watching still reaches someone. Turn them off for ProdDash in System
  Settings if you'd rather not have them.

On first run the launcher asks for what the modules declare, while someone is
still at the keyboard, rather than halfway through a service.

## Details worth knowing

- **One instance.** Opening a second copy raises the first one's window.
- **Port already in use.** If something already holds the port, the launcher
  asks before doing anything. When that something answers like ProdDash — an
  SSH-started copy, say, with no microphone access — it offers to take the
  port over.
- **Stopping is thorough.** The server is spawned into its own process group,
  so stopping it also stops anything it started. An orphaned `ltc-capture`
  would otherwise hold an audio device until someone found it in Activity
  Monitor.
- **Signals.** `killall ProdDash`, a logout or a shutdown stops the server
  first rather than leaving node running.
- **Nothing is required outside the app.** A development build (`--dev`)
  carries no server and no Node, and runs the checkout it was built in with
  whatever node is on the machine — Settings → ProdDash folder points it
  somewhere else.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| "ProdDash can't be opened because Apple cannot check it" | The app is ad-hoc signed. System Settings → Privacy & Security → **Open Anyway**, once. Signing it properly (above) removes this. |
| "ProdDash stopped 4 times in two minutes" | The server is failing on startup — the Log tab has its own error. |
| LTC shows no signal | Permissions tab → Microphone. If it says granted and the input is still silent, the server may be an older copy started outside the app — Stop, then Start. |
| Nothing on the network answers | Permissions tab → **Check Access**. |
| A development build says it can't find ProdDash | `--dev` builds need a checkout: Settings → ProdDash folder. |
