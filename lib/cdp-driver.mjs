// Minimal Chrome DevTools Protocol driver — no external dependencies.
// Used on Android/Termux where Playwright cannot run (process.platform === 'android').
// Drives the native chromium binary via --remote-debugging-port + WebSocket.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

async function openTab(port, url) {
  const base = `http://127.0.0.1:${port}`;
  for (const method of ['PUT', 'GET']) {
    try {
      const r = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method });
      if (r.ok) {
        const t = await r.json();
        if (t.webSocketDebuggerUrl) return t;
      }
    } catch {}
  }
  // fallback: use the first existing tab
  try {
    const r = await fetch(`${base}/json/list`);
    const tabs = await r.json();
    return tabs[0] || null;
  } catch {
    return null;
  }
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    };
  }
  send(method, params = {}, timeout = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeout);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

export async function solveWithCdp({ chromiumPath, timeoutMs = 120000, headless = true }) {
  const port = 9200 + Math.floor(Math.random() * 500);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const args = [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--disable-extensions',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
  ];
  if (headless) args.unshift('--headless=new');
  args.push('about:blank');

  const child = spawn(chromiumPath, args, { stdio: 'ignore' });
  let cdp = null;
  const stopChild = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await new Promise(res => {
      const t = setTimeout(() => res(), 3000);
      child.once('exit', () => { clearTimeout(t); res(); });
    });
  };
  const cleanupProfile = async () => {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        return;
      } catch {
        await sleep(300);
      }
    }
  };
  try {
    const ready = await waitForJsonVersion(port, 30000);
    if (!ready) throw new Error(`chromium CDP did not come up on port ${port} (binary: ${chromiumPath})`);

    const url = 'https://chat.inceptionlabs.ai/';
    const tab = await openTab(port, url);
    if (!tab?.webSocketDebuggerUrl) throw new Error('no CDP target available');

    cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url });

    const deadline = Date.now() + timeoutMs;
    let title = '';
    let passedCheckpoint = false;
    while (Date.now() < deadline) {
      const res = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }).catch(() => ({}));
      title = res?.result?.value ?? '';
      if (title && !title.includes('Vercel Security Checkpoint')) {
        passedCheckpoint = true;
        break;
      }
      await sleep(2500);
    }
    if (!passedCheckpoint) return { title, cookies: {}, localStorage: {}, sessionStorage: {} };

    // The checkpoint is solved; now collect cookies until the checkpoint's
    // proof cookies (vc_*) actually appear — those are what the API edge
    // checks. Keep polling up to 30s and merge every sample.
    const cookies = {};
    const collectCookies = async () => {
      const res = await cdp.send('Network.getAllCookies').catch(() => ({}));
      const cur = {};
      for (const c of res.cookies || []) cur[c.name] = c.value;
      Object.assign(cookies, cur);
      return cur;
    };

    const storageExpr = '(()=>{const dump=s=>{const o={};for(let i=0;i<s.length;i++){const k=s.key(i);o[k]=s.getItem(k)}return o};return {ls:dump(localStorage),ss:dump(sessionStorage)}})()';
    const readStorage = async () => {
      const res = await cdp.send('Runtime.evaluate', { expression: storageExpr, returnByValue: true }).catch(() => ({}));
      return res?.result?.value ?? { ls: {}, ss: {} };
    };

    let sawVc = false;
    let reloaded = false;
    const start = Date.now();
    const storageDeadline = start + 45000;
    while (Date.now() < storageDeadline) {
      const cur = await collectCookies();
      if (Object.keys(cur).some(k => k.startsWith('vc_'))) {
        sawVc = true;
        break;
      }
      // If no checkpoint cookie after ~15s, force a reload so the challenge
      // (and its proof cookies) re-runs in this browser context.
      if (!reloaded && Date.now() - start > 15000) {
        reloaded = true;
        try { await cdp.send('Page.reload'); } catch {}
      }
      await sleep(1500);
    }

    const { ls, ss } = await readStorage();
    if (!sawVc) {
      console.warn('[cdp] WARNING: no vc_* checkpoint cookie observed (cookies so far: ' + (Object.keys(cookies).join(', ') || 'none') + ')');
    }

    return { title, cookies, localStorage: ls, sessionStorage: ss };
  } finally {
    if (cdp) try { cdp.close(); } catch {}
    await stopChild();
    await cleanupProfile();
  }
}
