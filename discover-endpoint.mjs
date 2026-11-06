#!/usr/bin/env node
// Discover the real chat API endpoint by reading the site's own JS bundles
// inside a real browser page (in-page fetch = same-origin, no checkpoint issue).
// Usage: node discover-endpoint.mjs [--output endpoint-discovery.json]

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const output = (args.indexOf('--output') >= 0 && args[args.indexOf('--output') + 1]) || 'endpoint-discovery.json';
const CHROME = process.env.PREFIX + '/bin/chromium-browser';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForJsonVersion(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
    };
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, timeout);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const SCAN_SCRIPT = `
(async () => {
  const results = new Set();
  const saw = new Set();
  const PATTERNS = [/completions/g, /chats/g, /\/api\//g, /\/v1\//g, /chat\//g, /session/g, /generate/g, /\/llm\//g,
    /thinking/g, /reasoning/g, /reasoning_effort/g, /reasoningEffort/g, /enable_thinking/g, /effort/g,
    /instant/g, /diffusing/g, /budget/g, /tool[_-]?call/g, /toolCall/g, /max[_-]?tokens/g, /temperature/g,
    /mercury[-.\w]*/g, /contextWindow/g, /context_length/g, /max_output/g];
  const CONTEXT = 140;
  try {
    const html = await (await fetch('/')).text();
    const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]);
    for (const s of scripts.slice(0, 40)) {
      if (saw.has(s)) continue;
      saw.add(s);
      try {
        const text = await (await fetch(s)).text();
        if (text.length > 5_000_000) continue;
        for (const p of PATTERNS) {
          for (const m of text.matchAll(p)) {
            const start = Math.max(0, m.index - CONTEXT);
            const end = Math.min(text.length, m.index + CONTEXT);
            const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
            results.add(snippet);
          }
        }
      } catch {}
    }
  } catch (e) {
    // ignore
  }

  // Same-origin probes: what does the site itself expose?
  const PATHS = ['/api/models', '/api/chat/models', '/api/model', '/api/config', '/api/chat/config',
    '/api/settings', '/api/user', '/api/credits', '/api/session', '/api/features', '/api/flags'];
  const endpoints = [];
  for (const path of PATHS) {
    try {
      const r = await fetch(path, { credentials: 'include' });
      const t = await r.text();
      endpoints.push({ path, status: r.status, body: t.slice(0, 3000) });
    } catch (e) {
      endpoints.push({ path, error: String(e) });
    }
  }

  // UI controls that mention thinking / reasoning / models
  const uiLabels = Array.from(document.querySelectorAll('button,[role="menuitem"],[role="option"],select option,label,[data-value]'))
    .map(el => (el.textContent || '').trim())
    .filter(t => t && /mercury|lambda|coder|think|reason|effort|instant|diffus|model|medium|high|low/i.test(t));

  return {
    hits: [...results].slice(0, 400),
    endpoints,
    uiLabels: Array.from(new Set(uiLabels)).slice(0, 80),
    url: location.href,
  };
})()
`;

 10200 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-'));
const child = spawn(CHROME, [
  '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio',
  '--remote-allow-origins=*', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--headless=new', 'https://chat.inceptionlabs.ai/',
], { stdio: 'ignore' });

let cdp = null;
try {
  await waitForJsonVersion(port, 30000);
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  const tabs = await r.json();
  const tab = tabs.find(t => t.type === 'page') || tabs[0];
  cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const res = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }).catch(() => ({}));
    if (res?.result?.value && !String(res.result.value).includes('Vercel')) break;
    await sleep(2500);
  }

  const out = await cdp.send('Runtime.evaluate', { expression: SCAN_SCRIPT, awaitPromise: true, returnByValue: true });
  const val = out?.result?.value ?? { hits: [] };
  fs.writeFileSync(output, JSON.stringify(val, null, 2));
  console.log('=== endpoint hits ===');
  for (const h of (val.hits || [])) console.log(h);
  console.log('\n=== same-origin endpoint probes ===');
  for (const e of (val.endpoints || [])) {
    console.log(`\n--- ${e.path} -> ${e.status || e.error}`);
    if (e.body) console.log(String(e.body).replace(/\s+/g, ' ').slice(0, 1200));
  }
  console.log('\n=== UI labels ===');
  for (const l of (val.uiLabels || [])) console.log(l);
  console.log(`\nsaved -> ${output}`);
} finally {
  if (cdp) { cdp.close(); }
  child.kill('SIGKILL');
  await new Promise(r => { const t = setTimeout(() => r(), 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(300); }
  }
}
