# ProdCom Listener

A small web app that shows the live ProdCom transcript stream in any browser
on your network, and can be installed as a desktop web app on macOS and
Windows.

## How it works

`server.js` (zero dependencies, just Node.js) does two things:

1. Serves the web UI (`public/`).
2. Proxies everything under `/prodcom/*` to the ProdCom API, including the
   Server-Sent Events transcript stream — so browsers on other machines never
   have to talk to ProdCom directly (no CORS issues).

The page loads recent transcript history, then follows the live SSE stream.
In-progress speech updates in place; entries show the channel name in its
ProdCom color. Reconnects automatically if the stream drops.

## Run it

Requires [Node.js](https://nodejs.org) (any recent version).

```bash
node server.js
```

Or double-click **Start ProdCom Listener.command** (macOS) / **start.bat**
(Windows).

Then open the URL it prints — `http://localhost:24481` on this machine, or
the `http://<this-machine's-IP>:24481` address from any other device on the
network.

## Configure

Edit [config.json](config.json):

| Key | Meaning |
| --- | --- |
| `prodcomUrl` | Where the ProdCom API lives (default `http://10.3.11.152:24480`) |
| `port` | Port this listener serves on (default `24481`) |
| `apiKey` | Only needed if PSK auth is enabled in ProdCom settings |

Environment variables `PRODCOM_URL`, `PORT`, and `PRODCOM_API_KEY` override
the file.

## Install as a desktop web app

Open the page in a browser first, then:

- **macOS — Safari**: File → **Add to Dock…**
- **macOS/Windows — Chrome**: click the install icon in the address bar, or
  ⋮ menu → Cast, save and share → **Install page as app…**
- **Windows — Edge**: ⋯ menu → Apps → **Install this site as an app**

Note: Chrome only offers the one-click PWA install on `http://localhost` (a
"secure context"). When opening from *another* machine over plain HTTP, use
Edge's "Install this site as an app" or Chrome's ⋮ → Cast, save and share →
"Create shortcut…" (check "Open as window") — same result: a dock/taskbar app
in its own window.

## UI

- **Status dot** — green = live stream connected, red = reconnecting.
- **Channel dropdown** — filter to a single channel.
- **A− / A+** — text size (remembered per browser).
- **Clear** — clears this view only; never touches ProdCom's transcript.
- Scroll up to pause auto-scroll; a "↓ New messages" button appears to jump
  back to live.
