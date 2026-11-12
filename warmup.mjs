#!/usr/bin/env node
// Vercel Security Checkpoint solver + guest-session bootstrap for chat.inceptionlabs.ai.
//
// The checkpoint is an automatic JS challenge served by Vercel's edge. A real
// browser executes it, gets `vc_*` cookies (plus the app's own guest token),
// after which plain HTTP traffic with those cookies is served normally.
//
// Usage:
//   node warmup.mjs [--output creds.json] [--headless] [--timeout-ms 120000]
//
// Output (creds.json):
//   { active: [ { cookies: {...}, bearer: "<token if any>", created_at: ... } ] }

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUTPUT = arg('output', 'creds.json');
const HEADLESS = !args.includes('--headed');
const TIMEOUT_MS = parseInt(arg('timeout-ms', '120000'), 10);
const LOOP_HOURS = parseFloat(arg('loop-hours', '0')); // 0 = single run; >0 = loop forever
// Optional proxy for the checkpoint-solving browser. Set via --proxy or the
// WARMUP_PROXY env var (e.g. "http://user:pass@host:port"). When running in
// a datacenter (Render/Railway), a residential/mobile proxy is what lets the
// Vercel checkpoint pass.
const PROXY = arg('proxy', '') || process.env.WARMUP_PROXY || '';
// On Android/Termux: point at the native chromium (pkg install chromium).
// Auto-detect Termux chromium if no explicit path is given.
function detectChromium() {
  const explicit = arg('chromium', '') || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '';
  if (explicit) return explicit;
  const names = ['chromium', 'chromium-browser', 'chromium-headless-shell', 'google-chrome', 'google-chrome-stable'];
  try {
    if (process.env.PREFIX) {
      for (const n of names) {
        const c = `${process.env.PREFIX}/bin/${n}`;
        if (fs.existsSync(c)) return c;
      }
    }
    // Server portability: scan PATH (Debian/Ubuntu ship chromium-browser
    // on PATH) so warmup works out of the box on a normal server.
    for (const dir of String(process.env.PATH || '').split(':')) {
      if (!dir) continue;
      for (const n of names) {
        const c = path.join(dir, n);
        if (fs.existsSync(c)) return c;
      }
    }
  } catch {}
  return '';
}
const CHROMIUM_PATH = detectChromium();

