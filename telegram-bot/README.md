# Telegram serverless chatbot — Inception Mercury 3 (no servers of your own)

A simple Telegram AI chatbot whose **entire backend runs on Telegram's own
Serverless platform** ([core.telegram.org/bots/serverless](https://core.telegram.org/bots/serverless)).
You provide **no servers, no containers, no VPS**. The bot talks straight to
the free Inception chat (`chat.inceptionlabs.ai`, Mercury 3) from inside the
Telegram sandbox, using sessions you capture once from your PC.

```
┌──────────────┐   update   ┌─────────────────────────────┐   HTTP    ┌──────────────────────────┐
│  Telegram    │ ────────> │  Telegram Serverless (tgcloud) │ ────────> │  chat.inceptionlabs.ai  │
│  chat        │  webhook  │  handlers/message.js          │  /api/... │  free Mercury 3 chat    │
└──────────────┘           └─────────────────────────────┘           └──────────────────────────┘
```

Your only "machine" involvement: **none once set up** — an optional cloud
collector (`collector/`, runs on Railway/Render) refreshes the sessions
automatically, and the bot calls it itself when needed (self-healing).
Without the collector, the only manual step is a few seconds on your PC
every few hours (`npm run sessions`). No long-running process either way.

---

## What you get

- `/start`, `/help`, `/model` commands
- Mercury 3 completions with a **💭 thinking preview** when the model reasons
- conversation memory (last `maxHistoryTurns` turns) in Telegram's built-in
  SQLite database
- typing indicator while the engine works
- two engine modes:
  - **`direct` (default, zero-server)** — calls the Inception site directly
    from the Telegram sandbox using embedded sessions
  - **`bridge`** — calls your own `inception-free-bridge` instance if you
    ever prefer the more robust VPS route

---

## Requirements

1. **A bot** via [@BotFather](https://t.me/BotFather), with **Serverless
   enabled** (BotFather → your bot → Serverless → on, then CLI Access token).
2. **Node.js ≥ 18 on your PC** — only for the `tgcloud` CLI and the session
   capture tool.
3. **A browser on your PC** (Chrome/Chromium/Edge) — used once per session
   capture to pass the site's checkpoint.

## Setup

```bash
# 1. (optional) configure: mode, model, thinking, memory
$EDITOR tgcloud/lib/config.js

# 2. capture Inception sessions on your PC (opens a headless browser once)
npm run sessions

# 3. link the project to your bot (CLI access token)
npx tgcloud login

# 4. deploy handlers + create the memory table + sync webhook
npx tgcloud push
npx tgcloud migrate
npx tgcloud webhook sync
```

**Done.** Message your bot in Telegram.

### Keeping it alive — 100% automatic (optional cloud collector)

Inception sessions expire after a few hours. Two ways to keep the bot alive:

**A. Manual (zero servers, ~30s every few hours):**

```bash
npm run sessions        # re-captures sessions on your PC
npx tgcloud push        # redeploy
```

**B. Fully automatic (recommended): run the collector in the cloud.** The
`collector/` folder is a tiny Docker service that runs *on Railway / Render
/ any Docker host* and does the refresh loop for you:

1. solves the checkpoint with headless chromium (same as the PC flow),
2. writes the fresh sessions,
3. redeploys the bot automatically (`npx tgcloud push` with your
   `TGCLOUD_TOKEN`).

The bot is **self-healing**: when its sessions expire, it calls
`POST <collector>/refresh`, waits for the refresh, then retries the chat —
no human involved.

Deploy to Railway (free tier fits — the service only wakes up to refresh):

```bash
# one-time: put TGCLOUD_TOKEN in the service's environment
railway init
railway up          # build: collector/Dockerfile (auto-detected)
railway variables set TGCLOUD_TOKEN=app123:secret
# then set the collector URL in tgcloud/lib/config.js:
#   collectorUrl: 'https://<your-app>.up.railway.app'
npx tgcloud push
```

Same on Render: **Web Service → Docker** pointing at the repo root; set
`TGCLOUD_TOKEN` in the environment; configure `REFRESH_INTERVAL_HOURS`
(default 6).

Collector environment variables:

| Var | Default | Meaning |
|---|---|---|
| `TGCLOUD_TOKEN` | — (required) | CLI access token from BotFather → Serverless |
| `REFRESH_INTERVAL_HOURS` | `6` | timer refresh interval; `0` disables the timer (on-demand only) |
| `SESSION_COUNT` | `3` | how many sessions to keep |
| `PORT` | `8000` | HTTP port |

Endpoints: `GET /healthz`, `GET /status`, `POST /refresh` (used by the bot).

## Testing before deploying

```bash
# run the handler locally on the platform with a fake message
npx tgcloud run handlers/message '{ chat: { id: 1 }, text: "hello" }'

# offline unit tests (no network, no Telegram)
npm test
```

## Project layout

```
telegram-bot/
├─ tgcloud/                  # the deployed part (Telegram Serverless)
│  ├─ handlers/
│  │  └─ message.js          # Telegram routes every message here
│  ├─ lib/
│  │  ├─ engine.js           # core logic (pure, tested)
│  │  ├─ tgupstream-core.js  # pure protocol helpers (tested offline)
│  │  ├─ tgupstream.js       # direct Inception client (sdk fetch)
│  │  ├─ bridge.js           # optional: external bridge client
│  │  ├─ format.js           # reply + thinking formatting
│  │  ├─ sessions.js         # ★ AUTO-GENERATED sessions (npm run sessions)
│  │  └─ config.js           # ★ edit this: mode, model, toggles
│  └─ schema.js              # SQLite schema (conversation memory)
├─ tools/
│  └─ update-sessions.mjs    # capture/refresh sessions (runs on your PC)
├─ test-engine.mjs           # offline engine tests
├─ test-tgupstream.mjs       # offline protocol tests
└─ package.json              # scripts: test/sessions/deploy/status/run/webhook
```

## How direct mode works

1. Telegram delivers a `Message` to `handlers/message.js` → `lib/engine.js`.
2. The engine loads recent turns from the database, appends the new message,
   and sends it to the site with a session cookie/token:
   - `GET /api/session` → session token
   - `POST /api/chat` with the site's envelope (`model: "mercury"`, message
     `parts`, non-stream) → SSE/JSON answer
3. The answer is parsed into content + reasoning, formatted (thinking preview
   + reply), stored, and sent via `api.sendMessage`.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "⚠️ no sessions configured" | Run `npm run sessions` on your PC, then `npx tgcloud push` |
| "⚠️ sessions expired / challenged" | Same — refresh sessions (usually every few hours) |
| `npx tgcloud push` rejects | Not logged in or out of sync: `npx tgcloud login`, `npx tgcloud status` |
| Bot silent after deploy | Webhook not synced: `npx tgcloud webhook sync` |
| No thinking preview | `showThinking: false`, or the model produced no reasoning |
| Group spam | Set `allowGroups: false` in `tgcloud/lib/config.js` |

### Why sessions expire (honest limitations)

The Inception site is protected by a Vercel security checkpoint. Solving it
needs a real browser, which a serverless V8 sandbox cannot run — so sessions
are solved on your PC and reused from Telegram's network. This generally
works, but:

- sessions are short-lived (a few hours) → periodic `npm run sessions`
- the site may occasionally challenge datacenter IPs even with a valid
  session; the bot retries across your sessions and reports a clear message
  when that happens
- for a fully hands-off deployment, the `bridge` mode (a single cheap VPS or
  Docker host running `inception-free-bridge`) remains the most robust
  option — the code supports both, flip `mode` in `config.js`

## Cost & limits

- **Telegram Serverless**: no servers, scales automatically, database
  included.
- **Engine**: the free Inception chat — personal use, rate limits apply;
  multiple sessions rotate automatically.

## Going further

- **Streaming into Telegram**: Telegram can't render partial SSE, but you
  can edit a placeholder message as chunks arrive (the direct client can be
  extended to stream).
- **Other serverless hosts**: the pure `lib/` engine works anywhere with a
  `fetch`; only `handlers/message.js` is Telegram-specific.
