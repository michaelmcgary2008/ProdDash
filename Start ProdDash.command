#!/bin/zsh
# Double-click to start ProdDash (macOS)
cd "$(dirname "$0")"
# One dashboard per machine: take the port over from any prior instance
# (an SSH- or launchd-started one has no microphone access for the LTC
# listener — launching from here fixes that).
OLD=$(lsof -t -iTCP:24500 -sTCP:LISTEN 2>/dev/null)
[[ -n "$OLD" ]] && kill $OLD 2>/dev/null && sleep 1
# Prefer the bundled runtime (production machines have no system Node)
if [[ -x ./runtime/bin/node ]]; then exec ./runtime/bin/node server.js; fi
exec node server.js
