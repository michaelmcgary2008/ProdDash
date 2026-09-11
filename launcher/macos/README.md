# ProdDash Launcher (macOS)

A menu-bar app that starts, stops and watches over the ProdDash server on a
Mac — and, just as importantly, **owns the permissions its modules need**.

It is a native Swift app: about 1 MB, no dependencies, nothing to install but
the app itself. Build it with `./build.sh`.

## Why a launcher, and not just `Start ProdDash.command`

Two reasons, and the second is the one that bites.

**Supervision.** The server is started as a child process, its output is kept
in a log, and it is brought back if it stops on its own. The shell was built
for this: with `PRODDASH_LAUNCHER=1` in its environment it exits **75** rather
than respawning itself when the admin page applies an update, which the
launcher reads as "start me again" instead of as a fault. A crash gets a
backed-off restart (1s, 2s, 5s, 10s); four crashes in two minutes stops the
cycle, so a broken install doesn't spin forever.

**Permissions.** macOS grants privacy permissions to the *application* that
owns a process, and a child inherits its parent's identity. Start ProdDash
from here and node — plus the Timers module's `ltc-capture` tool — belong to
this app bundle, so the microphone and local-network prompts are asked, and
remembered, as **ProdDash**. Start it over SSH or from a bare launchd job and
there is no owner to ask: the permission is silently absent rather than
refused, and an LTC input reads as endless zeroes with no error anywhere.
That is the failure `modules/propresenter-timers/ltc-listener.js` warns about,
and this is the fix.

## Build

```bash
cd launcher/macos
./build.sh                  # build/ProdDash.app, universal (Apple Silicon + Intel)
./build.sh --install        # …and copy it to /Applications
./build.sh --run            # …and open it
./build.sh --arch native    # this Mac's architecture only — faster while iterating
```

Needs the Xcode command line tools (`xcode-select --install`) and macOS 13 or
newer. The app icon is built from `public/icons/icon-512.png`, so ProdDash's
own icon is the app's icon.

The build is signed ad-hoc, which is all a local tool needs — but the
signature changes on every rebuild, so macOS may treat a rebuilt app as a new
one and ask for the microphone again. Build once, install it, and leave it.

## Using it

The menu-bar icon is ProdDash's 2×2 tile mark; the accent tile is lit green
while the server runs, amber mid-move, red when something needs a person, and
hollow when it is stopped. Its menu has the whole app in it:

- **Open Dashboard** / **Open Admin** — the running server, in a browser.
- **Start / Stop / Restart ProdDash**.
- **Launcher…** — the window below.
- **Open at Login** — a login item, through the modern `SMAppService` API.
- **Quit ProdDash** — stops the server too, and asks first while it is running.

The window has the status, both addresses the dashboard answers on, and three
tabs:

- **Log** — everything the server prints, plus what the launcher did and why.
  Also written to `~/Library/Logs/ProdDash/proddash-<date>.log`, kept a week.
- **Settings** — the port, and how it starts (at login, server on open,
  restart on crash, open a browser, show this window). It also shows the
  ProdDash folder, the node binary in use and where settings are kept.
- **Permissions** — what the installed modules declare they need, who needs
  it, and what macOS currently allows. See below.

### Port

The port belongs to ProdDash, not to the launcher, so it is written to
`proddash.json` in the data directory — the file the server already reads.
Set it here and ProdDash keeps that port however it is started next. Changing
it while the server runs restarts it.

### Permissions

One line per permission: a status dot, its name, and the one thing you can do
about it. What appears is what the installed modules declare in their
manifests (`"permissions": [ … ]` — see
[docs/MODULE-GUIDE.md](../../docs/MODULE-GUIDE.md)); hover a row to see which
module asked, and why.

- **Microphone** — asked for directly, with the status macOS reports.
- **Local Network** — macOS has no API that reports whether this was granted,
  so **Check Access** asks the network instead: it browses for Bonjour
  services (which is what raises the prompt) and tries every upstream the
  admin page is pointed at, then says what the result means. Nothing
  answering, when the gear is on, means macOS is withholding access.
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
- **Where the settings live.** ProdDash's port is in the data directory's
  `proddash.json`; everything else (auto-start, restart-on-crash, the paths)
  is the launcher's own, in its preferences.
- **Finding things.** The ProdDash folder is the checkout the app was built
  inside, or `~/Apps/ProdDash` and the other usual spots, or whatever you
  pick under Settings. Node is the checkout's bundled `runtime/bin/node` if
  there is one, then Homebrew, `/usr/local`, nvm, Volta, and finally whatever
  a login shell finds.

## Troubleshooting

| What you see | What it means |
| --- | --- |
| "Can't find the ProdDash folder" | Point it at the folder with `server.js` in it, under Settings. |
| "Node.js 18 or newer isn't installed" | Install Node. A GUI app inherits almost no `PATH`, so one in an unusual place may not be found — Settings shows which one is in use. |
| "ProdDash stopped 4 times in two minutes" | The server is failing on startup — the Log tab has its own error. |
| LTC shows no signal | Permissions tab → Microphone. If it says granted and the input is still silent, the server may be an older copy started outside the launcher — Stop, then Start. |
| Nothing on the network answers | Permissions tab → **Check Access**. |
