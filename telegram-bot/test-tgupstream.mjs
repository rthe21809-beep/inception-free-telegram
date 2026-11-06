#!/usr/bin/env node
// Offline tests for the direct (zero-server) upstream client: envelope
// building, header shaping, chunk extraction and SSE/JSON body parsing.

import { buildEnvelope, headersFor, extractDelta, parseChatBody } from './tgcloud/lib/tgupstream-core.js';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

try {
  // ---- envelope ----
  {
    const env = buildEnvelope([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
    ]);
    check(env.model === 'mercury', 'envelope uses the site model id');
    check(env.stream === false, 'envelope is non-stream');
    check(env.messages.length === 3, 'envelope keeps all messages');
    check(env.messages[0].role === 'user', 'system message becomes user role (site format)');
    check(Array.isArray(env.messages[0].parts) && env.messages[0].parts[0].text === 'sys', 'content is converted to parts/text');
    check(Array.isArray(env.messages[2].parts) && env.messages[2].parts[0].text === 'yo', 'array content maps to parts');
    check(!!env.id && !!env.messageId, 'envelope carries ids');
    check(env.trigger === 'submit-message', 'envelope trigger set');
    check(env.reasoning_effort === 'medium', 'default effort sent');
  }

  // ---- headers ----
  {
    const h = headersFor({ cookies: { a: '1', b: '2' }, bearer: 'tok' }, { 'x-session-token': 's' });
    check(h.Cookie === 'a=1; b=2', 'cookies joined');
    check(h.Authorization === 'Bearer tok', 'bearer header');
    check(h['x-session-token'] === 's', 'extra headers merged');
    check(h.Origin === 'https://chat.inceptionlabs.ai', 'origin set');
  }

  // ---- extractDelta ----
  {
    check(extractDelta({ type: 'reasoning-delta', delta: 'think…' }).reasoning === 'think…', 'reasoning-delta extracted');
    check(extractDelta({ type: 'text-delta', delta: 'answer' }).content === 'answer', 'text-delta extracted');
    check(extractDelta({ choices: [{ delta: { content: 'x', reasoning_content: 'r' } }] }).content === 'x', 'choices delta content');
    check(extractDelta({ choices: [{ delta: { content: 'x', reasoning_content: 'r' } }] }).reasoning === 'r', 'choices delta reasoning');
    check(extractDelta({ content: 'plain' }).content === 'plain', 'plain content extracted');
    check(extractDelta({ reasoning_content: 'r2' }).reasoning === 'r2', 'reasoning_content fallback');
  }

  // ---- parseChatBody ----
  {
    const sse = [
      'data: {"type":"reasoning-delta","delta":"Let me think."}',
      'data: {"type":"text-delta","delta":"The answer is 42."}',
      'data: {"type":"finish","finishReason":"stop"}',
      'data: [DONE]',
    ].join('\n');
    const r = parseChatBody(sse);
    check(r.content === 'The answer is 42.', 'SSE content parsed');
    check(r.reasoning === 'Let me think.', 'SSE reasoning parsed');
  }
  {
    const json = JSON.stringify({ choices: [{ message: { content: 'Hi!', reasoning_content: 'short' } }] });
    const r = parseChatBody(json);
    check(r.content === 'Hi!' && r.reasoning === 'short', 'JSON completion parsed');
  }
  {
    const r = parseChatBody('not json');
    check(r.content === '' && r.reasoning === '', 'garbage body tolerated');
  }
  {
    const r = parseChatBody('');
    check(r.status === 200, 'empty body has default status');
  }
} catch (e) {
  failures++;
  console.error('FATAL', e);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall upstream checks passed');
process.exit(failures ? 1 : 0);
