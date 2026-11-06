#!/usr/bin/env node
// doctor — environment check for the portable bridge.
// Usage: node bin/doctor.mjs
// Prints a report on node, chromium, sessions and effective config, and tries
// a quick /healthz probe against a freshly spawned server (fake browser mode,
// fully offline).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = (tag, msg) => console.log(`${tag.padEnd(5)} ${msg}`);

// ---- node ---------------------------------------------------------------
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
log(nodeMajor >= 18 ? 'OK' : 'BAD', `Node.js ${process.versions.node}${nodeMajor >= 18 ? '' : ' (need >=18)'}`);

// ---- chromium ------------------------------------------------------------
function findChromium() {
  const explicit = process.env.BRIDGE_CHROMIUM;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const names = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
  for (const n of names) {
    const envPath = process.env.PATH || '';
    for (const dir of envPath.split(':')) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  if (process.env.PREFIX) {
    for (const n of ['chromium', 'chromium-browser', 'chromium-headless-shell']) {
      const p = `${process.env.PREFIX}/bin/${n}`;
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}
const chromium = findChromium();
log(chromium ? 'OK' : 'WARN', chromium ? `chromium: ${chromium}` : 'chromium: not found — warmup needs a browser (auto browser mode disabled)');

// ---- sessions ------------------------------------------------------------
const credsPath = process.env.BRIDGE_CREDS || path.join(ROOT, 'data', 'creds.json');
let sessions = 0;
if (fs.existsSync(credsPath)) {
  try {
    const d = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const arr = Array.isArray(d) ? d : d.active || [];
    sessions = arr.filter(a => a && a.bearer).length;
  } catch { sessions = 0; }
}
log(sessions > 0 ? 'OK' : 'WARN', `sessions: ${sessions} (${credsPath})${sessions ? '' : ' — run: npm run warmup (or npm run creds)'}`);

// ---- .env ---------------------------------------------------------------
const envFile = path.join(ROOT, '.env');
log(fs.existsSync(envFile) ? 'OK' : 'INFO', fs.existsSync(envFile) ? '.env found' : '.env absent (defaults are used)');

// ---- live probe (offline, fake browser) ----------------------------------
const port = 9300 + Math.floor(Math.random() * 500);
const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-doctor-'));
const seedCreds = path.join(seedDir, 'creds.json');
fs.writeFileSync(seedCreds, JSON.stringify({ active: [{ id: 'doctor', bearer: 'dummy.token', cookies: {}, created_at: 9999999999 }] }));

const server = spawn(process.execPath, [
  'server.mjs', '--port', String(port), '--creds', seedCreds,
  '--browser-mode', 'on', '--chromium', '/bin/true',
], {
  cwd: ROOT,
  env: { ...process.env, BRIDGE_FAKE_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logTxt = '';
server.stdout.on('data', d => (logTxt += String(d)));
server.stderr.on('data', d => (logTxt += String(d)));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ok = false;
try {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) { ok = true; break; } } catch {}
    await sleep(250);
  }
  if (ok) {
    const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
    log('OK', `server boots; /v1/models -> ${models.data.map(m => m.id).join(', ')}`);
  } else {
    log('BAD', 'server did not answer /healthz');
    console.log(logTxt.split('\n').slice(-10).join('\n'));
  }
} finally {
  server.kill('SIGKILL');
  await sleep(200);
  try { fs.rmSync(seedDir, { recursive: true, force: true }); } catch {}
}

console.log('\nTip: copy .env.example to .env and edit it, then run ./bin/inception-free');
