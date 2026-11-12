// Text formatting helpers (plain text — no parse_mode, so no escaping bugs).

import { config } from './config.js';

/** Compose the final reply: optional thinking preview + answer. */
export function composeReply({ reasoning = '', content = '' } = {}) {
  const parts = [];
  if (config.showThinking && reasoning) {
    const cap = config.thinkingPreviewChars || 400;
    const preview = reasoning.slice(0, cap);
    parts.push(`💭 ${preview}${reasoning.length > cap ? ' …' : ''}`);
  }
  if (content) parts.push(content);
  const text = parts.join('\n\n');
  return text || '_(no answer from the engine)_';
}

/** Human-readable command help. */
export function helpText(cfg = config) {
  return [
    '🤖 Inception free chatbot (Mercury 3)',
    '',
    'Just send a message — I\'ll reply using the Inception free chat engine.',
    '',
    'Commands:',
    '  /start  — show this message',
    '  /help   — show this message',
    '  /model  — show the model in use',
    '  /admin  — owner admin panel (providers, models, keys, users, logs)',
    '',
    `Model: ${cfg.model}`,
  ].join('\n');
}
