# Stage Now / Next

The ProPresenter **Now / Next** display, as its own program — the same feature that
lives in the Band Lineup app's right-hand column, but on its own so it can run on
studio machines, hallway TVs, green-room tablets, anywhere in the building.

Both programs share one engine: [`../propresenter-core`](../propresenter-core/index.js).
Fix a ProPresenter quirk there and both get the fix.

---

## The easiest way: let the Band Lineup app host it

If the backstage machine already runs **Band Lineup**, you don't need to start anything here.
Open the app, and in the **People** panel find **Studio Displays** → **Turn On**.

It then lists the addresses to use, best first, each with a **Copy** button. Open one on any
screen in the building and bookmark it. Nothing to install on those screens.

Because the app hands the display its own ProPresenter connection, there is exactly one
connection to ProPresenter no matter how many screens are watching, and the studios always
show precisely what the backstage screen shows. The connection is still set up in one place — the
app's ProPresenter section — and the studio screens' own settings are locked, with a note
saying so.

The displays are live whenever Band Lineup is open. Close the app and every screen says
**Display offline** and names the backstage computer, rather than quietly showing a frozen
lineup. They come back on their own when the app reopens — no reloading needed.

### The bookmark that keeps working

The first address in the list is `http://nownext.local:7654`. The app publishes that name
itself over mDNS, so the bookmark survives the backstage machine getting a new IP from DHCP.
It resolves on Macs, iPads and Windows 10/11.

Do **not** bookmark the computer's own name (`http://backstage-pc.local:7654`) — Windows can
*resolve* mDNS names but never *publishes* its own, so Macs and iPads get nothing back.

If `nownext.local` doesn't work on a particular screen (some managed networks and separate
VLANs block mDNS), use one of the numeric addresses below it. Once any screen has loaded
the page from an address, that address is relabelled **Confirmed working** and moves to the
top — so after the first studio connects, the app knows the right answer for your building.

For a permanently fixed address, ask IT for a DHCP reservation on the backstage machine, and
optionally a DNS name pointing at it. One caveat if you go the DNS route: the zone must not
end in `.local`, or Apple devices will route the lookup to mDNS and it will fail.

### If a studio screen can't load the page (Windows)

Almost always Windows Defender Firewall. Two things make this confusing:

- The prompt appears when the app **starts serving**, not when a studio first connects — so
  the backstage machine looks perfectly fine on `localhost` while every other screen times out.
- If whoever answered the prompt wasn't a local admin, Windows creates **block** rules no
  matter which button they pressed, and it never asks again.

The installer adds the allow rules for you, so a normal install is fine. If you're running
an unpacked build or the rules got lost, an admin can restore them:

```bash
netsh advfirewall firewall add rule name="Band Lineup Display (TCP)" dir=in action=allow program="C:\Program Files\Band Lineup\Band Lineup.exe" enable=yes profile=domain,private protocol=TCP
```

The app helps you spot this: if hosting is on and no screen has ever connected, the Studio
Displays status line says so and names the port to allow.

Other things that break a working setup: the backstage PC sleeping (turn off sleep on a machine
that hosts displays), and Windows flipping the network profile to *Public* — the allow rules
above only cover Domain and Private.

### Keep the studio screens awake

The page asks the browser for a screen wake lock, but browsers only grant that on a secure
(HTTPS) origin, and this is served over plain HTTP on the LAN — so the request is always
refused. Turn off screen sleep in the OS settings on any machine or tablet you leave running
as a dedicated display; the web page cannot do it for you.

---

## Security: what's protected, and what isn't

Be clear-eyed about this one, because the honest answer is unusual.

**Viewing is deliberately open.** Anyone who can reach the port can watch the page. There is no
password, and adding one was considered and rejected: a wall TV has to come back by itself
after a power cut with nobody standing there, and a login prompt, a key in the URL, or a
certificate warning all break exactly that. A key in the URL would also live forever in every
bookmark and in the address list volunteers copy into group chats.

**More importantly, gating this page would not raise the bar much.** ProPresenter's own network
API on the same LAN has no authentication at all, and unlike this page it is not read-only.
Anyone who can reach this display can already read the same service order straight from
ProPresenter — and put whatever they like on the main screen. **Network placement is the control
that actually covers both.**

### What is protected

- **Nothing can be changed over the network** while the Band Lineup app is hosting. The
  connection routes return `409`, so a browser on the LAN cannot retarget or disconnect the
  display. Standalone additionally requires `application/json`, a same-origin request, and a
  recognised `Host` — which blocks the JavaScript-free form CSRF and DNS-rebinding writes that
  are otherwise possible against a local HTTP server.
- **Hidden items stay hidden.** Anything flagged hidden in ProPresenter — cut songs, contingency
  cues, staff-only slides — has its name stripped before it leaves the machine, not merely
  skipped when drawing the page.
- **The playlist library is not exposed.** `/api/playlists` is refused while the app is hosting.
- **Connection limits.** Concurrent viewers are capped (32 total, 6 per device) so nobody can pile
  up connections inside the app, and a screen that stops reading is dropped rather than buffered
  forever. Established screens are never dropped to make room for a new one.
