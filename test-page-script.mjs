#!/usr/bin/env node
// Regression test for the page-side request builder.
//
// It runs the exact scripts that execute inside the Chromium page, in a
// simulated browser environment. The critical case: the free chat rejects
// `reasoning_effort` with HTTP 400, so the script must retry with a minimal
// body and still deliver the answer. (This is what broke when the minimal
// retry accidentally kept the rejected field.)
//
// Usage: node test-page-script.mjs

import { JOB_SCRIPT, STREAM_JOB } from './lib/browser-upstream.mjs';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

const SSE_LINES = [
  'data: {"type":"reasoning-delta","delta":"thinking..."}',
  'data: {"type":"text-delta","delta":"hello"}',
  'data: {"type":"finish","finishReason":"stop"}',
  'data: [DONE]',
];

function sseResponse() {
  const enc = new TextEncoder();
  const parts = SSE_LINES.map(l => enc.encode(l + '\n'));
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader: () => ({
        read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true, value: undefined }),
      }),
    },
    text: async () => SSE_LINES.join('\n'),
  };
}

function badRequest() {
  return {
    ok: false,
    status: 400,
    headers: { get: () => 'text/plain' },
    text: async () => 'bad request: unknown field',
    body: null,
  };
}

// Builds a fake page environment. `rejectFields` lists body fields that make
// the simulated upstream answer 400 (like the real free chat does).
function makeEnv({ payload, extra = null, rejectFields = ['reasoning_effort'] }) {
  const requests = [];
  const win = {};
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).endsWith('/api/session')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'TEST-TOKEN' }) };
    }
    const body = JSON.parse(opts.body || '{}');
    requests.push(body);
    const bad = rejectFields.some(f => body[f] !== undefined);
    return bad ? badRequest() : sseResponse();
  };
  win.__payload = payload;
  win.__bearer = 'bearer';
  win.__extra = extra;
  const crypto = { randomUUID: () => 'uuid-1234' };
  return { win, fetchImpl, requests, crypto };
}

function runScript(script, env) {
  const fn = new Function('window', 'fetch', 'crypto', 'TextDecoder', `return (${script});`);
  return fn(env.win, env.fetchImpl, env.crypto, TextDecoder);
}

const payload = {
  model: 'mercury',
  messages: [{ role: 'user', content: 'hi' }],
  reasoning_effort: 'high',
};

// ---- 1. buffered job: rejects the field, retries minimal, still answers ----
{
  const env = makeEnv({ payload });
  const job = runScript(JOB_SCRIPT, env);
  await env.win.__job;
  check(env.requests.length === 3, `staged fallback made three requests (got ${env.requests.length})`);
  check(env.requests[0]?.reasoning_effort === 'high', 'first request carried reasoning_effort');
  check(env.requests[1]?.reasoning_effort === 'high', 'second stage kept only the effort field');
  check(env.requests[2]?.reasoning_effort === undefined, 'third stage dropped the rejected reasoning_effort');
  check(env.requests[2]?.messages?.length === 1 && env.requests[2].messages[0].parts?.[0]?.text === 'hi', 'final retry kept the message content');
  check(Array.isArray(env.win.__dropped) && env.win.__dropped.includes('reasoning_effort'), `dropped fields recorded (${JSON.stringify(env.win.__dropped)})`);
  const types = (env.win.__chunks || []).map(c => c.type);
  check(types.includes('text-delta') && types.includes('reasoning-delta'), `chunks parsed (${JSON.stringify(types)})`);
}

// ---- 2. streaming job: same recovery, chunks arrive as they are parsed ----
{
  const env = makeEnv({ payload });
  runScript(STREAM_JOB, env);
  await env.win.__streamJob;
  check(env.requests.length === 3, `stream job made three staged requests (got ${env.requests.length})`);
  check(env.requests[2]?.reasoning_effort === undefined, 'stream fallback dropped the rejected field');
  check(env.win.__stream?.done === true, 'stream job finished');
  const types = (env.win.__stream?.chunks || []).map(c => c.type);
  check(types.includes('text-delta') && types.includes('reasoning-delta'), `stream chunks parsed (${JSON.stringify(types)})`);
  check(Array.isArray(env.win.__stream?.dropped) && env.win.__stream.dropped.includes('reasoning_effort'), 'stream job recorded the dropped field');
}

// ---- 3. no extra fields -> single request, no retry ----
{
  const env = makeEnv({ payload: { ...payload, reasoning_effort: undefined } });
  await runScript(JOB_SCRIPT, env);
  await env.win.__job;
  check(env.requests.length === 1, `no retry when nothing was rejected (got ${env.requests.length} requests)`);
}

// ---- 4. an unknown field is also dropped by the minimal retry ----
{
  const env = makeEnv({ payload: { ...payload, reasoning_effort: undefined }, extra: { thinking: 'high' }, rejectFields: ['thinking'] });
  await runScript(JOB_SCRIPT, env);
  await env.win.__job;
  check(env.requests.length === 3, `extra field triggered the staged fallback (got ${env.requests.length})`);
  check(env.requests[2]?.thinking === undefined, 'final retry dropped the extra field');
}

// ---- 5. a bad NON-effort field must not remove the effort field --------
{
  const env = makeEnv({ payload: { ...payload }, extra: { temperature: 0.7 }, rejectFields: ['temperature'] });
  await runScript(JOB_SCRIPT, env);
  await env.win.__job;
  check(env.requests.length === 2, `non-effort rejection used two stages (got ${env.requests.length})`);
  check(env.requests[1]?.reasoning_effort === 'high', 'the effort field survived a bad temperature field');
  check(env.requests[1]?.temperature === undefined, 'the bad field was dropped');
  check(Array.isArray(env.win.__dropped) && env.win.__dropped.includes('temperature'), `dropped list names the bad field (${JSON.stringify(env.win.__dropped)})`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
