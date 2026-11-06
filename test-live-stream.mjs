#!/usr/bin/env node
// Offline test of the live browser-stream plumbing: a fake CDP client feeds
// chunks with a delay, so we can verify that deltas are yielded as they
// arrive (not batched at the end) and that concurrent streams serialize.
//
// Usage: node test-live-stream.mjs

import { BrowserUpstream } from './lib/browser-upstream.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function makeFakeCdp(script) {
  let polls = 0;
  return {
    async send(method, params = {}) {
      const expr = String(params.expression || '');
      if (expr.includes('document.title')) {
        return { result: { value: 'Inception Chat|/chat' } };
      }
      if (expr.includes('window.__bearer')) {
        script.chunks = [];
        script.done = false;
        polls = 0;
        return { result: { value: true } };
      }
      if (expr.includes('.slice(')) {
        const m = expr.match(/slice\((\d+)\)/);
        const idx = m ? Number(m[1]) : 0;
        return { result: { value: JSON.stringify(script.chunks.slice(idx)) } };
      }
      if (expr.includes('JSON.stringify({ started:')) {
        polls++;
        // reveal chunks gradually, like a real model streaming
        const reveal = Math.min(script.all.length, Math.floor(polls / 2));
        script.chunks = script.all.slice(0, reveal);
        script.done = reveal >= script.all.length;
        return { result: { value: JSON.stringify({ s: script.done ? 200 : 0, e: '', d: script.done, n: script.chunks.length }) } };
      }
      return { result: { value: null } };
    },
  };
}

const up = new BrowserUpstream({ chromiumPath: '/nonexistent' });
const script = { all: [], chunks: [], done: false };
up.cdp = makeFakeCdp(script);
up.ready = true;

const chunks = [
  { type: 'reasoning-delta', delta: 'Let me work through this: 37*43 = 37*40 + 37*3.' },
  { type: 'reasoning-delta', delta: ' 1480 + 111 = 1591.' },
  { type: 'text-delta', delta: 'The answer is 1591.' },
  { type: 'finish', finishReason: 'stop' },
];

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// ---- 1. chunks are yielded incrementally -------------------------------
script.all = chunks;
const t0 = Date.now();
const seen = [];
const arrival = [];
for await (const c of up.stream({ model: 'mercury', messages: [] }, 'bearer-token', { pollMs: 10 })) {
  seen.push(c);
  arrival.push(Date.now() - t0);
}
check(seen.length === chunks.length, `all ${chunks.length} chunks yielded (got ${seen.length})`);
check(seen[0]?.type === 'reasoning-delta', 'first chunk is the reasoning delta');
check(seen[2]?.type === 'text-delta', 'third chunk is the text delta');
check(arrival[0] < arrival[arrival.length - 1], `chunks arrived progressively (${arrival.join('ms, ')}ms)`);

// ---- 2. concurrent streams serialize (one page, one job at a time) -----
let concurrent = 0;
let maxConcurrent = 0;
const runOne = async () => {
  let inside = false;
  for await (const _ of up.stream({ model: 'mercury', messages: [] }, 'tok', { pollMs: 10 })) {
    if (!inside) { inside = true; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); }
  }
  if (inside) concurrent--;
};
await Promise.all([runOne(), runOne()]);
check(maxConcurrent === 1, `streams serialized (max concurrent = ${maxConcurrent})`);

// ---- 3. upstream error surfaces ---------------------------------------
script.all = chunks;
script.failStatus = 500;
const up2 = new BrowserUpstream({ chromiumPath: '/nonexistent' });
const script2 = { all: [], chunks: [], done: false };
up2.cdp = makeFakeCdp(script2);
up2.ready = true;
const origSend = up2.cdp.send.bind(up2.cdp);
up2.cdp.send = async (m, p) => {
  const r = await origSend(m, p);
  const expr = String(p.expression || '');
  if (expr.includes('JSON.stringify({ started:')) {
    const st = JSON.parse(r.result.value);
    st.s = 500; st.e = 'upstream exploded'; st.d = true;
    return { result: { value: JSON.stringify(st) } };
  }
  return r;
};
let threw = null;
try {
  for await (const _ of up2.stream({ model: 'mercury', messages: [] }, 'tok', { pollMs: 10 })) { /* drain */ }
} catch (e) { threw = e; }
check(!!threw && /upstream HTTP 500/.test(String(threw)), `upstream error surfaces (${threw ? String(threw).slice(0, 60) : 'no error'})`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
