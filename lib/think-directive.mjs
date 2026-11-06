// Reasoning scraper.
//
// The bridge never changes how the model reasons — no injected directives, no
// prompt rewriting, because that would make the model generate extra tokens
// and slow it down. The model thinks (or does not) on its own, and the bridge
// simply separates whatever reasoning it produces from the answer:
//
//   * native reasoning chunks  (reasoning-delta / thinking-delta events)
//   * a <think>…</think> block  (some builds expose their reasoning that way)
//
// Both are streamed live, so the thinking panel fills while the model is
// still generating. If the model does not think, there is nothing to scrape
// and the answer is passed through untouched.

// Length of the longest suffix of `s` that is a proper prefix of `tag`
// (i.e. the tag was split across chunks and is still incomplete).
function partialTagLen(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

// Live splitter: turns a text stream into reasoning / content streams.
export class ThinkSplitter {
  constructor() {
    this.mode = 'pre';   // pre -> in -> post
    this.buf = '';
  }

  push(text) {
    const out = { reasoning: '', content: '' };
    if (!text) return out;
    let t = this.buf + text;
    this.buf = '';
    // a model may emit several <think> blocks in one answer
    while (t) {
      if (this.mode === 'pre') {
        const i = t.indexOf('<think>');
        if (i < 0) {
          // the opening tag may still be split across chunks — hold the tail
          const hold = partialTagLen(t, '<think>');
          out.content += t.slice(0, t.length - hold);
          this.buf = t.slice(t.length - hold);
          return out;
        }
        out.content += t.slice(0, i);
        t = t.slice(i + '<think>'.length);
        this.mode = 'in';
        continue;
      }
      if (this.mode === 'in') {
        const j = t.indexOf('</think>');
        if (j < 0) {
          // hold back a partially received closing tag
          const hold = partialTagLen(t, '</think>');
          out.reasoning += t.slice(0, t.length - hold);
          this.buf = t.slice(t.length - hold);
          return out;
        }
        out.reasoning += t.slice(0, j);
        t = t.slice(j + '</think>'.length);
        this.mode = 'post';
        continue;
      }
      // post mode: another reasoning block may follow
      const k = t.indexOf('<think>');
      if (k < 0) {
        out.content += t;
        return out;
      }
      out.content += t.slice(0, k);
      t = t.slice(k + '<think>'.length);
      this.mode = 'in';
    }
    return out;
  }

  flush() {
    const rest = this.buf;
    this.buf = '';
    if (!rest) return { reasoning: '', content: '' };
    if (this.mode === 'in') return { reasoning: rest, content: '' };
    return { reasoning: '', content: rest };
  }
}

// One-shot variant for buffered answers.
export function extractThink(text) {
  if (!text || !text.includes('<think>')) return { reasoning: '', content: text || '' };
  const sp = new ThinkSplitter();
  const out = sp.push(text);
  const tail = sp.flush();
  return {
    reasoning: out.reasoning + tail.reasoning,
    content: out.content + tail.content,
  };
}
