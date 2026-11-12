# Deploy — Cloudflare Pages + KV (panel) and tgcloud (bot)

Cloudflare fully supports the React + TypeScript panel: **Pages** serves the
built static app, and a **Pages Function** (`admin-panel/functions/api/`) on
the same domain runs the control-plane API, with state in a **KV** namespace.
One domain, one deploy.

You need: a Cloudflare account (free), your Telegram bot token, and your
Inception `sk-…` API key (added later inside the panel, not here).

---

## Part 1 — Cloudflare panel + API (≈10 min)

### 1. One-shot deploy (recommended)
The deploy script does steps 2-4 for you using the Cloudflare **REST API**
directly. Wrangler is deliberately **not** used: it ships the precompiled
`workerd` binary, which has no Android/arm64 build and cannot run in Termux.

```bash
cd <repo>/telegram-bot
export CLOUDFLARE_API_TOKEN=...        # see CREDENTIALS.md item 3
export CONTROL_KV_ID=...               # see CREDENTIALS.md item 4
bash scripts/termux-deploy-panel.sh    # prompts for the two secrets
```

It prints your `BOT_REPORT_SECRET` — copy it, the bot needs the same value.

### 2. Create the KV namespace (stores providers/keys/models/users/logs)
Dashboard: **Storage → KV → Namespaces → Create namespace**, name it `CONTROL_KV`
(older accounts: Workers & Pages → KV). Copy the **Namespace ID**.

The script writes it into `admin-panel/wrangler.toml` and binds it on the
project via the API. If you ever set it by hand:
```toml
[[kv_namespaces]]
binding = "CONTROL_KV"
id = "<paste namespace id here>"
preview_id = "<same id>"
```

### 3. Secrets (never commit these)
The script sets both as Pages **secret_text** env vars. To change them later:
```bash
cd <repo>/telegram-bot
BOT_TOKEN=123456:AA... BOT_REPORT_SECRET=$(openssl rand -hex 32) node scripts/cf-deploy.mjs
```
`BOT_TOKEN` is your real bot token from @BotFather. `BOT_REPORT_SECRET` is any
long random string — the bot must be given the **same** value (Part 3, step 2).

### 4. Manual deploy (no script)
```bash
cd <repo>/telegram-bot/admin-panel && npm install && npm run build
cd ..
node scripts/cf-deploy.mjs          # uses env vars above
node scripts/cf-deploy.mjs --dry-run   # build + hash only, no network
```
Output gives you a URL like `https://inception-panel.pages.dev`.
Your panel is live at that root URL. Opening it in a plain browser shows
"Access denied" — it only works inside Telegram (verified via initData HMAC).

### 5. (Optional) custom domain
Dashboard → your Pages project → **Custom domains** → add e.g.
`panel.yourdomain.com`. Use that URL everywhere below instead of the
`*.pages.dev` URL.

---

## Part 2 — Telegram bot (tgcloud)

```bash
cd telegram-bot
npx tgcloud login              # paste your tgcloud token (app…:secret)
npx tgcloud push               # deploys tgcloud/ to Telegram Serverless
npx tgcloud webhook sync       # points the bot webhook at your module
```

---

## Part 3 — Wire bot → panel (live config)

**Do not edit `runtime-config.js`.** This repository is public, and the value
that belongs there (`reportSecret`) can read `/api/runtime-config`, which hands
back your real `sk-…` provider keys. Committing it would leak them.

The URL and secret live in `telegram-bot/tgcloud/lib/host-secret.js`, which is
empty in git and filled locally right before each push:

```bash
cd telegram-bot
export BOT_REPORT_SECRET='the one the deploy script printed'
node scripts/set-host-secret.mjs https://inception-panel.pages.dev

npx tgcloud push
npx tgcloud webhook sync

node scripts/set-host-secret.mjs --restore   # put the file back to empty
```

If you use `bash scripts/termux-deploy-panel.sh`, it does the fill for you and
prints the exact push commands.

The bot now fetches `/api/runtime-config` (Bearer secret) on each message and
merges it live — so anything you change in the panel applies **without redeploy**.
With the secret absent, the bot still runs, it just has no provider configured.

## Part 4 — First configuration (in Telegram)

1. Open your bot in Telegram, send `/admin`.
   - If you're not user **6940999328**, you'll see "Unknown command" (by design).
2. Add your Inception provider + key:
   ```
   /admin addprovider inception https://api.inceptionlabs.ai/v1 sk-YOUR-KEY
   ```
3. Add a model and make it active:
   ```
   /admin addmodel mercury-3 inception mercury-3 "Mercury 3"
   /admin activemodel mercury-3
   ```
4. Or just tap the **🌐 Open Admin Panel** button on `/admin` and do all of the
   above (plus keys rotation, custom instructions, users, logs) in the
   monochrome mobile web panel.
5. Send any normal message to the bot — it answers via your `sk-` key.

---

## Security model (what's enforced)

- Panel API: Telegram `initData` HMAC-SHA256 verified with `BOT_TOKEN`,
  timing-safe compare, **1h replay window** (stale `auth_date` → 401).
- Owner/admin RBAC server-side; **admin add/remove is owner-only**.
- Bot↔plane: `Authorization: Bearer BOT_REPORT_SECRET`, timing-safe.
- API keys are **never returned** to panel/bot clients (masked `sk-…last4`);
  only `/api/runtime-config` (secret-authed) returns real keys, to the bot only.
- Headers on every response: CSP, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- Rate limiting: 60 req/min per IP and per user.
- State in KV; mutating routes persist immediately.

## Local testing
```bash
cd telegram-bot
npm test                       # 8 suites: engine, providers, control, live-config, admin-cmd, worker…
node scripts/cf-deploy.mjs --dry-run   # bundle the API into dist/_worker.js, no network
```
The bundled worker can be exercised directly in Node (no wrangler needed):
```js
import worker from './admin-panel/dist/_worker.js';
const env = { ASSETS: { fetch: () => new Response('static') },
              BOT_TOKEN: '123:abc', BOT_REPORT_SECRET: 'sek',
              CONTROL_KV: { async get(){return null}, async put(){}, async delete(){} } };
await worker.fetch(new Request('https://x.dev/api/runtime-config',
  { headers: { Authorization: 'Bearer sek' } }), env, { waitUntil(){}, passThroughOnException(){} });
```

## Why not wrangler?
`wrangler` depends on `workerd`, a precompiled native binary that Cloudflare
ships **only for linux/macOS/Windows x64+arm64** — there is no Android build, so
it fails in Termux with `Error: Unsupported platform: android arm64 LE`.
`scripts/cf-deploy.mjs` therefore talks to the Cloudflare REST API directly and
uses `esbuild` (JS, no native deps) to bundle the Pages Function.
