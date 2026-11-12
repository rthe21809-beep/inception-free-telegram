// Multi-provider OpenAI-compatible client.
//
// Supports any provider that implements the OpenAI /chat/completions schema
// (official Inception API, OpenAI, Anthropic-compatible gateways, local
// vLLM/ollama bridges, etc.). Keys are rotated round-robin per provider, and
// providers/models are selected from the control-plane runtime config.

function err(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * Ask a provider/model. `cfg` is the merged runtime config (must include
 * `providers`, `models`, `activeModelId`, plus shared settings).
 * Returns { content, reasoning, tokensIn, tokensOut, provider, keyId }.
 */
export async function askProvider(messages, cfg) {
  const models = cfg.models || [];
  const providers = cfg.providers || [];
  const activeId = cfg.activeModelId || cfg.settings?.defaultModelId || models.find(m => m.enabled)?.id;
  const model = models.find(m => m.id === activeId && m.enabled) || models.find(m => m.enabled);
  if (!model) throw err('NO_MODEL', 'No enabled model is configured.');
  const provider = providers.find(p => p.id === model.providerId && p.enabled);
  if (!provider) throw err('NO_PROVIDER', `Provider for model "${model.id}" is missing or disabled.`);
  const keys = (provider.keys || []).filter(k => k && k.value);
  if (!keys.length) throw err('NO_API_KEY', `Provider "${provider.name}" has no API keys.`);

  // round-robin across keys
  const idx = (provider._rr = (provider._rr || 0) + 1) % keys.length;
  const key = keys[idx];

  const systemPrompt = model.systemPrompt || cfg.settings?.defaultSystemPrompt || cfg.systemPrompt || '';
  const msgs = [];
  if (systemPrompt) msgs.push({ role: 'system', content: systemPrompt });
  msgs.push(...messages.filter(m => m.role !== 'system'));
  if (!msgs.length) msgs.push({ role: 'user', content: 'Hello' });

  const baseUrl = String(provider.baseUrl || '').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/chat/completions`;
  const body = {
    model: model.upstreamId || model.id,
    messages: msgs,
    temperature: model.temperature ?? cfg.settings?.temperature,
  };
  if (model.maxTokens) body.max_tokens = model.maxTokens;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 60000);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key.value}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw err('API_TIMEOUT', `Provider timed out after ${(cfg.timeoutMs || 60000) / 1000}s.`);
    throw err('API_NETWORK', `Network error to ${provider.name}: ${String(e?.message || e).slice(0, 160)}`);
  } finally {
    clearTimeout(t);
  }

  if (res.status === 401 || res.status === 403) {
    throw err('API_AUTH', `Provider "${provider.name}" rejected the API key (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw err('API_ERROR', `Provider "${provider.name}" returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try { data = await res.json(); } catch { throw err('API_ERROR', 'Provider returned non-JSON response.'); }

  const choice = data?.choices?.[0];
  const content = (choice?.message?.content) || (choice?.message?.reasoning_content) || choice?.text || '';
  const reasoning = choice?.message?.reasoning_content || choice?.reasoning || '';
  const usage = data?.usage || {};
  return {
    content: String(content || ''),
    reasoning: String(reasoning || ''),
    tokensIn: usage.prompt_tokens || 0,
    tokensOut: usage.completion_tokens || 0,
    provider: provider.id,
    keyId: key.id,
  };
}

/**
 * Pick the first *enabled* model that belongs to an enabled provider. Used by
 * the bot to validate config at startup / for /model.
 */
export function activeModel(cfg) {
  const models = cfg.models || [];
  const activeId = cfg.activeModelId || cfg.settings?.defaultModelId;
  return models.find(m => m.id === activeId && m.enabled) || models.find(m => m.enabled) || null;
}
