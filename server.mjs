#!/usr/bin/env node
// inception-bridge — OpenAI-compatible API over chat.inceptionlabs.ai free chat.
// Endpoints:
//   POST /v1/chat/completions   (stream + non-stream)
//   GET  /v1/models
//   GET  /healthz

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadCreds, completeOnce, buildEnvelope, upstreamStream, getSessionToken } from './lib/proxy.mjs';
import { runWarmup } from './lib/warmup-runner.mjs';
import { BrowserUpstream } from './lib/browser-upstream.mjs';
import { FakeBrowserUpstream } from './lib/fake-browser-upstream.mjs';
import { injectToolSpec, parseToolCalls } from './lib/tool-shim.mjs';
import { buildUsage, pickUpstreamUsage, throughput, estimateTokens } from './lib/usage.mjs';
import { effortFromBody, normalizeEffort, REAL_EFFORTS } from './lib/effort.mjs';
import { metaFor, EFFORTS } from './lib/model-meta.mjs';
import { ThinkSplitter, extractThink } from './lib/think-directive.mjs';

const args = process.argv.slice(2);

// Portable/deployment support: every CLI flag has an environment-variable
// fallback (handy for Docker, systemd and .env files). CLI flags always win,
// then env, then the built-in default. Naming: BRIDGE_<FLAG_IN_SNAKE>.
const ENV_MAP = {
  port: 'BRIDGE_PORT',
  host: 'BRIDGE_HOST',
  'api-key': 'BRIDGE_API_KEY',
  creds: 'BRIDGE_CREDS',
  'browser-mode': 'BRIDGE_BROWSER',
  chromium: 'BRIDGE_CHROMIUM',
  'auto-refresh': 'BRIDGE_AUTO_REFRESH',
  'session-ttl': 'BRIDGE_SESSION_TTL',
  'default-model': 'BRIDGE_DEFAULT_MODEL',
  thinking: 'BRIDGE_THINKING',
  'effort-field': 'BRIDGE_EFFORT_FIELD',
  'discover-effort': 'BRIDGE_DISCOVER_EFFORT',
  envelope: 'BRIDGE_ENVELOPE',
  'upstream-model': 'BRIDGE_UPSTREAM_MODEL',
  cw: 'BRIDGE_CW',
};
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const envName = ENV_MAP[name];
  if (envName && process.env[envName] !== undefined && process.env[envName] !== '') return process.env[envName];
  return dflt;
};
const PORT = parseInt(opt('port', '8890'), 10);
const HOST = opt('host', '127.0.0.1');
const DEFAULT_MODEL = opt('default-model', 'mercury-3');
const ENVELOPE = opt('envelope', 'auto');
// Field name the upstream honours for reasoning effort (auto-detected via /v1/effort-probe).
// 'auto' -> the bridge discovers which field the platform honours (startup probe)
let EFFORT_FIELD = opt('effort-field', 'reasoning_effort');
let effortFieldResolved = EFFORT_FIELD !== 'auto';
if (process.env.BRIDGE_FAKE_EFFORT_FIELD) {   // test hook
  EFFORT_FIELD = process.env.BRIDGE_FAKE_EFFORT_FIELD;
  effortFieldResolved = true;
}
// The free chat rejects some fields outright (HTTP 400). When we see that,
// we stop sending the field instead of paying a failed request every time.
let effortRejected = false;
const API_KEY = opt('api-key', ''); // optional enforcement
const CW = parseInt(opt('cw', '0'), 10);
const AUTO_REFRESH_HOURS = parseFloat(opt('auto-refresh', '0')); // 0 = off; e.g. 5 = re-solve every 5h
const SESSION_TTL_HOURS = parseFloat(opt('session-ttl', '6'));
// The platform decides on its own whether to think, and the bridge scrapes
// whatever it produces - so the startup discovery is OFF by default. It only
// costs time and browser time (it shares the tab with live requests).
const DISCOVER_EFFORT = String(opt('discover-effort', '0')) !== '0';
// How the captured thinking is delivered to DSH:
//   end  (default) -> the reasoning is collected and delivered as ONE block
//                    right before the final chunk: it shows up instantly,
//                    complete, with no live/paced thinking process at all
//   live           -> every reasoning delta is forwarded as it arrives
//   off            -> no reasoning is forwarded
const THINKING_MODE = (opt('thinking', 'end') || 'end').toLowerCase();
function detectChromiumPath() {
  const explicit = opt('chromium', '') || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '';
  if (explicit) return explicit;
  const candidates = ['chromium', 'chromium-browser', 'chromium-headless-shell', 'google-chrome', 'google-chrome-stable'];
  try {
    if (process.env.PREFIX) {
      for (const name of candidates) {
        const p = `${process.env.PREFIX}/bin/${name}`;
        if (fs.existsSync(p)) return p;
      }
    }
    // server portability: scan PATH for a browser binary, so `--browser-mode
    // auto` works out of the box on Debian/Ubuntu (chromium-browser) etc.
    for (const dir of String(process.env.PATH || '').split(':')) {
      if (!dir) continue;
      for (const name of candidates) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return '';
}
const CHROMIUM_PATH = detectChromiumPath();
const warmupExtra = CHROMIUM_PATH ? ['--chromium', CHROMIUM_PATH] : [];

const BROWSER_MODE = String(opt('browser-mode', 'auto')); // on | off | auto
const useBrowserFallback = BROWSER_MODE === 'on' || (BROWSER_MODE === 'auto' && !!CHROMIUM_PATH);
let browserUpstream = null;
let fakeBrowserUpstream = null;

function getBrowserUpstream() {
  // test hook: replay canned upstream chunks without a browser
  if (process.env.BRIDGE_FAKE_BROWSER === '1') {
    if (!fakeBrowserUpstream) {
      fakeBrowserUpstream = new FakeBrowserUpstream({ rejectEffort: process.env.BRIDGE_FAKE_REJECT_EFFORT === '1' });
    }
    return fakeBrowserUpstream;
  }
  if (!browserUpstream) browserUpstream = new BrowserUpstream({ chromiumPath: CHROMIUM_PATH });
  return browserUpstream;
}

const credsPath = opt('creds', 'creds.json');
let accounts = loadCreds(credsPath);
let cursor = 0;
let warmupAttempted = false;

async function ensureAccounts() {
  if (accounts.length) return true;
  if (warmupAttempted) return false;
  warmupAttempted = true;
  const ok = await runWarmup(credsPath, { force: true, extraArgs: warmupExtra });
  if (ok) accounts = loadCreds(credsPath);
  return accounts.length > 0;
}

function refreshSessions() {
  const cutoff = Date.now() / 1000 - SESSION_TTL_HOURS * 3600;
  accounts = accounts.filter(a => (a.created_at || 0) >= cutoff);
  fs.writeFileSync(credsPath, JSON.stringify({ active: accounts }, null, 2));
}

async function maybeAutoRefresh() {
  const now = Date.now() / 1000;
  const cutoff = now - (SESSION_TTL_HOURS - 1) * 3600; // refresh when oldest session is 1h from expiry
  const stale = accounts.filter(a => (a.created_at || 0) < cutoff);
  if (!stale.length) return;
  console.log(`[auto-refresh] ${stale.length} session(s) near expiry — re-solving checkpoint…`);
  const ok = await runWarmup(credsPath, { force: true, extraArgs: warmupExtra });
  if (ok) {
    accounts = loadCreds(credsPath);
    console.log(`[auto-refresh] sessions now: ${accounts.length}`);
  } else {
    console.log('[auto-refresh] warmup failed (no browser available?) — keeping existing sessions until they 401.');
  }
}

// The free chat serves exactly two models: Mercury 3 and Mercury 3 Decide.
const knownModels = ['mercury-3', 'mercury-3-decide'];
// The upstream chat endpoint has its own model id; 'mercury' is what the free
// site accepts today (override with --upstream-model mercury-3).
const UPSTREAM_MODELS = { 'mercury-3': 'mercury', 'mercury-3-decide': 'mercury' };
const UPSTREAM_MODEL_OVERRIDE = opt('upstream-model', '');
// recent request stats (ring buffer) served by GET /v1/usage
const recentStats = [];
const STATS_MAX = 200;
function recordStat(st) {
  recentStats.push(st);
  if (recentStats.length > STATS_MAX) recentStats.shift();
}

// Once the edge challenges plain HTTP we remember it and stop wasting time on
// the plain path — every later request goes straight to the browser context.
let plainBlocked = false;

// ---- idle probe scheduling ---------------------------------------------
// Browser probes must never race a live request. Every incoming request
// bumps lastRequestAt; a probe only starts after the bridge has been idle
// for idleMs, and a probe that is already running is skipped.
let lastRequestAt = Date.now();
let probeRunning = false;
const IDLE_MS = 15000;

function noteRequest() {
  lastRequestAt = Date.now();
}

function scheduleIdleProbe(fn, delayMs = 20000) {
  const tick = async () => {
    const wait = Math.max(0, delayMs - (Date.now() - lastRequestAt));
    await new Promise(r => setTimeout(r, wait));
    if (Date.now() - lastRequestAt < IDLE_MS) { setTimeout(tick, 5000).unref(); return; }
    if (probeRunning) { setTimeout(tick, 5000).unref(); return; }
    probeRunning = true;
    try {
      await fn();
    } catch (e) {
      console.log(`[probe] failed: ${String(e).slice(0, 160)}`);
    } finally {
      probeRunning = false;
    }
  };
  setTimeout(tick, delayMs).unref();
}

// Model ids the free site actually exposes (probed at startup).
let siteModelIds = [];
let siteProbe = null;

function applySiteProbe(probe) {
  if (!probe) return;
  siteProbe = probe;
  const ids = new Set();
  const scan = (txt) => {
    for (const m of String(txt || '').matchAll(/(?:mercury|lambda\.mercury)[\w.\-]*/gi)) {
      const id = m[0].replace(/[.,;:)"'`\]]+$/, '');
      if (id.length > 4 && id.length < 60) ids.add(id);
    }
  };
  for (const e of probe.out || []) scan(e.body);
  for (const l of probe.uiLabels || []) scan(l);
  siteModelIds = Array.from(ids);
  console.log(`[probe] site models: ${siteModelIds.join(', ') || '(none found)'}`);
  for (const e of probe.out || []) {
    console.log(`[probe] ${e.path} -> ${e.status || e.error} ${String(e.body || '').slice(0, 220).replace(/\s+/g, ' ')}`);
  }
}

async function probeSiteModels() {
  try {
    if (!CHROMIUM_PATH) { console.log('[probe] no chromium -> skipping site model probe'); return; }
    const probe = await getBrowserUpstream().probeSite();
    applySiteProbe(probe);
  } catch (e) {
    console.log(`[probe] site model probe failed: ${String(e).slice(0, 200)}`);
  }
}

// Send a probe prompt at a given effort and report whether the model actually
// produced reasoning output — i.e. whether the effort setting really applied.
async function verifyReasoning(model, effort) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'Think step by step: what is 17*23? Reply with the final number only.' }],
    stream: true,
    reasoning_effort: effort,
  };
  const t0 = Date.now();
  let chunks = [];
  try {
    if (!accounts.length) await ensureAccounts();
    const account = pickAccount();
    if (!account) return { effort, reasoning_applied: false, error: 'no session' };
    let r = await completeOnce(account, body);
    let browserRun = null;
    if ((r.status !== 200 || !r.chunks?.length) && CHROMIUM_PATH) {
      // plain HTTP is challenged outside the browser -> run it in the page
      browserRun = await collectBrowser(body, account, { extra: { [EFFORT_FIELD]: effort } });
    }
    if (browserRun && browserRun.ok) {
      chunks = [];
      if (browserRun.reasoning) chunks.push({ type: 'reasoning-delta', delta: browserRun.reasoning });
      if (browserRun.text) chunks.push({ type: 'text-delta', delta: browserRun.text });
    } else if (r.status !== 200) {
      return { effort, reasoning_applied: false, status: r.status, error: String(r.errBody).slice(0, 200) };
    } else {
      chunks = r.chunks;
    }
  } catch (e) {
    return { effort, reasoning_applied: false, error: String(e).slice(0, 200) };
  }
  let reasoningChars = 0;
  let text = '';
  for (const c of chunks) {
    if (c?.type === 'reasoning-delta') {
      const d = c.delta;
      reasoningChars += String(typeof d === 'string' ? d : (d?.text ?? d?.content ?? '')).length;
    } else if (c?.type === 'text-delta') {
      const d = c.delta;
      text += String(typeof d === 'string' ? d : (d?.text ?? d?.content ?? ''));
    } else if (c?.choices?.[0]?.delta?.content) {
      text += c.choices[0].delta.content;
    }
  }
  return {
    effort,
    reasoning_applied: reasoningChars > 0,
    reasoning_chars: reasoningChars,
    reasoning_tokens_estimate: estimateTokens('x'.repeat(reasoningChars)),
    answer: text.slice(0, 200),
    elapsed_ms: Date.now() - t0,
    note: reasoningChars > 0
      ? 'upstream produced reasoning chunks — effort is applied'
      : 'no reasoning chunks in the stream — the effort was not applied (or the model answered directly)',
  };
}

