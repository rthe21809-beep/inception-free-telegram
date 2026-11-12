# Run everything in Termux (Android)

The GitHub repo is **`inception-free-telegram`**. Inside it the bot lives in
the **`telegram-bot/`** folder. So on your phone the path is
`~/inception-free-telegram/telegram-bot`.

## 0. One-time Termux setup
```bash
pkg update -y
pkg install -y git nodejs openssl
# nodejs gives you node + npm + npx
node -v        # should print v20+ (v24 on newer Termux)
```

## 1. Get the code (pick ONE)
```bash
# A) clone the repo (recommended — lets you git pull updates later)
cd ~
git clone https://github.com/rthe21809-beep/inception-free-telegram.git
cd ~/inception-free-telegram/telegram-bot

# B) OR use the tar I exported to your phone:
#    /sdcard/Download/DSHA/inception-portable-v7.tar.gz
#    cd ~ && tar -xzf /sdcard/Download/DSHA/inception-portable-v7.tar.gz
#    cd ~/telegram-bot     # tar has ./telegram-bot at top
```

## 2. Deploy the panel to Cloudflare (from Termux)
You need a **Cloudflare API token** (create at dash.cloudflare.com → My
Profile → API Tokens → "Edit Cloudflare Workers" template), and a **KV
namespace** (**Storage → KV → Namespaces → Create**, name it `CONTROL_KV`).

```bash
cd ~/inception-free-telegram/telegram-bot
export CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
export CONTROL_KV_ID=your_kv_namespace_id
bash scripts/termux-deploy-panel.sh
```
The script installs wrangler, builds the React panel, sets the two secrets
(BOT_TOKEN, BOT_REPORT_SECRET — it will prompt you), and deploys.
It prints your panel URL, e.g. `https://inception-panel.pages.dev`.

## 3. Deploy the bot to Telegram Serverless
```bash
cd ~/inception-free-telegram/telegram-bot
npx tgcloud login          # paste your tgcloud token (app…:secret)
```

## 4. Point the bot at your panel (the ONLY file you edit)
```bash
nano ~/inception-free-telegram/telegram-bot/tgcloud/lib/runtime-config.js
```
Set exactly two lines (everything else stays empty — keys/models go in the panel):
```js
  reportUrl: 'https://inception-panel.pages.dev',   // your URL from step 2
  reportSecret: 'PASTE_BOT_REPORT_SECRET',          // the secret from step 2
```
Save (Ctrl-O, Enter, Ctrl-X), then:
```bash
npx tgcloud push
npx tgcloud webhook sync
```

## 5. Configure the bot in Telegram
Open your bot, send `/admin` (only works from your account 6940999328), then:
```
/admin addprovider inception https://api.inceptionlabs.ai/v1 sk-YOUR-INCEPTION-KEY
/admin addmodel mercury-3 inception mercury-3 "Mercury 3"
/admin activemodel mercury-3
```
or tap the **🌐 Open Admin Panel** button and do it in the web UI.
Then just send any message — the bot answers through your `sk-` key.

## 6. Update later
```bash
cd ~/inception-free-telegram && git pull origin main
cd telegram-bot && npx tgcloud push
```

## 7. Troubleshooting

### `CANNOT LINK EXECUTABLE "node": library "libicui18n.so.79" not found`
Termux's `node` was built against ICU 79 but your `libicu` is a different
version (the mirror drifted mid-upgrade). Node won't run at all until fixed:
```bash
termux-change-repo            # pick ONE mirror (e.g. Mirrors by Grimler), NOT "Rotate"
pkg update -y && pkg upgrade -y
pkg reinstall -y nodejs libicu
node -v                       # must print v20+ with no linker error
```
If it still fails, pick a different single mirror and repeat. Then re-run
`bash scripts/termux-deploy-panel.sh` (it now preflights node and prints this
same fix).

### `fatal: Need to specify how to reconcile divergent branches`
Your clone is on old commits I later rewrote. Just match the remote:
```bash
git fetch origin && git reset --hard origin/main
```

### `bash: scripts/termux-deploy-panel.sh: No such file or directory`
You are on a pre-v8 commit; run the `git fetch && git reset --hard` above.

---
## What only YOU can do (I can't, I don't have your accounts/secrets)
1. Create the **Cloudflare account + API token + KV namespace** (step 2).
2. `npx tgcloud login` with **your** tgcloud token (step 3).
3. Paste your **real bot token** and the **BOT_REPORT_SECRET** into the two
   prompts, and your **Inception `sk-` key** into the panel (step 5).
4. Revoke the GitHub PAT and the old bot token in @BotFather.

Everything else (all code, panel UI, worker backend, tests, docs, scripts) is
already done and pushed to the repo — see DEPLOY.md for the full detail.
