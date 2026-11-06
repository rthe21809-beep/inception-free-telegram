# inception-free-bridge

**A portable, server-deployable, OpenAI-compatible API in front of the free
Inception chat (Mercury 3).** Point any AI chat platform at it as a custom
"OpenAI compatible" provider and you get the full Mercury 3 experience —
**streaming, thinking/reasoning, tool calling, usage stats** — powered by the
free `chat.inceptionlabs.ai` web chat, no API key from Inception needed.

```
 ┌─────────────────┐        ┌──────────────────────────┐        ┌───────────────────────┐
 │  Your chat app  │ ─────> │  inception-free-bridge   │ ─────> │  chat.inceptionlabs.ai │
 │  OpenWebUI /    │  /v1   │  (this package)          │  HTTP   │  free Mercury 3 chat  │
 │  LobeChat / ... │ OpenAI  │  http://host:8890/v1    │  SSE    │  (browser context)    │
 └─────────────────┘        └──────────────────────────┘        └───────────────────────┘
```

Everything is plain Node.js (no framework, no build step) plus a chromium
binary for solving the site's Vercel checkpoint and for streaming inside a
real browser page. The whole source tree is **~250 KB**; dependencies are
optional (see [Dependencies](#dependencies)).

---

## Contents

- [Quickstart on a server](#quickstart-on-a-server)
- [Docker quickstart](#docker-quickstart)
- [Configuration](#configuration)
- [Getting a session (one-time)](#getting-a-session-one-time)
- [Use it as the chatbot of an AI chat platform](#use-it-as-the-chatbot-of-an-ai-chat-platform)
- [Thinking / reasoning](#thinking--reasoning)
- [Endpoints](#endpoints)
- [Operations](#operations)
- [Security](#security)
- [Deploying on bare metal (systemd + nginx)](#deploying-on-bare-metal-systemd--nginx)
- [Tests](#tests)
- [Packaging with moving to another server](#packaging--moving-to-another-server)
- [Limitations & fair use](#limitations--fair-use)

---

## Quickstart on a server

Requires **Node.js ≥ 18** and (recommended) a chromium/chrome binary.

```bash
# 1. unpack / copy this folder to the server, then:
tar xzf inception-free-bridge-1.0.0.tgz
cd inception-free-bridge-1.0.0

# 2. one-shot installer: checks node, installs optional deps, finds/installs chromium
bash bin/setup.sh

# 3. get a session (one-time, needs the browser from step 2)
npm run warmup            # auto-solves the Vercel checkpoint and saves data/creds.json
#    (alternative, manual: npm run creds  — paste Cookie/Bearer from your browser)

# 4. start
./bin/inception-free --api-key choose-a-key

# 5. verify
curl http://127.0.0.1:8890/v1/models
npm run smoke              # offline self-test of the whole surface
```

Done. The bridge is now an OpenAI-compatible API at
`http://127.0.0.1:8890/v1` with model `mercury-3`.

> **Server note:** to accept connections from other machines (or a reverse
> proxy on the same box is absent), start with `--host 0.0.0.0`, or put
> `BRIDGE_HOST=0.0.0.0` in `.env` (see [Configuration](#configuration)).

## Docker quickstart

```bash
cd docker
cp ../.env.example ../.env    # optional; edit key values (API key, host)
docker compose up -d --build
docker compose logs -f bridge
```

- First boot **auto-warms** a session using the bundled chromium (writes
  `data/creds.json` in a volume). If the checkpoint can't be solved from your
  IP, the bridge still starts; get a session manually:

  ```bash
  docker compose -f docker/docker-compose.yml exec bridge node get-creds.mjs --output data/creds.json
  ```

- Default port `8890`, health check hits `/healthz`, container restarts
  automatically. The image is `node:20-bookworm-slim` + `chromium` (no heavy
  Playwright browser downloads).

Standalone run:

```bash
docker build -t inception-free-bridge -f docker/Dockerfile .
docker run -d --name inception-bridge \
  -p 8890:8890 \
  -e BRIDGE_HOST=0.0.0.0 \
  -e BRIDGE_API_KEY=change-me \
  -e BRIDGE_AUTO_REFRESH=5 \
  -v inception-bridge-data:/app/data \
  inception-free-bridge
```

## Configuration

Every CLI flag of `server.mjs` has an environment-variable fallback, so a
`.env` file (copy `.env.example`) or Docker `-e` flags configure everything.
**CLI flags win over env; env wins over defaults.**

| Env var | Flag | Default | Meaning |
|---|---|---|---|
| `BRIDGE_HOST` | `--host` | `127.0.0.1` | Bind address. `0.0.0.0` for servers/Docker |
| `BRIDGE_PORT` | `--port` | `8890` | Listen port |
| `BRIDGE_API_KEY` | `--api-key` | *(none)* | If set, requests must send `Authorization: Bearer <value>` |
| `BRIDGE_CREDS` | `--creds` | `data/creds.json` | Sessions file (see below) |
| `BRIDGE_AUTO_REFRESH` | `--auto-refresh` | `0` | Re-solve the checkpoint every N hours (e.g. `5`) |
| `BRIDGE_SESSION_TTL` | `--session-ttl` | `6` | Drop sessions older than N hours |
| `BRIDGE_DEFAULT_MODEL` | `--default-model` | `mercury-3` | Model id when the request omits one |
| `BRIDGE_UPSTREAM_MODEL` | `--upstream-model` | `mercury` | The site's internal model id |
| `BRIDGE_BROWSER` | `--browser-mode` | `auto` | `auto` (use chromium when found), `on` (always browser), `off` (plain HTTP) |
| `BRIDGE_CHROMIUM` | `--chromium` | *auto-detect* | Path to chromium/chrome binary |
| `BRIDGE_THINKING` | `--thinking` | `end` | `end` (one reasoning block), `live` (per-delta), `off` |
| `BRIDGE_EFFORT_FIELD` | `--effort-field` | `reasoning_effort` | Request field the site honours; `auto` = discover |
| `BRIDGE_DISCOVER_EFFORT` | `--discover-effort` | `0` | Probe at startup to verify the effort field |

Example `.env`:

```dotenv
BRIDGE_HOST=0.0.0.0
BRIDGE_PORT=8890
BRIDGE_API_KEY=my-secret-key
BRIDGE_BROWSER=auto
BRIDGE_CHROMIUM=/usr/bin/chromium
BRIDGE_AUTO_REFRESH=5
BRIDGE_THINKING=end
```

## Getting a session (one-time)

The free chat is a web app behind Vercel's security checkpoint. The bridge
needs a **session** (checkpoint cookies + a token), saved as one or more
entries in `data/creds.json`. Two ways:

### A. Auto warmup (recommended, needs a browser on the server)

```bash
npm run warmup
```

`warmup.mjs` opens the site in chromium, lets the checkpoint pass, captures
the cookies and writes `data/creds.json`. With `BRIDGE_AUTO_REFRESH=5` the
bridge re-runs this in the background so sessions never expire.

### B. Manual import (works anywhere, even without a browser)

In your own browser: open `https://chat.inceptionlabs.ai`, send a message,
open DevTools → Network, find the `completions` request, copy its
`Cookie` header (and `Authorization: Bearer …` if present). Then:

```bash
npm run creds   # pastes interactively, or:
node get-creds.mjs --cookies "k1=v1; k2=v2" --bearer "eyJ..." --output data/creds.json
```

Multiple sessions are fine — the bridge rotates on request and keeps going if
one expires.

## Use it as the chatbot of an AI chat platform

Any platform/config that accepts a **custom "OpenAI compatible" provider**
works. Set:

| Setting | Value |
|---|---|
| API Base URL | `http://<host>:8890/v1` (or `https://your.domain/v1` behind nginx) |
| API Key | whatever you put in `BRIDGE_API_KEY` (any non-empty string if unset) |
| Model | `mercury-3` (or `mercury-3-decide`) |

Quick tests:

```bash
# streaming chat completion
curl -N http://127.0.0.1:8890/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key" \
  -d '{"model":"mercury-3","messages":[{"role":"user","content":"Hello!"}],"stream":true}'

# OpenAI Python SDK
pip install openai
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8890/v1", api_key="your-key")
r = client.chat.completions.create(
    model="mercury-3",
    messages=[{"role": "user", "content": "Solve 37*43 step by step."}],
    stream=True,
)
for chunk in r:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

```js
// Node.js / TypeScript (OpenAI SDK)
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://127.0.0.1:8890/v1", apiKey: "your-key" });
const stream = await client.chat.completions.create({
  model: "mercury-3",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

Known-good platforms (all have an "OpenAI compatible" provider):

- **Open WebUI** — Settings → Connections → OpenAI API → URL `.../v1`
- **LobeChat** — AI service provider → custom → OpenAI compatible
- **NextChat / ChatGPT-Next-Web** — custom endpoint + key
- **LibreChat** — `librechat.yaml` → `endpoints.custom` (OpenAI-compatible)
- **Dify / FastGPT / Gradio Chatbot** — OpenAI-compatible model provider
- **Cherry Studio / ChatBox / LM Studio / AnythingLLM** — custom OpenAI endpoint
- Any code using `openai` SDK with `base_url` (see above)

## Telegram chatbot (serverless, zero servers)

The `telegram-bot/` subproject is a [Telegram Serverless](https://core.telegram.org/bots/serverless)
handler (`tgcloud`) that runs the chat engine **entirely inside Telegram's
own sandbox** — no VPS, no container, no long-running process of yours. Two
engine modes:

- **`direct` (default)** — the bot calls `chat.inceptionlabs.ai` straight
  from the Telegram sandbox using sessions captured on your PC
  (`npm run sessions`, a few seconds every few hours). For a fully
  hands-off setup, the bundled `collector/` service (Railway/Render/Docker)
  refreshes sessions automatically — and the bot calls it itself when
  sessions expire (self-healing).
- **`bridge`** — the bot calls this package's bridge instead, if you later
  prefer the most robust option (one small VPS/Docker host).

```bash
cd telegram-bot
npm run sessions                 # capture Inception sessions on your PC
npx tgcloud login                # CLI access token from @BotFather → Serverless
npx tgcloud push && npx tgcloud migrate && npx tgcloud webhook sync
```

See [`telegram-bot/README.md`](telegram-bot/README.md) for details, the
honest limitations of direct mode (session expiry, occasional checkpoint
challenges), and the offline test suites (`npm test`).

## Thinking / reasoning

Mercury 3 decides on its own whether to think; the bridge **never injects
prompt directives** (that would slow the model down). Anything the model
produces as reasoning is **scraped and delivered to you**:

- native reasoning chunks (`reasoning-delta` / `thinking-delta`)
- a `<think>…</think>` block, if the model writes one
- reasoning embedded in the final message payload (recovered)

It is streamed as `reasoning_content` (and `reasoning`) in the SSE delta —
the exact field most chat platforms use for their "thinking" panel.

You control delivery via `BRIDGE_THINKING`:

| Mode | Behavior |
|---|---|
| `end` *(default)* | reasoning collected and sent as one complete block just before the final chunk — good for platforms that show a filled-in thinking block |
| `live` | every reasoning delta forwarded as it arrives — fills the thinking panel in real time |
| `off` | reasoning stripped entirely |

Effort levels (`reasoning_effort` in the request body) map to the platform's
own levels: `off/none/minimal → instant`, `low → low`, `medium → medium`,
`high/max → max`. If a client sends a field the site doesn't know, the
bridge retries without it, so requests are never rejected.

## Endpoints

| Method & path | Description |
|---|---|
| `POST /v1/chat/completions` | Chat completion — streaming SSE and non-stream; `tools` supported via the tool-call shim; `reasoning_effort` handled |
| `GET /v1/models` | `mercury-3`, `mercury-3-decide` + context/max-output metadata |
| `GET /v1/usage` | Recent requests: tokens, tokens/s, TTFT, chunk inventory |
| `GET /v1/effort-probe` | Probe which effort field the site honours (`?apply=1&field=...` to set) |
| `POST /v1/session/refresh` | Force a checkpoint re-solve |
| `GET /healthz` | Liveness (used by Docker healthcheck) |
| `GET /` | Status summary |

## Operations

- **Logs** — key events are prefixed: `[usage]`, `[effort]`, `[think]`,
  `[tool-shim]`, `[browser]`, `[warmup]`.
- **Auto-refresh** — keep sessions alive: `BRIDGE_AUTO_REFRESH=5`.
- **Multi-session** — add more accounts to `data/creds.json` (or run `npm
  run warmup` again); the bridge load-balances and rotates past dead ones.
- **Self-healing** — stalled streams fail fast (60 s stall / 240 s total
  timeouts), the page is reloaded and requests retry; an empty upstream
  answer becomes a `502`, never an empty success.
- **Update** — replace the package folder and restart; `data/creds.json`
  (and `.env`) survive.

## Security

- Set `BRIDGE_API_KEY` whenever the port is reachable by others; without it,
  anyone with network access can burn your free-chat quota.
- Bind to `127.0.0.1` and expose through a TLS reverse proxy (nginx example
  in `deploy/nginx.conf.example`) for public deployments.
- The free-chat credential file is a secret — keep `data/creds.json` out of
  backups/CI (it is git-ignored).

## Deploying on bare metal (systemd + nginx)

1. Put the package in `/opt/inception-free-bridge`, create a service user,
   `chown -R` it, and copy `deploy/inception-free.service` to
   `/etc/systemd/system/`.
2. `systemctl daemon-reload && systemctl enable --now inception-free`.
3. Optional: terminate TLS with `deploy/nginx.conf.example`
   (`https://your.domain/v1`).

## Tests

All offline — no network, no real browser, no phone:

```bash
npm install
npm test          # unit tests (tool shim, think scraper, page script, CDP stream, e2e)
npm run smoke     # full self-test against a spawned server (fake browser upstream)
npm run doctor    # environment report: node / chromium / sessions
```

## Packaging & moving to another server

```bash
bash bin/package.sh              # -> inception-free-bridge-1.0.0.tgz (~250 KB)
bash bin/package.sh --with-deploy  # + docker/, deploy/, .env.example
```

Then on the target server: unpack → `bash bin/setup.sh` → `npm run warmup`
→ `./bin/inception-free`.

## Dependencies

- **Runtime:** Node.js ≥ 18 only. The bridge speaks to the site over HTTP and
  drives chromium over the Chrome DevTools Protocol (raw WebSocket) — no npm
  packages are required to run.
- **Optional:** `playwright` (only used by `register-playwright.mjs`, auto
  account registration) — installed by `setup.sh` when network is available.
- **Recommended:** any chromium/chrome binary for checkpoint solving and
  browser-context streaming (`BRIDGE_CHROMIUM`). If your distro has none (or
  only a snap stub), install Playwright's bundled browser — `npx playwright
  install chromium` — and the bridge finds it automatically (it checks
  `$PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and PATH).

## Troubleshooting

### Warmup fails with "chromium CDP did not come up"

The browser binary could not start in this environment. Common causes:

- No real chromium exists on the machine (e.g. `/usr/bin/chromium-browser`
  is a snap stub) → install one: `npx playwright install chromium`, or
  `apt-get install chromium`.
- The container is too restrictive (no `/dev/shm`, seccomp blocks Chrome's
  syscalls). Run the container with `--shm-size 1g` and without a
  seccomp profile; on a normal VPS/Docker setup chromium runs fine.
- The checkpoint may need a clean IP. If warmup keeps failing, use the
  manual import instead — `npm run creds` (paste cookies from your own
  browser); it works on any machine, browser or not.

### Requests hang or time out

Stalled upstreams fail fast by design: 60 s without data → error + reload,
240 s total stream cap. If you see `upstream stalled` in logs, the site
itself is slow or the session expired — the bridge retries automatically and
re-solves sessions when `BRIDGE_AUTO_REFRESH` is on.

### A platform says "model not found"

Make sure the chat platform sends the model id exactly as exposed by
`GET /v1/models`: `mercury-3` or `mercury-3-decide`. Some platforms append
a suffix — set the model name explicitly in the platform's settings.

## Limitations & fair use

- The free chat has its own context cap; very long conversations are trimmed
  (oldest turns dropped first, system message and newest turn kept).
- One conversation/turn runs through one browser tab but requests are
  serialized per browser; concurrent clients queue on a mutex (safe, but
  throughput is bounded by the site, not by this bridge).
- This is a personal-use bridge for the free web chat. Respect Inception's
  terms of service, don't resell the API, and don't hammer it — the warmup
  and browser mode exist precisely to behave like a normal user.
