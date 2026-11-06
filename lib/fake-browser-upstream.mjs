// Test-only stand-in for the Chromium browser upstream.
//
// Enabled with BRIDGE_FAKE_BROWSER=1 so the whole server path (live
// streaming, reasoning, tool shim, usage) can be exercised without a phone
// or a browser. It replays the same chunk shapes the real site sends.

const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEFAULT_CHUNKS = [
  { type: 'reasoning-delta', delta: 'Let me work through this step by step. ' },
  { type: 'reasoning-delta', delta: '37*40 = 1480, 37*3 = 111, total 1591.' },
  { type: 'text-delta', delta: 'The answer is 1591.' },
  { type: 'finish', finishReason: 'stop' },
];

const TOOL_CHUNKS = [
  { type: 'reasoning-delta', delta: 'I need to write the file.' },
  { type: 'text-delta', delta: "Writing the file now.\n<write file='/sdcard/Download/hello.txt'>hello world</write>" },
  { type: 'finish', finishReason: 'stop' },
];

const THINK_CHUNKS = [
  { type: 'text-delta', delta: '<think>First I restate the problem. </think>' },
  { type: 'text-delta', delta: '<think>Then I solve it: 1591.</think>' },
  { type: 'text-delta', delta: 'The answer is 1591.' },
  { type: 'finish', finishReason: 'stop' },
];

export class FakeBrowserUpstream {
  constructor({ delayMs = 15, rejectEffort = false } = {}) {
    this.delayMs = delayMs;
    this.rejectEffort = rejectEffort;
    this.dropped = [];
  }

  _chunksFor(body) {
    const text = JSON.stringify(body?.messages || []);
    if (/EMPTYTEST/.test(text)) return [];
    if (/TOOLTEST/.test(text)) return TOOL_CHUNKS;
    if (/THINKTEST/.test(text)) return THINK_CHUNKS;
    return DEFAULT_CHUNKS;
  }

  async *stream(body, bearer, { extra = null } = {}) {
    if (extra && extra.reasoning_effort && this.rejectEffort) {
      // the real site rejects the field and the page retries minimal
      this.dropped = Object.keys(extra);
    }
    for (const c of this._chunksFor(body)) {
      await sleep(this.delayMs);
      yield c;
    }
    yield { type: 'debug', model: body?.model || null, extra: extra || null };
  }

  async complete(body, bearer, { extra = null } = {}) {
    if (extra && extra.reasoning_effort && this.rejectEffort) {
      this.dropped = Object.keys(extra);
    }
    await sleep(this.delayMs);
    return { status: 200, chunks: this._chunksFor(body), errBody: '', debug: { fake: true } };
  }

  async droppedFields() { return this.dropped; }
  async reload() {}
  async stop() {}
  async probeSite() { return { out: [], uiLabels: [] }; }
}
