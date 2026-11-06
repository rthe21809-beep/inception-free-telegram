// Tool-calling shim for chat.inceptionlabs.ai.
//
// The site's /api/chat endpoint has NO OpenAI-native tool support: it accepts
// {model, messages:[{role,parts}], stream, ...} only, and the model happily
// writes tool calls as *text* (e.g. <write file='...'>...</write>).
//
// This module bridges that gap:
//   injectToolSpec(body)  -> describes the caller's tools inside the prompt
//   parseToolCalls(text, tools) -> turns the model's text back into real
//                                  OpenAI tool_calls objects
//
// The parser is deliberately tolerant: it understands the formats Mercury
// actually emits (XML-ish tags, fenced tool_call blocks, tool:name lines, the
// <|inc_tool_call_ml|:tool> form) as well as clean JSON tool calls.

import { randomUUID } from 'node:crypto';

const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Canonical name for a tool-ish word -> the name DSH-style toolsets use.
const CANONICAL = {
  bash: 'bash', shell: 'bash', sh: 'bash', cmd: 'bash', command: 'bash',
  terminal: 'bash', exec: 'bash', execute: 'bash', run: 'bash', runcommand: 'bash',
  powershell: 'bash', zsh: 'bash', runbash: 'bash',
  write: 'write', writefile: 'write', write_file: 'write', createfile: 'write',
  create_file: 'write', save: 'write', savefile: 'write', create: 'write',
  edit: 'edit', editfile: 'edit', edit_file: 'edit', strreplace: 'edit',
  str_replace: 'edit', replace: 'edit', patch: 'edit', applypatch: 'edit',
  read: 'read', readfile: 'read', read_file: 'read', cat: 'read', view: 'read', open: 'read',
  glob: 'glob', listfiles: 'glob', findfiles: 'glob', find: 'glob', ls: 'glob',
  grep: 'grep', search: 'grep', ripgrep: 'grep', rg: 'grep', searchfiles: 'grep',
};

// Candidate raw keys for a schema property.
const SYN = {
  path: ['file', 'path', 'filepath', 'filename', 'name', 'target', 'dest', 'destination', 'location', 'p'],
  content: ['content', 'text', 'body', 'contents', 'data', 'value', 'payload', 'newcontent', 'newtext'],
  command: ['cmd', 'command', 'commandline', 'script', 'shell', 'args', 'arg', 'input', 'run', 'code'],
  pattern: ['pattern', 'glob', 'query', 'regex', 'search', 'namepattern', 'q'],
  oldstring: ['old', 'oldstr', 'oldstring', 'find', 'search', 'from', 'before', 'target'],
  newstring: ['new', 'newstr', 'newstring', 'replace', 'to', 'with', 'after', 'replacement', 'text'],
  url: ['url', 'link', 'href', 'uri'],
  limit: ['limit', 'max', 'count', 'n'],
  offset: ['offset', 'skip', 'start'],
};

const WRAPPER_TAGS = new Set([
  'tool_use', 'tooluse', 'tool_calls', 'toolcalls', 'tool_call', 'toolcall',
  'tool_parameters', 'toolparameters', 'tool_input', 'toolinput', 'parameters',
  'parameter', 'arguments', 'function', 'functions', 'invoke', 'invocation',
  'schema', 'json', 'code', 'pre', 'p', 'div', 'span', 'br', 'b', 'i', 'em', 'strong',
]);

export function toolNameOf(t) {
  return t?.function?.name || t?.name || '';
}

function toolDefs(tools) {
  return (tools || []).filter(Boolean).map(t => ({
    name: toolNameOf(t),
    schema: t?.function?.parameters || t?.parameters || t?.function?.schema || {},
    raw: t,
  }));
}

function resolveTool(name, defs) {
  const n = norm(name);
  if (!n) return null;
  for (const d of defs) if (norm(d.name) === n) return d;
  const canon = CANONICAL[n];
  if (canon) for (const d of defs) if (norm(d.name) === canon) return d;
  for (const d of defs) {
    const dn = norm(d.name);
    if (dn && (dn.includes(n) || n.includes(dn))) return d;
  }
  return null;
}

