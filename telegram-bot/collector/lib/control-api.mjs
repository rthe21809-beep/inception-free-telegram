// Control-plane HTTP API for the admin panel + the bot's reporting.
//
// Mounted inside the collector (Render/Railway) service. It provides:
//   - Telegram Mini-App auth (initData HMAC verification)
//   - owner/admin-gated CRUD for providers / models / admins / settings
//   - read-only analytics (users, usage, chat logs)
//   - POST /api/report (bot -> plane) for one-way usage/chat ingestion
//   - config regeneration + tgcloud push (so changes reach the bot)
//   - static serving of the React build under /panel/*
//
// Auth model:
//   - Panel/members: header X-Telegram-Init-Data (initData). Verified by HMAC
//     with the Telegram bot token (env BOT_TOKEN / TELEGRAM_BOT_TOKEN).
//   - Bot reporting: header Authorization: Bearer <BOT_REPORT_SECRET>.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '';
const REPORT_SECRET = process.env.BOT_REPORT_SECRET || '';

export function createControlApi({ state, botDir, run, defaultCfgPath, cfgPath, tgCloudPush }) {
  const PANEL_DIR = path.join(botDir, 'admin-panel', 'dist');

  // ---------- security: rate limiting ----------
  const RATE_WINDOW_MS = 60_000;
  const RATE_MAX = 60; // requests per window per key
  const rateMap = new Map();
  function rateLimit(key) {
    const now = Date.now();
    const e = rateMap.get(key);
    if (!e || now - e.start > RATE_WINDOW_MS) {
      rateMap.set(key, { start: now, count: 1 });
      return false;
    }
    e.count++;
    if (rateMap.size > 5000) rateMap.clear();
    return e.count > RATE_MAX;
  }

  // ---------- security headers on every response ----------
  const SEC_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };

  // ---------- Telegram initData verification (hardened) ----------
  // initData is "key=value&key2=value2&hash=<hex>"; hash is HMAC-SHA256 of
  // query-string-minus-hash with key = HMAC-SHA256(bot_token, "WebAppData").
  const MAX_INITDATA_AGE_MS = 60 * 60 * 1000; // reject initData older than 1h (replay protection)
  function timingSafeEqualHex(a, b) {
    try {
      const ba = Buffer.from(a, 'hex');
      const bb = Buffer.from(b, 'hex');
      if (ba.length !== bb.length) return false;
      return crypto.timingSafeEqual(ba, bb);
    } catch { return false; }
  }

  function verifyInitData(raw) {
    try {
      if (!raw || !BOT_TOKEN) return null;
      const params = new URLSearchParams(raw);
      const hash = params.get('hash');
      if (!hash) return null;
      params.delete('hash');
      const dataCheckString = [...params.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join('\n');
      const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
      const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
      if (!timingSafeEqualHex(computed, hash)) return null;
      // replay protection: auth_date must be recent
      const authDate = parseInt(params.get('auth_date') || '0', 10);
      if (!authDate || Date.now() / 1000 - authDate > MAX_INITDATA_AGE_MS / 1000) return null;
      const user = params.get('user');
      if (!user) return null;
      const u = JSON.parse(user);
      if (!u.id) return null;
      return { id: Number(u.id), username: u.username || '', firstName: u.first_name || '' };
    } catch {
      return null;
    }
  }

  function requireMember(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (rateLimit('init:' + ip)) return { error: 429, msg: 'rate limited' };
    const initData = req.headers['x-telegram-init-data'] || '';
    const u = verifyInitData(initData);
    if (!u) return { error: 401, msg: 'unauthorized' };
    if (rateLimit('user:' + u.id)) return { error: 429, msg: 'rate limited' };
    return { user: u };
  }

  function requireAdmin(req) {
    const m = requireMember(req);
    if (m.error) return m;
    if (!state.isAdmin(m.user.id)) return { error: 403, msg: 'forbidden: owner/admin only' };
    return { user: m.user };
  }

  function requireOwner(req) {
    const m = requireMember(req);
    if (m.error) return m;
    if (!state.isOwner(m.user.id)) return { error: 403, msg: 'forbidden: owner only' };
    return { user: m.user };
  }

  // Bearer-secret auth for bot <-> control-plane calls.
  function requireSecret(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    if (rateLimit('secret:' + ip)) return { error: 429, msg: 'rate limited' };
    const auth = req.headers['authorization'] || '';
    if (!REPORT_SECRET || auth.length !== `Bearer ${REPORT_SECRET}`.length) return { error: 401, msg: 'unauthorized' };
    if (!timingSafeEqualHex(Buffer.from(auth.slice(7)).toString('hex'), Buffer.from(REPORT_SECRET).toString('hex'))) {
      return { error: 401, msg: 'unauthorized' };
    }
    return { ok: true };
  }

  // ---------- response helpers ----------
  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { ...SEC_HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function readBody(req, limit = 1_000_000) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // ---------- config regeneration + push ----------
  async function regenerateAndPush(reason) {
    try {
      const s = state.state;
      const active = s.settings.defaultModelId;
      const runtime = {
        mode: 'api',
        activeModelId: active,
        providers: s.providers.map(p => ({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          enabled: p.enabled,
          keys: (p.keys || []).map(k => ({ id: k.id, value: k.value })),
        })),
        models: s.models.map(m => ({
          id: m.id, providerId: m.providerId, upstreamId: m.upstreamId,
          label: m.label, enabled: m.enabled, temperature: m.temperature,
          systemPrompt: m.systemPrompt,
        })),
        settings: {
          showThinking: s.settings.showThinking,
          thinkingPreviewChars: s.settings.thinkingPreviewChars,
          maxHistoryTurns: s.settings.maxHistoryTurns,
          allowGroups: s.settings.allowGroups,
          defaultSystemPrompt: s.settings.defaultSystemPrompt,
          defaultModelId: active,
        },
        reportUrl: detectReportUrl(),
        reportSecret: REPORT_SECRET,
        configEpoch: s.configEpoch,
      };
      const file = 'export const runtimeConfig = ' + JSON.stringify(runtime, null, 2) + ';\n';
      fs.writeFileSync(path.join(botDir, 'tgcloud', 'lib', 'runtime-config.js'), file);
      // The bot pulls live config from /api/runtime-config, so the push is
      // only a fallback — fire it in the background so the API replies fast.
      if (tgCloudPush) {
        console.log(`[control] config regenerated (epoch ${s.configEpoch}) — pushing bot in background… ${reason}`);
        Promise.resolve(tgCloudPush()).catch(() => {});
      } else {
        console.log(`[control] config regenerated (epoch ${s.configEpoch}) — push disabled ${reason}`);
      }
      return true;
    } catch (e) {
      throw new Error('regenerate failed: ' + String(e?.message || e).slice(0, 200));
    }
  }

  function detectReportUrl() {
    return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN || '').replace(/\/+$/, '');
  }

  // ---------- body parser for POSTs ----------
  async function jsonBody(req) {
    const raw = await readBody(req);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new Error('invalid JSON'); }
  }

  // ---------- route handler ----------
  async function handle(u, req, res) {
    const method = req.method || 'GET';
    const p = u.pathname;

    // static panel
    if (p === '/panel' || p === '/panel/') {
      return serveStatic(res, path.join(PANEL_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (p.startsWith('/panel/')) {
      const rel = p.slice('/panel/'.length);
      const abs = path.join(PANEL_DIR, rel);
      if (abs.startsWith(PANEL_DIR) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const ext = path.extname(abs);
        const type = ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'text/html; charset=utf-8';
        return serveStatic(res, abs, type);
      }
      return serveStatic(res, path.join(PANEL_DIR, 'index.html'), 'text/html; charset=utf-8');
    }

    // ---- bot reporting (server-to-server) ----
    if (p === '/api/report' && method === 'POST') {
      const sa = requireSecret(req);
      if (sa.error) return json(res, sa.error, { error: sa.msg });
      try {
        const body = await jsonBody(req);
        // body: { uid, username, firstName, provider, model, tokensIn, tokensOut,
        //         charIn, charOut, status, preview }
        if (body.uid != null) {
          state.touchUser(body.uid, body);
          state.addLog({
            uid: body.uid,
            username: body.username || '',
            provider: body.provider || '',
            keyId: body.keyId || '',
            model: body.model || '',
            promptChars: body.charIn || 0,
            outputChars: body.charOut || 0,
            tokensIn: body.tokensIn || 0,
            tokensOut: body.tokensOut || 0,
            status: body.status || 'ok',
            preview: body.preview ? String(body.preview).slice(0, 300) : '',
          });
        }
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e).slice(0, 200) });
      }
    }

    // ---- bot runtime config (server-to-server, real keys) ----
    if (p === '/api/runtime-config' && method === 'GET') {
      const sa = requireSecret(req);
      if (sa.error) return json(res, sa.error, { error: sa.msg });
      const s = state.state;
      return json(res, 200, {
        mode: 'api',
        activeModelId: s.settings.defaultModelId,
        providers: s.providers.map(p => ({
          id: p.id,
          name: p.name,
          baseUrl: p.baseUrl,
          enabled: p.enabled,
          keys: (p.keys || []).map(k => ({ id: k.id, value: k.value })),
        })),
        models: s.models.map(m => ({
          id: m.id, providerId: m.providerId, upstreamId: m.upstreamId,
          label: m.label, enabled: m.enabled, temperature: m.temperature,
          systemPrompt: m.systemPrompt,
        })),
        settings: {
          showThinking: s.settings.showThinking,
          thinkingPreviewChars: s.settings.thinkingPreviewChars,
          maxHistoryTurns: s.settings.maxHistoryTurns,
          allowGroups: s.settings.allowGroups,
          defaultSystemPrompt: s.settings.defaultSystemPrompt,
          defaultModelId: s.settings.defaultModelId,
        },
        configEpoch: s.configEpoch,
      });
    }

    // ---- bot command API (server-to-server, Bearer secret) ----
    // Used by the in-bot /admin commands. Same store as the panel.
    if (p.startsWith('/api/bot/') && method === 'POST') {
      const sa = requireSecret(req);
      if (sa.error) return json(res, sa.error, { error: sa.msg });
      try {
        const b = await jsonBody(req);
        const op = p.slice('/api/bot/'.length);
        switch (op) {
          case 'providers': return json(res, 200, { providers: state.listProvidersSafe() });
          case 'providers/add': return json(res, 200, { provider: state.addProvider(b) });
          case 'providers/remove': return json(res, 200, { provider: state.removeProvider(b.id) });
          case 'providers/toggle': return json(res, 200, { provider: state.toggleProvider(b.id, b.enabled) });
          case 'keys/add': return json(res, 200, { key: state.addKey(b.id, b.key) });
          case 'keys/remove': { const p = state.removeKey(b.id, b.keyId); return json(res, 200, { provider: p ? state.maskProvider(p) : null }); }
          case 'models': return json(res, 200, { models: state.listModels(), activeModelId: state.state.settings.defaultModelId });
          case 'models/add': return json(res, 200, { model: state.addModel(b) });
          case 'models/remove': return json(res, 200, { model: state.removeModel(b.id) });
          case 'models/active': return json(res, 200, { model: state.setActiveModel(b.id) });
          case 'models/toggle': return json(res, 200, { model: state.toggleModel(b.id, b.enabled) });
          case 'models/prompt': return json(res, 200, { model: state.setModelPrompt(b.id, b.prompt) });
          case 'models/temperature': return json(res, 200, { model: state.setModelTemperature(b.id, b.temperature) });
          case 'admins': return json(res, 200, { owner: state.state.ownerId, admins: state.listAdmins() });
          case 'admins/add': return json(res, 200, { admins: state.addAdmin(b.id, b.username || '') });
          case 'admins/remove': return json(res, 200, { admins: state.removeAdmin(b.id) });
          case 'settings': return json(res, 200, { settings: state.state.settings });
          case 'settings/set': return json(res, 200, { settings: state.setSetting(b.key, b.value) });
          case 'users': return json(res, 200, { users: state.topUsers(b.limit || 20), total: Object.keys(state.state.users).length });
          case 'user': return json(res, 200, { user: state.state.users[Number(b.uid)] || null, logs: state.userLogs(b.uid, 50) });
          case 'logs': return json(res, 200, { logs: state.state.logs.slice(-(b.limit || 50)).reverse() });
          case 'stats': {
            const users = Object.values(state.state.users);
            const sum = fn => users.reduce((a, u) => a + (fn(u) || 0), 0);
            return json(res, 200, { totalUsers: users.length, totalMessages: sum(u => u.messages), totalTokensIn: sum(u => u.tokensIn), totalTokensOut: sum(u => u.tokensOut), totalLogs: state.state.logs.length });
          }
          case 'state': {
            const snap = state.snapshot();
            return json(res, 200, snap);
          }
          default: return json(res, 404, { error: 'unknown op' });
        }
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e).slice(0, 200) });
      }
    }

    // ---- panel API (auth-gated) ----
    if (p.startsWith('/api/')) {
      const auth = requireAdmin(req);
      if (auth.error) return json(res, auth.error, { error: auth.msg });

      const m = method === 'POST' ? { handler: async () => { const b = await jsonBody(req); return b; } } : null;

      try {
        // GET snapshot
        if (p === '/api/state' && method === 'GET') {
          const snap = state.snapshot();
          snap.role = state.roleOf(auth.user.id);
          return json(res, 200, snap);
        }

        // members (owner + admins) for display
        if (p === '/api/members' && method === 'GET') {
          return json(res, 200, { owner: state.state.ownerId, admins: state.listAdmins() });
        }

        // ---- admins (OWNER ONLY) ----
        if (p === '/api/admins/add' && method === 'POST') {
          if (!state.isOwner(auth.user.id)) return json(res, 403, { error: 'owner only' });
          const b = await jsonBody(req);
          const admins = state.addAdmin(b.id, b.username || '');
          await regenerateAndPush('admin added');
          return json(res, 200, { admins });
        }
        if (p === '/api/admins/remove' && method === 'POST') {
          if (!state.isOwner(auth.user.id)) return json(res, 403, { error: 'owner only' });
          const b = await jsonBody(req);
          const admins = state.removeAdmin(b.id);
          await regenerateAndPush('admin removed');
          return json(res, 200, { admins });
        }

        // ---- providers ----
        if (p === '/api/providers' && method === 'GET') {
          return json(res, 200, { providers: state.listProvidersSafe() });
        }
        if (p === '/api/providers/add' && method === 'POST') {
          const b = await jsonBody(req);
          const provider = state.addProvider(b);
          await regenerateAndPush('provider added');
          return json(res, 200, { provider });
        }
        if (p === '/api/providers/remove' && method === 'POST') {
          const b = await jsonBody(req);
          const provider = state.removeProvider(b.id);
          await regenerateAndPush('provider removed');
          return json(res, 200, { provider });
        }
        if (p === '/api/providers/toggle' && method === 'POST') {
          const b = await jsonBody(req);
          const provider = state.toggleProvider(b.id, b.enabled);
          await regenerateAndPush('provider toggled');
          return json(res, 200, { provider });
        }
        if (p === '/api/providers/keys/add' && method === 'POST') {
          const b = await jsonBody(req);
          const key = state.addKey(b.id, b.key);
          await regenerateAndPush('key added');
          return json(res, 200, { key });
        }
        if (p === '/api/providers/keys/remove' && method === 'POST') {
          const b = await jsonBody(req);
          const provider = state.removeKey(b.id, b.keyId);
          await regenerateAndPush('key removed');
          return json(res, 200, { provider: provider ? state.maskProvider(provider) : null });
        }

        // ---- models ----
        if (p === '/api/models' && method === 'GET') {
          return json(res, 200, { models: state.listModels(), activeModelId: state.state.settings.defaultModelId });
        }
        if (p === '/api/models/add' && method === 'POST') {
          const b = await jsonBody(req);
          const model = state.addModel(b);
          await regenerateAndPush('model added');
          return json(res, 200, { model });
        }
        if (p === '/api/models/remove' && method === 'POST') {
          const b = await jsonBody(req);
          const model = state.removeModel(b.id);
          await regenerateAndPush('model removed');
          return json(res, 200, { model });
        }
        if (p === '/api/models/active' && method === 'POST') {
          const b = await jsonBody(req);
          const model = state.setActiveModel(b.id);
          await regenerateAndPush('active model changed');
          return json(res, 200, { model });
        }
        if (p === '/api/models/toggle' && method === 'POST') {
          const b = await jsonBody(req);
          const model = state.toggleModel(b.id, b.enabled);
          await regenerateAndPush('model toggled');
          return json(res, 200, { model });
        }
        if (p === '/api/models/prompt' && method === 'POST') {
          const b = await jsonBody(req);
          const model = state.setModelPrompt(b.id, b.prompt);
          await regenerateAndPush('model prompt updated');
          return json(res, 200, { model });
        }
        if (p === '/api/models/temperature' && method === 'POST') {
          const b = await jsonBody(req);
          const model = state.setModelTemperature(b.id, b.temperature);
          await regenerateAndPush('model temperature updated');
          return json(res, 200, { model });
        }

        // ---- settings ----
        if (p === '/api/settings' && method === 'GET') {
          return json(res, 200, { settings: state.state.settings });
        }
        if (p === '/api/settings/set' && method === 'POST') {
          const b = await jsonBody(req);
          const settings = state.setSetting(b.key, b.value);
          await regenerateAndPush('settings changed');
          return json(res, 200, { settings });
        }

        // ---- analytics ----
        if (p === '/api/users' && method === 'GET') {
          return json(res, 200, { users: state.topUsers(50), total: Object.keys(state.state.users).length });
        }
        if (p.startsWith('/api/users/') && method === 'GET') {
          const uid = Number(p.split('/').pop());
          const user = state.state.users[uid];
          return json(res, 200, { user: user || null, logs: state.userLogs(uid, 100) });
        }
        if (p === '/api/logs' && method === 'GET') {
          const limit = parseInt(u.searchParams.get('limit') || '100', 10);
          return json(res, 200, { logs: state.state.logs.slice(-limit).reverse() });
        }
        if (p === '/api/stats' && method === 'GET') {
          const logs = state.state.logs;
          const users = Object.values(state.state.users);
          const sum = (fn) => users.reduce((a, u) => a + (fn(u) || 0), 0);
          return json(res, 200, {
            totalUsers: users.length,
            totalMessages: sum(u => u.messages),
            totalTokensIn: sum(u => u.tokensIn),
            totalTokensOut: sum(u => u.tokensOut),
            totalChars: sum(u => u.charIn + u.charOut),
            totalLogs: logs.length,
            lastLog: logs.length ? new Date(logs[logs.length - 1].ts).toISOString() : null,
          });
        }

        return json(res, 404, { error: 'not found' });
      } catch (e) {
        return json(res, 400, { error: String(e?.message || e).slice(0, 200) });
      }
    }

    return json(res, 404, { error: 'not found' });
  }

  function serveStatic(res, file, type) {
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { ...SEC_HEADERS, 'Content-Type': type, 'Content-Length': data.length });
      res.end(data);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }

  return { handle };
}
