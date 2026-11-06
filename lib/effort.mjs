// Reasoning-effort normalization.
//
// Mercury 3 thinking levels (the platform's own chat UI uses exactly these):
//   instant | low | medium | high | max
// The DSH selection maps onto them as:
//   off -> instant, low -> low, medium -> medium, high -> max
// Clients that send an OpenAI-style spelling are normalized here:
//   off / none / minimal -> instant
//   xhigh                -> max
// Everything else is passed through untouched, so the platform decides.

export const REAL_EFFORTS = ['instant', 'low', 'medium', 'high', 'max'];

const MAP = {
  off: 'instant',
  none: 'instant',
  no: 'instant',
  minimal: 'instant',
  instant: 'instant',
  low: 'low',
  medium: 'medium',
  normal: 'medium',
  default: 'medium',
  high: 'high',
  max: 'max',
  maximum: 'max',
  xhigh: 'max',
  'x-high': 'max',
  'x_high': 'max',
  extreme: 'max',
};

export function normalizeEffort(value) {
  if (value === undefined || value === null || value === false) return '';
  if (value === true) return 'medium';
  const v = String(value).trim().toLowerCase();
  if (!v) return '';
  return MAP[v] || (REAL_EFFORTS.includes(v) ? v : '');
}

// Pull the reasoning effort out of an OpenAI-style request body, accepting
// the common spellings clients use.
export function effortFromBody(body, modelOverride = '') {
  const candidates = [
    body.reasoning_effort,
    body.reasoningEffort,
    body.thinking_effort,
    body.thinkingEffort,
    typeof body.thinking === 'string' ? body.thinking : undefined,
    typeof body.reasoning === 'string' ? body.reasoning : undefined,
  ];
  for (const c of candidates) {
    const e = normalizeEffort(c);
    if (e) return e;
  }
  // a boolean "thinking" flag only means "on"; the level comes from elsewhere
  if (body.thinking === true) return 'medium';
  const m = modelOverride || body.model || '';
  if (/[\-_]thinking$/i.test(String(m))) return 'medium';
  return '';
}
