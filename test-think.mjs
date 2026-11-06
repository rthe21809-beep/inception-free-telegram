#!/usr/bin/env node
// Offline test of the reasoning scraper and the Mercury 3 effort mapping.
//
// The bridge never injects thinking directives (that would slow the model
// down) — it only scrapes whatever reasoning the model produces.
// Usage: node test-think.mjs

import { ThinkSplitter, extractThink } from './lib/think-directive.mjs';
import { normalizeEffort, effortFromBody } from './lib/effort.mjs';

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failures++;
};

// ---- 1. split across arbitrary chunk boundaries -------------------------
function splitAll(parts) {
  const sp = new ThinkSplitter();
  let reasoning = '';
  let content = '';
  for (const p of parts) {
    const o = sp.push(p);
    reasoning += o.reasoning;
    content += o.content;
  }
  const t = sp.flush();
  return { reasoning: reasoning + t.reasoning, content: content + t.content };
}

const full = '<think>37*40 = 1480 and 37*3 = 111, so 1591.</think>The answer is 1591.';
for (const size of [1, 3, 7, 13, 40, 500]) {
  const parts = [];
  for (let i = 0; i < full.length; i += size) parts.push(full.slice(i, i + size));
  const out = splitAll(parts);
  check(out.reasoning.trim() === '37*40 = 1480 and 37*3 = 111, so 1591.',
    `chunk size ${size}: reasoning extracted (${JSON.stringify(out.reasoning.slice(0, 40))})`);
  check(out.content.trim() === 'The answer is 1591.',
    `chunk size ${size}: content kept clean (${JSON.stringify(out.content.slice(0, 40))})`);
}

// ---- 2. reasoning arrives before the closing tag (live) -----------------
{
  const sp = new ThinkSplitter();
  const a = sp.push('<think>step one, step two');
  check(a.reasoning === 'step one, step two', 'live reasoning is emitted before </think> arrives');
  const b = sp.push(' done</think>final answer');
  check(b.content.includes('final answer'), 'content resumes after </think>');
  check(b.reasoning === ' done', 'trailing reasoning is flushed');
}

// ---- 3. no tags -> everything is content --------------------------------
{
  const out = splitAll(['plain ', 'answer']);
  check(out.reasoning === '' && out.content.replace(/\s+/g, ' ') === 'plain answer', 'untagged text stays content');
}

// ---- 4. extractThink (buffered path) ------------------------------------
{
  const r = extractThink('<think>abc</think>answer');
  check(r.reasoning === 'abc' && r.content.trim() === 'answer', 'extractThink splits a complete block');
  const r2 = extractThink('<think>unclosed reasoning');
  check(r2.reasoning === 'unclosed reasoning', 'extractThink handles an unclosed block');
}

// ---- 5. several <think> blocks in one answer ----------------------------
{
  const out = splitAll(['<think>first</think>', 'mid ', '<think>second</think>', 'end']);
  check(out.reasoning.includes('first') && out.reasoning.includes('second'), 'multiple think blocks are all captured');
  check(!out.reasoning.includes('mid') && out.content.includes('mid'), 'content between blocks stays content');
  check(!out.content.includes('<think>') && !out.content.includes('</think>'), 'no think tags leak into the answer');
}

// ---- 6. Mercury 3 effort mapping ----------------------------------------
{
  check(normalizeEffort('off') === 'instant', 'off -> instant');
  check(normalizeEffort('instant') === 'instant', 'instant -> instant');
  check(normalizeEffort('low') === 'low', 'low -> low');
  check(normalizeEffort('medium') === 'medium', 'medium -> medium');
  check(normalizeEffort('high') === 'high', 'high -> high');
  check(normalizeEffort('max') === 'max', 'max -> max');
  check(normalizeEffort('xhigh') === 'max', 'xhigh -> max');
  check(normalizeEffort('minimal') === 'instant', 'minimal -> instant');
  check(normalizeEffort('nonsense') === '', 'unknown level -> no effort');
}

// ---- 7. the effort comes from the request body --------------------------
{
  check(effortFromBody({ reasoning_effort: 'max' }, 'mercury-3') === 'max', 'body effort is used');
  check(effortFromBody({ reasoning_effort: 'off' }, 'mercury-3') === 'instant', 'off in the body -> instant');
  check(effortFromBody({}, 'mercury-3') === '', 'no effort requested -> nothing sent');
  check(effortFromBody({ reasoning_effort: 'high' }, 'mercury-3') === 'high', 'high stays high');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
