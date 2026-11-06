#!/usr/bin/env node
// smoke — full offline self-test of the bridge (no network, no real browser).
//
// Spawns server.mjs with the fake-browser upstream (BRIDGE_FAKE_BROWSER=1)
// and verifies the complete surface a chat platform relies on:
//   /healthz, /v1/models, streaming + reasoning, tool-call shim,
//   non-stream responses, usage, [DONE] terminator, API-key auth, 404s.
//
// Usage: node bin/smoke.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const port = 9400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const API_KEY = 'smoke-secret-key';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-smoke-'));
const credsFile = path.join(credsDir, 'creds.json');
fs.writeFileSync(credsFile, JSON.stringify({ active: [{ id: 'smoke', bearer: 'dummy.token.value', cookies: {}, created_at: 9999999999 }] }));

const server = spawn(process.execPath, [
  'server.mjs', '--port', String(port), '--creds', credsFile,
  '--browser-mode', 'on', '--chromium', '/bin/true', '--api-key', API_KEY,
], {
  cwd: ROOT,
  env: { ...process.env, BRIDGE_FAKE_BROWSER: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', d => serverLog.push(String(d)));
server.stderr.on('data', d => serverLog.push(String(d)));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/healthz`); if (r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}

function parseSSE(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') { out.push({ done: true }); continue; }
    try { out.push(JSON.parse(payload)); } catch { out.push({ raw: payload }); }
  }
  return out;
}

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` };
const post = (pathname, body) => fetch(`${base}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) });

try {
  check(await waitForServer(), 'server started');

  // auth
  {
    const r = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mercury-3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    check(r.status === 401, `missing API key rejected with 401 (got ${r.status})`);
  }

  // models
  {
    const json = await (await fetch(`${base}/v1/models`)).json();
    check(json.data.length === 2 && json.data.some(m => m.id === 'mercury-3'), 'models listed (mercury-3, mercury-3-decide)');
    check(json.data.find(m => m.id === 'mercury-3').context_length === 1000000, 'mercury-3 context length reported');
  }

  // stream: reasoning + content + usage + [DONE]
  {
    const res = await post('/v1/chat/completions', {
      model: 'mercury-3',
      messages: [{ role: 'user', content: 'What is 37*43?' }],
      stream: true,
      reasoning_effort: 'high',
    });
    const chunks = parseSSE(await res.text());
    const deltas = chunks.flatMap(c => c.choices || []).map(c => c.delta || {});
    const reasoning = deltas.map(d => d.reasoning_content || '').join('');
    const content = deltas.map(d => d.content || '').join('');
    check(res.status === 200, `stream returned 200 (got ${res.status})`);
    check(reasoning.includes('1480'), 'reasoning streamed (thinking delivered)');
    check(content.includes('1591'), 'answer content streamed');
    check(chunks.some(c => c.done), '[DONE] terminator sent');
    const usageChunk = chunks.find(c => c.usage);
    check(!!usageChunk?.usage?.completion_tokens, 'final chunk carries usage');
    check(!!chunks.find(c => c.choices?.[0]?.finish_reason), 'finish_reason sent');
  }

  // non-stream
  {
    const json = await (await post('/v1/chat/completions', {
      model: 'mercury-3', messages: [{ role: 'user', content: 'hello' }], stream: false,
    })).json();
    check(json.choices?.[0]?.message?.content?.includes('1591'), 'non-stream content returned');
    check(json.usage?.prompt_tokens > 0 && json.usage?.completion_tokens > 0, 'non-stream usage returned');
  }

  // tool shim: tool_calls emitted, markup stripped
  {
    const chunks = parseSSE(await (await post('/v1/chat/completions', {
      model: 'mercury-3',
      messages: [{ role: 'user', content: 'TOOLTEST: write hello.txt' }],
      stream: true,
      tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }],
    })).text());
    const toolChunks = chunks.flatMap(c => c.choices || []).map(c => c.delta?.tool_calls).filter(Boolean);
    check(toolChunks.length > 0 && toolChunks[0][0].function.name === 'write', 'tool_calls emitted');
    const leaked = chunks.flatMap(c => c.choices || []).map(c => c.delta?.content || '').join('');
    check(!leaked.includes('<write'), 'tool markup did not leak into content');
  }

  // <think> block splitting
  {
    const chunks = parseSSE(await (await post('/v1/chat/completions', {
      model: 'mercury-3', messages: [{ role: 'user', content: 'THINKTEST: 37*43' }], stream: true,
    })).text());
    const deltas = chunks.flatMap(c => c.choices || []).map(c => c.delta || {});
    const reasoning = deltas.map(d => d.reasoning_content || '').join('');
    const content = deltas.map(d => d.content || '').join('');
    check(reasoning.includes('restate the problem'), '<think> block captured as reasoning');
    check(!content.includes('<think>'), 'think tags stripped from answer');
  }

  // usage endpoint + 404
  {
    const json = await (await fetch(`${base}/v1/usage`)).json();
    check(json.count >= 3, 'usage stats recorded');
    const r404 = await fetch(`${base}/v1/nope`);
    check(r404.status === 404, 'unknown endpoint -> 404');
  }
} finally {
  server.kill('SIGKILL');
  await sleep(200);
  try { fs.rmSync(credsDir, { recursive: true, force: true }); } catch {}
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall smoke checks passed');
process.exit(failures ? 1 : 0);
