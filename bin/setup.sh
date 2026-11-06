#!/usr/bin/env bash
# setup.sh — one-shot installer for a fresh server.
#
# What it does:
#   1. checks Node.js >= 18
#   2. installs npm dependencies (playwright is optional; skipped if offline)
#   3. finds or installs a chromium/chrome binary so the bridge can solve the
#      Vercel checkpoint automatically (auto warmup) and stream from a real
#      browser context
#   4. prints the next steps
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32mOK  \033[0m%s\n' "$*"; }
warn() { printf '\033[1;33m !! \033[0m%s\n' "$*"; }

step "Node.js check"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js >= 18 is required (https://nodejs.org)."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js >= 18 required, found $(node --version)."
  exit 1
fi
ok "node $(node --version)"

step "npm dependencies"
if npm install --no-audit --no-fund; then
  ok "dependencies installed"
else
  warn "npm install failed (offline?). The bridge still runs with zero npm deps —"
  warn "only register-playwright.mjs needs the playwright package."
fi

step "Browser (chromium/chrome)"
CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || command -v google-chrome-stable || true)"
if [ -n "$CHROME" ]; then
  if grep -q '^BRIDGE_CHROMIUM=' .env 2>/dev/null || [ -f .env ] && grep -q '^BRIDGE_CHROMIUM=' .env; then
    :
  fi
  ok "browser found: $CHROME"
  echo "    hint: add this line to your .env to make it explicit:"
  echo "          BRIDGE_CHROMIUM=$CHROME"
else
  warn "no chromium/chrome binary found on PATH."
  if command -v apt-get >/dev/null 2>&1; then
    echo "    installing via apt (Debian/Ubuntu):"
    echo "      sudo apt-get update && sudo apt-get install -y chromium"
  elif command -v dnf >/dev/null 2>&1; then
    echo "    installing via dnf (Fedora/RHEL):"
    echo "      sudo dnf install -y chromium"
  elif command -v apk >/dev/null 2>&1; then
    echo "    installing via apk (Alpine):"
    echo "      apk add chromium"
  else
    echo "    install a browser any way you like, then set BRIDGE_CHROMIUM"
    echo "    in .env (or use: npx playwright install chromium)."
  fi
fi

step "Next steps"
echo "  1. Get a session (one-time):"
echo "       npm run warmup        # auto-solve the checkpoint (needs a browser)"
echo "       # or manually paste cookies:"
echo "       npm run creds"
echo "  2. Start the bridge:"
echo "       ./bin/inception-free --api-key YOUR_KEY"
echo "  3. Self-test (offline):"
echo "       npm run smoke"
echo "  4. Point your chat platform at:"
echo "       http://127.0.0.1:8890/v1   (model: mercury-3)"
