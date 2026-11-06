#!/usr/bin/env node
// End-to-end test of the running bridge with a fake browser upstream.
//
//   BRIDGE_FAKE_BROWSER=1 node server.mjs --port 8899 --browser-mode on
//
// This exercises the real request path: live SSE forwarding, reasoning
// deltas, the tool shim, usage/tok-s accounting and the [DONE] terminator.
//
// Usage: node test-e2e.mjs [--port 8899]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const port = (args.indexOf('--port') >= 0 && args[args.indexOf('--port') + 1]) || '8899';
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const credsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-e2e-'));
const credsFile = path.join(credsDir, 'creds.json');
fs.writeFileSync(credsFile, JSON.stringify({ active: [{ id: 'test', bearer: 'dummy.token.value', cookies: {}, created_at: 9999999999 }] }));

const server = spawn(process.execPath, [
  'server.mjs', '--port', String(port), '--creds', credsFile, '--browser-mode', 'on',
], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: { ...process.env, BRIDGE_FAKE_BROWSER: '1', BRIDGE_FAKE_REJECT_EFFORT: '1', BRIDGE_FAKE_EFFORT_FIELD: 'reasoning_effort' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', d => serverLog.push(String(d)));
server.stderr.on('data', d => serverLog.push(String(d)));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

// Parse an SSE body into chunks.
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

try {
  check(await waitForServer(), 'server started');

  // ---- 1. plain stream: reasoning + content + usage --------------------
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mercury-3',
        messages: [{ role: 'user', content: 'What is 37*43?' }],
        stream: true,
        reasoning_effort: 'high',
      }),
    });
    const text = await res.text();
    const chunks = parseSSE(text);
    const deltas = chunks.flatMap(c => c.choices || []).map(c => c.delta || {});
    const reasoning = deltas.map(d => d.reasoning_content || '').join('');
    const content = deltas.map(d => d.content || '').join('');
    check(res.status === 200, `stream request returned 200 (got ${res.status})`);
    check(reasoning.includes('37*40 = 1480'), `reasoning streamed to the client (${JSON.stringify(reasoning.slice(0, 50))})`);
    check(content.includes('1591'), `content streamed to the client (${JSON.stringify(content.slice(0, 50))})`);
    const usageChunk = chunks.find(c => c.usage);
    check(!!usageChunk, 'final chunk carries usage');
    check(usageChunk?.usage?.completion_tokens > 0, `usage reports completion tokens (${usageChunk?.usage?.completion_tokens})`);
    check(typeof usageChunk?.usage?.tokens_per_second === 'number' && usageChunk.usage.tokens_per_second > 0, `tokens/s reported (${usageChunk?.usage?.tokens_per_second})`);
    check(usageChunk?.usage?.usage_source === 'estimated', 'usage source labelled');
    check(chunks.some(c => c.done), '[DONE] terminator sent');
    const finish = chunks.find(c => c.choices?.[0]?.finish_reason);
    check(!!finish, 'finish_reason sent');
  }

  // ---- 1b. the upstream receives the mapped model id and the effort -----
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mercury-3',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        reasoning_effort: 'max',
      }),
    });
    await res.text();
    await sleep(150);
    const log = serverLog.join('');
    check(/\[upstream\] model=mercury /.test(log), 'upstream model id is mapped to the platform id');
    check(/effort_field=reasoning_effort effort=max/.test(log), 'effort level is forwarded as max');
  }

  // ---- 1c. the thinking is delivered as ONE instant block, not live ------
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mercury-3',
        messages: [{ role: 'user', content: 'What is 37*43?' }],
        stream: true,
      }),
    });
    const text = await res.text();
    const chunks = parseSSE(text);
    const deltas = chunks.flatMap(c => c.choices || []).map(c => c.delta || {});
    const rDeltas = deltas.map(d => d.reasoning_content || '').filter(Boolean);
    const tDeltas = deltas.map(d => d.content || '').filter(Boolean);
    check(rDeltas.length === 1, `the thinking arrives in one single block (${rDeltas.length} reasoning events)`);
    check(rDeltas[0] === 'Let me work through this step by step. 37*40 = 1480, 37*3 = 111, total 1591.', `the thinking is complete and unchanged (${JSON.stringify((rDeltas[0] || '').slice(0, 30))})`);
    check(tDeltas.length === 1 && tDeltas[0] === 'The answer is 1591.', `the answer is forwarded verbatim (${JSON.stringify(tDeltas)})`);
    const firstR = deltas.findIndex(d => d.reasoning_content);
    const firstT = deltas.findIndex(d => d.content);
    check(firstR > firstT, 'the thinking block is delivered after the answer (no live thinking)');
  }

  // ---- 2. tool shim: tool call extracted, markup not leaked -------------
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mercury-3',
        messages: [{ role: 'user', content: 'TOOLTEST: write hello.txt' }],
        stream: true,
        tools: [{ type: 'function', function: { name: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } }],
      }),
    });
    const text = await res.text();
    const chunks = parseSSE(text);
    const toolChunks = chunks.flatMap(c => c.choices || []).map(c => c.delta?.tool_calls).filter(Boolean);
    check(toolChunks.length > 0, 'tool_calls emitted');
    const call = toolChunks[0]?.[0];
    check(call?.function?.name === 'write', `tool name parsed (${call?.function?.name})`);
    check(JSON.parse(call?.function?.arguments || '{}').path === '/sdcard/Download/hello.txt', 'tool arguments parsed');
    const leaked = chunks.flatMap(c => c.choices || []).map(c => c.delta?.content || '').join('');
    check(!leaked.includes('<write'), `tool markup did not leak into content (${JSON.stringify(leaked.slice(0, 60))})`);
    const finish = chunks.find(c => c.choices?.[0]?.finish_reason);
    check(finish?.choices?.[0]?.finish_reason === 'tool_calls', `finish_reason is tool_calls (${finish?.choices?.[0]?.finish_reason})`);
  }

  // ---- 3. non-stream: usage in the body --------------------------------
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mercury-3', messages: [{ role: 'user', content: 'hello' }], stream: false }),
    });
    const json = await res.json();
    check(json.choices?.[0]?.message?.content?.includes('1591'), 'non-stream content returned');
    check(json.usage?.prompt_tokens > 0 && json.usage?.completion_tokens > 0, 'non-stream usage returned');
    check(typeof json.usage?.tokens_per_second === 'number', 'non-stream tok/s returned');
  }

  // ---- 4. reasoning scraping: <think> split out of the answer -----------
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mercury-3', messages: [{ role: 'user', content: 'THINKTEST: 37*43' }], stream: true }),
    });
    const text = await res.text();
    const chunks = parseSSE(text);
    const deltas = chunks.flatMap(c => c.choices || []).map(c => c.delta || {});
    const reasoning = deltas.map(d => d.reasoning_content || '').join('');
    const content = deltas.map(d => d.content || '').join('');
    check(reasoning.includes('restate the problem'), `think block captured as reasoning (${JSON.stringify(reasoning.slice(0, 50))})`);
    check(reasoning.includes('1591'), 'think block fully captured');
    check(!content.includes('<think>') && !content.includes('</think>'), 'think tags stripped from the answer');
    check(content.includes('The answer is 1591'), 'answer content kept');
  }

  // ---- 4b. an empty upstream must be an ERROR, never an empty answer ----
  {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mercury-3', messages: [{ role: 'user', content: 'EMPTYTEST' }], stream: true }),
    });
    const text = await res.text();
    check(res.status >= 400, `an empty upstream response becomes an error (status ${res.status})`);
    check(!text.includes('"content":""'), 'no empty completion is returned to the client');
  }

  // ---- 5. /v1/usage statistics -----------------------------------------
  {
    const json = await (await fetch(`${base}/v1/usage`)).json();
    check(json.count >= 4, `usage stats recorded (${json.count})`);
    check(json.data.some(d => d.mode === 'live-browser'), 'live-browser mode recorded');
    check(json.data.some(d => d.chunk_types && Object.keys(d.chunk_types).length), 'chunk inventory recorded');
  }

  // ---- 6. /v1/models carries real context metadata ---------------------
  {
    const json = await (await fetch(`${base}/v1/models`)).json();
    check(json.data.length === 2, `exactly two models listed (${json.data.map(x => x.id).join(', ')})`);
    const m = json.data.find(x => x.id === 'mercury-3');
    check(!!m, 'mercury-3 is listed');
    check(m?.context_length === 1000000, `context length reported (${m?.context_length})`);
    check(m?.max_output_tokens === 131072, `max output reported (${m?.max_output_tokens})`);
    check(Array.isArray(m?.reasoning_efforts) && m.reasoning_efforts.includes('max'), 'real effort levels listed');
    check(!!json.data.find(x => x.id === 'mercury-3-decide'), 'mercury-3-decide is listed');
    check(!json.data.find(x => /mercury-2|coder|thinking/.test(x.id)), 'no legacy/alias models listed');
  }
} finally {
  server.kill('SIGKILL');
  await sleep(200);
  try { fs.rmSync(credsDir, { recursive: true, force: true }); } catch {}
}

console.log('\n--- server log ---');
for (const l of serverLog.join('').split('\n').filter(x => x.includes('[usage]') || x.includes('[effort]') || x.includes('[think]') || x.includes('[tool-shim]'))) {
  console.log(l);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
