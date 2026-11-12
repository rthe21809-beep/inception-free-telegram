#!/usr/bin/env bash
# Deploy the admin panel + API to Cloudflare Pages from Termux.
# Run AFTER you cloned the repo. Needs: node, and a Cloudflare API token.
#
#   cd ~/inception-free-telegram/telegram-bot
#   bash scripts/termux-deploy-panel.sh
#
set -euo pipefail

PANEL_DIR="$(cd "$(dirname "$0")/../admin-panel" && pwd)"
PROJECT=inception-panel

cd "$PANEL_DIR"

echo "==> 1/5 Installing wrangler + building panel"
npm install
npm run build

echo
echo "==> 2/5 Cloudflare API token"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "Create one at: https://dash.cloudflare.com/profile/api-tokens"
  echo "Use template 'Edit Cloudflare Workers' (gives Pages:Edit + KV:Edit)."
  echo "Then run:  export CLOUDFLARE_API_TOKEN=xxxxxxxx"
  echo "and re-run this script."
  exit 1
fi

echo "==> 3/5 KV namespace id"
KVID="${CONTROL_KV_ID:-}"
if [ -z "$KVID" ]; then
  echo "Create namespace: Workers & Pages -> KV -> Create namespace -> name it CONTROL_KV"
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