const TARGET = 'https://chat.inceptionlabs.ai/';
const CHECKPOINT_TITLE = 'Vercel Security Checkpoint';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function solve() {
  // On Android/Termux (process.platform === 'android') Playwright cannot even load.
  // Use the built-in CDP driver with the native chromium binary.
  if (process.platform === 'android') {
    const { solveWithCdp } = await import('./lib/cdp-driver.mjs');
    if (!CHROMIUM_PATH) {
      throw new Error(
        'chromium not found — run: pkg install chromium, then retry. ' +
        'If the binary has a different name (e.g. chromium-browser), pass: --chromium "$PREFIX/bin/chromium-browser"'
      );
    }
    const res = await solveWithCdp({ chromiumPath: CHROMIUM_PATH, timeoutMs: TIMEOUT_MS, headless: HEADLESS, proxy: PROXY });
    return { ...res, bearer: extractBearer(res.cookies, res.localStorage) };
  }

  // Desktop: prefer Playwright (real browser), fall back to CDP if not installed.
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({
      headless: HEADLESS,
      executablePath: CHROMIUM_PATH || undefined,
      chromiumSandbox: false,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox'],
      proxy: PROXY ? { server: PROXY } : undefined,
    });
    try {
      const ctx = await browser.newContext({
        userAgent: UA,
        viewport: { width: 1280, height: 800 },
        locale: 'en-US',
        timezoneId: 'America/Los_Angeles',
      });
      const page = await ctx.newPage();

      // Capture auth material from network traffic: Authorization headers on
      // requests/responses, and JWT-shaped tokens inside JSON API responses.
      const netAuth = { bearer: '' };
      page.on('request', req => {
        const h = req.headers()['authorization'] || '';
        if (h.startsWith('Bearer ')) netAuth.bearer = h.slice(7);
      });
      page.on('response', async res => {
        try {
          const h = res.headers()['authorization'] || '';
          if (h.startsWith('Bearer ')) netAuth.bearer = h.slice(7);
          const ct = res.headers()['content-type'] || '';
          if (/api|auth|token|session|chat|login/i.test(res.url()) && ct.includes('json')) {
            const body = await res.text().catch(() => '');
            const m = body.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/);
            if (m) netAuth.bearer = netAuth.bearer || m[0];
          }
        } catch {}
      });

      await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 60000 });

      const deadline = Date.now() + TIMEOUT_MS;
      let title = '';
      while (Date.now() < deadline) {
        title = await page.title().catch(() => '');
        if (title && !title.includes(CHECKPOINT_TITLE) && title !== '') break;
        await page.waitForTimeout(2500);
      }

      // Poll for cookies up to 45s (the app sets its session cookies during
      // bootstrap, not at first paint). Reload once if nothing appears.
      const cookies = {};
      const start = Date.now();
      let reloaded = false;
      while (Date.now() - start < 45000 && Date.now() < deadline) {
        const arr = await ctx.cookies().catch(() => []);
        for (const c of arr) cookies[c.name] = c.value;
        if (Object.keys(cookies).some(k => k.startsWith('vc_')) || Object.keys(cookies).length >= 2) break;
        if (!reloaded && Date.now() - start > 15000) {
          reloaded = true;
          await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        }
        await page.waitForTimeout(1500);
      }
      const finalArr = await ctx.cookies().catch(() => []);
      for (const c of finalArr) cookies[c.name] = c.value;

      const storageData = await page.evaluate(() => {
        const dump = s => {
          const o = {};
          try { for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } } catch {}
          return o;
        };
        return { ls: dump(localStorage), ss: dump(sessionStorage) };
      }).catch(() => ({ ls: {}, ss: {} }));

      const ls = storageData.ls || {};
      const ss = storageData.ss || {};
      const bearer = netAuth.bearer || extractBearer(cookies, { ...ls, ...ss });
      return { cookies, localStorage: ls, sessionStorage: ss, bearer, title: title || '(unknown)' };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    console.log(`[warmup] playwright launch failed (${String(e.message).slice(0, 120)}) — using built-in CDP driver`);
    const { solveWithCdp } = await import('./lib/cdp-driver.mjs');
    if (!CHROMIUM_PATH) {
      throw new Error('no chromium path (use --chromium <path>, or install a browser: npx playwright install chromium)');
    }
    const res = await solveWithCdp({ chromiumPath: CHROMIUM_PATH, timeoutMs: TIMEOUT_MS, headless: HEADLESS, proxy: PROXY });
    return { ...res, bearer: extractBearer(res.cookies, res.localStorage) };
  }
}

function extractBearer(cookies, storageData) {
  // Look for a JWT by shape (header.payload.signature of base64url), preferring
  // keys that mention token/auth/jwt.
  const jwtRe = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/;
  const entries = { ...(cookies || {}), ...(storageData || {}) };
  for (const [k, v] of Object.entries(entries)) {
    if (/jwt|token|auth/i.test(k) && typeof v === 'string' && jwtRe.test(v)) return v;
  }
  for (const v of Object.values(entries)) {
    if (typeof v === 'string' && jwtRe.test(v)) return v;
  }
  return '';
}

function loadExisting() {
  try {
    const d = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    return Array.isArray(d) ? d : (d.active || []);
  } catch { return []; }
}

async function runOnce() {
  const result = await solve();
  console.log('page title after warmup:', result.title);
  console.log('cookies:', Object.keys(result.cookies).join(', ') || '(none)');
  console.log('localStorage keys:', Object.keys(result.localStorage || {}).join(', ') || '(none)');
  console.log('sessionStorage keys:', Object.keys(result.sessionStorage || {}).join(', ') || '(none)');
  console.log('bearer token:', result.bearer ? result.bearer.slice(0, 20) + '…' : '(none)');

  if (!Object.keys(result.cookies).length && !result.bearer) {
    console.error('[!] warmup did not yield any cookies. The checkpoint may require a clean IP.');
    if (result.title) console.error('    final title was:', result.title);
    return false;
  }

  const list = loadExisting();
  list.push({ cookies: result.cookies, bearer: result.bearer, sessionStorage: result.sessionStorage || {}, created_at: Math.floor(Date.now() / 1000), id: randomUUID() });
  fs.writeFileSync(OUTPUT, JSON.stringify({ active: list }, null, 2));
  console.log(`saved session -> ${OUTPUT} (${list.length} total)`);
  return true;
}

if (LOOP_HOURS > 0) {
  console.log(`[warmup-loop] solving every ${LOOP_HOURS}h (Ctrl+C to stop)`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await runOnce();
    await new Promise(r => setTimeout(r, LOOP_HOURS * 3600 * 1000));
  }
} else {
  await runOnce();
}
