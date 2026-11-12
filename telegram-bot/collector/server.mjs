#!/usr/bin/env node
// Session collector — runs in the cloud (Railway / Render / any Docker
// host) and keeps the Telegram bot running, automatically.
//
// Two jobs, depending on the bot's mode:
//
//   Bot mode 'api'   (official Inception API — RECOMMENDED):
//     No sessions are needed at all. The collector simply injects the
//     INCEPTION_API_KEY from its environment into the bot's config and
//     redeploys it. No chromium, no checkpoint, nothing to refresh.
//
//   Bot mode 'direct' (free web chat):
//     The collector solves the Vercel checkpoint with chromium, writes the
//     fresh sessions, sets the bot's collectorUrl (self-healing), and
//     redeploys the bot.
//
// Environment:
//   TGCLOUD_TOKEN            required — CLI access token (@BotFather → Serverless)
//   INCEPTION_API_KEY        optional — official API key; if set, bot switches
//                            to api mode (recommended, no sessions needed)
//   PORT                     default 8000
//   REFRESH_INTERVAL_HOURS   default 6 (0 disables the timer)
//   SESSION_COUNT            default 3 (how many web-chat sessions to keep)
//   WARMUP_TIMEOUT_MS        default 150000
//   PUBLIC_URL               optional — your public URL; auto-set the bot's
//                            collectorUrl so its direct mode can self-heal.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // telegram-bot/
const APP_DIR = path.dirname(ROOT);                                     // inception-portable/
const BOT_DIR = ROOT;
const CREDS_TMP = '/tmp/collector-creds.json';
const CFG_PATH = path.join(BOT_DIR, 'tgcloud', 'lib', 'config.js');

const PORT = parseInt(process.env.PORT || '8000', 10);
const INTERVAL_HOURS = parseFloat(process.env.REFRESH_INTERVAL_HOURS || '6');
const COUNT = parseInt(process.env.SESSION_COUNT || '3', 10);
const WARMUP_MS = parseInt(process.env.WARMUP_TIMEOUT_MS || '150000', 10);
const API_KEY = (process.env.INCEPTION_API_KEY || '').trim();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let out = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (out += d));
  const t = setTimeout(() => child.kill('SIGKILL'), (opts.timeoutMs || 240000));
  child.on('error', e => { clearTimeout(t); reject(e); });
  child.on('close', code => {
    clearTimeout(t);
    if (code !== 0) reject(new Error(`${cmd} exit ${code}: ${out.slice(-600)}`));
    else resolve(out);
  });
});

let refreshing = false;
let lastRefresh = null;
let lastError = null;

function detectPublicUrl() {
  const fromEnv = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  return '';
}

// In direct mode, point the bot's collectorUrl at this service so it can
// self-heal.
function patchCollectorUrl() {
  const url = detectPublicUrl();
  if (!url) { console.log('[collector] no PUBLIC_URL — leaving bot collectorUrl unset'); return; }
  try {
    let src = fs.readFileSync(CFG_PATH, 'utf8');
    if (src.includes('collectorUrl: \'\'')) {
      src = src.replace("collectorUrl: ''", `collectorUrl: '${url}'`);
      fs.writeFileSync(CFG_PATH, src);
      console.log(`[collector] bot collectorUrl set to ${url}`);
    }
  } catch (e) {
    console.log('[collector] could not patch config.js:', String(e).slice(0, 120));
  }
}

// Inject the official API key and switch the bot to api mode if env set.
// Returns true if the bot is now in api mode.
function patchInceptionKey() {
  if (!API_KEY) { console.log('[collector] no INCEPTION_API_KEY — leaving bot mode as-is'); return false; }
  try {
    let src = fs.readFileSync(CFG_PATH, 'utf8');
    let changed = false;
    if (src.includes("inceptionApiKey: ''")) {
      src = src.replace("inceptionApiKey: ''", `inceptionApiKey: '${API_KEY}'`);
      changed = true;
    }
    if (src.includes("mode: 'direct'")) {
      src = src.replace("mode: 'direct'", "mode: 'api'");
      changed = true;
    }
    const isApi = src.includes("mode: 'api'");
    if (changed) {
      fs.writeFileSync(CFG_PATH, src);
      console.log('[collector] injected INCEPTION_API_KEY and switched bot to api mode');
    } else {
      console.log(`[collector] config already set (api mode: ${isApi}) — leaving as-is`);
    }
    return isApi;
  } catch (e) {
    console.log('[collector] could not patch config.js:', String(e).slice(0, 120));
    return false;
  }
}

