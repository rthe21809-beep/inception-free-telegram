# Session collector — keeps the Telegram bot running, automatically.
#
# Two roles:
#   - Bot mode 'api'  (official Inception API): only needs the tgcloud CLI to
#     redeploy the bot with the injected API key. No browser at all.
#   - Bot mode 'direct' (free web chat): needs a real chromium to solve the
#     Vercel checkpoint and refresh sessions.
#
# Deploy (Render):   New Web Service -> Docker -> this repo (Dockerfile path:
#                     telegram-bot/collector/Dockerfile). Set TGCLOUD_TOKEN
#                     and optionally INCEPTION_API_KEY as env vars.
# Deploy (Railway):  railway up (same env vars).

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8000 \
    REFRESH_INTERVAL_HOURS=6 \
    SESSION_COUNT=3

# Shared OS bits + a fallback chromium (also used by warmup's CDP path).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      dumb-init \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# whole portable package (bridge + telegram-bot + collector)
COPY . .

# tgcloud CLI (used by the collector to redeploy the bot)
RUN cd telegram-bot && npm install --save-dev @tgcloud/cli --no-audit --no-fund

# Build the admin panel (React + TypeScript) — served by the control plane.
RUN cd telegram-bot/admin-panel \
    && npm install --no-audit --no-fund \
    && npm run build

# Playwright + its bundled chromium — the most reliable path for solving the
# Vercel checkpoint in 'direct' mode. (Installed at project root where the
# bridge's warmup.mjs expects it.)
RUN npm install playwright@^1.64.0 --no-audit --no-fund \
    && npx playwright install chromium --with-deps >/dev/null 2>&1 || true

EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "telegram-bot/collector/server.mjs"]