function pickAccount() {
  if (!accounts.length) return null;
  const a = accounts[cursor % accounts.length];
  cursor += 1;
  return a;
}

function authOk(req) {
  if (!API_KEY) return true;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${API_KEY}` || auth === API_KEY;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendSSE(res, id, model, createdAt, body, finishReason = null) {
  const chunk = {
    id, object: 'chat.completion.chunk', created: createdAt, model,
    choices: [{ index: 0, delta: body, finish_reason: finishReason }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

// Markers that indicate the model is writing a tool call as text. While
// streaming we hold content back from the first marker so tool markup never
// reaches the client.
const TOOL_MARKERS = ['<tool_use', '<tool_call>', '<write', '<bash', '<read', '<edit', '<execute', 'tool:', '```tool_call', '<|inc_tool_call_ml'];

function safeFlushPoint(content, tail = 24) {
  let cut = Math.max(0, content.length - tail);
  for (const m of TOOL_MARKERS) {
    const i = content.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  return cut;
}

// Live browser-context streaming: forwards deltas to the client as they arrive
// in the page (true TTFT + live reasoning). Returns {ok:false} only when the
// browser path failed before anything was written, so the caller can fall back.
async function runLiveBrowser(upstreamReq, account, ctx) {
  const { res, id, model, createdAt, t0, shimTools, declaredTools } = ctx;
  const bu = getBrowserUpstream();
  const chunkTypes = {};
  const rawChunks = [];
  let text = '';
  let reasoning = '';
  let flushed = 0;
  const nativeCalls = [];
  let headersSent = false;
  const splitter = new ThinkSplitter();   // always scrape whatever the model thinks
  let upstreamReasoning = false;

  const writeHeaders = () => {
    if (headersSent) return;
    headersSent = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sendSSE(res, id, model, createdAt, { role: 'assistant' });
  };

  // The answer is forwarded exactly as the platform sends it - no re-chunking,
  // no pacing, no added delay.
  const flushContent = (final) => {
    if (!text) return;
    const cut = final ? text.length : safeFlushPoint(text);
    if (cut > flushed) {
      sendSSE(res, id, model, createdAt, { content: text.slice(flushed, cut) });
      flushed = cut;
    }
  };

  try {
    const effortExtra = (ctx.requestedEffort && !effortRejected && EFFORT_FIELD) ? { [EFFORT_FIELD]: ctx.requestedEffort } : null;
    for await (const chunk of bu.stream(upstreamReq, account.bearer, { extra: effortExtra })) {
      const t = (chunk && (chunk.type || (chunk.choices ? 'openai-chunk' : 'unknown'))) || 'unknown';
      chunkTypes[t] = (chunkTypes[t] || 0) + 1;
      rawChunks.push(chunk);
      const d = chunkToDelta(chunk);
      if (!d) continue;
      if (d.reasoning_content) {
        upstreamReasoning = true;
        writeHeaders();
        if (!ctx.ttftMs) ctx.ttftMs = Date.now() - t0;
        reasoning += d.reasoning_content;
        if (THINKING_MODE === 'live') {
          sendSSE(res, id, model, createdAt, { reasoning_content: d.reasoning_content, reasoning: d.reasoning_content });
        }
      }
      if (d.content) {
        writeHeaders();
        if (!ctx.ttftMs) ctx.ttftMs = Date.now() - t0;
        if (splitter && !upstreamReasoning) {
          // prompt-level thinking: the model writes <think>…</think> inside its
          // answer — split it out and stream it as live reasoning
          const sp = splitter.push(d.content);
          if (sp.reasoning) {
            reasoning += sp.reasoning;
            if (THINKING_MODE === 'live') {
              sendSSE(res, id, model, createdAt, { reasoning_content: sp.reasoning, reasoning: sp.reasoning });
            }
          }
          if (sp.content) {
            text += sp.content;
            if (!shimTools) flushContent(false);
          }
        } else {
          text += d.content;
          if (!shimTools) flushContent(false);
        }
      }
      if (d.tool_calls) {
        writeHeaders();
        for (const tc of d.tool_calls) nativeCalls.push(tc);
      }
    }
  } catch (e) {
    if (headersSent) {
      sendSSE(res, id, model, createdAt, {}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
      return { ok: true, partial: true, error: String(e) };
    }
    return { ok: false, error: String(e) };
  }

  // some streams carry the reasoning only in the final message payload —
  // recover it so the thinking panel is never empty
  if (!reasoning.length && rawChunks.length) {
    const tail = extractFinalReasoning(rawChunks);
    if (tail) {
      reasoning = tail;
      console.log(`[reasoning] recovered ${tail.length} chars from the final message payload`);
    }
  }

  // did the upstream reject the effort field? then stop sending it
  try {
    const dropped = await bu.droppedFields();
    if (Array.isArray(dropped) && dropped.length) {
      console.log(`[effort] upstream rejected: ${dropped.join(', ')} — retrying without it; these fields are ignored by the free chat`);
      if (dropped.includes(EFFORT_FIELD)) effortRejected = true;
    }
  } catch {}

  // ---- finalize (same accounting as the buffered path) ----
  if (splitter) {
    const tail = splitter.flush();
    if (tail.reasoning) {
      reasoning += tail.reasoning;
      sendSSE(res, id, model, createdAt, { reasoning_content: tail.reasoning, reasoning: tail.reasoning });
    }
    if (tail.content) text += tail.content;
  }
  if (!reasoning) {
    const tailReasoning = extractFinalReasoning(rawChunks);
    if (tailReasoning) {
      reasoning = tailReasoning;
      sendSSE(res, id, model, createdAt, { reasoning_content: reasoning, reasoning });
      console.log(`[reasoning] recovered ${reasoning.length} chars from the final message payload`);
    }
  }
  let content = text;
  let toolCalls = nativeCalls.filter(Boolean);
  if (shimTools && !toolCalls.length) {
    const parsed = parseToolCalls(text, declaredTools);
    content = parsed.content;
    toolCalls = parsed.toolCalls;
    if (toolCalls.length) console.log(`[tool-shim] parsed ${toolCalls.length} tool call(s): ${toolCalls.map(t => t.function?.name).join(', ')}`);
  }
  const finishReason = toolCalls.length ? 'tool_calls' : 'stop';

  if (!shimTools) {
    flushContent(true);
  } else if (content) {
    // content was held back (tool markup must be stripped first)
    sendSSE(res, id, model, createdAt, { content });
  }
  // deliver the captured thinking in one block (mode "end", the default):
  // it shows up instantly and complete, with no live thinking process
  if (THINKING_MODE === 'end' && reasoning.length) {
    writeHeaders();
    sendSSE(res, id, model, createdAt, { reasoning_content: reasoning, reasoning: reasoning });
  }
  for (const tc of toolCalls) sendSSE(res, id, model, createdAt, { tool_calls: [tc] });

  // An upstream that produced nothing is a FAILURE, never an empty answer.
  if (!content && !reasoning.length && !toolCalls.length) {
    console.log('[live] upstream produced no content at all — treating as failure');
    if (!headersSent) {
      return { ok: false, error: 'upstream returned an empty response' };
    }
    sendSSE(res, id, model, createdAt, {}, 'stop');
    res.write('data: [DONE]\n\n');
    res.end();
    return { ok: true, partial: true, error: 'upstream returned an empty response' };
  }

  const elapsed = Date.now() - t0;
  const usage = buildUsage({
    promptText: JSON.stringify(upstreamReq.messages || []),
    completionText: content,
    reasoningText: reasoning,
  });
  const perf = throughput(usage, { ttftMs: ctx.ttftMs || 0, elapsedMs: elapsed, ttftKnown: !!ctx.ttftMs });
  recordStat({ ts: new Date().toISOString(), model, effort: ctx.requestedEffort || null, usage, ...perf, mode: 'live-browser', chunk_types: chunkTypes });
  console.log(`[usage] model=${model} effort=${ctx.requestedEffort || '-'} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} tps=${perf.tokens_per_second} ttft=${perf.ttft_ms}ms gen=${perf.generation_ms}ms source=${usage.usage_source} reasoning=${reasoning.length}ch chunks=${JSON.stringify(chunkTypes)}${ctx.requestedEffort && !reasoning.length ? ' (effort requested but no reasoning chunks — not applied)' : ''}`);

  sendSSE(res, id, model, createdAt, {}, finishReason);
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: createdAt, model, choices: [], usage: { ...usage, ...perf } })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
  return { ok: true, text: content, reasoning, toolCalls, chunkTypes };
}

// Collect a browser-context completion without touching the HTTP response
// (used by the effort probe).
async function collectBrowser(body, account, { extra = null } = {}) {
  const bu = getBrowserUpstream();
  const chunkTypes = {};
  let text = '';
  let reasoning = '';
  try {
    for await (const chunk of bu.stream(body, account.bearer, { extra })) {
      const t = (chunk && (chunk.type || (chunk.choices ? 'openai-chunk' : 'unknown'))) || 'unknown';
      chunkTypes[t] = (chunkTypes[t] || 0) + 1;
      const d = chunkToDelta(chunk);
      if (!d) continue;
      if (d.reasoning_content) reasoning += d.reasoning_content;
      if (d.content) text += d.content;
    }
    const dropped = await bu.droppedFields().catch(() => []);
    return { ok: true, text, reasoning, chunkTypes, dropped };
  } catch (e) {
    const dropped = await bu.droppedFields().catch(() => []);
    return { ok: false, error: String(e), text, reasoning, chunkTypes, dropped };
  }
}

// Empirically determine which field the free chat honours for thinking, and
// whether the levels actually change the output.
// Mercury 3 thinking levels (the platform's own UI): instant | low | medium | high | max
const REAL_LEVELS = ['instant', 'low', 'medium', 'high', 'max'];
// Field spellings the platform might honour, most likely first.
const PROBE_FIELDS = [
  { field: 'reasoning_effort', value: 'max' },
  { field: 'reasoningEffort', value: 'max' },
  { field: 'thinking', value: 'max' },
  { field: 'effort', value: 'max' },
  { field: 'reasoning_level', value: 'max' },
  { field: 'reasoningLevel', value: 'max' },
  { field: 'thinking_level', value: 'max' },
  { field: 'thinkingLevel', value: 'max' },
  { field: 'enable_thinking', value: true },
  { field: 'reasoning', value: 'max' },
];
const PROBE_PROMPT = 'Compute 37*43. Think through the calculation step by step, then state the final answer.';

async function runEffortProbe(model, { quick = false } = {}) {
  if (!CHROMIUM_PATH) return { error: 'no chromium available — the probe needs the browser context', model };
  if (!accounts.length) await ensureAccounts();
  const account = pickAccount();
  if (!account) return { error: 'no session' };
  const field_tests = [];
  let accepted = null;      // first field the upstream kept
  let winner = null;        // field that actually produced reasoning
  for (const cand of PROBE_FIELDS) {
    const body = { model, messages: [{ role: 'user', content: PROBE_PROMPT }], stream: true };
    const r = await collectBrowser(body, account, { extra: { [cand.field]: cand.value } });
    const rejected = Array.isArray(r.dropped) && r.dropped.includes(cand.field);
    const test = {
      field: cand.field,
      value: cand.value,
      ok: r.ok,
      rejected_by_upstream: rejected,
      reasoning_chars: r.reasoning.length,
      text_chars: r.text.length,
      error: r.error,
      chunk_types: r.chunkTypes,
    };
    field_tests.push(test);
    console.log(`[probe] effort field ${cand.field}=${JSON.stringify(cand.value)} -> reasoning=${r.reasoning.length}ch text=${r.text.length}ch ${rejected ? 'REJECTED-BY-UPSTREAM' : ''} ${r.ok ? '' : r.error}`);
    if (!rejected && r.ok) {
      if (!accepted) accepted = cand.field;
      if (r.reasoning.length > 0) { winner = cand.field; break; }   // working field found
    }
  }
  const bestField = winner || accepted;
  const level_tests = [];
  if (bestField && !quick) {
    for (const level of REAL_LEVELS) {
      const body = { model, messages: [{ role: 'user', content: PROBE_PROMPT }], stream: true };
      const r = await collectBrowser(body, account, { extra: { [bestField]: level } });
      level_tests.push({ level, reasoning_chars: r.reasoning.length, text_chars: r.text.length, chunk_types: r.chunkTypes });
      console.log(`[probe] level ${level} -> reasoning=${r.reasoning.length}ch text=${r.text.length}ch`);
    }
  }
  const distinct = new Set(level_tests.map(l => l.reasoning_chars)).size;
  return {
    model,
    field_tests,
    best_field: winner || null,
    accepted_field: accepted || null,
    level_tests,
    levels_change_output: level_tests.length > 1 && distinct > 1,
    current_effort_field: EFFORT_FIELD,
    rejected_fields: field_tests.filter(f => f.rejected_by_upstream).map(f => f.field),
    verdict: winner
      ? `field "${winner}" is honoured by the platform`
      : (accepted
        ? `field "${accepted}" is accepted but produced no reasoning in the probe`
        : (field_tests.every(f => f.rejected_by_upstream)
          ? 'the free chat rejects every reasoning field — it exposes no thinking control over this API'
          : 'no field spelling produced reasoning output — the free chat may not expose a thinking control over this API')),
  };
}

// Startup discovery: find the field the platform honours so the hot path
// never pays for a rejected request. Runs once, in the background.
//
// A field that the platform does not know may be either rejected (HTTP 400)
// or silently stripped — so the only reliable signal is reasoning actually
// appearing. If no field produces reasoning, the bridge sends none: the
// model keeps its normal speed and no request is wasted.
async function discoverEffortField() {
  if (effortFieldResolved) return;
  if (!DISCOVER_EFFORT) { console.log('[effort] discovery disabled (--discover-effort 0) — sending no effort field'); EFFORT_FIELD = ''; effortFieldResolved = true; return; }
  if (!CHROMIUM_PATH) { console.log('[effort] no chromium -> cannot discover the thinking field; sending none'); EFFORT_FIELD = ''; effortFieldResolved = true; return; }
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const out = await runEffortProbe(UPSTREAM_MODELS['mercury-3'] || 'mercury', { quick: true });
      if (out.error) {
        console.log(`[effort] discovery attempt ${attempt}: ${out.error}`);
        await new Promise(r => setTimeout(r, 8000));
        continue;
      }
      if (out.best_field) {
        EFFORT_FIELD = out.best_field;
        console.log(`[effort] platform honours "${EFFORT_FIELD}" — levels: ${REAL_LEVELS.join(', ')}`);
      } else if (out.accepted_field) {
        EFFORT_FIELD = out.accepted_field;
        console.log(`[effort] platform accepts "${EFFORT_FIELD}" (no reasoning seen in the probe — the level may be inert)`);
      } else {
        EFFORT_FIELD = '';
        console.log('[effort] no thinking field is honoured by the free chat — sending none (no rejected requests, normal speed)');
      }
      effortFieldResolved = true;
      return;
    } catch (e) {
      console.log(`[effort] discovery attempt ${attempt} failed: ${e}`);
      await new Promise(r => setTimeout(r, 8000));
    }
  }
  EFFORT_FIELD = '';
  effortFieldResolved = true;
  console.log('[effort] discovery gave up — sending no effort field (the model still thinks on its own)');
}

