// Control-plane state store for the admin panel.
//
// Single source of truth for the bot's configuration and analytics. Stored
// as JSON on the host (persistent volume recommended; ephemeral on free tiers
// but that only resets settings, never the bot itself).
//
// State shape:
// {
//   ownerId: 6940999328,
//   admins: [{ id, username, addedAt }],
//   settings: { showThinking, thinkingPreviewChars, maxHistoryTurns,
//               allowGroups, defaultSystemPrompt, defaultModelId },
//   providers: [{ id, name, baseUrl, enabled, createdAt,
//                 keys: [{ id, value, created, lastUsedAt, errors }] }],
//   models: [{ id, providerId, upstreamId, label, enabled, temperature,
//              systemPrompt, createdAt }],
//   users: { [uid]: { id, username, firstName, messages, tokensIn, tokensOut,
//                     charIn, charOut, lastSeen, firstSeen, providersUsed } },
//   logs: [{ ts, uid, username, provider, keyId, model, promptChars,
//            outputChars, tokensIn, tokensOut, status, preview }],
//   configEpoch: 0,       // bumped on every config change
//   lastConfigWrite: null,
// }

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE = {
  ownerId: 6940999328,
  admins: [],
  settings: {
    showThinking: true,
    thinkingPreviewChars: 400,
    maxHistoryTurns: 12,
    allowGroups: true,
    defaultSystemPrompt: 'You are a helpful assistant in a Telegram chat. Answer concisely.',
    defaultModelId: 'mercury-3',
  },
  providers: [],
  models: [],
  users: {},
  logs: [],
  configEpoch: 0,
  lastConfigWrite: null,
};

export class ControlState {
  constructor({ file, maxLogs = 5000 } = {}) {
    this.file = file;
    this.maxLogs = maxLogs;
    this.state = structuredClone(DEFAULT_STATE);
    this._load();
  }

  _load() {
    try {
      if (this.file && fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        this.state = { ...structuredClone(DEFAULT_STATE), ...parsed };
        if (this.state.settings) this.state.settings = { ...DEFAULT_STATE.settings, ...this.state.settings };
      }
    } catch (e) {
      console.error('[control-state] load failed:', String(e?.message || e).slice(0, 150));
    }
  }

  save() {
    try {
      if (this.file) fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('[control-state] save failed:', String(e?.message || e).slice(0, 150));
    }
  }

  // ---- identity ----
  isOwner(uid) { return Number(uid) === Number(this.state.ownerId); }
  isAdmin(uid) {
    return this.isOwner(uid) || this.state.admins.some(a => Number(a.id) === Number(uid));
  }
  roleOf(uid) {
    if (this.isOwner(uid)) return 'owner';
    if (this.isAdmin(uid)) return 'admin';
    return 'user';
  }

  // ---- helpers ----
  get(key) { return this.state[key]; }

  bumpEpoch() {
    this.state.configEpoch += 1;
    this.state.lastConfigWrite = new Date().toISOString();
    this.save();
  }

  sanitize() {
    // never leak API keys to panel clients where they're not needed
    const providers = this.state.providers.map(p => ({
      ...p,
      keys: (p.keys || []).map(k => ({ ...k, value: k.value ? `sk-…${k.value.slice(-4)}` : '' })),
    }));
    return { ...this.state, providers };
  }

  // ---- providers ----
  listProviders() { return this.state.providers; }

  findProvider(idOrName) {
    const s = String(idOrName);
    return this.state.providers.find(p => p.id === s || p.name.toLowerCase() === s.toLowerCase());
  }

  addProvider({ name, baseUrl, key } = {}) {
    if (!name || !baseUrl) throw new Error('name and baseUrl are required');
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'p-' + Date.now();
    if (this.findProvider(id)) throw new Error(`provider "${id}" already exists`);
    const provider = {
      id,
      name,
      baseUrl: String(baseUrl).replace(/\/+$/, ''),
      enabled: true,
      createdAt: new Date().toISOString(),
      keys: [],
    };
    const trimmedKey = String(key || '').trim();
    if (trimmedKey) provider.keys.push(this._newKey(trimmedKey));
    this.state.providers.push(provider);
    this.bumpEpoch();
    return provider;
  }

  removeProvider(idOrName) {
    const p = this.findProvider(idOrName);
    if (!p) throw new Error('provider not found');
    this.state.providers = this.state.providers.filter(x => x.id !== p.id);
    // drop its models
    this.state.models = this.state.models.filter(m => m.providerId !== p.id);
    this.bumpEpoch();
    return p;
  }

  toggleProvider(idOrName, enabled) {
    const p = this.findProvider(idOrName);
    if (!p) throw new Error('provider not found');
    p.enabled = enabled !== false;
    this.bumpEpoch();
    return p;
  }

  _newKey(value) {
    return {
      id: 'k' + Math.random().toString(36).slice(2, 10),
      value,
      created: new Date().toISOString(),
      lastUsedAt: null,
      errors: 0,
    };
  }

  addKey(idOrName, value) {
    const p = this.findProvider(idOrName);
    if (!p) throw new Error('provider not found');
    const v = String(value || '').trim();
    if (!v) throw new Error('key value is empty');
    const key = this._newKey(v);
    p.keys.push(key);
    this.bumpEpoch();
    return key;
  }

  removeKey(providerIdOrName, keyId) {
    const p = this.findProvider(providerIdOrName);
    if (!p) throw new Error('provider not found');
    const before = p.keys.length;
    p.keys = p.keys.filter(k => k.id !== String(keyId));
    if (p.keys.length === before) throw new Error('key not found');
    this.bumpEpoch();
    return p;
  }

