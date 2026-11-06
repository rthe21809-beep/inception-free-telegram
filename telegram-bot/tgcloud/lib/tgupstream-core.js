// Pure protocol helpers for the direct Inception upstream — no SDK imports,
// so this module is fully testable offline (see test-tgupstream.mjs).

const BASE = 'https://chat.inceptionlabs.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const COMPLETIONS_URL = `${BASE}/api/chat`;
export const SESSION_URL = `${BASE}/api/session`;

export function headersFor(account, extra = {}) {
  const cookieStr = account.cookies
    ? Object.entries(account.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';
  return {
    Accept: '*/*',
    'Content-Type': 'application/json',
    Origin: BASE,
    Referer: `${BASE}/`,
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(account.bearer ? { Authorization: `Bearer ${account.bearer}` } : {}),
    ...(cookieStr ? { Cookie: cookieStr } : {}),
    ...extra,
  };
}

export function rfid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function buildEnvelope(messages) {
  const conv = m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    parts: Array.isArray(m.content)
      ? m.content.map(p => ({ type: p.type || 'text', text: typeof p === 'string' ? p : (p.text ?? p.content ?? '') }))
      : [{ type: 'text', text: String(m.content ?? '') }],
  });
  return {
    model: 'mercury',
    messages: (messages || []).map(conv),
    stream: false,
    id: rfid(),
    messageId: rfid(),
    trigger: 'submit-message',
    reasoning_effort: 'medium',
  };
}

/** Extract {content, reasoning} from one upstream chunk (any shape). */
export function extractDelta(chunk) {
  if (!chunk || typeof chunk !== 'object') return { content: '', reasoning: '' };
  const out = { content: '', reasoning: '' };
  if (chunk.choices?.[0]) {
    const m = chunk.choices[0].delta ?? chunk.choices[0].message;
    if (m && typeof m === 'object') {
      if (m.content || m.text) out.content = String(m.content ?? m.text ?? '');
      if (m.reasoning_content || m.reasoning) out.reasoning = String(m.reasoning_content ?? m.reasoning ?? '');
    }
    return out;
  }
  const d = chunk.delta ?? chunk.text ?? chunk.content;
  const t = typeof d === 'string' ? d : (d?.text ?? d?.content ?? '');
  if (chunk.type === 'reasoning-delta' || chunk.type === 'thinking-delta' || chunk.type === 'reasoning' || chunk.type === 'thinking' || chunk.type === 'reasoning-start') {
    out.reasoning = String(t || '');
  } else if (t) {
    out.content = String(t);
  }
  if (!out.content && !out.reasoning) {
    if (chunk.reasoning_content || chunk.reasoning) out.reasoning = String(chunk.reasoning_content ?? chunk.reasoning ?? '');
  }
  return out;
}

/** Parse a chat response body into {content, reasoning, status}. */
export function parseChatBody(text) {
  const out = { content: '', reasoning: '', status: 200 };
  if (!text) return out;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('data:')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const { content, reasoning } = extractDelta(JSON.parse(payload));
        out.content += content;
        out.reasoning += reasoning;
      } catch { /* skip malformed */ }
    }
    return out;
  }
  try {
    const j = JSON.parse(text);
    if (j.choices?.[0]) {
      const m = j.choices[0].message || {};
      out.content = String(m.content || '');
      out.reasoning = String(m.reasoning_content || m.reasoning || '');
    } else {
      const d = extractDelta(j);
      out.content = d.content;
      out.reasoning = d.reasoning;
    }
  } catch { /* non-JSON */ }
  return out;
}
