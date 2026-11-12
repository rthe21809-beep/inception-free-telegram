# Telegram serverless chatbot — Inception Mercury 3 (no servers of your own)

A simple Telegram AI chatbot whose **entire backend runs on Telegram's own
Serverless platform** ([core.telegram.org/bots/serverless](https://core.telegram.org/bots/serverless)).
You provide **no servers, no containers, no VPS**.

**The goal: the free Inception web chat (`chat.inceptionlabs.ai`) as the
engine.** The bot is a frontend for the free-chat→API bridge — users chat
with Mercury 3 through the free chat, no Inception API key required. It
runs in `direct` mode: the handler talks to the chat site from inside the
Telegram sandbox using sessions, and a tiny cloud collector (`collector/`,
on Render/Railway) keeps those sessions fresh automatically.

```
┌──────────────┐   update   ┌─────────────────────────────┐   HTTP    ┌──────────────────────────┐
│  Telegram    │ ────────> │  Telegram Serverless (tgcloud) │ ────────> │  chat.inceptionlabs.ai  │
│  chat        │  webhook  │  handlers/message.js          │  /api/... │  free Mercury 3 chat    │
└──────────────┘           └─────────────────────────────┘           └──────────────────────────┘
```

An optional `api` mode (official Inception API, 100M free tokens) remains
available as a fallback if the web chat's checkpoint ever hard-blocks cloud
IPs — but direct mode is the primary path.

---

## What you get

- `/start`, `/help`, `/model` commands
- Mercury 3 completions with a **💭 thinking preview** when the model reasons
- conversation memory (last `maxHistoryTurns` turns) in Telegram's built-in
  SQLite database
- typing indicator while the engine works
- three engine modes:
  - **`direct` (default — the goal)** — calls the free Inception web chat
    from inside the Telegram sandbox using sessions (kept fresh by the
    cloud collector). No API key needed.
  - **`bridge`** — calls your own `inception-free-bridge` instance if you
    run one (VPS / Docker / home machine) in front of the same free chat.
  - **`api` (optional fallback)** — calls the official Inception API
    (100M free tokens) if the web chat's checkpoint ever blocks cloud IPs.

---

## Requirements (direct mode — the goal)

1. **A bot** via [@BotFather](https://t.me/BotFather), with **Serverless
   enabled** (BotFather → your bot → Serverless → on, then CLI Access token).
2. **Node.js ≥ 18 on your PC** — only for the one-time `tgcloud` CLI push.
3. **A cloud collector** (`collector/`, Render/Railway) to keep the free-chat
   sessions fresh. No Inception API key is needed.

> The optional `api` mode instead needs a key from platform.inceptionlabs.ai
> (100M free tokens) and needs no collector — but it is not the goal path.

## Setup (direct mode)

```bash
# 1. (one-time) deploy the cloud collector first (see "Keeping it alive"),
#    then make sure the bot's mode is direct (it is, by default):
$EDITOR tgcloud/lib/config.js
#    → mode: 'direct'
#    → collectorUrl: 'https://<your-collector>.onrender.com'
#      (the collector sets this automatically when it deploys the bot)

# 2. link the project to your bot (CLI access token)
npx tgcloud login

# 3. deploy handlers + create the memory table + sync webhook
npx tgcloud push
npx tgcloud migrate
npx tgcloud webhook sync
```

**Done.** Message your bot in Telegram. Sessions are kept fresh by the
collector automatically — nothing manual, no server of yours.

### Keeping it alive (the collector)

The free-chat sessions expire after a few hours. The `collector/` Docker
service runs on Render/Railway and keeps them fresh:

1. solves the Vercel checkpoint with chromium (Playwright's bundled browser,
   retried up to 3×),
2. writes the fresh sessions into the bot,
3. redeploys the bot automatically (`npx tgcloud push` with your
   `TGCLOUD_TOKEN`).

The bot is also self-healing: when its sessions expire it calls
`POST <collector>/refresh`, waits, and retries.

Collector environment variables:

| Var | Default | Meaning |
|---|---|---|
| `TGCLOUD_TOKEN` | — (required) | CLI access token from BotFather → Serverless |
| `INCEPTION_API_KEY` | — | if set, bot switches to **api mode** (no sessions needed) |
| `REFRESH_INTERVAL_HOURS` | `6` | timer refresh interval; `0` disables the timer (on-demand only) |
| `SESSION_COUNT` | `3` | how many web-chat sessions to keep (direct mode only) |
| `PORT` | `8000` | HTTP port |
| `PROXY_LIST` | — | **optional** — one proxy per line (e.g. `http://user:pass@host:port`). The collector rotates through them, one per warmup attempt, so the Vercel checkpoint sees a residential/mobile IP instead of your cloud host's datacenter IP (works in both the Playwright and CDP browser paths) |

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
