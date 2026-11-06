// Configuration for the Telegram bot.
//
// Note: Telegram Serverless (tgcloud) runs only .js modules with the `sdk`
// imports — there is no env-var mechanism documented at runtime, so config
// lives here in plain constants. Edit these before `npx tgcloud push`.
//
// Two engine modes:
//   mode: 'direct'  — the bot talks straight to chat.inceptionlabs.ai from
//                     Telegram's sandbox. ZERO servers of your own. Needs
//                     sessions (see ./sessions.js, filled by
//                     tools/update-sessions.mjs on your PC).
//   mode: 'bridge'  — the bot calls your own inception-free-bridge instance
//                     (a VPS / Docker / home machine). Most reliable, but
//                     requires you to run that one server.

import { sessions } from './sessions.js';

export const config = {
  mode: 'direct',      // 'direct' | 'bridge'

  // ---- direct mode ----
  sessions,            // captured sessions (auto-generated file)
  sessionTtlHours: 6,  // sessions older than this are deprioritised
  // Cloud session collector (telegram-bot/collector). When sessions expire
  // or are challenged, the bot POSTs /refresh to this URL, waits for the
  // collector to solve fresh sessions + redeploy, then retries once.
  // Leave '' to disable auto-refresh (then manual `npm run sessions` is
  // needed). Example: 'https://your-collector.up.railway.app'
  collectorUrl: '',

  // ---- bridge mode (only when mode === 'bridge') ----
  bridgeBaseUrl: 'https://YOUR-BRIDGE-HOST',
  bridgeApiKey: 'YOUR-BRIDGE-API-KEY',

  // ---- shared ----
  model: 'mercury-3',
  timeoutMs: 55000,
  showThinking: true,
  thinkingPreviewChars: 400,
  maxHistoryTurns: 12,
  systemPrompt: 'You are a helpful assistant in a Telegram chat. Answer concisely.',
  allowGroups: true,
};
