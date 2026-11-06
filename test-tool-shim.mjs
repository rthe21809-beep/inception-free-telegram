#!/usr/bin/env node
// Offline unit test for the tool-call shim parser (no network).
let failures = 0;
const check = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) failures++; };
import { parseToolCalls, injectToolSpec } from './lib/tool-shim.mjs';

const TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'run a shell command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'write', description: 'write a file', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'glob', description: 'list files', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
];

const cases = [
  {
    name: 'xml write tag',
    text: `I'll create a file now.\n<write file='/root/Projects/Mercury/sample.txt'> Hello! This is a sample text file. </write>\nDone!`,
    expect: [{ name: 'write', args: { path: '/root/Projects/Mercury/sample.txt', content: 'Hello! This is a sample text file.' } }],
  },
  {
    name: 'xml bash tags',
    text: `<bash> pwd </bash> <bash> ls -la </bash>`,
    expect: [{ name: 'bash', args: { command: 'pwd' } }, { name: 'bash', args: { command: 'ls -la' } }],
  },
  {
    name: 'tool_use xml',
    text: `<tool_use> <tool_name>write</tool_name> <tool_parameters> { "path": "/root/Projects/Mercury/hello.txt", "content": "hello" } </tool_parameters> </tool_use>`,
    expect: [{ name: 'write', args: { path: '/root/Projects/Mercury/hello.txt', content: 'hello' } }],
  },
  {
    name: 'tool: prefix form',
    text: `tool:bash <cmd>pwd && ls -la</cmd> </tool:bash>`,
    expect: [{ name: 'bash', args: { command: 'pwd && ls -la' } }],
  },
  {
    name: 'inc_tool_call_ml form',
    text: `<|inc_tool_call_ml|:glob> <pattern>*</pattern> </tool:glob>`,
    expect: [{ name: 'glob', args: { pattern: '*' } }],
  },
  {
    name: 'fenced tool_call',
    text: `Sure!\n\`\`\`tool_call\n{"name":"read","arguments":{"path":"/tmp/a.txt"}}\n\`\`\``,
    expect: [{ name: 'read', args: { path: '/tmp/a.txt' } }],
  },
  {
    name: 'plain text -> no calls',
    text: 'Hi! How can I help you today?',
    expect: [],
  },
  {
    name: 'unknown tag ignored',
    text: '<div>hello</div>',
    expect: [],
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const r = parseToolCalls(c.text, TOOLS);
  const got = r.toolCalls.map(t => ({ name: t.function.name, args: JSON.parse(t.function.arguments) }));
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (ok) { pass++; console.log(`PASS  ${c.name}`); }
  else {
    fail++;
    console.log(`FAIL  ${c.name}`);
    console.log('  expected:', JSON.stringify(c.expect));
    console.log('  got     :', JSON.stringify(got));
    console.log('  content :', JSON.stringify(r.content));
  }
}

// injection test
const inj = injectToolSpec({ messages: [{ role: 'developer', content: 'sys' }], tools: TOOLS, tool_choice: 'auto' });
const specOk = inj.body.messages[0].content.includes('## Tool protocol (mandatory)')
  && inj.body.messages[0].content.includes('- name: bash')
  && inj.body.tools === undefined
  && inj.body.tool_choice === undefined;
console.log(specOk ? 'PASS  tool spec injected' : 'FAIL  tool spec injected');
if (!specOk) { fail++; console.log(JSON.stringify(inj.body.messages[0].content).slice(0, 400)); } else pass++;


// ---- envelope integration check ------------------------------------------
import { buildEnvelope } from './lib/proxy.mjs';
const { body: inj2 } = injectToolSpec({
  model: 'mercury-2',
  messages: [{ role: 'developer', content: 'sys prompt' }, { role: 'user', content: 'make a file' }],
  tools: TOOLS,
  tool_choice: 'auto',
  max_completion_tokens: 64,
});
const env = buildEnvelope(inj2);
const envOk = env.tools === undefined
  && env.tool_choice === undefined
  && env.max_tokens === 64
  && env.messages[0].parts[0].text.includes('## Tool protocol (mandatory)')
  && env.messages[0].parts[0].text.includes('- name: write')
  && env.messages[1].parts[0].text === 'make a file';
console.log(envOk ? 'PASS  upstream envelope (tools hidden, spec injected, max_completion_tokens mapped)' : 'FAIL  upstream envelope');
if (!envOk) console.log(JSON.stringify(env, null, 2).slice(0, 900));


// ---- malformed tool markup must not leak into the answer ----------------
{
  const tools = [{ type: 'function', function: { name: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } }];
  const dirty = 'Here you go.\n<write file=\'/tmp/x\'>hello\nSome explanation after.';
  const r = parseToolCalls(dirty, tools);
  check(!r.content.includes('<write'), `unparsed tool markup is stripped from the answer (${JSON.stringify(r.content.slice(0, 40))})`);
  check(r.content.includes('Here you go.') && r.content.includes('Some explanation after.'), 'the surrounding text is kept');
  const dirty2 = 'Answer: <bash command="ls -la"> and then more text';
  const r2 = parseToolCalls(dirty2, [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }]);
  check(!r2.content.includes('<bash'), `a lone opening tag is removed too (${JSON.stringify(r2.content)})`);
  check(r2.content.includes('Answer:') && r2.content.includes('and then more text'), 'text around it survives');
}

console.log(`\n${pass} passed, ${fail + failures} failed`);
process.exit((fail + failures) ? 1 : 0);
