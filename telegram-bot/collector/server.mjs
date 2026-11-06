#!/usr/bin/env node
// Session collector — runs in the cloud (Railway / Render / any Docker
// host) and keeps the Telegram bot's Inception sessions fresh, fully
// automatically. Nothing runs on your PC.
//
// What it does:
//   1. solves the Vercel checkpoint with a real chromium (headless)
//   2. writes the fresh sessions into telegram-bot/tgcloud/lib/sessions.js
//   3. redeploys the bot to Telegram Serverless via `npx tgcloud push`
//      (uses TGCLOUD_TOKEN, the same CLI token as your PC would)
//
// Trigger it:
//   - on demand:  POST /refresh   (the bot calls this itself when its
//     sessions expire — self-healing)
//   - periodically: REFRESH_INTERVAL_HOURS>0 makes the service refresh on a
//     timer (e.g. every 6h)
//
// Environment:
//   TGCLOUD_TOKEN            required — CLI access token (@BotFather → Serverless)
//   PORT                     default 8000
//   REFRESH_INTERVAL_HOURS   default 6 (0 disables the timer)
//   SESSION_COUNT            default 3 (how many sessions to keep)
//   WARMUP_TIMEOUT_MS        default 150000
//   PUBLIC_URL               optional — your public URL; auto-set the bot's
//                            collectorUrl so it can self-heal. Falls back to
//                            RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN.

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // telegram-bot/
const APP_DIR = path.dirname(ROOT);                                     // inception-portable/
const BOT_DIR = ROOT;
const CREDS_TMP = '/tmp/collector-creds.json';

const PORT = parseInt(process.env.PORT || '8000', 10);
const INTERVAL_HOURS = parseFloat(process.env.REFRESH_INTERVAL_HOURS || '6');
const COUNT = parseInt(process.env.SESSION_COUNT || '3', 10);
const WARMUP_MS = parseInt(process.env.WARMUP_TIMEOUT_MS || '150000', 10);

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
  // never guess — if Render/Railway give us nothing, leave unset
  return '';
}

function patchCollectorUrl() {
  const url = detectPublicUrl();
  if (!url) { console.log('[collector] no PUBLIC_URL — leaving bot collectorUrl unset (manual mode)'); return; }
  const cfgPath = path.join(BOT_DIR, 'tgcloud', 'lib', 'config.js');
  try {
    let src = fs.readFileSync(cfgPath, 'utf8');
    if (src.includes('collectorUrl: \'\'')) {
      src = src.replace("collectorUrl: ''", `collectorUrl: '${url}'`);
      fs.writeFileSync(cfgPath, src);
      console.log(`[collector] bot collectorUrl set to ${url}`);
    }
  } catch (e) {
    console.log('[collector] could not patch config.js:', String(e).slice(0, 120));
  }
}

async function refreshOnce() {
  if (refreshing) return { ok: true, note: 'already running' };
  refreshing = true;
  try {
    // 1) solve the checkpoint with chromium
    const warmup = path.join(APP_DIR, 'warmup.mjs');
    console.log('[collector] warmup…');
    await run(process.execPath, [warmup, '--output', CREDS_TMP, '--headless', '--timeout-ms', String(WARMUP_MS)], { timeoutMs: WARMUP_MS + 30000 });

    // 2) convert creds -> telegram-bot/tgcloud/lib/sessions.js
    console.log('[collector] writing sessions.js…');
    const updater = path.join(BOT_DIR, 'tools', 'update-sessions.mjs');
    await run(process.execPath, [updater, '--from', CREDS_TMP, '--count', String(COUNT)], { timeoutMs: 30000 });

    // 2b) make the bot self-healing: point its collectorUrl at this service
    patchCollectorUrl();

    // 3) redeploy the bot to Telegram Serverless
    console.log('[collector] tgcloud push…');
    await run('npx', ['tgcloud', 'push'], { cwd: BOT_DIR, timeoutMs: 120000 });
    try { await run('npx', ['tgcloud', 'webhook', 'sync'], { cwd: BOT_DIR, timeoutMs: 60000 }); } catch {}

    lastRefresh = { at: new Date().toISOString(), ok: true };
    lastError = null;
    console.log('[collector] refresh OK');
    return { ok: true, at: lastRefresh.at };
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
  if (u.pathname === '/healthz') return send(200, { ok: true });
  if (u.pathname === '/status') return send(200, { refreshing, lastRefresh, lastError });
  if (u.pathname === '/refresh' && req.method === 'POST') {
    const result = await refreshOnce();
    return send(result.ok ? 200 : 502, result);
  }
  return send(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[collector] listening on :${PORT}`);
  if (!process.env.TGCLOUD_TOKEN) console.warn('[collector] WARNING: TGCLOUD_TOKEN is not set — tgcloud push will fail');
  if (INTERVAL_HOURS > 0) {
    console.log(`[collector] auto-refresh every ${INTERVAL_HOURS}h`);
    setInterval(() => { refreshOnce().catch(() => {}); }, INTERVAL_HOURS * 3600 * 1000).unref();
    setTimeout(() => refreshOnce().catch(() => {}), 15000).unref(); // refresh shortly after boot
  } else {
    console.log('[collector] timer disabled (REFRESH_INTERVAL_HOURS=0) — only POST /refresh triggers refreshes');
  }
});
