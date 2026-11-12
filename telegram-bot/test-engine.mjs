#!/usr/bin/env node
// Offline tests for the bot engine — no Telegram, no bridge, no sdk.
// Mocks the SDK-shaped deps the handler would inject and verifies the full
// behavior: commands, bridge call payload, thinking preview, memory,
// failure handling.

import { handleMessage } from './tgcloud/lib/engine.js';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

function makeDeps(overrides = {}) {
  const calls = { sendMessage: [], sendChatAction: [], bridge: [] };
  const memory = [];
  const deps = {
    calls,
    memory,
    api: {
      sendMessage: async p => { calls.sendMessage.push(p); return { ok: true, result: { message_id: 1 } }; },
      sendChatAction: async p => { calls.sendChatAction.push(p); return { ok: true }; },
    },
    askBridge: async (messages, cfg) => {
      calls.bridge.push({ messages, cfg });
      return { content: 'The answer is 1591.', reasoning: 'Let me compute: 37*40=1480, +111=1591.' };
    },
    getHistory: async (chatId, limit) => memory.filter(m => m.chatId === chatId).slice(-limit).map(m => ({ role: m.role, content: m.content })),
    saveTurn: async (chatId, role, content) => { memory.push({ chatId, role, content }); },
    ...overrides,
  };
  return deps;
}

const msg = (text, chatId = 42) => ({ chat: { id: chatId }, text, message_id: 1 });

