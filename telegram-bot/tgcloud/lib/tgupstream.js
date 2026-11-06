// Direct upstream client for chat.inceptionlabs.ai — runs entirely inside the
// Telegram Serverless sandbox (zero servers of your own).
//
// The site's Vercel checkpoint needs a real browser only to SOLVE it. Once
// solved, the resulting session (cookies + token) can be reused from any
// network, including Telegram's. Sessions are captured on your PC with
// tools/update-sessions.mjs and embedded in tgcloud/lib/sessions.js.

import { fetch } from 'sdk';
import { headersFor, buildEnvelope, parseChatBody, COMPLETIONS_URL, SESSION_URL } from './tgupstream-core.js';

async function getSessionToken(account) {
  const r = await fetch(SESSION_URL, { headers: headersFor(account) });
  if (!r.ok) throw new Error(`session HTTP ${r.status}`);
  const j = await r.json().catch(() => ({}));
  return j.token || '';
}

async function chatOnce(account, messages) {
  const token = await getSessionToken(account);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  let res;
  try {
    res = await fetch(COMPLETIONS_URL, {
      method: 'POST',
      headers: headersFor(account, token ? { 'x-session-token': token } : {}),
      body: JSON.stringify(buildEnvelope(messages)),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (res.status === 429 && (text.includes('Vercel') || res.headers.get?.('x-vercel-mitigated') === 'challenge')) {
      const err = new Error('upstream checkpoint challenge (429)');
      err.code = 'CHALLENGE';
      throw err;
    }
    const err = new Error(`upstream HTTP ${res.status}: ${text.slice(0, 160)}`);
    err.code = res.status === 401 ? 'AUTH' : 'UPSTREAM';
    throw err;
  }
  return parseChatBody(text);
}

/**
 * Ask Inception directly. Rotates sessions; returns {content, reasoning}.
 * Throws with a friendly message when every session fails.
 */
export async function askInceptionDirect(messages, cfg) {
  const sessions = (cfg.sessions || []).filter(s => s && (s.cookies || s.cookie) && Object.keys(s.cookies || s.cookie || {}).length);
  if (!sessions.length) {
    const err = new Error('no sessions configured — run tools/update-sessions.mjs on your PC and re-deploy');
    err.code = 'NO_SESSIONS';
    throw err;
  }
  const ttlMs = (cfg.sessionTtlHours || 6) * 3600 * 1000;
  const fresh = sessions.filter(s => !s.created_at || Date.now() - s.created_at * 1000 < ttlMs);
  const pool = fresh.length ? fresh : sessions; // fall back to stale rather than nothing
  let lastErr = null;
  for (let attempt = 0; attempt < Math.min(pool.length * 2, 6); attempt++) {
    const account = pool[attempt % pool.length];
    try {
      return await chatOnce(account, messages);
    } catch (err) {
      lastErr = err;
      if (err?.code === 'AUTH') continue; // rotate to another session
      if (err?.code === 'CHALLENGE') continue;
      throw err;
    }
  }
  const err = new Error(`all sessions failed (${String(lastErr?.message || lastErr).slice(0, 120)})`);
  err.code = 'SESSIONS_EXHAUSTED';
  throw err;
}