// Choose a tool by matching the raw argument keys against a schema.
function resolveBySchema(raw, defs) {
  const keys = Object.keys(raw || {}).map(norm);
  if (!keys.length) return null;
  let best = null, bestScore = 0;
  for (const d of defs) {
    const props = Object.keys(d.schema?.properties || {});
    if (!props.length) continue;
    const required = d.schema?.required || [];
    let score = 0;
    for (const p of props) if (keys.includes(norm(p))) score += 2;
    for (const p of required) if (keys.includes(norm(p))) score += 3;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return bestScore >= 2 ? best : null;
}

function coerce(schema, v) {
  if (v === null || v === undefined) return v;
  const t = schema?.type;
  if (t === 'integer' || t === 'number') {
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    return v;
  }
  if (t === 'boolean') {
    if (typeof v === 'string') return /^(true|1|yes|on)$/i.test(v.trim());
    return !!v;
  }
  if (t === 'string') {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.join('\n');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }
  if (t === 'array' && typeof v === 'string') {
    try { return JSON.parse(v); } catch { return [v]; }
  }
  if (t === 'object' && typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

function normalizeArgs(def, raw) {
  const props = def?.schema?.properties || {};
  const out = {};
  const used = new Set();
  const rawKeys = Object.keys(raw || {});

  const take = (propKey, schema) => {
    const pNorm = norm(propKey);
    const candidates = [propKey, ...(SYN[pNorm] || [])];
    for (const cand of candidates) {
      const hit = rawKeys.find(k => !used.has(k) && norm(k) === norm(cand));
      if (hit !== undefined) {
        used.add(hit);
        out[propKey] = coerce(schema, raw[hit]);
        return true;
      }
    }
    return false;
  };

  for (const [p, sch] of Object.entries(props)) take(p, sch);

  // A single body/command value with one required property -> map it there.
  const required = def?.schema?.required || [];
  if (required.length === 1 && !(required[0] in out)) {
    const prop = required[0];
    const bodyKey = rawKeys.find(k => !used.has(k) && ['body', 'text', 'content', 'cmd', 'command'].includes(norm(k)));
    if (bodyKey !== undefined) {
      used.add(bodyKey);
      out[prop] = coerce(props[prop], raw[bodyKey]);
    }
  }

  // Keep unmatched raw keys (tools without a schema, or extra info).
  if (!Object.keys(props).length) {
    for (const k of rawKeys) out[k] = raw[k];
  } else {
    for (const k of rawKeys) {
      if (used.has(k)) continue;
      if (out[k] !== undefined) continue;
      out[k] = raw[k];
    }
  }
  return out;
}

function parseAttrs(s) {
  const out = {};
  if (!s) return out;
  const re = /([\w\-:.]+)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s'">]+))/g;
  let m;
  while ((m = re.exec(s))) {
    out[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function innerTags(s) {
  const out = {};
  const re = /<([\w\-:.]+)((?:\s+[\w\-:.]+\s*=\s*(?:'[^']*'|"[^"]*"))*)\s*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(s))) {
    out[m[1]] = m[3];
  }
  return out;
}

function looseJson(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  const c = t.indexOf('['), d = t.lastIndexOf(']');
  if (c >= 0 && d > c) { try { return JSON.parse(t.slice(c, d + 1)); } catch {} }
  return null;
}

// Normalize one parsed "call-ish" object into {name, args}.
function normalizeCall(obj, defs) {
  if (!obj || typeof obj !== 'object') return null;
  let name = obj.name || obj.tool || obj.tool_name || obj.toolName || obj.function?.name || '';
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input ?? obj.tool_input ?? obj.tool_parameters ?? obj.params ?? obj.arguments_json;
  if (typeof args === 'string') {
    const j = looseJson(args);
    args = j ?? args;
  }
  if (args === undefined || args === null) args = {};
  if (typeof args !== 'object') args = { value: args };

  let def = resolveTool(name, defs);
  if (!def) def = resolveBySchema(args, defs);
  if (!def) return null;
  if (!name) name = def.name;

  const normalized = normalizeArgs(def, args);
  return { name: def.name || name, args: normalized };
}

function mkToolCall(name, args) {
  return {
    id: `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args ?? {}) },
  };
}

// Extract call candidates from free text.
function extractCandidates(text, defs) {
  const found = [];   // {start, end, call}
  const take = (start, end, call) => { if (call) found.push({ start, end, call }); };

  // 1) <tool_use> ... </tool_use>
  const reUse = /<tool_use>([\s\S]*?)<\/tool_use>/gi;
  let m;
  while ((m = reUse.exec(text))) {
    const inner = m[1];
    const nm = /<tool_name>\s*([\s\S]*?)\s*<\/tool_name>/i.exec(inner)
      || /<name>\s*([\s\S]*?)\s*<\/name>/i.exec(inner)
      || /name\s*=\s*['"]([^'"]+)['"]/i.exec(inner);
    const am = /<tool_parameters>([\s\S]*?)<\/tool_parameters>/i.exec(inner)
      || /<tool_input>([\s\S]*?)<\/tool_input>/i.exec(inner)
      || /<parameters>([\s\S]*?)<\/parameters>/i.exec(inner)
      || /<arguments>([\s\S]*?)<\/arguments>/i.exec(inner);
    const call = normalizeCall({ name: nm ? nm[1] : '', args: am ? (looseJson(am[1]) ?? am[1]) : {} }, defs);
    take(m.index, m.index + m[0].length, call);
  }

  // 2) invocation tags: <write file='x'>text</write>, <bash>cmd</bash>
  const reTag = /<([a-zA-Z_][\w\-]*)((?:\s+[\w\-:.]+\s*=\s*(?:'[^']*'|"[^"]*"))*)\s*>([\s\S]*?)<\/\1>/g;
  while ((m = reTag.exec(text))) {
    const tag = m[1];
    if (WRAPPER_TAGS.has(norm(tag))) continue;
    const def = resolveTool(tag, defs);
    if (!def) continue;
    const attrs = parseAttrs(m[2]);
    const kids = innerTags(m[3]);
    const raw = { ...attrs };
    for (const [k, v] of Object.entries(kids)) raw[k] = v;
    if (!Object.keys(kids).length && m[3].trim()) raw.body = m[3].trim();
    const call = normalizeCall({ name: def.name, args: raw }, defs);
    take(m.index, m.index + m[0].length, call);
  }

  // 3) tool:name lines — "tool:bash <cmd>...</cmd> </tool:bash>"
  const reToolLine = /(?<![\/<])tool\s*:\s*([a-zA-Z_][\w\-]*)/gi;
  while ((m = reToolLine.exec(text))) {
    const def = resolveTool(m[1], defs);
    if (!def) continue;
    const rest = text.slice(m.index, m.index + 800);
    const close = rest.search(/<\/tool[:\s>]/i);
    const chunk = close > 0 ? rest.slice(0, close) : rest;
    const kids = innerTags(chunk);
    const raw = { ...kids };
    if (!Object.keys(kids).length) {
      const cleaned = chunk.replace(/^tool\s*:\s*[a-zA-Z_][\w\-]*/i, '').replace(/<\/?tool[:\s>][^>]*>/gi, '').trim();
      if (cleaned) raw.body = cleaned;
    }
    const call = normalizeCall({ name: def.name, args: raw }, defs);
    take(m.index, m.index + (close > 0 ? close : chunk.length), call);
  }

  // 4) <|inc_tool_call_ml|:tool> <arg>val</arg> </tool:tool>
  const reInc = /<\|inc_tool_call_ml\|:([a-zA-Z_][\w\-]*)\s*>([\s\S]*?)(?:<\/tool:|$)/gi;
  while ((m = reInc.exec(text))) {
    const def = resolveTool(m[1], defs);
    if (!def) continue;
    const kids = innerTags(m[2]);
    const raw = { ...kids };
    const call = normalizeCall({ name: def.name, args: raw }, defs);
    take(m.index, m.index + m[0].length, call);
  }

  // 5) fenced tool_call blocks
  const reFence = /```(?:tool_call|tool_calls|tool|json)?\s*\n?([\s\S]*?)```/gi;
  while ((m = reFence.exec(text))) {
    const payload = looseJson(m[1]);
    if (!payload) continue;
    const list = Array.isArray(payload) ? payload
      : Array.isArray(payload.tool_calls) ? payload.tool_calls
      : Array.isArray(payload.calls) ? payload.calls
      : [payload];
    let ok = false;
    for (const item of list) {
      const call = normalizeCall(item, defs);
      if (call) { ok = true; }
    }
    if (ok) take(m.index, m.index + m[0].length, { calls: list.map(i => normalizeCall(i, defs)).filter(Boolean) });
  }

  // 6) whole text is one JSON call
  const whole = looseJson(text.trim());
  if (whole && !found.length) {
    const list = Array.isArray(whole) ? whole
      : Array.isArray(whole.tool_calls) ? whole.tool_calls : [whole];
    const calls = list.map(i => normalizeCall(i, defs)).filter(Boolean);
    if (calls.length) take(0, text.length, { calls });
  }

  return found;
}

// Parse model text into {content, toolCalls}.
// Remove any markup that looks like a call to one of the declared tools,
// even when it could not be parsed into a real tool_call (broken tag, missing
// argument, ...). Keeps the model's answer readable.
export function stripToolMarkup(text, tools) {
  if (!text) return '';
  const names = new Set();
  for (const t of tools || []) {
    const n = norm(toolNameOf(t));
    if (n) names.add(n);
    for (const [canon, target] of Object.entries(CANONICAL)) {
      if (target === n) names.add(canon);
    }
  }
  let out = String(text);
  if (names.size) {
    const alt = [...names].join('|');
    // paired blocks: <write ...>...</write>
    out = out.replace(new RegExp(`<(${alt})\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, 'gi'), '');
    // a lone opening tag (possibly unclosed): <write file='x'> ... up to the next real tag or EOL
    out = out.replace(new RegExp(`<(${alt})\\b[^>]*>`, 'gi'), '');
    out = out.replace(new RegExp(`</(${alt})\\s*>`, 'gi'), '');
  }
  out = out
    .replace(/<\/?tool[:\s>][^>]*>/gi, '')
    .replace(/<\/?tool_use[^>]*>/gi, '')
    .replace(/<\|inc_tool_call_ml\|[^>]*>/gi, '')
    .replace(/^\s*tool\s*:\s*[a-zA-Z_][\w\-]*\s*$/gm, '')
    .trim();
  return out;
}

export function parseToolCalls(text, tools) {
  const defs = toolDefs(tools);
  if (!defs.length || !text) return { content: text || '', toolCalls: [] };

  const candidates = extractCandidates(text, defs);
  if (!candidates.length) return { content: stripToolMarkup(text, tools), toolCalls: [] };

  // Resolve overlaps: earlier match wins.
  candidates.sort((a, b) => a.start - b.start);
  const kept = [];
  let cursor = -1;
  for (const c of candidates) {
    if (c.start < cursor) continue;
    kept.push(c);
    cursor = c.end;
  }

  const toolCalls = [];
  let content = '';
  let pos = 0;
  for (const c of kept) {
    content += text.slice(pos, c.start);
    pos = c.end;
    if (c.call?.calls) toolCalls.push(...c.call.calls);
    else if (c.call) toolCalls.push(c.call);
  }
  content += text.slice(pos);

  // drop duplicate calls (same tool + same args)
  const seenCall = new Set();
  const uniqueCalls = [];
  for (const c of toolCalls) {
    const key = c.name + '|' + JSON.stringify(c.args);
    if (seenCall.has(key)) continue;
    seenCall.add(key);
    uniqueCalls.push(c);
  }

  // clean up leftovers, including tool markup the parser could not turn into
  // a call (malformed/partial tags) so the answer text stays clean
  content = stripToolMarkup(content, tools);
  if (content === '</' || content === '<') content = '';

  return {
    content,
    toolCalls: uniqueCalls.map(c => mkToolCall(c.name, c.args)),
  };
}

// Describe the caller's tools inside the prompt so the model can call them.
export function renderToolSpec(tools, toolChoice) {
  const defs = toolDefs(tools);
  const lines = [];
  lines.push('');
  lines.push('## Tool protocol (mandatory)');
  lines.push('');
  lines.push('You can call tools. Available tools:');
  for (const d of defs) {
    lines.push('');
    lines.push(`- name: ${d.name}`);
    const desc = d.raw?.function?.description || d.schema?.description || '';
    if (desc) lines.push(`  description: ${desc}`);
    lines.push(`  parameters: ${JSON.stringify(d.schema?.properties ? d.schema : {})}`);
  }
  lines.push('');
  lines.push('To call a tool, output a fenced block tagged tool_call containing ONE JSON object per call:');
  lines.push('');
  lines.push('```tool_call');
  lines.push('{"name":"<tool name>","arguments":{<json arguments>}}');
  lines.push('```');
  lines.push('');
  lines.push('Rules:');
  lines.push('- The fenced tool_call block is the ONLY way to call a tool. Never write tool names in prose or XML tags.');
  lines.push('- Never invent a tool name; use exactly one of the names listed above.');
  lines.push('- Arguments must match that tool\'s parameters (use the property names given).');
  lines.push('- You may emit several tool_call blocks in one reply, in the order they should run.');
  if (toolChoice === 'required') lines.push('- You MUST call at least one tool in this reply.');
  if (toolChoice && typeof toolChoice === 'object' && toolChoice?.function?.name) {
    lines.push(`- You MUST call the tool "${toolChoice.function.name}" in this reply.`);
  }
  lines.push('- If no tool is needed, answer normally in plain text with no tool_call block.');
  lines.push('');
  return lines.join('\n');
}

// Inject the tool spec into the outgoing request.
export function injectToolSpec(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (!tools.length) return { body, tools: [] };
  const spec = renderToolSpec(tools, body.tool_choice);
  const messages = (Array.isArray(body.messages) ? body.messages : []).map(m => ({ ...m }));
  const idx = messages.findIndex(m => m.role === 'system' || m.role === 'developer');
  if (idx >= 0 && typeof messages[idx].content === 'string') {
    messages[idx].content = messages[idx].content + '\n' + spec;
  } else {
    messages.unshift({ role: 'system', content: spec.trim() });
  }
  const out = { ...body, messages };
  delete out.tools;
  delete out.tool_choice;
  return { body: out, tools };
}
