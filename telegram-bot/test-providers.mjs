#!/usr/bin/env node
// Offline tests for the multi-provider client (mock fetch).

import { askProvider, activeModel } from './tgcloud/lib/providers.js';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

function cfg(overrides = {}) {
  return {
    providers: [
      { id: 'inception', name: 'Inception', baseUrl: 'https://api.inceptionlabs.ai/v1', enabled: true, keys: [{ id: 'k1', value: 'sk-one' }, { id: 'k2', value: 'sk-two' }] },
      { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', enabled: true, keys: [{ id: 'o1', value: 'sk-openai' }] },
    ],
    models: [
      { id: 'mercury-3', providerId: 'inception', upstreamId: 'mercury-3', label: 'Mercury 3', enabled: true, systemPrompt: '', temperature: 0.7 },
      { id: 'gpt-4o-mini', providerId: 'openai', upstreamId: 'gpt-4o-mini', label: 'GPT-4o mini', enabled: true, systemPrompt: 'Be terse.', temperature: 0 },
    ],
    activeModelId: 'mercury-3',
    settings: { defaultModelId: 'mercury-3', defaultSystemPrompt: 'Default.' },
    timeoutMs: 5000,
    ...overrides,
  };
}

async function withMock(responses) {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, opts });
    const status = responses.status || 200;
    const body = responses.body;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  // temporarily monkeypatch global fetch inside askProvider module scope is not
  // possible for ESM static import; so we fetch via the module that uses the
  // global fetch. We simulate by validating shape with a valid response.
  return { calls, fakeFetch };
}

// --- activeModel selection ---
{
  const c = cfg();
  check(activeModel(c)?.id === 'mercury-3', 'active model resolved');
  const c2 = cfg(); c2.activeModelId = 'missing'; c2.models[0].enabled = false;
  check(activeModel(c2)?.id === 'gpt-4o-mini', 'falls back to first enabled model');
  const c3 = cfg(); c3.models[0].enabled = false; c3.models[1].enabled = false;
  check(activeModel(c3) === null, 'null when no enabled model');
}

// --- askProvider success + key rotation ---
async function scenario() {
  const c = cfg();
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization, body: opts?.body });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'hello there', reasoning_content: 'thinking…' } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      }),
      text: async () => '{}',
    };
  };
  try {
    const r1 = await askProvider([{ role: 'user', content: 'hi' }], c);
    const r2 = await askProvider([{ role: 'user', content: 'hi' }], c);
    check(r1.content === 'hello there', 'content extracted');
    check(r1.reasoning === 'thinking…', 'reasoning extracted');
    check(r1.provider === 'inception', 'provider recorded');
    check(calls.length === 2, 'two calls made');
    const auths = calls.map(c => c.auth).sort();
    check(auths[0] === 'Bearer sk-one' && auths[1] === 'Bearer sk-two', 'both keys used (rotation)');
    check(calls[0].url.includes('chat/completions'), 'correct endpoint');
    const parsed = JSON.parse(calls[0].body);
    check(parsed.model === 'mercury-3', 'model in body');
    check(parsed.messages[0].content === 'Default.', 'system prompt present');
    check(parsed.temperature === 0.7, 'temperature passed');
    check(r1.tokensIn === 12 && r1.tokensOut === 4, 'usage tokens');
  } finally {
    global.fetch = originalFetch;
  }
}

// --- model-specific instruction overrides default system prompt ---
async function scenarioPrompt() {
  const c = cfg();
  c.models[0].systemPrompt = 'Model-specific instruct.';
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }], usage: {} }), text: async () => '{}' });
  try {
    const r = await askProvider([{ role: 'user', content: 'hi' }], c);
    check(r.content === 'x', 'prompt scenario answers');
  } finally { global.fetch = originalFetch; }
}

// --- error mapping ---
async function scenarioErrors() {
  const orig = global.fetch;
  try {
    const c = cfg();

    // 401
    global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '{}' });
    try { await askProvider([{ role: 'user', content: 'x' }], c); check(false, '401 should throw'); }
    catch (e) { check(e.code === 'API_AUTH', '401 -> API_AUTH'); }

    // no keys
    const c2 = cfg(); c2.providers[0].keys = [];
    try { await askProvider([{ role: 'user', content: 'x' }], c2); check(false, 'no-key should throw'); }
    catch (e) { check(e.code === 'NO_API_KEY', 'no keys -> NO_API_KEY'); }

    // provider disabled
    const c3 = cfg(); c3.providers[0].enabled = false; c3.activeModelId = 'mercury-3';
    try { await askProvider([{ role: 'user', content: 'x' }], c3); check(false, 'disabled-provider should throw'); }
    catch (e) { check(e.code === 'NO_PROVIDER', 'disabled provider -> NO_PROVIDER'); }

    // no model
    const c4 = cfg(); c4.models = []; c4.activeModelId = '';
    try { await askProvider([{ role: 'user', content: 'x' }], c4); check(false, 'no-model should throw'); }
    catch (e) { check(e.code === 'NO_MODEL', 'no model -> NO_MODEL'); }
  } finally { global.fetch = orig; }
}

await scenario();
await scenarioPrompt();
await scenarioErrors();

console.log(failures ? `\n${failures} check(s) failed` : '\nall provider checks passed');
process.exit(failures ? 1 : 0);
