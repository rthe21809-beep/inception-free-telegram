#!/usr/bin/env node
// Smoke test against the live upstream using current creds.
// Usage: node test.mjs [--verbose] [--model mercury] [--stream] [--browser] [--thinking] [--tools]
//                 [--effort instant|low|medium|high] [--bridge]   (talk to a running bridge)

import { loadCreds, buildEnvelope, upstreamStream, newChatId, completeOnce } from './lib/proxy.mjs';
import { buildUsage, pickUpstreamUsage, throughput } from './lib/usage.mjs';
import { effortFromBody } from './lib/effort.mjs';
import { BrowserUpstream } from './lib/browser-upstream.mjs';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const wantStream = args.includes('--stream');
const useBrowser = args.includes('--browser');
const thinking = args.includes('--thinking');
const tools = args.includes('--tools');
const useBridge = args.includes('--bridge');
const effortArg = (args.indexOf('--effort') >= 0 && args[args.indexOf('--effort') + 1]) || '';
const model = (args.indexOf('--model') >= 0 && args[args.indexOf('--model') + 1]) || (thinking ? 'mercury-thinking' : 'mercury');

const accounts = loadCreds();
if (!accounts.length) {
  console.error('[!] no creds found — run: node warmup.mjs --output creds.json');
  process.exit(1);
}
const account = accounts[0];
console.log(`account: ${account.bearer.slice(0, 18)}…  model: ${model}  stream: ${wantStream}  browser: ${useBrowser}`);

const body = { model, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], stream: wantStream && !useBrowser };
if (thinking) body.thinking = true;
if (effortArg) body.reasoning_effort = effortArg;
if (tools) {
  body.tools = [{ type: 'function', function: { name: 'get_weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
  body.tool_choice = 'auto';
  body.messages[0].content = 'Call the get_weather tool with city=Paris. Reply with exactly: pong';
}

const t0 = Date.now();
let r;
if (useBridge) {
  // hit the running bridge and report its usage/tok-s numbers
  const res = await fetch('http://127.0.0.1:8890/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(txt); } catch {}
  console.log(`bridge status: ${res.status} (${Date.now() - t0}ms)`);
  if (parsed?.usage) {
    const u = parsed.usage;
    console.log(`usage: prompt=${u.prompt_tokens} completion=${u.completion_tokens} total=${u.total_tokens} source=${u.usage_source}`);
    console.log(`speed: ${u.tokens_per_second} tok/s  ttft=${u.ttft_ms}ms  gen=${u.generation_ms}ms  basis=${u.throughput_basis}`);
    if (u.completion_tokens_details?.reasoning_tokens) console.log(`reasoning tokens: ${u.completion_tokens_details.reasoning_tokens}`);
  }
  if (parsed?.choices?.[0]?.message) {
    const m = parsed.choices[0].message;
    console.log('content:', JSON.stringify(m.content).slice(0, 300));
    if (m.reasoning_content) console.log('reasoning:', JSON.stringify(m.reasoning_content).slice(0, 300));
    if (m.tool_calls) console.log('tool_calls:', JSON.stringify(m.tool_calls).slice(0, 300));
  }
  console.log('OK');
  process.exit(0);
}
if (useBrowser) {
  const up = new BrowserUpstream({ chromiumPath: process.env.PREFIX + '/bin/chromium-browser' });
  r = await up.complete(body, account.bearer);
  await up.stop();
} else {
  r = await completeOnce(account, body, 'minimal');
}
const tt = Date.now() - t0;
if (useBrowser) {
  const d = r.debug || {};
  const first = r.chunks?.[0];
  console.log(`[dbg] chunks=${(r.chunks || []).length} err=${JSON.stringify(String(r.errBody || '').slice(0, 200))} type=${d.contentType} done=${d.done} preview=${JSON.stringify(String(d.preview || '').slice(0, 500))} first=${JSON.stringify(first).slice(0, 600)}`);
}
console.log(`upstream status: ${r.status} (${tt}ms)`);
if (verbose && r.payload) console.log('envelope sent:', JSON.stringify(r.payload));
if (r.status !== 200) {
  console.error('error body:', r.errBody);
  if (r.errBody === 'vercel-challenge') {
    console.error('Vercel checkpoint in the way. Options:');
    console.error('  1) node warmup.mjs   (auto-capture session)');
    console.error('  2) node test.mjs --stream --browser   (run through real browser)');
    console.error('  3) node get-creds.mjs (paste a session from your own browser)');
  }
  process.exit(1);
}

function normalizeChunks(chunks) {
  const out = [];
  for (const c of chunks || []) {
    if (typeof c === 'string') {
      try {
        out.push(JSON.parse(c));
      } catch {
        out.push({ content: c });
      }
    } else {
      out.push(c);
    }
  }
  return out;
}

const norm = normalizeChunks(r.chunks);

function chunkContent(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  // Vercel AI SDK data-stream protocol: {type:'text-delta', id, delta:'...'}
  if (c.type === 'text-delta' || c.type === 'reasoning-delta' || c.type === 'content-delta') {
    const d = c.delta;
    return typeof d === 'string' ? d : (d?.text ?? d?.content ?? '');
  }
  // OpenAI shape
  const choice = c.choices?.[0];
  if (choice) {
    const m = choice.delta ?? choice.message;
    if (typeof m === 'string') return m;
    if (m) return m.content ?? m.text ?? '';
  }
  if (c.delta) return typeof c.delta === 'string' ? c.delta : (c.delta.text ?? c.delta.content ?? '');
  return c.content ?? c.text ?? '';
}

let firstTok = null;
if (wantStream) {
  let len = 0;
  let toolsSeen = 0;
  for (const c of norm) {
    const s = chunkContent(c);
    const tc = c?.type === 'tool-call' ? c : null;
    if (tc) { toolsSeen++; console.log(`\n[tool-call] name=${tc.toolName} args=${JSON.stringify(tc.args).slice(0, 200)}`); }
    if (!s) continue;
    if (firstTok === null) firstTok = Date.now() - t0;
    len += s.length;
    if (verbose) process.stdout.write(s);
  }
  console.log(`\nfirst-token ${firstTok}ms, total chars ${len}, tool_calls ${toolsSeen}`);
} else {
  let content = norm.map(chunkContent).join('');
  if (!content && norm[0]?.choices) content = JSON.stringify(norm[0]);
  console.log('completion:', JSON.stringify(content).slice(0, 400));
}
const reasoningText = norm.filter(c => c?.type === 'reasoning-delta').map(chunkContent).join('');
const textAll = norm.filter(c => c?.type !== 'reasoning-delta').map(chunkContent).join('');
const usage = buildUsage({
  promptText: JSON.stringify(body.messages),
  completionText: textAll,
  reasoningText,
  upstream: pickUpstreamUsage(norm),
});
const perf = throughput(usage, { ttftMs: wantStream ? (firstTok || 0) : 0, elapsedMs: Date.now() - t0, ttftKnown: wantStream });
console.log(`usage: prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} source=${usage.usage_source}`);
console.log(`speed: ${perf.tokens_per_second} tok/s  ttft=${perf.ttft_ms}ms  gen=${perf.generation_ms}ms  basis=${perf.throughput_basis}`);
console.log(`effort requested: ${effortFromBody(body, model) || '(none)'}   reasoning chars: ${reasoningText.length}`);
console.log('OK');
