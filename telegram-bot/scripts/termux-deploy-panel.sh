#!/usr/bin/env bash
# Deploy the admin panel + API to Cloudflare Pages from Termux.
# Run AFTER you cloned the repo. Needs: node, and a Cloudflare API token.
#
#   cd <repo>/telegram-bot
#   bash scripts/termux-deploy-panel.sh
#
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/../admin-panel" && pwd)"
PROJECT=inception-panel

# ---- preflight: node must actually run (Termux ICU breakage is common) ----
echo "==> 0/5 Checking node"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is not installed."
  echo "Fix:  pkg install -y nodejs"
  exit 1
fi
if ! NODE_V="$(node -v 2>&1)"; then
  echo "ERROR: node is installed but cannot run:"
  echo "  $NODE_V"
  echo
  echo "This is the Termux libicu version mismatch. Fix with:"
  echo "  termux-change-repo        # pick ONE mirror (not Rotate)"
  echo "  pkg update -y && pkg upgrade -y"
  echo "  pkg reinstall -y nodejs libicu"
  echo "  node -v                   # must print a version, then re-run this script"
  exit 1
fi
echo "    node $NODE_V"
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm missing. Fix: pkg reinstall -y nodejs"
  exit 1
fi

cd "$PANEL_DIR"

echo "==> 1/5 Installing wrangler + building panel"
npm install
npm run build

echo
echo "==> 2/5 Cloudflare API token"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "Create one at: https://dash.cloudflare.com/profile/api-tokens"
  echo "Custom token with: Account -> Cloudflare Pages -> Edit"
  echo "                   Account -> Workers KV Storage -> Edit"
  echo "Then run:  export CLOUDFLARE_API_TOKEN=xxxxxxxx"
  echo "and re-run this script."
  exit 1
fi

echo "==> 3/5 KV namespace id"
KVID="${CONTROL_KV_ID:-}"
if [ -z "$KVID" ]; then
  echo "Create namespace: dash.cloudflare.com -> Storage -> KV -> Namespaces -> Create"
  echo "Then:  export CONTROL_KV_ID=<namespace id>   and re-run."
  exit 1
fi
sed -i "s/REPLACE_WITH_KV_NAMESPACE_ID/$KVID/g; s/REPLACE_WITH_PREVIEW_KV_NAMESPACE_ID/$KVID/g" wrangler.toml

echo "==> 4/5 Setting secrets (you will be prompted twice)"
echo "   BOT_TOKEN         = your real Telegram bot token from @BotFather"
echo "   BOT_REPORT_SECRET = run: openssl rand -hex 32   (SAVE IT for Part 3)"
npx wrangler pages secret put BOT_TOKEN --project-name "$PROJECT"
npx wrangler pages secret put BOT_REPORT_SECRET --project-name "$PROJECT"

echo "==> 5/5 Deploying"
npx wrangler pages deploy dist --project-name "$PROJECT"
echo
echo "DONE. Your panel URL is shown above (https://$PROJECT.pages.dev)."
echo "Use it as reportUrl in tgcloud/lib/runtime-config.js (Part 3 of DEPLOY.md)."
