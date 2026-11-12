// Loads the bot's runtime configuration from the control plane at runtime,
// so the owner can add API keys / providers / models from the admin panel
// without redeploying the bot. Falls back to the embedded runtime-config.js
// (or nothing) when the control plane is unreachable.

import { runtimeConfig } from './runtime-config.js';

let cache = { t: 0, cfg: null };

const TTL_MS = 20000; // re-check at most every 20s

export async function fetchLiveConfig({ url, secret, fetchImpl } = {}) {
  const u = String(url || '').replace(/\/+$/, '');
  if (!u || !secret) return null;

  const now = Date.now();
  if (cache.cfg && now - cache.t < TTL_MS) return cache.cfg;

  try {
    const res = await (fetchImpl || fetch)(`${u}/api/runtime-config`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    cache = { t: now, cfg: data };
    return data;
  } catch (e) {
    console.warn('[live-config] fetch failed:', String(e?.message || e).slice(0, 120));
    return cache.cfg || null;
  }
}

// Build a fully merged config object (defaults <- runtime-config.js <- live).
export function mergeConfig(cfg, live) {
  const out = { ...cfg };
  const rt = live || runtimeConfig || {};
  const settings = rt.settings || {};

  if (rt.mode) out.mode = rt.mode;
  if (Array.isArray(rt.providers)) out.providers = rt.providers;
  if (Array.isArray(rt.models)) out.models = rt.models;
  if (rt.activeModelId) out.activeModelId = rt.activeModelId;
  if (settings.defaultModelId) out.activeModelId = out.activeModelId || settings.defaultModelId;
  if (settings.showThinking != null) out.showThinking = !!settings.showThinking;
  if (settings.thinkingPreviewChars != null) out.thinkingPreviewChars = settings.thinkingPreviewChars;
  if (settings.maxHistoryTurns != null) out.maxHistoryTurns = settings.maxHistoryTurns;
  if (settings.allowGroups != null) out.allowGroups = !!settings.allowGroups;
  if (settings.defaultSystemPrompt) out.systemPrompt = settings.defaultSystemPrompt;
  return out;
}
