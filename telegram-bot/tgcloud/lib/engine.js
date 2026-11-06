// Core bot logic, platform-agnostic.
//
// `deps` lets the handler inject real SDK objects and tests inject mocks:
//
//   deps = {
//     api,            // Telegram Bot API (sendMessage, sendChatAction, …)
//     config,         // config overrides (defaults from ./config.js)
//     askBridge,      // async (messages, config) -> {content, reasoning}
//                     //   (default: lib/bridge.js using sdk fetch)
//     getHistory,     // async (chatId, limit) -> [{role, content}]
//     saveTurn,       // async (chatId, role, content) -> void
//   }
//
// No 'sdk' import at module top level, so this file loads anywhere — the
// default bridge client is lazy-imported only when actually used.

import { composeReply, helpText } from './format.js';
import { config as defaultConfig } from './config.js';

async function defaultAskBridge(messages, cfg) {
  if (cfg.mode === 'direct') {
    // zero-server mode: talk straight to chat.inceptionlabs.ai from the
    // Telegram sandbox, using embedded sessions
    const { askInceptionDirect } = await import('./tgupstream.js');
    return askInceptionDirect(messages, cfg);
  }
  const { askBridge } = await import('./bridge.js');
  return askBridge(messages, cfg);
}

/**
 * Handle one Telegram message. Returns nothing (all side effects happen via
 * deps.api). The handler wraps this in a catch-all that replies with a
 * friendly error if anything unexpected throws.
 */
export async function handleMessage(message, deps) {
  const { api } = deps;
  const cfg = { ...defaultConfig, ...(deps.config || {}) };
  const chatId = message.chat?.id;
  if (chatId == null) return;

  const text = String(message.text || '').trim();

  // --- commands ---
  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (cmd === '/start' || cmd === '/help') {
      await api.sendMessage({ chat_id: chatId, text: helpText(cfg) });
      return;
    }
    if (cmd === '/model') {
      await api.sendMessage({ chat_id: chatId, text: `Model: ${cfg.model}` });
      return;
    }
    await api.sendMessage({ chat_id: chatId, text: 'Unknown command. Try /help.' });
    return;
  }

  if (!text) return; // ignore media / empty messages

  // --- typing indicator (before the slow bridge call) ---
  await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  const t0 = Date.now();

  // --- conversation memory ---
  const history = [];
  if (deps.getHistory) {
    try {
      history.push(...(await deps.getHistory(chatId, cfg.maxHistoryTurns) || []));
    } catch { /* memory unavailable -> stateless */ }
  }
  const messages = [];
  if (cfg.systemPrompt) messages.push({ role: 'system', content: cfg.systemPrompt });
  for (const h of history) messages.push(h);
  messages.push({ role: 'user', content: text });

  // --- engine call (with optional self-healing via the cloud collector) ---
  const askBridge = deps.askBridge || defaultAskBridge;
  const tryAsk = () => askBridge(messages, cfg);
  let answer;
  let failed = false;

  const attempt = async (firstTry) => {
    try {
      const r = await tryAsk();
      return { answer: composeReply({ reasoning: r.reasoning, content: r.content }) };
    } catch (err) {
      const refreshable = ['NO_SESSIONS', 'SESSIONS_EXHAUSTED', 'CHALLENGE'].includes(err?.code);
      if (refreshable && cfg.collectorUrl && firstTry) {
        // sessions expired or challenged -> ask the cloud collector to refresh
        // fresh sessions and redeploy, then retry once
        try {
          if (deps.collectorRefresh) await deps.collectorRefresh(cfg.collectorUrl);
          else {
            const { refreshViaCollector } = await import('./tgcollector.js');
            await refreshViaCollector(cfg.collectorUrl);
          }
          console.log('[engine] collector refresh ok — retrying');
          return await attempt(false);
        } catch (e2) {
          console.error('[engine] collector refresh failed:', String(e2?.message || e2).slice(0, 160));
        }
      }
      console.error('[engine] bridge failed:', String(err?.message || err).slice(0, 200));
      if (err?.code === 'NO_SESSIONS') {
        return { answer: '⚠️ The engine has no sessions configured, and the session collector is not reachable.\nCheck the collector service, or run `node tools/update-sessions.mjs` and redeploy.' };
      }
      if (err?.code === 'SESSIONS_EXHAUSTED' || err?.code === 'CHALLENGE') {
        return { answer: '⚠️ The engine\'s sessions expired or were challenged, and the automatic refresh did not help.\nCheck the collector service logs and try again in a minute.' };
      }
      return { answer: '⚠️ The engine could not answer right now. Please try again in a moment.' };
    }
  };

  const first = await attempt(true);
  answer = first.answer;
  failed = !first.answer || first.answer.startsWith('⚠️');

  // --- memory write (store the user message always, the answer only when it
  //     is a real engine reply) ---
  if (deps.saveTurn) {
    try {
      await deps.saveTurn(chatId, 'user', text);
      if (!failed) await deps.saveTurn(chatId, 'assistant', answer);
    } catch { /* non-fatal */ }
  }

  // keep the typing bubble alive for long generations
  if (Date.now() - t0 > 4000) {
    await api.sendChatAction({ chat_id: chatId, action: 'typing' }).catch(() => {});
  }

  await api.sendMessage({ chat_id: chatId, text: answer });
}
