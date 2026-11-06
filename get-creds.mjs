#!/usr/bin/env node
// Manual credential import — for when the auto-warmup browser can't run
// (e.g. restricted container) or you want to reuse your own browser session.
//
// Usage: node get-creds.mjs [--cookies "k1=v1; k2=v2"] [--bearer <jwt>] [--output creds.json]
//
// How to get a valid session in your real browser:
//   1. Open https://chat.inceptionlabs.ai — let the Vercel checkpoint pass
//      (it resolves automatically in a real browser).
//   2. F12 → Network → send one chat message → click the "completions" request.
//   3. Copy the request headers:
//        - Authorization: Bearer <jwt>   (only if present)
//        - Cookie: <full cookie string>  (must include the vc_* checkpoint cookies)
//   4. Paste them below.

import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUTPUT = arg('output', 'creds.json');
let cookieStr = arg('cookies', '');
let bearer = arg('bearer', '');

if (!cookieStr || !bearer) {
  console.log('Paste the Cookie header value (from the completions request):');
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));
  if (!cookieStr) cookieStr = (await ask('Cookie: ')).trim();
  if (!bearer) bearer = (await ask('Bearer JWT (Enter to skip): ')).trim();
  rl.close();
}

const cookies = {};
for (const part of cookieStr.split(';')) {
  const eq = part.indexOf('=');
  if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
}

if (!Object.keys(cookies).length) {
  console.error('no cookies parsed — aborting');
  process.exit(1);
}

let list = [];
try {
  const old = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
  list = Array.isArray(old) ? old : (old.active || []);
} catch {}

list.push({ cookies, bearer, created_at: Math.floor(Date.now() / 1000) });
fs.writeFileSync(OUTPUT, JSON.stringify({ active: list }, null, 2));
console.log(`saved ${list.length} session(s) -> ${OUTPUT}`);
console.log('cookie keys:', Object.keys(cookies).join(', '));
