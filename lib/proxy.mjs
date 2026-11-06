// Upstream client for chat.inceptionlabs.ai
// Endpoint (from open-source implementations + site UI): POST /api/chat/completions
// Auth: Authorization: Bearer <jwt> (+ Cookie: token=<jwt>)
// Streaming: SSE lines "data: <json>" ... "data: [DONE]"

import { randomUUID } from 'node:crypto';
import { effortFromBody } from './effort.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://chat.inceptionlabs.ai';
const COMPLETIONS_URL = `${BASE}/api/chat`;
const SESSION_URL = `${BASE}/api/session`;
const CHATS_NEW_URL = `${BASE}/api/v1/chats/new`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export function loadCreds(credsPath) {
  const p = credsPath || path.join(__dirname, '..', 'creds.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : data.active || [];
    return arr.filter(a => a && a.bearer);
  } catch { return []; }
}

function headersFor(account, extra = {}) {
  const cookieStr = account.cookies
    ? Object.entries(account.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    : '';
  const h = {
    'Accept': '*/*',
    'Content-Type': 'application/json',
    'Origin': BASE,
    'Referer': `${BASE}/`,
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Sec-CH-UA': '"Chromium";v="156", "Not/A)Brand";v="8"',
    'Sec-CH-UA-Mobile': '?1',
    'Sec-CH-UA-Platform': '"Android"',
    ...extra,
  };
  if (account.sessionToken) h['x-session-token'] = account.sessionToken;
  else if (account.bearer) h['Authorization'] = `Bearer ${account.bearer}`;
  if (cookieStr) h['Cookie'] = cookieStr;
  if (process.env.INCEPTION_COOKIE) h['Cookie'] = process.env.INCEPTION_COOKIE;
  return h;
}

export async function getSessionToken(account) {
  const r = await fetch(SESSION_URL, {
    headers: headersFor(account),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`session HTTP ${r.status} ${txt.slice(0, 200)}`);
  }
  const j = await r.json().catch(() => ({}));
  return j.token || '';
}

export async function newChatId(account) {
  const payload = {
    chat: {
      id: '',
      title: 'bench',
      models: ['mercury'],
      params: {},
      history: { messages: {}, currentId: null },
      messages: [],
      tags: [],
      timestamp: Date.now(),
    },
  };
  const r = await fetch(CHATS_NEW_URL, {
    method: 'POST',
    headers: headersFor(account),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`chats/new HTTP ${r.status} ${await r.text().catch(() => '')}`);
  const j = await r.json().catch(() => ({}));
  if (!j.id) throw new Error('chats/new: no id in response');
  return j.id;
}

// Extra OpenAI-style params we forward to the site's /api/chat when present.
const PASSTHROUGH = [
  'temperature', 'top_p', 'max_tokens', 'min_p', 'stop',
  'presence_penalty', 'frequency_penalty', 'seed', 'repetition_penalty',
  'diffusing',
];

export function buildEnvelope(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const conv = m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    parts: Array.isArray(m.content)
      ? m.content.map(p => ({ type: p.type || 'text', text: typeof p === 'string' ? p : (p.text ?? p.content ?? '') }))
      : [{ type: 'text', text: String(m.content ?? '') }],
  });
  let model = body.model || 'mercury';
  const env = {
    model,
    messages: messages.map(conv),
    stream: !!body.stream,
    id: randomUUID(),
    messageId: randomUUID(),
    trigger: 'submit-message',
  };
  // model alias: mercury-thinking -> mercury with reasoning on
  if (/^(mercury[\w-]*)[\-_]thinking$/i.test(model)) {
    env.model = model.replace(/[\-_]thinking$/i, '');
  }
  for (const k of PASSTHROUGH) {
    if (body[k] !== undefined && env[k] === undefined) env[k] = body[k];
  }
  // reasoning effort -> the four levels the upstream actually supports
  const effort = effortFromBody(body, model);
  if (effort) env.reasoning_effort = effort;
  // OpenAI renamed max_tokens -> max_completion_tokens; the site knows max_tokens
  if (env.max_tokens === undefined && body.max_completion_tokens !== undefined) {
    env.max_tokens = body.max_completion_tokens;
  }
  return env;
}

// streamChunks returns an async generator of {event, data|error, raw}
export async function* upstreamStream(account, payload, opts = {}) {
  const r = await fetch(COMPLETIONS_URL, {
    method: 'POST',
    headers: headersFor(account),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(opts.timeoutMs || 180000),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    const mitigated = r.headers.get('x-vercel-mitigated');
    const isChallenge = r.status === 429 && (mitigated === 'challenge' || errText.includes('Vercel Security Checkpoint'));
    if (isChallenge) {
      yield { event: 'challenge', status: 429, body: errText, raw: null };
      return;
    }
    yield { event: 'error', status: r.status, body: errText, raw: null };
    return;
  }

  const ctype = r.headers.get('content-type') || '';
  const isSSE = ctype.includes('text/event-stream') || ctype.includes('text/plain');
  const reader = r.body?.getReader();
  if (!reader) {
    yield { event: 'error', status: 500, body: 'no response body', raw: null };
    return;
  }

  const decoder = new TextDecoder();
  let buf = '';
  let sse = isSSE;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // We may not know it is SSE until first line; sniff.
    if (!sse) {
      const trimmed = buf.trimStart();
      if (trimmed.startsWith('data:')) sse = true;
    }

    if (!sse) {
      // Non-SSE: could be a single JSON doc; only emit when buffering ends.
      // We still stream nothing until end for non-stream; handled by caller
      // by collecting all lines. (We keep line mode to be safe.)
      yield { event: 'raw', data: buf, raw: buf };
      buf = '';
      continue;
    }

    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const content = line.slice(5).trim();
      if (content === '[DONE]') {
        yield { event: 'done', raw: '[DONE]' };
        continue;
      }
      if (!content) continue;
      try {
        const parsed = JSON.parse(content);
        yield { event: 'chunk', data: parsed, raw: content };
      } catch {
        yield { event: 'malformed', raw: content };
      }
    }
  }

  if (!sse && buf.trim()) {
    yield { event: 'raw', data: buf, raw: buf };
  }
  yield { event: 'eof', raw: null };
}

// One completion turn: returns {status, payload, chunks} or throws on non-recoverable errors.
export async function completeOnce(account, body) {
  // obtain the app session token (x-session-token) if we don't have one yet
  if (!account.sessionToken) {
    try {
      account.sessionToken = await getSessionToken(account);
    } catch (e) {
      return { status: 502, payload: null, chunks: [], errBody: `session: ${String(e.message).slice(0, 300)}` };
    }
  }
  const payload = buildEnvelope(body);
  const chunks = [];
  let status = 200;
  let errBody = '';
  for await (const ev of upstreamStream(account, payload)) {
    if (ev.event === 'error' || ev.event === 'challenge') {
      status = ev.status;
      errBody = ev.event === 'challenge' ? 'vercel-challenge' : ev.body;
      break;
    }
    if (ev.event === 'chunk' || ev.event === 'raw') chunks.push(ev.data);
  }
  return { status, payload, chunks, errBody };
}
