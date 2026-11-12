// Official Inception API client — runs inside the Telegram Serverless
// sandbox.
//
// Why this mode exists: the free *web chat* sits behind a Vercel security
// checkpoint whose solver needs a real browser, which a serverless sandbox
// (and often a datacenter IP) cannot pass reliably. The official API has no
// checkpoint at all — it is a plain OpenAI-compatible endpoint, and every
// account includes 100M free tokens.
//
//   POST https://api.inceptionlabs.ai/v1/chat/completions
//   Authorization: Bearer <INCEPTION_API_KEY>
//
// With this mode the bot needs NO session collector at all: the handler
// calls the API directly from Telegram's infrastructure.

import { fetch } from 'sdk';

const API_URL = 'https://api.inceptionlabs.ai/v1/chat/completions';

export async function askInceptionApi(messages, cfg) {
  if (!cfg.inceptionApiKey) {
    const err = new Error('no INCEPTION_API_KEY configured');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 55000);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.inceptionApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model || 'mercury-3',
        messages,
        reasoning_effort: cfg.reasoningEffort || 'medium',
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const e = new Error(`inception api request failed: ${String(err?.message || err).slice(0, 160)}`);
    e.code = 'API_NETWORK';
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const e = new Error(`inception api HTTP ${res.status}: ${text.slice(0, 200)}`);
    e.code = res.status === 401 ? 'API_AUTH' : 'API_ERROR';
    throw e;
  }

  let data;
  try { data = JSON.parse(text); } catch {
    const e = new Error('inception api returned a non-JSON body');
    e.code = 'API_ERROR';
    throw e;
  }
  const message = data?.choices?.[0]?.message || {};
  return {
    content: String(message.content || '').trim(),
    reasoning: String(message.reasoning_content || message.reasoning || '').trim(),
  };
}
