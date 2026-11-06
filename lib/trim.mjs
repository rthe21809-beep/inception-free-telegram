// Conversation trimming.
//
// The free chat has its own context cap and answers
//   400 {"error":"This conversation is too long. Please start a new chat to continue."}
// when the history exceeds it. The bridge therefore keeps the request inside
// a character budget: the oldest turns are dropped first, the system message
// and the newest turn are always kept.

function textLen(m) {
  const c = m?.content;
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) {
    let n = 0;
    for (const part of c) {
      if (typeof part === 'string') n += part.length;
      else if (part && typeof part.text === 'string') n += part.text.length;
    }
    return n;
  }
  return 0;
}

function headLen(m) {
  const c = m?.content;
  if (typeof c === 'string') return 0;
  if (Array.isArray(c)) {
    let n = 0;
    for (const part of c) {
      if (part && typeof part.text === 'string') n += part.text.length;
    }
    return n;
  }
  return 0;
}

function truncateTail(m, max) {
  const out = { ...m };
  if (typeof out.content === 'string') {
    out.content = out.content.length > max ? '…' + out.content.slice(-max) : out.content;
  } else if (Array.isArray(out.content)) {
    // keep the newest text parts
    const kept = [];
    let used = 0;
    for (let i = out.content.length - 1; i >= 0; i--) {
      const part = out.content[i];
      const len = typeof part === 'string' ? part.length : (part?.text?.length || 0);
      if (used + len > max && kept.length) continue;
      kept.unshift(part);
      used += len;
    }
    out.content = kept;
  }
  return out;
}

// Keep the conversation within maxChars.
// - the first message (system/instructions) is always kept
// - the newest message is always kept (truncated from the front if needed)
// - the oldest turns are dropped first
export function trimMessages(messages, maxChars) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return { messages: list, dropped: 0, before: 0, after: 0 };
  const before = list.reduce((a, m) => a + textLen(m), 0);
  const budget = Math.max(1000, Number(maxChars) || 0);
  if (before <= budget) return { messages: list, dropped: 0, before, after: before };

  const keep = new Array(list.length).fill(false);
  keep[0] = true;                         // system / instructions
  keep[list.length - 1] = true;           // the current question

  let used = textLen(list[0]) + textLen(list[list.length - 1]);
  for (let i = list.length - 2; i >= 1; i--) {
    const len = textLen(list[i]);
    if (used + len > budget) break;
    keep[i] = true;
    used += len;
  }

  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (!keep[i]) continue;
    if (i === list.length - 1 && used > budget) {
      out.push(truncateTail(list[i], Math.max(500, budget - textLen(list[0]))));
      used = budget;
    } else {
      out.push(list[i]);
    }
  }
  const after = out.reduce((a, m) => a + textLen(m), 0);
  return { messages: out, dropped: list.length - out.length, before, after };
}

// Approximate token count (good enough for budgeting).
export function approxTokens(chars) {
  return Math.ceil((chars || 0) / 4);
}