try {
  // ---- commands ----
  {
    const d = makeDeps();
    await handleMessage(msg('/start'), d);
    check(d.calls.sendMessage.length === 1, '/start sends one message');
    check(d.calls.sendMessage[0].text.includes('Mercury 3'), '/start shows the intro');
    check(d.calls.bridge.length === 0, 'commands do not call the bridge');
  }
  {
    const d = makeDeps();
    await handleMessage(msg('/model'), d);
    check(d.calls.sendMessage[0].text.includes('mercury-3'), '/model shows the model');
  }
  {
    const d = makeDeps();
    await handleMessage(msg('/nope'), d);
    check(d.calls.sendMessage[0].text.includes('Unknown command'), 'unknown command gets a hint');
  }

  // ---- normal message: payload shape + thinking + reply ----
  {
    const d = makeDeps();
    await handleMessage(msg('what is 37*43?'), d);
    check(d.calls.bridge.length === 1, 'bridge called once');
    const { messages, cfg } = d.calls.bridge[0];
    check(messages[0].role === 'system', 'system prompt first');
    check(messages.at(-1) === { role: 'user', content: 'what is 37*43?' } || messages.at(-1).content === 'what is 37*43?', 'user message appended');
    check(cfg.bridgeBaseUrl && cfg.bridgeApiKey && cfg.model === 'mercury-3', 'config forwarded to bridge');
    check(d.calls.sendChatAction.some(a => a.action === 'typing'), 'typing sent before the bridge call');
    const reply = d.calls.sendMessage.at(-1).text;
    check(reply.includes('💭'), 'thinking preview included');
    check(reply.includes('1591'), 'answer included');
    check(d.memory.some(m => m.role === 'user'), 'user turn saved to memory');
    check(d.memory.some(m => m.role === 'assistant'), 'assistant turn saved to memory');
  }

  // ---- conversation memory is fed back ----
  {
    const d = makeDeps();
    d.memory.push({ chatId: 7, role: 'user', content: 'old turn' });
    await handleMessage(msg('new turn', 7), d);
    const { messages } = d.calls.bridge[0];
    check(messages.some(m => m.content === 'old turn'), 'history is sent with the request');
  }

  // ---- bridge failure -> friendly error, no assistant memory ----
  {
    const d = makeDeps({ askBridge: async () => { throw new Error('bridge HTTP 502: nope'); } });
    await handleMessage(msg('hello'), d);
    const reply = d.calls.sendMessage.at(-1).text;
    check(reply.startsWith('⚠️'), 'failure produces a friendly error');
    check(!d.memory.some(m => m.role === 'assistant'), 'failed answer is not saved to memory');
  }

  // ---- session expiry -> collector refresh -> retry succeeds ----
  {
    let bridgeCalls = 0;
    const collectorCalls = [];
    const d = makeDeps({
      config: { collectorUrl: 'https://collector.example' },
      collectorRefresh: async url => { collectorCalls.push(url); },
      askBridge: async (messages, cfg) => {
        bridgeCalls++;
        if (bridgeCalls === 1) {
          const err = new Error('all sessions failed');
          err.code = 'SESSIONS_EXHAUSTED';
          throw err;
        }
        return { content: 'Fresh answer.', reasoning: '' };
      },
    });
    await handleMessage(msg('hello'), d);
    check(collectorCalls.length === 1, 'collector called once on session expiry');
    check(collectorCalls[0] === 'https://collector.example', 'collector URL forwarded');
    check(bridgeCalls === 2, 'bridge retried after refresh');
    check(d.calls.sendMessage.at(-1).text.includes('Fresh answer.'), 'fresh answer delivered after auto-refresh');
    check(d.memory.some(m => m.role === 'assistant' && m.content.includes('Fresh answer.')), 'assistant turn saved after success');
  }

  // ---- API mode: official Inception API path ----
  {
    const d = makeDeps({
      config: { mode: 'api', inceptionApiKey: 'sk-test' },
      askBridge: async (messages, cfg) => {
        check(cfg.mode === 'api', 'api mode selected');
        check(cfg.inceptionApiKey === 'sk-test', 'api key forwarded');
        check(messages.at(-1).content === 'hello api', 'message forwarded to api');
        return { content: 'API reply.', reasoning: 'api reasoning.' };
      },
    });
    await handleMessage(msg('hello api'), d);
    const reply = d.calls.sendMessage.at(-1).text;
    check(reply.includes('API reply.'), 'api mode returns the model answer');
    check(reply.includes('api reasoning.'), 'api mode includes reasoning preview');
  }

  // ---- API auth failure -> clear guidance ----
  {
    const d = makeDeps({
      config: { mode: 'api', inceptionApiKey: 'sk-bad' },
      askBridge: async () => {
        const err = new Error('inception api HTTP 401: unauthorized');
        err.code = 'API_AUTH';
        throw err;
      },
    });
    await handleMessage(msg('hi'), d);
    check(d.calls.sendMessage.at(-1).text.includes('401'), 'api auth failure explains the 401');
  }

  // ---- collector refresh fails -> friendly error, no assistant memory ----
  {
    const d = makeDeps({
      config: { collectorUrl: 'https://collector.example' },
      collectorRefresh: async () => { throw new Error('collector HTTP 502'); },
      askBridge: async () => {
        const err = new Error('no sessions configured');
        err.code = 'NO_SESSIONS';
        throw err;
      },
    });
    await handleMessage(msg('hello'), d);
    const reply = d.calls.sendMessage.at(-1).text;
    check(reply.startsWith('⚠️'), 'collector failure still yields a friendly error');
    check(!d.memory.some(m => m.role === 'assistant'), 'no assistant memory after failed refresh');
  }

  // ---- stateless mode (no memory adapters) ----
  {
    const d = makeDeps({ getHistory: undefined, saveTurn: undefined });
    await handleMessage(msg('hi'), d);
    check(d.calls.bridge.length === 1, 'works without memory');
    check(d.memory.length === 0, 'no memory writes without adapters');
  }

  // ---- empty/ignored messages ----
  {
    const d = makeDeps();
    await handleMessage({ chat: { id: 1 }, text: '', message_id: 1 }, d);
    await handleMessage({ chat: { id: 1 }, photo: [{}], message_id: 2 }, d);
    check(d.calls.bridge.length === 0, 'empty or media messages are ignored');
  }

  // ---- no chat id ----
  {
    const d = makeDeps();
    await handleMessage({ message_id: 9 }, d);
    check(d.calls.sendMessage.length === 0, 'message without chat id is ignored');
  }
} catch (e) {
  failures++;
  console.error('FATAL', e);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall engine checks passed');
process.exit(failures ? 1 : 0);
