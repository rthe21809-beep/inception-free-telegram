# inception-free-bridge — portable image.
#
# Build:     docker build -t inception-free-bridge -f docker/Dockerfile .
# Run:       docker compose -f docker/docker-compose.yml up -d
# Standalone:
#   docker run -d --name inception-bridge -p 8890:8890 \
#     -e BRIDGE_HOST=0.0.0.0 -e BRIDGE_API_KEY=change-me \
#     -v inception-bridge-data:/app/data inception-free-bridge
#
# The image includes a real chromium so the Vercel checkpoint can be solved
# automatically on first boot (entrypoint runs warmup when data/creds.json
# is empty) and so completions can stream from a real browser context.

FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    BRIDGE_HOST=0.0.0.0 \
    BRIDGE_PORT=8890 \
    BRIDGE_BROWSER=auto \
    BRIDGE_CREDS=data/creds.json \
    BRIDGE_CHROMIUM=/usr/bin/chromium

WORKDIR /app

# chromium + tiny runtime tools. The CDP driver drives chromium directly, so
# no npm browser download is needed — this keeps the image small.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      dumb-init \
      curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true

COPY . .

RUN mkdir -p data && chmod +x bin/*.sh bin/inception-free docker/entrypoint.sh

EXPOSE 8890
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8890/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/docker/entrypoint.sh"]
