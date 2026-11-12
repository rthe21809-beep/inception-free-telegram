#!/usr/bin/env node
// Exercises the Cloudflare Pages Function (functions/api/[[path]].js) in Node
// with a mock KV + env, to prove the Worker logic (auth, RBAC, bot API, report).

import { onRequest } from './admin-panel/functions/api/[[path]].js';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// mock KV
function mkKV() {
  const store = {};
  return {
    async get(k, type) {
      const v = store[k];
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) { store[k] = v; },
    _store: store,
  };
}

const BOT_TOKEN = '123:abc';
const SECRET = 'sek';
function mkEnv() {
  return { CONTROL_KV: mkKV(), BOT_TOKEN, BOT_REPORT_SECRET: SECRET };
}

async function call(env, method, path, { headers = {}, body } = {}) {
  const req = new Request(`https://panel.example${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const res = await onRequest({ request: req, env, params: { path: path.split('/').slice(1) } });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

// build valid initData
async function mkInit(uid, username, authDateSec = Math.floor(Date.now() / 1000)) {
  const te = new TextEncoder();
  const user = JSON.stringify({ id: uid, first_name: username, username });
  const pairs = [['user', user], ['auth_date', String(authDateSec)]];
  const dcs = pairs.map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const key = await crypto.subtle.importKey('raw', te.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(BOT_TOKEN)));
  const key2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key2, te.encode(dcs)))].map(b => b.toString(16).padStart(2, '0')).join('');
  return pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&') + '&hash=' + hash;
}

const env = mkEnv();
const OWNER = await mkInit(6940999328, 'owner');
const HELPER = await mkInit(111, 'helper');
const STALE = await mkInit(6940999328, 'owner', Math.floor(Date.now() / 1000) - 7200);

// 1. security headers
{
  const r = await call(env, 'GET', '/api/state', { headers: { 'X-Telegram-Init-Data': OWNER } });
  check(r.headers.get('x-frame-options') === 'DENY', 'X-Frame-Options DENY present');
  check(r.headers.get('content-security-policy')?.includes('frame-ancestors'), 'CSP frame-ancestors present');
  check(r.headers.get('cache-control') === 'no-store', 'no-store present');
}

// 2. no auth -> 401
{
  const r = await call(env, 'GET', '/api/state');
  check(r.status === 401, 'no initData -> 401');
}

// 3. stale auth_date -> 401
{
  const r = await call(env, 'GET', '/api/state', { headers: { 'X-Telegram-Init-Data': STALE } });
  check(r.status === 401, 'stale auth_date -> 401 (replay)');
}

// 4. owner -> 200, role owner
{
  const r = await call(env, 'GET', '/api/state', { headers: { 'X-Telegram-Init-Data': OWNER } });
  check(r.status === 200 && r.data.role === 'owner', 'owner auth -> 200 role=owner');
}

// 5. non-owner non-admin -> 403
{
  const r = await call(env, 'GET', '/api/state', { headers: { 'X-Telegram-Init-Data': HELPER } });
  check(r.status === 403, 'random user -> 403');
}

// 6. owner adds admin 111 (panel route, owner-only)
{
  const r = await call(env, 'POST', '/api/admins/add', { headers: { 'X-Telegram-Init-Data': OWNER }, body: { id: 111, username: 'helper' } });
  check(r.status === 200 && r.data.admins.length === 1, 'owner adds admin -> 200');
}

// 7. now helper is admin: state -> 200 role admin; but admin addadmin -> 403
{
  const r1 = await call(env, 'GET', '/api/state', { headers: { 'X-Telegram-Init-Data': HELPER } });
  check(r1.status === 200 && r1.data.role === 'admin', 'helper now admin');
  const r2 = await call(env, 'POST', '/api/admins/add', { headers: { 'X-Telegram-Init-Data': HELPER }, body: { id: 222 } });
  check(r2.status === 403, 'admin cannot add admin (owner-only) -> 403');
}

// 8. bot API with secret: add provider + model, set active; without secret 401
{
  const noAuth = await call(env, 'POST', '/api/bot/providers/add', { body: { name: 'Inception', baseUrl: 'https://api.inceptionlabs.ai/v1', key: 'sk-x' } });
  check(noAuth.status === 401, 'bot API without secret -> 401');
  const H = { Authorization: `Bearer ${SECRET}` };
  const addP = await call(env, 'POST', '/api/bot/providers/add', { headers: H, body: { name: 'Inception', baseUrl: 'https://api.inceptionlabs.ai/v1', key: 'sk-x' } });
  check(addP.status === 200 && addP.data.provider.id === 'inception', 'bot adds provider');
  const addM = await call(env, 'POST', '/api/bot/models/add', { headers: H, body: { id: 'mercury-3', providerId: 'inception', upstreamId: 'mercury-3' } });
  check(addM.status === 200, 'bot adds model');
  const act = await call(env, 'POST', '/api/bot/models/active', { headers: H, body: { id: 'mercury-3' } });
  check(act.status === 200, 'bot sets active model');
  const rc = await call(env, 'GET', '/api/runtime-config', { headers: H });
  check(rc.status === 200 && rc.data.activeModelId === 'mercury-3' && rc.data.providers[0].keys[0].value === 'sk-x', 'runtime-config returns real key + active model');
}

// 9. report ingestion + users + stats
{
  const H = { Authorization: `Bearer ${SECRET}` };
  const rep = await call(env, 'POST', '/api/report', { headers: H, body: { uid: 42, username: 'alice', provider: 'inception', model: 'mercury-3', tokensIn: 10, tokensOut: 5, charIn: 50, charOut: 100, status: 'ok', preview: 'hi' } });
  check(rep.status === 200, 'report accepted');
  const users = await call(env, 'POST', '/api/bot/users', { headers: H, body: {} });
  check(users.data.total === 1 && users.data.users[0].messages === 1, 'user stats aggregated');
}

// 10. state persisted to KV
{
  const raw = await env.CONTROL_KV.get('state', 'json');
  check(raw && raw.providers.length === 1 && raw.models.length === 1 && raw.configEpoch >= 4, 'state persisted to KV with epoch');
}

// 11. panel GET /api/providers with owner auth shows masked keys
{
  const r = await call(env, 'GET', '/api/providers', { headers: { 'X-Telegram-Init-Data': OWNER } });
  check(r.status === 200 && r.data.providers[0].keys[0].value.startsWith('sk-…'), 'panel sees masked key');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall worker checks passed');
process.exit(failures ? 1 : 0);