function botMode() {
  try {
    const src = fs.readFileSync(CFG_PATH, 'utf8');
    const m = src.match(/mode:\s*'(\w+)'/);
    return m ? m[1] : 'direct';
  } catch { return 'direct'; }
}

async function refreshOnce() {
  if (refreshing) return { ok: true, note: 'already running' };
  refreshing = true;
  try {
    // 0) always inject the API key & decide the mode
    const apiMode = patchInceptionKey();

    if (apiMode || botMode() === 'api') {
      // API mode: no sessions, no warmup — just redeploy the bot with the key.
      console.log('[collector] api mode — no sessions needed; redeploying bot');
      patchCollectorUrl(); // harmless; keeps direct fallback sane
      await run('npx', ['tgcloud', 'push'], { cwd: BOT_DIR, timeoutMs: 120000 });
      try { await run('npx', ['tgcloud', 'webhook', 'sync'], { cwd: BOT_DIR, timeoutMs: 60000 }); } catch {}
    } else {
      // direct mode: warm up sessions, write them, then redeploy.
      const warmup = path.join(APP_DIR, 'warmup.mjs');

      // Prefer Playwright's bundled chromium (most reliable checkpoint
      // solver); fall back to any system chromium via the warmup's own
      // auto-detection.
      let chromiumArg = [];
      try {
        const pw = await run(process.execPath, ['-e', "import('playwright').then(p=>console.log(p.chromium.executablePath()))"], { timeoutMs: 30000 });
        const p = pw.trim();
        if (p && fs.existsSync(p)) chromiumArg = ['--chromium', p];
      } catch { /* playwright not installed -> warmup auto-detection */ }

      // Automatic rotating proxy pool: fresh proxies are fetched from public
      // lists, health-checked, and one is used per warmup attempt. Any
      // PROXY_LIST env entries act as extra seeds (highest priority).
      const { ProxyPool } = await import('./lib/proxy-pool.mjs');
      const pool = new ProxyPool({ minPool: 3, maxValidated: 12 });
      const envProxyList = (process.env.PROXY_LIST || '')
        .split('\n').map(s => s.trim()).filter(Boolean);
      const envProxyFor = i => envProxyList.length ? envProxyList[(i - 1) % envProxyList.length] : '';

      // Pre-warm the pool once (fetch + validate) so attempts can start
      // through a proxy immediately.
      try { await pool.ensurePool(); } catch {}

      // The Vercel checkpoint sometimes needs several attempts from a
      // datacenter IP: retry with backoff until we get cookies.
      const MAX_ATTEMPTS = Math.max(4, envProxyList.length, pool.minPool);
      let solved = false;
      let warmupTrace = '';
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let proxy = envProxyFor(attempt);
        if (!proxy) {
          const p = await pool.next().catch(() => null);
          proxy = p ? pool.toUrl(p) : '';
        }
        if (proxy) console.log(`[collector] warmup attempt ${attempt}/${MAX_ATTEMPTS} via proxy ${proxy.slice(0, 40)}…`);
        else console.log(`[collector] warmup attempt ${attempt}/${MAX_ATTEMPTS} (no proxy)…`);
        try {
          const out = await run(process.execPath, [warmup, '--output', CREDS_TMP, '--headless', '--timeout-ms', String(WARMUP_MS), ...chromiumArg], {
            timeoutMs: WARMUP_MS + 45000,
            env: { ...process.env, ...(proxy ? { WARMUP_PROXY: proxy } : {}) },
          });
          warmupTrace = out.trim().split('\n').slice(-8).join('\n');
        } catch (e) {
          console.log(`[collector] warmup attempt ${attempt} failed: ${String(e?.message || e).slice(0, 200)}`);
          warmupTrace = String(e?.message || e).slice(-500);
        }
        try {
          const d = JSON.parse(fs.readFileSync(CREDS_TMP, 'utf8'));
          const arr = Array.isArray(d) ? d : (d.active || []);
          if (arr.some(a => a && a.bearer && a.cookies && Object.keys(a.cookies).length)) {
            solved = true;
            break;
          }
        } catch {}
        if (attempt < MAX_ATTEMPTS) await sleep(15000);
      }
      if (!solved) {
        throw new Error('warmup could not obtain a session after ' + MAX_ATTEMPTS + ' attempts (Vercel checkpoint on this IP; proxies: env=' + envProxyList.length + ' pool=' + pool.size + ' stats=' + JSON.stringify(pool.stats) + ')\n--- warmup trace ---\n' + warmupTrace);
      }

      console.log('[collector] writing sessions.js…');
      const updater = path.join(BOT_DIR, 'tools', 'update-sessions.mjs');
      await run(process.execPath, [updater, '--from', CREDS_TMP, '--count', String(COUNT)], { timeoutMs: 30000 });

      patchCollectorUrl();
      await run('npx', ['tgcloud', 'push'], { cwd: BOT_DIR, timeoutMs: 120000 });
      try { await run('npx', ['tgcloud', 'webhook', 'sync'], { cwd: BOT_DIR, timeoutMs: 60000 }); } catch {}
    }

    lastRefresh = { at: new Date().toISOString(), ok: true, mode: botMode() };
    lastError = null;
    console.log('[collector] refresh OK');
    return { ok: true, at: lastRefresh.at, mode: lastRefresh.mode };
  } catch (e) {
    lastError = String(e?.message || e).slice(0, 500);
    lastRefresh = { at: new Date().toISOString(), ok: false, error: lastError };
    console.error('[collector] refresh FAILED:', lastError);
    return { ok: false, error: lastError };
  } finally {
    refreshing = false;
    try { fs.rmSync(CREDS_TMP, { force: true }); } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };
  // control plane (admin panel + reporting) owns /panel and /api prefixes
  if (globalThis.__controlApi && (u.pathname.startsWith('/panel') || u.pathname.startsWith('/api'))) {
    try {
      return await globalThis.__controlApi.handle(u, req, res);
    } catch (e) {
      return send(500, { error: String(e?.message || e).slice(0, 200) });
    }
  }
  if (u.pathname === '/healthz') return send(200, { ok: true });
  if (u.pathname === '/status') return send(200, { refreshing, lastRefresh, lastError, mode: botMode() });
  if (u.pathname === '/refresh' && req.method === 'POST') {
    const result = await refreshOnce();
    return send(result.ok ? 200 : 502, result);
  }
  return send(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`[collector] listening on :${PORT}`);
  if (!process.env.TGCLOUD_TOKEN) console.warn('[collector] WARNING: TGCLOUD_TOKEN is not set — tgcloud push will fail');
  // patch the API key + decide the very first action
  const apiMode = patchInceptionKey();
  console.log(`[collector] bot mode: ${apiMode ? 'api' : botMode()}`);

  // --- control plane (admin panel + reporting) ---
  const { ControlState } = await import('./lib/control-state.mjs').catch(() => ({ ControlState: null }));
  const { createControlApi } = await import('./lib/control-api.mjs').catch(() => ({ createControlApi: null }));
  const state = new ControlState({
    file: process.env.CONTROL_STATE_FILE || path.join(APP_DIR, 'data', 'control.json'),
  });
  const tgCloudPush = async () => {
    try {
      await run('npx', ['tgcloud', 'push'], { cwd: BOT_DIR, timeoutMs: 120000 });
      try { await run('npx', ['tgcloud', 'webhook', 'sync'], { cwd: BOT_DIR, timeoutMs: 60000 }); } catch {}
      console.log('[control] tgcloud push + webhook sync done');
    } catch (e) {
      console.error('[control] tgcloud push failed:', String(e?.message || e).slice(0, 160));
    }
  };
  const controlApi = createControlApi({ state, botDir: BOT_DIR, run, tgCloudPush });
  globalThis.__controlApi = controlApi;
  console.log(`[control] control plane ready (${state.state.providers.length} providers, ${state.state.models.length} models, ${state.state.admins.length} admins)`);
  if (INTERVAL_HOURS > 0) {
    console.log(`[collector] auto-refresh every ${INTERVAL_HOURS}h`);
    setInterval(() => { refreshOnce().catch(() => {}); }, INTERVAL_HOURS * 3600 * 1000).unref();
    setTimeout(() => refreshOnce().catch(() => {}), 15000).unref(); // shortly after boot
  } else {
    console.log('[collector] timer disabled (REFRESH_INTERVAL_HOURS=0) — only POST /refresh triggers refreshes');
  }
});
