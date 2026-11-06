#!/bin/sh
# entrypoint.sh — first-boot auto-warmup, then run the bridge.
set -e

cd /app

# Auto-solve the Vercel checkpoint once when there are no sessions yet.
# Set SKIP_WARMUP=1 to disable (e.g. you will inject data/creds.json).
if [ ! -s data/creds.json ] && [ -z "$SKIP_WARMUP" ]; then
  echo "[entrypoint] no sessions found — attempting auto warmup (chromium)..."
  if node warmup.mjs --output data/creds.json --headless --timeout-ms 150000; then
    echo "[entrypoint] warmup OK — session saved to data/creds.json"
  else
    echo "[entrypoint] warmup failed (checkpoint may need a clean IP or a proxy)."
    echo "[entrypoint] The bridge will still start; get a session manually:"
    echo "[entrypoint]   docker compose -f docker/docker-compose.yml exec bridge node get-creds.mjs --output data/creds.json"
  fi
fi

echo "[entrypoint] starting bridge on ${BRIDGE_HOST}:${BRIDGE_PORT}"
exec node server.mjs "$@"
