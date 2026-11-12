// Cloudflare Pages Function — the control plane API for the admin panel and
// the bot. Runs as a Worker on the same domain as the static panel (served
// automatically from dist/ at "/").
//
// State lives in the CONTROL_KV KV namespace (key "state"). Auth:
//   - panel/member: header X-Telegram-Init-Data (HMAC verified with BOT_TOKEN)
//   - bot <-> plane: header Authorization: Bearer BOT_REPORT_SECRET
//
// This file is pure ESM with NO node imports so it bundles for Workers.
// It reuses the storage-agnostic ControlState class.

import { ControlState } from '../../../collector/lib/control-state.mjs';

const MAX_INITDATA_AGE_S = 3600; // replay protection: 1h

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

// ---------- crypto helpers (Web Crypto — works in Workers and Node 18+) ----------
const te = new TextEncoder();
const td = new TextDecoder();

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
  return new Uint8Array(sig);
}

function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqStr(a, b) {
  const ta = te.encode(String(a));
  const tb = te.encode(String(b));
  if (ta.length !== tb.length) return false;
  let r = 0;
  for (let i = 0; i < ta.length; i++) r |= ta[i] ^ tb[i];
  return r === 0;
}

// Verify Telegram WebApp initData. Returns {id, username, firstName} or null.
async function verifyInitData(raw, botToken) {
  try {
    if (!raw || !botToken) return null;
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secretKey = await hmacSha256(te.encode('WebAppData'), te.encode(botToken));
    const computed = toHex(await hmacSha256(secretKey, te.encode(dataCheckString)));
    if (!safeEqStr(computed, hash)) return null;
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || Date.now() / 1000 - authDate > MAX_INITDATA_AGE_S) return null;
    const user = params.get('user');
    if (!user) return null;
    const u = JSON.parse(user);
    if (!u.id) return null;
    return { id: Number(u.id), username: u.username || '', firstName: u.first_name || '' };
  } catch {
    return null;
  }
}

// ---------- rate limiting (per-instance, best-effort) ----------
const rateMap = new Map();
function rateLimited(key, windowMs = 60000, max = 60) {
  const now = Date.now();
  const e = rateMap.get(key);
  if (!e || now - e.start > windowMs) { rateMap.set(key, { start: now, count: 1 }); return false; }
  e.count++;
  if (rateMap.size > 5000) rateMap.clear();
  return e.count > max;
}

// ---------- helpers ----------
function json(obj, code = 200) {
  const body = JSON.stringify(obj);
  return new Response(body, { status: code, headers: { ...SEC_HEADERS, 'Content-Type': 'application/json', 'Content-Length': String(body.length) } });
}

async function readJson(request) {
  const raw = await request.text();
  try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('invalid JSON'); }
}

async function getState(env) {
  let initial = null;
  try { initial = await env.CONTROL_KV.get('state', 'json'); } catch { /* first run */ }
  const persist = async (s) => { try { await env.CONTROL_KV.put('state', JSON.stringify(s)); } catch {} };
  return ControlState.fromObject(initial, { persist });
}

function runtimeConfigPayload(state) {
  const s = state.state;
  return {
    mode: 'api',
    activeModelId: s.settings.defaultModelId,
    providers: s.providers.map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, enabled: p.enabled, keys: (p.keys || []).map(k => ({ id: k.id, value: k.value })) })),
    models: s.models.map(m => ({ id: m.id, providerId: m.providerId, upstreamId: m.upstreamId, label: m.label, enabled: m.enabled, temperature: m.temperature, systemPrompt: m.systemPrompt })),
    settings: { showThinking: s.settings.showThinking, thinkingPreviewChars: s.settings.thinkingPreviewChars, maxHistoryTurns: s.settings.maxHistoryTurns, allowGroups: s.settings.allowGroups, defaultSystemPrompt: s.settings.defaultSystemPrompt, defaultModelId: s.settings.defaultModelId },
    configEpoch: s.configEpoch,
  };
}

