#!/usr/bin/env bash
# package.sh — build a clean, portable tarball of the bridge.
#
# The tarball excludes node_modules, runtime data (.env, data/creds.json)
# and the docker/deploy extras can be included with --with-deploy:
#
#   bash bin/package.sh            # bridge source only (~250 KB)
#   bash bin/package.sh --with-deploy   # + docker/, deploy/, .env.example
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

VERSION="$(node -p 'require("./package.json").version')"
NAME="inception-free-bridge-${VERSION}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/$NAME"
cp server.mjs warmup.mjs get-creds.mjs register-playwright.mjs discover-endpoint.mjs \
   termux-install.sh package.json README.md "$STAGE/$NAME/"
cp -r lib "$STAGE/$NAME/"
cp -r bin "$STAGE/$NAME/"
mkdir -p "$STAGE/$NAME/data"
touch "$STAGE/$NAME/data/.gitkeep"
cp test-*.mjs test.mjs "$STAGE/$NAME/"

# Telegram serverless bot (always included — it is part of the product)
if [ -d telegram-bot ]; then
  mkdir -p "$STAGE/$NAME/telegram-bot"
  cp -r telegram-bot/tgcloud telegram-bot/tools telegram-bot/collector \
     telegram-bot/test-engine.mjs telegram-bot/test-tgupstream.mjs \
     telegram-bot/package.json telegram-bot/.env.example telegram-bot/.gitignore \
     telegram-bot/README.md "$STAGE/$NAME/telegram-bot/"
fi

if [ "${1:-}" = "--with-deploy" ]; then
  cp -r docker deploy "$STAGE/$NAME/"
  cp .env.example "$STAGE/$NAME/"
fi

OUT="$DIR/$NAME.tgz"
tar -czf "$OUT" -C "$STAGE" "$NAME"
echo "built: $OUT"
echo "size:  $(du -h "$OUT" | cut -f1)"
echo
echo "copy to your server and unpack:"
echo "  tar xzf $NAME.tgz && cd $NAME && bash bin/setup.sh"
