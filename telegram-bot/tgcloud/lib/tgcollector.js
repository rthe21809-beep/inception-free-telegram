// Client for the cloud session collector (telegram-bot/collector).
// The bot calls POST /refresh when its sessions are expired or challenged;
// the collector solves fresh ones and redeploys the bot automatically.

import { fetch } from 'sdk';

export async function refreshViaCollector(url, timeoutMs = 90000) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base) throw new Error('no collector url configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}/refresh`, { method: 'POST', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    throw new Error(`collector HTTP ${res.status}: ${String(body || '').slice(0, 160)}`);
  }
  return true;
}