// ---------- main entry ----------
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const p = url.pathname;
  const method = request.method;
  const headers = request.headers;
  const ip = headers.get('cf-connecting-ip') || headers.get('x-forwarded-for') || 'unknown';

  // /panel and / are served as static by Pages (dist/). Anything else that
  // is not /api/* is a 404 here.
  if (!p.startsWith('/api/')) return json({ error: 'not found' }, 404);

  const state = await getState(env);
  const BOT_TOKEN = env.BOT_TOKEN || '';
  const SECRET = env.BOT_REPORT_SECRET || '';

  const requireSecret = () => {
    if (rateLimited('secret:' + ip)) return { error: 429, msg: 'rate limited' };
    const auth = headers.get('authorization') || '';
    if (!SECRET || !safeEqStr(auth, `Bearer ${SECRET}`)) return { error: 401, msg: 'unauthorized' };
    return { ok: true };
  };

  const requireMember = async () => {
    if (rateLimited('init:' + ip)) return { error: 429, msg: 'rate limited' };
    const u = await verifyInitData(headers.get('x-telegram-init-data') || '', BOT_TOKEN);
    if (!u) return { error: 401, msg: 'unauthorized' };
    if (rateLimited('user:' + u.id)) return { error: 429, msg: 'rate limited' };
    return { user: u };
  };
  const requireAdmin = async () => {
    const m = await requireMember();
    if (m.error) return m;
    if (!state.isAdmin(m.user.id)) return { error: 403, msg: 'forbidden: owner/admin only' };
    return { user: m.user };
  };

  let mutated = false;
  const mark = () => { mutated = true; };

  try {
    // ---- bot runtime config (Bearer secret) ----
    if (p === '/api/runtime-config' && method === 'GET') {
      const sa = requireSecret();
      if (sa.error) return json({ error: sa.msg }, sa.error);
      return json(runtimeConfigPayload(state));
    }

    // ---- bot reporting (Bearer secret) ----
    if (p === '/api/report' && method === 'POST') {
      const sa = requireSecret();
      if (sa.error) return json({ error: sa.msg }, sa.error);
      const body = await readJson(request);
      if (body.uid != null) {
        state.touchUser(body.uid, body);
        state.addLog({ uid: body.uid, username: body.username || '', provider: body.provider || '', keyId: body.keyId || '', model: body.model || '', promptChars: body.charIn || 0, outputChars: body.charOut || 0, tokensIn: body.tokensIn || 0, tokensOut: body.tokensOut || 0, status: body.status || 'ok', preview: body.preview ? String(body.preview).slice(0, 300) : '' });
        mutated = true;
      }
      if (mutated) await state.flush();
      return json({ ok: true });
    }

    // ---- bot command API (Bearer secret) ----
    if (p.startsWith('/api/bot/') && method === 'POST') {
      const sa = requireSecret();
      if (sa.error) return json({ error: sa.msg }, sa.error);
      const b = await readJson(request);
      const op = p.slice('/api/bot/'.length);
      try {
        let result;
        switch (op) {
          case 'providers': result = { providers: state.listProvidersSafe() }; break;
          case 'providers/add': result = { provider: state.addProvider(b) }; mark(); break;
          case 'providers/remove': result = { provider: state.removeProvider(b.id) }; mark(); break;
          case 'providers/toggle': result = { provider: state.toggleProvider(b.id, b.enabled) }; mark(); break;
          case 'keys/add': result = { key: state.addKey(b.id, b.key) }; mark(); break;
          case 'keys/remove': { const p = state.removeKey(b.id, b.keyId); result = { provider: p ? state.maskProvider(p) : null }; } mark(); break;
          case 'models': result = { models: state.listModels(), activeModelId: state.state.settings.defaultModelId }; break;
          case 'models/add': result = { model: state.addModel(b) }; mark(); break;
          case 'models/remove': result = { model: state.removeModel(b.id) }; mark(); break;
          case 'models/active': result = { model: state.setActiveModel(b.id) }; mark(); break;
          case 'models/toggle': result = { model: state.toggleModel(b.id, b.enabled) }; mark(); break;
          case 'models/prompt': result = { model: state.setModelPrompt(b.id, b.prompt) }; mark(); break;
          case 'models/temperature': result = { model: state.setModelTemperature(b.id, b.temperature) }; mark(); break;
          case 'admins': result = { owner: state.state.ownerId, admins: state.listAdmins() }; break;
          case 'admins/add': result = { admins: state.addAdmin(b.id, b.username || '') }; mark(); break;
          case 'admins/remove': result = { admins: state.removeAdmin(b.id) }; mark(); break;
          case 'settings': result = { settings: state.state.settings }; break;
          case 'settings/set': result = { settings: state.setSetting(b.key, b.value) }; mark(); break;
          case 'users': result = { users: state.topUsers(b.limit || 20), total: Object.keys(state.state.users).length }; break;
          case 'user': result = { user: state.state.users[Number(b.uid)] || null, logs: state.userLogs(b.uid, 50) }; break;
          case 'logs': result = { logs: state.state.logs.slice(-(b.limit || 50)).reverse() }; break;
          case 'stats': {
            const users = Object.values(state.state.users);
            const sum = fn => users.reduce((a, u) => a + (fn(u) || 0), 0);
            result = { totalUsers: users.length, totalMessages: sum(u => u.messages), totalTokensIn: sum(u => u.tokensIn), totalTokensOut: sum(u => u.tokensOut), totalLogs: state.state.logs.length };
            break;
          }
          case 'state': result = state.snapshot(); break;
          default: return json({ error: 'unknown op' }, 404);
        }
        if (mutated) await state.flush();
        return json(result);
      } catch (e) {
        return json({ error: String(e?.message || e).slice(0, 200) }, 400);
      }
    }

    // ---- panel API (initData auth) ----
    if (p.startsWith('/api/')) {
      const auth = await requireAdmin();
      if (auth.error) return json({ error: auth.msg }, auth.error);
      try {
        if (p === '/api/state' && method === 'GET') {
          const snap = state.snapshot();
          snap.role = state.roleOf(auth.user.id);
          return json(snap);
        }
        if (p === '/api/members' && method === 'GET') return json({ owner: state.state.ownerId, admins: state.listAdmins() });
        if (method === 'POST') {
          const b = await readJson(request);
          const ownerOnly = p === '/api/admins/add' || p === '/api/admins/remove';
          if (ownerOnly && !state.isOwner(auth.user.id)) return json({ error: 'owner only' }, 403);
          let result;
          switch (p) {
            case '/api/admins/add': result = { admins: state.addAdmin(b.id, b.username || '') }; mark(); break;
            case '/api/admins/remove': result = { admins: state.removeAdmin(b.id) }; mark(); break;
            case '/api/providers': return json({ providers: state.listProvidersSafe() });
            case '/api/providers/add': result = { provider: state.addProvider(b) }; mark(); break;
            case '/api/providers/remove': result = { provider: state.removeProvider(b.id) }; mark(); break;
            case '/api/providers/toggle': result = { provider: state.toggleProvider(b.id, b.enabled) }; mark(); break;
            case '/api/providers/keys/add': result = { key: state.addKey(b.id, b.key) }; mark(); break;
            case '/api/providers/keys/remove': { const p = state.removeKey(b.id, b.keyId); result = { provider: p ? state.maskProvider(p) : null }; } mark(); break;
            case '/api/models': return json({ models: state.listModels(), activeModelId: state.state.settings.defaultModelId });
            case '/api/models/add': result = { model: state.addModel(b) }; mark(); break;
            case '/api/models/remove': result = { model: state.removeModel(b.id) }; mark(); break;
            case '/api/models/active': result = { model: state.setActiveModel(b.id) }; mark(); break;
            case '/api/models/toggle': result = { model: state.toggleModel(b.id, b.enabled) }; mark(); break;
            case '/api/models/prompt': result = { model: state.setModelPrompt(b.id, b.prompt) }; mark(); break;
            case '/api/models/temperature': result = { model: state.setModelTemperature(b.id, b.temperature) }; mark(); break;
            case '/api/settings': return json({ settings: state.state.settings });
            case '/api/settings/set': result = { settings: state.setSetting(b.key, b.value) }; mark(); break;
            case '/api/users': return json({ users: state.topUsers(50), total: Object.keys(state.state.users).length });
            default:
              if (p.startsWith('/api/users/') && method === 'GET') {
                const uid = Number(p.split('/').pop());
                return json({ user: state.state.users[uid] || null, logs: state.userLogs(uid, 100) });
              }
              if (p === '/api/logs' && method === 'GET') {
                const limit = parseInt(url.searchParams.get('limit') || '100', 10);
                return json({ logs: state.state.logs.slice(-limit).reverse() });
              }
              if (p === '/api/stats' && method === 'GET') {
                const users = Object.values(state.state.users);
                const sum = fn => users.reduce((a, u) => a + (fn(u) || 0), 0);
                return json({ totalUsers: users.length, totalMessages: sum(u => u.messages), totalTokensIn: sum(u => u.tokensIn), totalTokensOut: sum(u => u.tokensOut), totalChars: sum(u => u.charIn + u.charOut), totalLogs: state.state.logs.length, lastLog: state.state.logs.length ? new Date(state.state.logs[state.state.logs.length - 1].ts).toISOString() : null });
              }
              return json({ error: 'not found' }, 404);
          }
          if (mutated) await state.flush();
          return json(result);
        }
        // GET routes
        if (p === '/api/providers') return json({ providers: state.listProvidersSafe() });
        if (p === '/api/models') return json({ models: state.listModels(), activeModelId: state.state.settings.defaultModelId });
        if (p === '/api/settings') return json({ settings: state.state.settings });
        if (p === '/api/users') return json({ users: state.topUsers(50), total: Object.keys(state.state.users).length });
        if (p.startsWith('/api/users/')) {
          const uid = Number(p.split('/').pop());
          return json({ user: state.state.users[uid] || null, logs: state.userLogs(uid, 100) });
        }
        if (p === '/api/logs') {
          const limit = parseInt(url.searchParams.get('limit') || '100', 10);
          return json({ logs: state.state.logs.slice(-limit).reverse() });
        }
        if (p === '/api/stats') {
          const users = Object.values(state.state.users);
          const sum = fn => users.reduce((a, u) => a + (fn(u) || 0), 0);
          return json({ totalUsers: users.length, totalMessages: sum(u => u.messages), totalTokensIn: sum(u => u.tokensIn), totalTokensOut: sum(u => u.tokensOut), totalChars: sum(u => u.charIn + u.charOut), totalLogs: state.state.logs.length, lastLog: state.state.logs.length ? new Date(state.state.logs[state.state.logs.length - 1].ts).toISOString() : null });
        }
        return json({ error: 'not found' }, 404);
      } catch (e) {
        return json({ error: String(e?.message || e).slice(0, 200) }, 400);
      }
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: String(e?.message || e).slice(0, 200) }, 500);
  }
}
