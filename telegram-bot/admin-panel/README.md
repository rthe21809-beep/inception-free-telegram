# Admin Panel (React + TypeScript Mini App)

Owner/admin control plane for the Inception Telegram bot. Runs as a **Telegram
Mini App** — it opens inside Telegram, so identity is verified automatically via
`initData` (HMAC-signed by the bot token). The owner (6940999328) and any added
admins can manage everything; everyone else gets a hard 403.

## What you can do

- **Providers** — add/remove, enable/disable, and manage multiple API keys per
  provider (keys rotate round-robin automatically). Each provider is any
  OpenAI-compatible endpoint (`baseUrl` + `Bearer` key).
- **Models** — add/remove, enable/disable, set the active model, per-model
  temperature and **custom instructions** (system prompt).
- **Admins** — add/remove other admins (owner is always privileged).
- **Users / usage** — per-user message counts, token usage, last-seen, and chat
  logs (previews). Global stats on the dashboard.
- **Settings** — show/hide thinking, history turns, groups allowed, default
  system prompt.

## How it works

The frontend (this folder) is a Vite + React + TypeScript app. It talks to the
**control plane** — the same collector service that keeps your bot alive —
over `/api/*`. The control plane:

1. verifies your identity from the Telegram `initData` header,
2. stores state in `data/control.json`,
3. regenerates the bot's `tgcloud/lib/runtime-config.js` and pushes the bot
   (`tgcloud push`) after any change.

The bot then uses the pushed config at runtime, and reports usage back to the
control plane (`POST /api/report`) after every message.

## Local development

```bash
cd admin-panel
npm install
npm run dev        # http://localhost:5173 (proxies /api to :8000)
```

Build (used by the collector's Dockerfile automatically):

```bash
npm run build      # outputs dist/
```

## Opening the panel in Telegram

Send `/admin` to the bot (owner only). The bot replies with a **Open Admin
Panel** / button. Tap it — the Mini App opens inside Telegram with the user's
identity already attached.

> The panel only works inside Telegram (a browser shows "Unauthorized"), because
> there is no initData outside the Telegram client.
