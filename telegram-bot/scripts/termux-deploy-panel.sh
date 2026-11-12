#!/usr/bin/env bash
# Deploy the admin panel + API to Cloudflare Pages from Termux.
#
# Uses the Cloudflare REST API directly (scripts/cf-deploy.mjs) — NO wrangler,
# because wrangler ships the precompiled "workerd" binary which has no Android
# arm64 build and can never run in Termux.
#
#   cd <repo>/telegram-bot
#   bash scripts/termux-deploy-panel.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PANEL_DIR="$(cd "$HERE/../admin-panel" && pwd)"

# ---- preflight: node must actually run (Termux ICU breakage is common) ----
echo "==> 0/4 Checking node"
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

cd "$PANEL_DIR"

echo "==> 1/4 Installing deps + building panel"
# Root dep: the deployer hashes assets with blake3 (Cloudflare asset keys).
# It must be installed at the repo root, not inside admin-panel/.
( cd "$HERE/.." && npm install --no-audit --no-fund --silent ) || {
  echo "root npm install failed; blake3-wasm is required by cf-deploy.mjs" >&2
  exit 1
}
cd "$PANEL_DIR"
npm install --no-audit --no-fund
npm run build

echo
echo "==> 2/4 Cloudflare credentials"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat <<'EOT'
CLOUDFLARE_API_TOKEN is not set. Create one:
  1. open https://dash.cloudflare.com/profile/api-tokens
  2. "Create Token" -> "Create Custom Token"
  3. Permissions:  Account -> Cloudflare Pages -> Edit
                   Account -> Workers KV Storage -> Edit
  4. Account Resources: your account
  5. Create, copy the token, then:
        export CLOUDFLARE_API_TOKEN=xxxxxxxxxxxxxxxx
EOT
  exit 1
fi
if [ -z "${CONTROL_KV_ID:-}" ]; then
  cat <<'EOT'
CONTROL_KV_ID is not set. Create the namespace:
  1. open https://dash.cloudflare.com
  2. left sidebar -> Storage -> KV -> Namespaces -> "Create a namespace"
  3. name it CONTROL_KV
  4. copy the 32-hex "Namespace ID", then:
        export CONTROL_KV_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EOT
  exit 1
fi

echo "==> 3/4 Secrets (paste when asked; input is hidden)"
if [ -z "${BOT_TOKEN:-}" ]; then
  printf 'BOT_TOKEN (from @BotFather /mybots -> API Token): '
  read -rs BOT_TOKEN; echo
fi
if [ -z "${BOT_REPORT_SECRET:-}" ]; then
  SUGGESTED="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  echo "BOT_REPORT_SECRET — press Enter to use a fresh random one:"
  echo "   $SUGGESTED"
  printf 'BOT_REPORT_SECRET: '
  read -rs _INPUT; echo
  if [ -z "$_INPUT" ]; then
    BOT_REPORT_SECRET="$SUGGESTED"
    echo "   using the generated value above."
  else
    BOT_REPORT_SECRET="$_INPUT"
  fi
fi
export BOT_TOKEN BOT_REPORT_SECRET

echo "==> 4/4 Deploying via Cloudflare REST API"
echo "   >>> COPY THE BOT_REPORT_SECRET BELOW NOW — you must paste it into"
echo "   >>> tgcloud/lib/runtime-config.js (reportSecret), or the bot can't talk to the panel."
echo "   BOT_REPORT_SECRET = $BOT_REPORT_SECRET"
echo
node "$HERE/cf-deploy.mjs"

echo
echo "DONE."
echo "1) Use the https://<project>.pages.dev URL above as reportUrl in"
echo "   tgcloud/lib/runtime-config.js, together with the BOT_REPORT_SECRET above"
echo "   as reportSecret  (Part 3 of DEPLOY.md)."
echo "2) Then:  npx tgcloud push  &&  npx tgcloud webhook sync"