- **The mDNS name can't be stolen with one packet.** A claim on `nownext.local` is verified by
  probing before this host stands aside, and it reclaims the name when the other host leaves.

### What is exposed

Song and sermon titles, slide numbers, and the upcoming service order — in the clear, over plain
HTTP, to anything that can reach the port. Also the ProPresenter machine's address and port, and
the host's LAN addresses. Decide whether an unannounced sermon title or a baptism in the order
matters to you before a service; if it does, the answer is the VLAN below, not a password.

### Where this should live on the network

- Backstage PC, ProPresenter, and the display screens on a **trusted A/V or management VLAN**.
- **Guest Wi-Fi kept off that VLAN.** This is the single highest-value control here.
- A **DHCP reservation** for the backstage machine — which you want anyway so bookmarks survive.
- If you ever set a ProPresenter network password, treat it as a LAN-visible string: it travels
  in the query string of ProPresenter's own API on every poll, because that is the interface
  ProPresenter offers.

---

## Run it standalone

For a machine that doesn't run Band Lineup — or to host the display without it — run the
server on its own. Every other screen just opens a web page.

```bash
cd propresenter-app
node server.js
```

Then open `http://localhost:7654` on that machine, press the **gear** (bottom-right,
appears when you move the mouse or tap), and enter the IP and port of the computer
running ProPresenter. That's it — the connection is stored on the server, so every
other screen that opens the page is already following along.

The startup log prints the addresses other screens should use, e.g.
`http://10.1.1.42:7654`. They're also listed in the settings panel under
**Other screens**.

Requirements: Node 18 or newer. No `npm install`, no dependencies.

### ProPresenter side

Turn the network API on in **ProPresenter ▸ Preferences ▸ Network**. Note the port
(1025 by default) and set a password there if you want one.

## Run it as an app window

For the machine that should *host* the display, there's an Electron wrapper that
starts the same server and shows the page in a window:

```bash
npm run kiosk
```

```bash
npm run kiosk -- --kiosk
```

The second form is true kiosk: no window chrome, fullscreen, for a dedicated screen.
Either way the server still serves the rest of the building.

## Options

| What | How |
| --- | --- |
| Different port | `PORT=9000 node server.js` |
| Lock the settings so viewers can't change the connection | `PP_DISPLAY_READONLY=1 node server.js` |
| Move where `config.json` lives (a NAS, a shared path) | `PP_DISPLAY_DATA_DIR=/path/to/dir node server.js` |

Per-screen looks — text size (Small → Huge), whether to show the playlist name, the
progress bar, and whether to tidy titles — are set in the gear panel and saved on
**that device only**, so a 65" TV and an iPad can each be sized for their own room.

Keyboard: `f` toggles fullscreen, `Esc` closes the settings panel.

## Running it as a service

Any process manager works since it's a plain Node script. For example, with `pm2`:

```bash
pm2 start server.js --name stage-now-next -- --port 7654
```

## What's in here

| File | Job |
| --- | --- |
| `server.js` | Serves the UI and pushes the live view-model to every browser over SSE. Standalone it polls ProPresenter itself; embedded it mirrors the client the Band Lineup app is already polling with |
| `config.js` | Reads/writes `config.json` (password obfuscated at rest — treat the file as a secret), and ranks which LAN address to bookmark |
| `mdns.js` | Publishes `nownext.local` so a bookmark survives a DHCP change. Zero dependencies |
| `public/index.html`, `public/app.js`, `public/styles.css` | The display itself and the settings panel |
| `main.js` | Optional Electron kiosk wrapper |
| `../propresenter-core/index.js` | The shared ProPresenter client — also used by the Band Lineup app |

## API

Anything on the LAN can read the live state, which makes it easy to hang other
displays or automations off the same feed:

| Endpoint | Returns |
| --- | --- |
| `GET /api/state` | `{ state, status }` — one JSON snapshot |
| `GET /api/stream` | Server-Sent Events: `state` on every poll, `status` on connection changes |
| `GET /api/status` | Connection info only |
| `GET /api/playlists` | Every playlist ProPresenter knows about |
| `GET /api/health` | `{ ok, viewers, reachable }` |
| `POST /api/connect` | `{ host, port, password? }` — tests, saves, and starts following |
| `POST /api/disconnect` | Stops following; keeps host/port for next time |

The two `POST` routes return `403` when `PP_DISPLAY_READONLY=1`, and `409` when the Band
Lineup app is hosting — a browser on the LAN must never be able to retarget or disconnect
the backstage app's own ProPresenter connection.

## Notes

- **The display auto-follows whatever ProPresenter is presenting** — the live playlist
  and item come from ProPresenter itself, so there's nothing to pick each week.
- **Slide totals respect arrangements.** If an arrangement repeats a chorus, the total
  counts the repeat, so "Slide 41 / 43" always matches what the operator sees.
- **Building a Windows installer** (`npm run dist`) needs `npm install` in this folder
  first, and packages `../propresenter-core` alongside — keep the two folders siblings.
  The everyday `node server.js` path needs neither step.
