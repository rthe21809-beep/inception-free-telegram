// Official model metadata (docs.inceptionlabs.ai/get-started/models).
//
//   Model             Context (chat)   Max output
//   Mercury 3           1,000,000         131,072
//   Mercury 3 Decide         —                —
//
// Mercury 3 thinking levels upstream: instant | low | medium | high | max
// (the free chat exposes Mercury 3 and Mercury 3 Decide only).

export const OFFICIAL = {
  'mercury-3': { context_length: 1000000, max_output_tokens: 131072, family: 'mercury-3', default_effort: 'low' },
  'mercury-3-decide': { context_length: 1000000, max_output_tokens: 131072, family: 'mercury-3-decide', default_effort: 'low' },
};

export const EFFORTS = ['instant', 'low', 'medium', 'high', 'max'];

export function metaFor(id) {
  if (!id) return null;
  const key = String(id).toLowerCase();
  if (OFFICIAL[key]) return OFFICIAL[key];
  return null;
}
