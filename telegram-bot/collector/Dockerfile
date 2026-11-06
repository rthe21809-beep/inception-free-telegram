# Session collector — runs chromium headless + the tgcloud CLI, so the
# Telegram bot's sessions refresh themselves in the cloud.
#
# Deploy (Railway):  railway up   (from the repo root containing this file)
# Deploy (Render):   new Web Service -> Docker -> this folder's repo
#
# Required env: TGCLOUD_TOKEN (BotFather -> Serverless -> CLI Access token)

FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=8000 \
    REFRESH_INTERVAL_HOURS=6 \
    SESSION_COUNT=3

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

EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "telegram-bot/collector/server.mjs"]
