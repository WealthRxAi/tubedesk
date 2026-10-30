#!/bin/bash
# Double-click me: installs dependencies, registers TubeDesk as a login service, opens it in your browser.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "== TubeDesk installer =="
if ! command -v node >/dev/null; then echo "Node.js not found. Install from https://nodejs.org and run me again."; read -n1 -p "Press any key to close"; exit 1; fi
npm install --omit=dev --no-audit --no-fund || { echo "npm install failed"; read -n1 -p "Press any key to close"; exit 1; }
bash ./install-mac.sh || { echo "service install failed"; read -n1 -p "Press any key to close"; exit 1; }
sleep 1; open "http://localhost:4949"
echo; echo "TubeDesk is running at http://localhost:4949 and will start automatically at login."
echo "You can close this window."
