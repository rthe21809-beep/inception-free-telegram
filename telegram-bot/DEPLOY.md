# Deploy — Cloudflare Pages + KV (panel) and tgcloud (bot)

Cloudflare fully supports the React + TypeScript panel: **Pages** serves the
built static app, and a **Pages Function** (`admin-panel/functions/api/`) on
the same domain runs the control-plane API, with state in a **KV** namespace.
One domain, one deploy.

You need: a Cloudflare account (free), your Telegram bot token, and your
Inception `sk-…` API key (added later inside the panel, not here).

---

## Part 1 — Cloudflare panel + API (≈10 min)

### 1. Install wrangler and log in
```bash
npm install -g wrangler        # or: npx wrangler ...
wrangler login                  # opens browser, authorize Cloudflare
```

### 2. Create the KV namespace (stores providers/keys/models/users/logs)
Dashboard: **Storage → KV → Namespaces → Create namespace**, name it `CONTROL_KV` (older accounts: Workers & Pages → KV).
Copy the **Namespace ID**.
(Optional) create a second one named `CONTROL_KV_PREVIEW` for `wrangler pages dev`.

Paste the IDs into `admin-panel/wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "CONTROL_KV"
id = "<paste namespace id here>"
preview_id = "<paste preview id here, or same id>"
```

### 3. Set the secrets (never commit these)
```bash
cd telegram-bot/admin-panel
wrangler pages secret put BOT_TOKEN --project-name inception-panel
# paste your REAL bot token:  123456789:AA....

wrangler pages secret put BOT_REPORT_SECRET --project-name inception-panel
# paste a long random string, e.g. output of:  openssl rand -hex 32
# SAVE THIS — the bot needs the same value (Part 3, step 2).
```

### 4. Build the React/TypeScript panel and deploy
```bash
cd telegram-bot/admin-panel
npm install
npm run build                 # outputs dist/ (index.html + assets/)
npx wrangler pages deploy dist --project-name inception-panel
```
Output gives you a URL like `https://inception-panel.pages.dev`.
Your panel is live at that root URL (e.g. `https://inception-panel.pages.dev/`).
Opening it in a plain browser shows "Access denied" — it only works inside
Telegram (verified via initData HMAC).

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

Edit ONE file: `telegram-bot/tgcloud/lib/runtime-config.js`

```js
export const runtimeConfig = {
  mode: 'api',
  reportUrl: 'https://inception-panel.pages.dev',   // your Part-1 URL (no trailing /)
  reportSecret: 'PASTE_THE_SAME_BOT_REPORT_SECRET',
  // providers/models/keys are managed in the panel — leave empty here:
  providers: [],
  models: [],
  activeModelId: null,
  settings: {},
};
```
Then push again:
```bash
npx tgcloud push
```
The bot now fetches `/api/runtime-config` (Bearer secret) on each message and
merges it live — so anything you change in the panel applies **without redeploy**.

---

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
npm test          # 8 suites: engine, providers, control, live-config, admin-cmd, worker…
# serve the worker logic locally against a mock KV:
npx wrangler pages dev admin-panel/dist --kv CONTROL_KV --var BOT_TOKEN:123:abc --var BOT_REPORT_SECRET:sek
```
