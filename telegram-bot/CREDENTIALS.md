# Where to get every credential (click-by-click)

You need 6 things. None of them come from me. Here is exactly where each one
lives.

---

## 1. Telegram bot token  (format `123456789:AA…`) — for the panel's BOT_TOKEN
In Telegram, open **@BotFather**:
- If your old token was leaked, revoke it first: `/revoke` → pick your bot →
  confirm. (The leaked `9220157456:AAFedN…` is dead after this.)
- Get a fresh one: `/token` → pick your bot (e.g. `@merc_chat_bot`) → copy the
  token. It looks like `123456789:AAEXxxxxxxxxxxxxxxxxxxxxxxxxxxx`.
- If you don't have a bot yet: `/newbot` → give it a name → a username ending
  in `bot` → copy the token.
- You will paste this into Cloudflare as the secret **BOT_TOKEN** (step 2 of
  the deploy script prompts you).

## 2. tgcloud CLI access token  (format `app…:secret`) — for `npx tgcloud login`
Also in **@BotFather**:
- `/mybots` → select your bot → **Serverless** → **CLI Access** → copy the
  token (looks like `app123456789:0123abcd…secret…`).
- This is NOT the same as the bot token in (1). Don't mix them up.
- Run: `npx tgcloud login` and paste it.

## 3. Cloudflare API token — for deploying the panel from Termux
1. Sign up / log in at **https://dash.cloudflare.com** (free account).
2. Go to **https://dash.cloudflare.com/profile/api-tokens**
3. Click **Create Token** → under "Custom token" click **Get started**.
4. Token name: `inception-panel`
5. Permissions → Add:
   - **Account → Cloudflare Pages → Edit**
   - **Account → Workers KV Storage → Edit**
6. Account Resources → **Include → All accounts** (or pick your account).
7. Continue to summary → **Create Token**.
8. **Copy the token now** — it is shown only once.
9. In Termux: `export CLOUDFLARE_API_TOKEN=<that token>`

## 4. Cloudflare KV namespace ID — where panel state is stored
1. In **https://dash.cloudflare.com**, left sidebar: **Workers & Pages → KV → Namespaces**
   (direct: https://dash.cloudflare.com → your account → Workers & Pages → KV)
2. Click **Create namespace**, title it exactly `CONTROL_KV`, click **Add**.
3. Click the new namespace — you'll see its **Namespace ID**: a 32-character
   hex string like `a1b2c3…`. Copy it.
4. In Termux: `export CONTROL_KV_ID=<that id>`

## 5. Inception API key  (format `sk-…`) — the engine your bot uses
1. Go to **https://platform.inceptionlabs.ai** → log in (Google or GitHub).
2. Open **https://platform.inceptionlabs.ai/dashboard/api-keys**
3. **Create API key** → name it → copy the key (`sk-…`). Shown once — save it.
4. Base URL for the provider (already default in the panel): `https://api.inceptionlabs.ai/v1`
5. You add this key **inside the Telegram panel/bot** after deploy:
   `/admin addprovider inception https://api.inceptionlabs.ai/v1 sk-…`
   — you do NOT put it in any file or git.

## 6. BOT_REPORT_SECRET — the shared secret between bot and panel
Not from any website. Generate it yourself in Termux:
```bash
openssl rand -hex 32
```
Copy the 64-char output. You paste it into Cloudflare as **BOT_REPORT_SECRET**
(deploy script prompts you) AND into `tgcloud/lib/runtime-config.js` as
`reportSecret`.

---

## Quick checklist
| # | Credential | From | Looks like | Used for |
|---|-----------|------|-----------|----------|
| 1 | bot token | @BotFather `/token` | `123456:AA…` | Cloudflare secret `BOT_TOKEN` |
| 2 | tgcloud token | @BotFather → bot → Serverless → CLI Access | `app…:secret` | `npx tgcloud login` |
| 3 | CF API token | dash.cloudflare.com/profile/api-tokens | long random | `export CLOUDFLARE_API_TOKEN` |
| 4 | KV namespace id | dash.cloudflare.com → Workers & Pages → KV | 32-hex | `export CONTROL_KV_ID` |
| 5 | Inception key | platform.inceptionlabs.ai/dashboard/api-keys | `sk-…` | add in panel via `/admin` |
| 6 | report secret | `openssl rand -hex 32` (Termux) | 64-hex | CF secret + runtime-config.js |

Security: revoke anything you pasted into chats. Never commit (1)(2)(3)(5)(6)
to git — the repo's .gitignore and the clean runtime-config template already
keep them out.
