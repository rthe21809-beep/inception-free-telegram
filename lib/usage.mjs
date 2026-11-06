// Token accounting + throughput metrics for the bridge.
//
// Upstream (chat.inceptionlabs.ai) does not report usage, so counts are
// estimated locally. Every emitted usage object carries `usage_source` so a
// benchmark never mistakes an estimate for an upstream measurement.

const CJK = [
  [0x4e00, 0x9fff], [0x3040, 0x30ff], [0xac00, 0xd7af],
  [0xf900, 0xfaff], [0x3000, 0x303f], [0xff00, 0xffef],
];

function isCjk(cp) {
  for (const [a, b] of CJK) if (cp >= a && cp <= b) return true;
  return false;
}

// Rough token estimate: CJK ~= 1 token/char, other text ~= 4 chars/token.
export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cjk = 0;
  for (const ch of s) if (isCjk(ch.codePointAt(0))) cjk++;
  const rest = s.length - cjk;
  return Math.max(1, Math.round(cjk + rest / 4));
}

// Look for a usage object the upstream may have included in the stream.
export function pickUpstreamUsage(chunks) {
  for (const c of chunks || []) {
    if (!c || typeof c !== 'object') continue;
    const u = c.usage
      || c.finish?.usage
      || c.messageMetadata?.usage
      || c.finishMessage?.usage
      || c.response?.usage;
    if (u && typeof u === 'object' && (u.inputTokens || u.outputTokens || u.prompt_tokens || u.completion_tokens)) {
      return {
        prompt_tokens: u.inputTokens ?? u.prompt_tokens ?? 0,
        completion_tokens: u.outputTokens ?? u.completion_tokens ?? 0,
        total_tokens: u.totalTokens ?? u.total_tokens ?? ((u.inputTokens ?? u.prompt_tokens ?? 0) + (u.outputTokens ?? u.completion_tokens ?? 0)),
      };
    }
  }
  return null;
}

// Build the OpenAI-shaped usage object.
export function buildUsage({ promptText = '', completionText = '', reasoningText = '', upstream = null }) {
  let prompt_tokens, completion_tokens, total_tokens, source;
  if (upstream) {
    prompt_tokens = upstream.prompt_tokens;
    completion_tokens = upstream.completion_tokens;
    total_tokens = upstream.total_tokens ?? (prompt_tokens + completion_tokens);
    source = 'upstream';
  } else {
    prompt_tokens = estimateTokens(promptText);
    completion_tokens = estimateTokens(completionText) + estimateTokens(reasoningText);
    total_tokens = prompt_tokens + completion_tokens;
    source = 'estimated';
  }
  const usage = {
    prompt_tokens,
    completion_tokens,
    total_tokens,
    usage_source: source,
  };
  if (reasoningText) {
    usage.completion_tokens_details = { reasoning_tokens: estimateTokens(reasoningText) };
  }
  return usage;
}

// Throughput: completion tokens per second of generation time.
export function throughput(usage, { ttftMs = 0, elapsedMs = 0, ttftKnown = true } = {}) {
  const known = ttftKnown && ttftMs > 0;
  // buffered (browser-context) mode cannot observe TTFT -> throughput is end-to-end
  const genMs = known ? Math.max(1, (elapsedMs || 0) - ttftMs) : Math.max(1, elapsedMs || 0);
  const tps = (usage?.completion_tokens || 0) / (genMs / 1000);
  return {
    tokens_per_second: Math.round(tps * 10) / 10,
    ttft_ms: known ? Math.round(ttftMs) : null,
    generation_ms: Math.round(genMs),
    throughput_basis: known ? 'generation' : 'end_to_end',
  };
}
