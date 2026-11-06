// Bridge client — talks to inception-free-bridge's OpenAI-compatible API
// over outbound HTTP. The fetch/Response objects come from the Telegram
// Serverless SDK (`sdk/fetch`), which mirrors the web platform shapes.

import { fetch } from 'sdk';

export async function askBridge(messages, cfg) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), cfg.timeoutMs || 55000)
    : null;
  let res;
  try {
    res = await fetch(`${cfg.bridgeBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.bridgeApiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model || 'mercury-3',
        messages,
        stream: false,
      }),
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    throw new Error(`bridge request failed: ${String(err?.message || err).slice(0, 160)}`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    throw new Error(`bridge HTTP ${res.status}: ${String(body || '').slice(0, 200)}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  const message = choice?.message || {};
  return {
    content: String(message.content || '').trim(),
    reasoning: String(message.reasoning_content || message.reasoning || '').trim(),
  };
}