  // ---- models ----
  listModels() { return this.state.models; }

  findModel(id) { return this.state.models.find(m => m.id === String(id)); }

  addModel({ id, providerId, upstreamId, label, systemPrompt, temperature }) {
    if (!id || !providerId) throw new Error('id and providerId are required');
    if (!this.findProvider(providerId)) throw new Error(`provider "${providerId}" not found`);
    if (this.findModel(id)) throw new Error(`model "${id}" already exists`);
    const model = {
      id: String(id),
      providerId: String(providerId),
      upstreamId: String(upstreamId || id),
      label: String(label || id),
      enabled: true,
      temperature: temperature != null ? Number(temperature) : undefined,
      systemPrompt: String(systemPrompt || ''),
      createdAt: new Date().toISOString(),
    };
    this.state.models.push(model);
    this.bumpEpoch();
    return model;
  }

  removeModel(id) {
    const m = this.findModel(id);
    if (!m) throw new Error('model not found');
    this.state.models = this.state.models.filter(x => x.id !== m.id);
    if (this.state.settings.defaultModelId === m.id) {
      const first = this.state.models.find(x => x.enabled);
      this.state.settings.defaultModelId = first ? first.id : '';
    }
    this.bumpEpoch();
    return m;
  }

  setActiveModel(id) {
    const m = this.findModel(id);
    if (!m || !m.enabled) throw new Error('model not found or disabled');
    this.state.settings.defaultModelId = m.id;
    this.bumpEpoch();
    return m;
  }

  toggleModel(id, enabled) {
    const m = this.findModel(id);
    if (!m) throw new Error('model not found');
    m.enabled = enabled !== false;
    if (!m.enabled && this.state.settings.defaultModelId === m.id) {
      const first = this.state.models.find(x => x.enabled && x.id !== m.id);
      this.state.settings.defaultModelId = first ? first.id : '';
    }
    this.bumpEpoch();
    return m;
  }

  setModelPrompt(id, prompt) {
    const m = this.findModel(id);
    if (!m) throw new Error('model not found');
    m.systemPrompt = String(prompt || '');
    this.bumpEpoch();
    return m;
  }

  setModelTemperature(id, temp) {
    const m = this.findModel(id);
    if (!m) throw new Error('model not found');
    m.temperature = temp != null ? Number(temp) : undefined;
    this.bumpEpoch();
    return m;
  }

  // ---- admins ----
  listAdmins() { return this.state.admins; }
  addAdmin(id, username = '') {
    const uid = Number(id);
    if (!uid) throw new Error('admin id required');
    if (this.isOwner(uid)) throw new Error('owner is already an admin');
    if (this.isAdmin(uid)) throw new Error('already an admin');
    this.state.admins.push({ id: uid, username: String(username || ''), addedAt: new Date().toISOString() });
    this.bumpEpoch();
    return this.state.admins;
  }
  removeAdmin(id) {
    const uid = Number(id);
    const before = this.state.admins.length;
    this.state.admins = this.state.admins.filter(a => Number(a.id) !== uid);
    if (this.state.admins.length === before) throw new Error('admin not found');
    this.bumpEpoch();
    return this.state.admins;
  }

  // ---- settings ----
  setSetting(key, value) {
    const s = this.state.settings;
    if (!(key in s)) throw new Error(`unknown setting "${key}"`);
    if (key === 'defaultModelId') return this.setActiveModel(value);
    if (key === 'maxHistoryTurns' || key === 'thinkingPreviewChars') {
      s[key] = parseInt(value, 10);
      if (!Number.isFinite(s[key])) throw new Error('expected a number');
    } else if (key === 'allowGroups' || key === 'showThinking') {
      s[key] = String(value) === 'true' || value === true || value === '1';
    } else {
      s[key] = String(value);
    }
    this.bumpEpoch();
    return s;
  }

  // ---- users / logs ----
  touchUser(uid, { username, firstName, provider, model, tokensIn, tokensOut, charIn, charOut, status }) {
    const id = Number(uid);
    const now = Date.now();
    let u = this.state.users[id];
    if (!u) {
      u = { id, username: username || '', firstName: firstName || '', messages: 0, tokensIn: 0, tokensOut: 0, charIn: 0, charOut: 0, lastSeen: now, firstSeen: now, providersUsed: {} };
      this.state.users[id] = u;
    }
    u.username = username || u.username;
    u.firstName = firstName || u.firstName;
    u.messages += 1;
    u.tokensIn += (tokensIn || 0);
    u.tokensOut += (tokensOut || 0);
    u.charIn += (charIn || 0);
    u.charOut += (charOut || 0);
    u.lastSeen = now;
    const pk = String(provider || 'unknown');
    u.providersUsed[pk] = (u.providersUsed[pk] || 0) + 1;
    this.save();
  }

  addLog(entry) {
    this.state.logs.push({ ts: Date.now(), ...entry });
    if (this.state.logs.length > this.maxLogs) this.state.logs.splice(0, this.state.logs.length - this.maxLogs);
    this.save();
  }

  userLogs(uid, limit = 50) {
    return this.state.logs.filter(l => Number(l.uid) === Number(uid)).slice(-limit).reverse();
  }

  topUsers(limit = 20) {
    return Object.values(this.state.users)
      .sort((a, b) => b.messages - a.messages)
      .slice(0, limit);
  }

  // Public snapshot used by the API (sanitized + derived).
  snapshot() {
    const s = this.sanitize();
    return {
      ownerId: s.ownerId,
      role: undefined, // filled by caller
      settings: s.settings,
      providers: s.providers,
      models: s.models,
      admins: s.admins,
      configEpoch: s.configEpoch,
    };
  }
}
