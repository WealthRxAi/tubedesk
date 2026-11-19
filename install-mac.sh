#!/bin/bash
# Installs TubeDesk as a macOS LaunchAgent: starts at login, restarts if it crashes.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then echo "node not found on PATH"; exit 1; fi
PORT="${PORT:-4949}"
PLIST="$HOME/Library/LaunchAgents/com.tubedesk.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cd "$DIR" && npm install --omit=dev --no-audit --no-fund
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.tubedesk</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/src/server.js</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>$PORT</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/tubedesk.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/tubedesk.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf "http://localhost:$PORT/api/status" >/dev/null && break; sleep 1; done
if curl -sf "http://localhost:$PORT/api/status" >/dev/null; then
  echo "TubeDesk is running at http://localhost:$PORT (LaunchAgent com.tubedesk, log: ~/Library/Logs/tubedesk.log)"
else
  echo "Started, but no response yet on port $PORT — check ~/Library/Logs/tubedesk.log"; exit 1
fi