// Some streams carry the reasoning only in the final message payload (no
// reasoning-delta events). Recover it so the thinking panel is never empty.
function extractFinalReasoning(chunks) {
  for (let i = (chunks?.length || 0) - 1; i >= 0; i--) {
    const c = chunks[i];
    if (!c || typeof c !== 'object') continue;
    const parts = c.message?.parts || c.messageMetadata?.parts || c.parts;
    if (Array.isArray(parts)) {
      const r = parts
        .filter(pp => /reason|think/i.test(pp?.type || ''))
        .map(pp => pp?.text ?? pp?.content ?? '')
        .join('');
      if (r) return r;
    }
  }
  return '';
}

// ---- core handler ---------------------------------------------------------
async function handleCompletion(req, res, body) {
  const t0 = Date.now();
  const createdAt = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randomUUID()}`;
  const model = body.model || DEFAULT_MODEL;
  const wantStream = !!body.stream;
  const requestedEffort = effortFromBody(body, model);
  let ttftMs = 0;
  // ---- tool-calling shim -------------------------------------------------
  // The upstream endpoint has no OpenAI-native tool support, so the caller's
  // tools are declared inside the prompt and the model's text is parsed back
  // into real tool_calls objects.
  const declaredTools = Array.isArray(body.tools) ? body.tools : [];
  const shimTools = declaredTools.length > 0 && body.tool_choice !== 'none';
  const upstreamBody = shimTools ? injectToolSpec(body).body : body;
  const upstreamReq = shimTools ? { ...upstreamBody, stream: false } : upstreamBody;
  // normalize the effort for BOTH transports (the browser job forwards the
  // payload's reasoning_effort verbatim, so it must already be a real level)
  if (requestedEffort && !effortRejected && effortFieldResolved && EFFORT_FIELD) {
    upstreamReq[EFFORT_FIELD] = requestedEffort;
  }

  // ---- upstream model id -----------------------------------------------
  upstreamReq.model = UPSTREAM_MODEL_OVERRIDE || UPSTREAM_MODELS[model] || upstreamReq.model;
  console.log(`[upstream] model=${upstreamReq.model} effort_field=${EFFORT_FIELD || '(none)'} effort=${requestedEffort || '-'} mode=${BROWSER_MODE}`);
  // Native thinking only: we never change how the model reasons (no injected
  // directives - that would slow it down). We only scrape whatever reasoning
  // the model produces and stream it live.

  if (!accounts.length) {
    await ensureAccounts();
  }
  let account = pickAccount();
  if (!account) {
    return sendJSON(res, 401, {
      error: { message: 'No Inception session. Run: node warmup.mjs --output creds.json', type: 'authentication_error', param: null, code: 'no_credentials' },
    });
  }
  const ctx = { res, id, model, createdAt, t0, shimTools, declaredTools, requestedEffort, ttftMs: 0 };
  // --browser-mode on  -> always run in the browser context (live streaming),
  // skipping the plain-HTTP path that the Vercel checkpoint blocks anyway.
  const forceBrowser = BROWSER_MODE === 'on' && !!CHROMIUM_PATH;

  // Browser mode "on": run the request inside the page and stream live.
  if (forceBrowser && wantStream) {
    let live = await runLiveBrowser(upstreamReq, account, ctx);
    if (live.ok) { ttftMs = ctx.ttftMs; return; }
    console.log(`[live] browser stream failed: ${String(live.error).slice(0, 200)} — reloading the page and retrying once`);
    // a dead tab is the usual cause: reload and try again before falling back
    try { await getBrowserUpstream().reload(); } catch {}
    live = await runLiveBrowser(upstreamReq, account, ctx);
    if (live.ok) { ttftMs = ctx.ttftMs; return; }
    console.log(`[live] browser stream failed again: ${String(live.error).slice(0, 200)} — falling back`);
  }

  // Fast path: genuinely incremental streaming (real TTFT) when no tool shim
  // is needed. If the first upstream event is a challenge/error we fall through
  // to the buffered + browser-context recovery path below.
  if (wantStream && !shimTools && !forceBrowser && !plainBlocked) {
    try {
      if (!account.sessionToken) account.sessionToken = await getSessionToken(account);
      const payload = buildEnvelope(upstreamReq);
      const gen = upstreamStream(account, payload);
      const first = await gen.next();
      const fv = first?.value;
      if (!first?.done && fv && (fv.event === 'chunk' || fv.event === 'raw')) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        sendSSE(res, id, model, createdAt, { role: 'assistant' });
        let incText = '';
        let incReason = '';
        const push = (d) => {
          if (!d) return;
          if (d.reasoning_content) { if (!ttftMs) ttftMs = Date.now() - t0; incReason += d.reasoning_content; sendSSE(res, id, model, createdAt, { reasoning_content: d.reasoning_content, reasoning: d.reasoning_content }); }
          if (d.content) { if (!ttftMs) ttftMs = Date.now() - t0; incText += d.content; sendSSE(res, id, model, createdAt, { content: d.content }); }
          if (d.tool_calls) sendSSE(res, id, model, createdAt, { tool_calls: d.tool_calls });
        };
        push(chunkToDelta(fv.data));
        try {
          for await (const ev of gen) {
            if (ev.event !== 'chunk' && ev.event !== 'raw') break;
            push(chunkToDelta(ev.data));
          }
        } catch {}
        const elapsed = Date.now() - t0;
        const usage = buildUsage({
          promptText: JSON.stringify(upstreamReq.messages || []),
          completionText: incText,
          reasoningText: incReason,
        });
        const perf = throughput(usage, { ttftMs, elapsedMs: elapsed, ttftKnown: ttftMs > 0 });
        const stat = { ts: new Date().toISOString(), model, effort: requestedEffort || null, usage, ...perf, mode: 'incremental' };
        recordStat(stat);
        console.log(`[usage] model=${model} effort=${requestedEffort || '-'} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} tps=${perf.tokens_per_second} ttft=${perf.ttft_ms}ms gen=${perf.generation_ms}ms source=${usage.usage_source}`);
        sendSSE(res, id, model, createdAt, {}, 'stop');
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: createdAt, model, choices: [], usage: { ...usage, ...perf } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        console.log('[stream] incremental passthrough');
        return;
      }
      try { await gen.return?.(); } catch {}
    } catch (e) {
      // fall through to buffered recovery
    }
  }

  const mode = ENVELOPE === 'auto' ? 'minimal' : ENVELOPE;
  let attempt = 0;
  let result;

  while (attempt < 3 && !plainBlocked && !forceBrowser) {
    try {
      result = await completeOnce(account, upstreamReq, mode);
    } catch (e) {
      // transient / envelope issue: retry with full envelope once
      if (mode !== 'full' && attempt === 0) {
        attempt += 1;
        result = await completeOnce(account, upstreamReq, 'full').catch(e2 => ({ status: 502, chunks: [], errBody: String(e2), payload: null }));
        break;
      }
      return sendJSON(res, 502, { error: { message: String(e), type: 'upstream_error', param: null, code: 'upstream_error' } });
    }

    if (result.status === 429 && CHROMIUM_PATH && !forceBrowser) {
      // the edge challenges plain HTTP — the browser context is the only way
      break;
    }
    if (result.status === 400 && mode === 'minimal' && ENVELOPE === 'auto') {
      attempt += 1;
      result = await completeOnce(account, upstreamReq, 'full').catch(e2 => ({ status: 502, chunks: [], errBody: String(e2), payload: null }));
      break;
    }
    if (result.status === 401) {
      // rotate account
      accounts = accounts.filter(a => a !== account);
      if (!accounts.length) {
        return sendJSON(res, 401, {
          error: { message: 'All Inception tokens expired/invalid. Re-run warmup.mjs', type: 'authentication_error', param: null, code: 'token_expired' },
        });
      }
      account = pickAccount();
      attempt += 1;
      continue;
    }
    if (result.errBody === 'vercel-challenge' && attempt < 2) {
      // edge challenge: refresh the solved session and retry
      const ok = await runWarmup(credsPath, { force: true });
      if (ok) accounts = loadCreds(credsPath);
      account = pickAccount();
      attempt += 1;
      continue;
    }
    break;
  }

  // If the edge still challenges plain HTTP (including the /api/session 429),
  // fall back to running the request inside the real browser (CDP) —
  // byte-identical to the site's own traffic.
  const looksChallenged = result && (
    result.status === 429 ||
    result.errBody === 'vercel-challenge' ||
    /Vercel Security Checkpoint|vercel-challenge|session HTTP 429|x-vercel-mitigated/i.test(result.errBody || '')
  );
  if (looksChallenged) {
    plainBlocked = true;
    console.log('[challenge] plain HTTP is blocked by the Vercel checkpoint — switching to browser-context mode');
  }
  const needBrowser = forceBrowser || plainBlocked || looksChallenged;
  if (useBrowserFallback && needBrowser) {
    if (process.env.BRIDGE_DEBUG) console.log('[debug] incoming body:', JSON.stringify(body).slice(0, 1500));
    if (wantStream) {
      // live path: deltas (and reasoning) reach the client while the model works
      let live = await runLiveBrowser(upstreamReq, account, ctx);
      if (live.ok) { ttftMs = ctx.ttftMs; return; }
      console.log(`[live] browser stream failed: ${String(live.error).slice(0, 200)} — reloading the page and retrying once`);
      try { await getBrowserUpstream().reload(); } catch {}
      live = await runLiveBrowser(upstreamReq, account, ctx);
      if (live.ok) { ttftMs = ctx.ttftMs; return; }
      console.log(`[live] browser stream failed again: ${String(live.error).slice(0, 200)} — using buffered browser mode`);
    }
    let br = null;
    for (let i = 0; i < 5 && !(br && br.status === 200 && br.chunks.length); i++) {
      try {
        br = await getBrowserUpstream().complete(upstreamReq, account.bearer, { extra: (requestedEffort && EFFORT_FIELD) ? { [EFFORT_FIELD]: requestedEffort } : null });
      } catch (e) {
        console.log(`[browser-mode] attempt ${i + 1} error: ${String(e).slice(0, 200)}`);
      }
      if (!(br && br.status === 200 && br.chunks.length)) {
        console.log(`[browser-mode] attempt ${i + 1} failed (status=${br?.status}) — reloading browser page, waiting 8s`);
        try { await getBrowserUpstream().reload(); } catch {}
        await new Promise(r => setTimeout(r, 8000));
      }
    }
    if (br && br.status === 200 && br.chunks.length) {
      result = {
        status: 200,
        chunks: br.chunks,
        errBody: '',
        payload: null,
      };
      console.log('[browser-mode] completion executed in browser context (status 200)');
    } else if (br) {
      console.log(`[browser-mode] browser completion failed: status=${br.status} err=${String(br.errBody).slice(0, 200)} dbg=${JSON.stringify(br.debug || {})}`);
    }
  }

  if (!result || result.status !== 200) {
    if (forceBrowser && !wantStream) {
      const br = await getBrowserUpstream().complete(upstreamReq, account.bearer).catch(e => ({ status: 0, chunks: [], errBody: String(e) }));
      if (br.status === 200 && br.chunks.length) {
        result = { status: 200, chunks: br.chunks, errBody: '', payload: null };
      }
    }
  }
  if (!result || result.status !== 200) {
    const code = (result && result.status) || 502;
    const msg = (result && result.errBody) || 'upstream failure';
    return sendJSON(res, code, { error: { message: msg.slice(0, 500), type: 'upstream_error', param: null, code: 'upstream_error' } });
  }

  // ---- success -----------------------------------------------------------
  // Fold the captured chunks into text / reasoning / tool calls.
  const textParts = [];
  const reasonParts = [];
  const nativeCalls = [];
  for (const c of result.chunks) {
    const d = chunkToDelta(c);
    if (!d) continue;
    if (d.content) textParts.push(d.content);
    if (d.reasoning_content) reasonParts.push(d.reasoning_content);
    if (d.tool_calls) for (const tc of d.tool_calls) {
      const idx = tc.index ?? nativeCalls.length;
      const slot = nativeCalls[idx] || (nativeCalls[idx] = { index: idx, id: tc.id, type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name = tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
  }
  let content = textParts.join('');
  let reasoning = reasonParts.join('');
  if (!reasoning) {
    const tailReasoning = extractFinalReasoning(result.chunks);
    if (tailReasoning) {
      reasoning = tailReasoning;
      console.log(`[reasoning] recovered ${reasoning.length} chars from the final message payload`);
    }
  }
  if (!reasoning) {
    const split = extractThink(content);
    if (split.reasoning) {
      reasoning = split.reasoning;
      content = split.content;
      console.log(`[think] split ${reasoning.length} reasoning chars out of the answer`);
    }
  }
  let toolCalls = nativeCalls.filter(Boolean);

  // Shim: recover tool calls the model wrote as plain text.
  if (shimTools && !toolCalls.length) {
    const parsed = parseToolCalls(content, declaredTools);
    if (parsed.toolCalls.length) {
      toolCalls = parsed.toolCalls;
      content = parsed.content;
      console.log(`[tool-shim] parsed ${toolCalls.length} tool call(s): ${toolCalls.map(t => t.function.name).join(', ')}`);
    }
  }
  const finishReason = toolCalls.length ? 'tool_calls' : 'stop';

  const elapsed = Date.now() - t0;
  const upstreamUsage = pickUpstreamUsage(result.chunks);
  const usage = buildUsage({
    promptText: JSON.stringify(upstreamReq.messages || []),
    completionText: content,
    reasoningText: reasoning,
    upstream: upstreamUsage,
  });
  const perf = throughput(usage, { ttftMs, elapsedMs: elapsed, ttftKnown: ttftMs > 0 });
  const stat = { ts: new Date().toISOString(), model, effort: requestedEffort || null, usage, ...perf, mode: 'buffered' };
  recordStat(stat);
  const reasoningApplied = reasoning.length > 0;
  console.log(`[usage] model=${model} effort=${requestedEffort || '-'} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens} tps=${perf.tokens_per_second} ttft=${perf.ttft_ms}ms gen=${perf.generation_ms}ms source=${usage.usage_source} reasoning=${reasoningApplied ? reasoning.length + 'ch' : 'none'}${requestedEffort && !reasoningApplied ? ' (effort requested but no reasoning chunks — not applied)' : ''}`);

  if (wantStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sendSSE(res, id, model, createdAt, { role: 'assistant' });
    if (reasoning) sendSSE(res, id, model, createdAt, { reasoning_content: reasoning, reasoning });
    if (content) sendSSE(res, id, model, createdAt, { content });
    for (const tc of toolCalls) sendSSE(res, id, model, createdAt, { tool_calls: [tc] });
    sendSSE(res, id, model, createdAt, {}, finishReason);
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: createdAt, model, choices: [], usage: { ...usage, ...perf } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Non-stream: byte-for-byte passthrough when upstream already speaks OpenAI.
  if (!shimTools && result.chunks.length === 1 && typeof result.chunks[0] === 'object' && result.chunks[0].choices) {
    const raw = result.chunks[0];
    if (!raw.usage) raw.usage = { ...usage, ...perf };
    return sendJSON(res, 200, raw);
  }

  const message = { role: 'assistant', content };
  if (reasoning) {
    if (THINKING_MODE !== 'off') message.reasoning_content = reasoning;
    message.reasoning = reasoning;
  }
  if (toolCalls.length) message.tool_calls = toolCalls;
  return sendJSON(res, 200, {
    id, object: 'chat.completion', created: createdAt, model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { ...usage, ...perf },
  });
}


// Normalize one upstream chunk (OpenAI shape or AI-SDK data-stream type) to an
// OpenAI delta object. Returns null for chunks that carry no delta.
function chunkToDelta(chunk) {
  if (chunk == null) return null;
  if (typeof chunk === 'string') return chunk ? { content: chunk } : null;
  const choice = chunk.choices?.[0];
  if (choice) {
    const m = choice.delta ?? choice.message;
    if (!m) return null;
    if (typeof m === 'string') return { content: m };
    const d = {};
    if (m.content ?? m.text) d.content = m.content ?? m.text;
    if (m.reasoning_content ?? m.reasoning) {
      d.reasoning_content = m.reasoning_content ?? m.reasoning;
      d.reasoning = d.reasoning_content;
    }
    if (m.tool_calls) d.tool_calls = m.tool_calls;
    return d;
  }
  if (!chunk.type) {
    const r = chunk.reasoning_content ?? chunk.reasoning ?? chunk.thinking;
    if (typeof r === 'string' && r) return { reasoning_content: r, reasoning: r };
  }
  switch (chunk.type) {
    case 'text-delta':
    case 'content-delta': {
      const d = chunk.delta;
      const s = typeof d === 'string' ? d : (d?.text ?? d?.content ?? '');
      return s ? { content: s } : null;
    }
    case 'reasoning-delta':
    case 'reasoning':
    case 'reasoning-text-delta':
    case 'thinking-delta':
    case 'thinking':
    case 'reasoning-start': {
      const d = chunk.delta ?? chunk.text ?? chunk.content ?? chunk.reasoning ?? chunk.thinking;
      const s = typeof d === 'string' ? d : (d?.text ?? d?.content ?? '');
      // emit both field names — clients read either `reasoning` or `reasoning_content`
      return s ? { reasoning_content: s, reasoning: s } : null;
    }
    case 'tool-call':
      return {
        tool_calls: [{
          index: 0,
          id: chunk.toolCallId || chunk.id,
          type: 'function',
          function: {
            name: chunk.toolName || chunk.name || '',
            arguments: typeof chunk.args === 'string' ? chunk.args : JSON.stringify(chunk.args ?? chunk.arguments ?? ''),
          },
        }],
      };
    case 'tool-call-delta': {
      const args = chunk.args ?? chunk.arguments ?? chunk.delta;
      return {
        tool_calls: [{
          index: 0,
          function: { arguments: typeof args === 'string' ? args : JSON.stringify(args ?? '') },
        }],
      };
    }
    default:
      if (chunk.delta) {
        const d = chunk.delta;
        const s = typeof d === 'string' ? d : (d?.text ?? d?.content ?? '');
        return s ? { content: s } : null;
      }
      if (chunk.content ?? chunk.text) return { content: chunk.content ?? chunk.text };
      return null;
  }
}

// ---- server --------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);

  if (u.pathname === '/') {
    const lines = [
      '# inception-bridge',
      '',
      'Free chat-to-API bridge for chat.inceptionlabs.ai (OpenAI-compatible).',
      '',
      'Endpoints:',
      '  POST /v1/chat/completions   (stream + non-stream)',
      '  GET  /v1/models',
      '  GET  /healthz',
      '',
      `Sessions (accounts): ${accounts.length}`,
      accounts.length
        ? 'Status: ready (sessions loaded).'
        : 'Status: NO SESSION YET. Obtain one:',
      accounts.length ? '' : '  1) node warmup.mjs --output creds.json   (auto-solve Vercel checkpoint, needs a browser-capable machine)',
      accounts.length ? '' : '  2) node get-creds.mjs                   (paste Cookie/Bearer from your own browser — works everywhere)',
      '',
      'Then: node test.mjs --stream --verbose',
    ].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(lines + '\n');
  }
  if (u.pathname === '/healthz') return sendJSON(res, 200, { ok: true, accounts: accounts.length });
  if (u.pathname === '/v1/session/refresh') {
    const ok = await runWarmup(credsPath, { force: true, extraArgs: warmupExtra });
    if (ok) accounts = loadCreds(credsPath);
    return sendJSON(res, ok ? 200 : 502, { refreshed: ok, accounts: accounts.length, hint: ok ? '' : 'warmup failed: no browser in this environment — use node get-creds.mjs' });
  }
  if (u.pathname === '/v1/models') {
    // exactly the two models the platform offers
    const ids = knownModels.slice();
    const data = ids.map(m => {
      const meta = metaFor(m);
      return {
        id: m,
        object: 'model',
        created: 1700000000,
        owned_by: 'inception-free',
        context_length: meta?.context_length ?? null,
        max_output_tokens: meta?.max_output_tokens ?? null,
        reasoning_efforts: EFFORTS,
        default_reasoning_effort: meta?.default_effort || null,
      };
    });
    return sendJSON(res, 200, { object: 'list', data });
  }
  if (u.pathname === '/v1/usage') {
    const total = recentStats.reduce((a, s) => a + (s.usage?.completion_tokens || 0), 0);
    return sendJSON(res, 200, {
      object: 'usage.list',
      count: recentStats.length,
      totals: {
        prompt_tokens: recentStats.reduce((a, s) => a + (s.usage?.prompt_tokens || 0), 0),
        completion_tokens: total,
        total_tokens: recentStats.reduce((a, s) => a + (s.usage?.total_tokens || 0), 0),
      },
      data: recentStats.slice(-50).reverse(),
    });
  }
  if (u.pathname === '/v1/effort-probe') {
    const model = u.searchParams.get('model') || DEFAULT_MODEL;
    if (u.searchParams.get('apply') === '1') {
      EFFORT_FIELD = u.searchParams.get('field') || EFFORT_FIELD;
      effortFieldResolved = true;
    }
    const out = await runEffortProbe(model);
    return sendJSON(res, 200, out);
  }
  if (u.pathname === '/v1/reasoning-check') {
    const effort = normalizeEffort(u.searchParams.get('effort') || 'high') || 'high';
    const model = u.searchParams.get('model') || DEFAULT_MODEL;
    const check = await verifyReasoning(model, effort);
    return sendJSON(res, 200, check);
  }
  if (u.pathname !== '/v1/chat/completions') return sendJSON(res, 404, { error: { message: 'not found', type: 'invalid_request_error', param: null, code: null } });
  noteRequest();

  if (!authOk(req)) return sendJSON(res, 401, { error: { message: 'invalid api key', type: 'authentication_error', param: null, code: 'invalid_api_key' } });
  if (req.method !== 'POST') return sendJSON(res, 405, { error: { message: 'method not allowed', type: 'invalid_request_error', param: null, code: null } });

  let raw = '';
  for await (const c of req) raw += c;
  let body;
  try { body = JSON.parse(raw); } catch { return sendJSON(res, 400, { error: { message: 'invalid JSON body', type: 'invalid_request_error', param: null, code: null } }); }

  try {
    await handleCompletion(req, res, body);
  } catch (e) {
    if (!res.headersSent) return sendJSON(res, 500, { error: { message: String(e).slice(0, 300), type: 'server_error', param: null, code: null } });
    res.end();
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`inception-bridge listening on http://${HOST}:${PORT}/v1`);
  if (!accounts.length) {
    console.log('[startup] no session yet — running warmup to solve Vercel checkpoint…');
    const ok = await ensureAccounts();
    if (!ok) {
      console.log('[startup] warmup did not produce a session (browser may be unavailable in this environment).');
      console.log('[startup] → run:  node get-creds.mjs   (paste Cookie header from your own browser)');
      console.log('[startup]   or on a browser-capable machine:  node warmup.mjs --output creds.json');
    }
  }
  console.log(`accounts: ${accounts.length}, envelope mode: ${ENVELOPE}, model default: ${DEFAULT_MODEL}`);
  // Probe the site for its real model list (background, non-blocking).
  // Probes share the browser tab with live requests, so they only run when
  // the bridge has been idle for a while - never during real traffic.
  scheduleIdleProbe(() => probeSiteModels(), 20000);
  scheduleIdleProbe(() => discoverEffortField(), 30000);
  if (AUTO_REFRESH_HOURS > 0) {
    const intervalMs = AUTO_REFRESH_HOURS * 3600 * 1000;
    console.log(`[auto-refresh] enabled: every ${AUTO_REFRESH_HOURS}h (session TTL ${SESSION_TTL_HOURS}h)`);
    setInterval(maybeAutoRefresh, Math.min(intervalMs, 6 * 3600 * 1000)).unref();
    setTimeout(maybeAutoRefresh, 60_000).unref();
  }
});
