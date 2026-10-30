#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null; then echo "Install Node.js from https://nodejs.org first."; read -p "Press Enter to close"; exit 1; fi
[ -d node_modules ] || npm install
npm start
