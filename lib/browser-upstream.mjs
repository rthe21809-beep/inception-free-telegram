// Browser-context upstream: performs /api/chat/completions inside a real
// Chromium page (via CDP), so the request is byte-identical to what the
// website itself sends — TLS fingerprint, cookies, headers, everything.
// Used as a fallback when plain HTTP is blocked by the Vercel checkpoint.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForJsonVersion(port, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
    };
  }
  send(method, params = {}, timeout = 60000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeout);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

export const JOB_SCRIPT = `
(() => {
  window.__chunks = [];
  window.__status = 0;
  window.__error = null;
  window.__done = false;
  window.__contentType = '';
  window.__preview = '';
  window.__job = (async () => {
    const summary = () => ({ status: window.__status, chunks: window.__chunks, error: window.__error, done: window.__done, contentType: window.__contentType, preview: window.__preview });
    try {
      const payload = window.__payload;
      const s = await (await fetch('/api/session')).json();
      const tok = s && s.token;
      const msgId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
      const normRole = r => (r === 'assistant' ? 'assistant' : 'user');
      const msgs = (payload.messages || []).map(m => ({
        role: normRole(m.role),
        parts: Array.isArray(m.content)
          ? m.content.map(p => ({ type: p.type || 'text', text: typeof p === 'string' ? p : (p.text || p.content || '') }))
          : [{ type: 'text', text: String(m.content || '') }]
      }));
      const PASSTHROUGH = ['temperature','top_p','max_tokens','min_p','stop','presence_penalty','frequency_penalty','seed','repetition_penalty','diffusing'];
      const EFFORT_KEYS = ['reasoning_effort','reasoningEffort','thinking','enable_thinking','effort','reasoning','reasoning_level','reasoningLevel','thinking_level','thinkingLevel'];
      let model = payload.model || 'mercury';
      const extra = {};
      for (const k of PASSTHROUGH) if (payload[k] !== undefined && extra[k] === undefined) extra[k] = payload[k];
      for (const k of EFFORT_KEYS) if (payload[k] !== undefined && extra[k] === undefined) extra[k] = payload[k];
      const baseBody = { model, messages: msgs, stream: true, messageId: msgId, trigger: 'submit-message' };
      if (window.__extra) for (const [k, v] of Object.entries(window.__extra)) if (v !== undefined) extra[k] = v;
      const post = async (bodyObj) => {
        const opts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-token': tok },
          body: JSON.stringify(bodyObj)
        };
        try {
          return await fetch('/api/chat', opts);
        } catch (e) {
          // a transient network error inside the page: wait and try once more
          await new Promise(r => setTimeout(r, 900));
          return await fetch('/api/chat', opts);
        }
      };
      // staged fallback: the site answers 400 for fields it does not know
      //   1) every field  2) only the effort field  3) the bare body
      let dropped = [];
      let r = null;
      let fetchError = '';
      try {
        r = await post({ ...baseBody, ...extra });
        if (!r.ok && Object.keys(extra).length) {
          const effortOnly = {};
          for (const k of EFFORT_KEYS) if (extra[k] !== undefined) effortOnly[k] = extra[k];
          dropped = Object.keys(extra).filter(k => !(k in effortOnly));
          window.__error = 'retry-effort-only after ' + r.status;
          r = await post({ ...baseBody, ...effortOnly });
          if (!r.ok && Object.keys(effortOnly).length) {
            dropped = dropped.concat(Object.keys(effortOnly));
            window.__error = 'retry-minimal after ' + r.status;
            r = await post(baseBody);
          }
        }
      } catch (e) {
        fetchError = String(e && e.message ? e.message : e);
      }
      window.__dropped = dropped;
      if (fetchError || !r) {
        window.__error = 'fetch failed: ' + (fetchError || 'no response');
        window.__status = 0;
        return;
      }
      window.__status = r.status;
      window.__contentType = r.headers.get('content-type') || '';
      if (!r.ok) {
        window.__error = await r.text();
        window.__done = true;
        return summary();
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let sawData = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\\r$/, '').trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          sawData = true;
          const content = line.slice(5).trim();
          if (!content) continue;
          if (content === '[DONE]') continue;
          try {
            window.__chunks.push(JSON.parse(content));
          } catch {
            window.__chunks.push({ content });
          }
        }
      }
      if (!sawData) {
        window.__preview = buf.slice(0, 500);
        try {
          if (buf.trim()) window.__chunks.push(JSON.parse(buf.trim()));
        } catch { window.__chunks.push({ content: buf }); }
      }
      window.__done = true;
      return summary();
    } catch (e) {
      window.__error = String(e);
      window.__done = true;
      return summary();
    }
  })();
  return window.__job;
})()
`;

// Page-side incremental job: pushes every SSE chunk into window.__stream as
// soon as it arrives, so the bridge can forward deltas live (true TTFT).
export const STREAM_JOB = `
(() => {
  window.__stream = { status: 0, chunks: [], error: '', done: false, startedAt: Date.now() };
  window.__streamJob = (async () => {
    const st = window.__stream;
    try {
      const payload = window.__payload;
      const s = await (await fetch('/api/session')).json();
      const tok = s && s.token;
      const msgId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
      const normRole = r => (r === 'assistant' ? 'assistant' : 'user');
      const msgs = (payload.messages || []).map(m => ({
        role: normRole(m.role),
        parts: Array.isArray(m.content)
          ? m.content.map(p => ({ type: p.type || 'text', text: typeof p === 'string' ? p : (p.text || p.content || '') }))
          : [{ type: 'text', text: String(m.content || '') }]
      }));
      const PASSTHROUGH = ['temperature','top_p','max_tokens','min_p','stop','presence_penalty','frequency_penalty','seed','repetition_penalty','diffusing'];
      const EFFORT_KEYS = ['reasoning_effort','reasoningEffort','thinking','enable_thinking','effort','reasoning','reasoning_level','reasoningLevel','thinking_level','thinkingLevel'];
      let model = payload.model || 'mercury';
      const extra = {};
      for (const k of PASSTHROUGH) if (payload[k] !== undefined && extra[k] === undefined) extra[k] = payload[k];
      for (const k of EFFORT_KEYS) if (payload[k] !== undefined && extra[k] === undefined) extra[k] = payload[k];
      if (window.__extra) for (const [k, v] of Object.entries(window.__extra)) if (v !== undefined) extra[k] = v;
      const baseBody = { model, messages: msgs, stream: true, messageId: msgId, trigger: 'submit-message' };
      const post = async (bodyObj) => {
        const opts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-session-token': tok },
          body: JSON.stringify(bodyObj)
        };
        try {
          return await fetch('/api/chat', opts);
        } catch (e) {
          // a transient network error inside the page: wait and try once more
          await new Promise(r => setTimeout(r, 900));
          return await fetch('/api/chat', opts);
        }
      };
      let dropped = [];
      let r = null;
      let fetchError = '';
      try {
        r = await post({ ...baseBody, ...extra });
        if (!r.ok && Object.keys(extra).length) {
          const effortOnly = {};
          for (const k of EFFORT_KEYS) if (extra[k] !== undefined) effortOnly[k] = extra[k];
          dropped = Object.keys(extra).filter(k => !(k in effortOnly));
          st.error = 'retry-effort-only after ' + r.status;
          r = await post({ ...baseBody, ...effortOnly });
          if (!r.ok && Object.keys(effortOnly).length) {
            dropped = dropped.concat(Object.keys(effortOnly));
            st.error = 'retry-minimal after ' + r.status;
            r = await post(baseBody);
          }
        }
      } catch (e) {
        fetchError = String(e && e.message ? e.message : e);
      }
      st.dropped = dropped;
      if (fetchError || !r) {
        st.error = 'fetch failed: ' + (fetchError || 'no response');
        st.done = true;
        return;
      }
      st.status = r.status;
      if (!r.ok) {
        st.error = (await r.text()).slice(0, 800);
        st.done = true;
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\\r$/, '').trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const content = line.slice(5).trim();
          if (!content || content === '[DONE]') continue;
          try { st.chunks.push(JSON.parse(content)); }
          catch { st.chunks.push({ content }); }
        }
      }
      if (buf.trim()) {
        try { st.chunks.push(JSON.parse(buf.trim())); } catch { st.chunks.push({ content: buf }); }
      }
      st.done = true;
    } catch (e) {
      st.error = String(e);
      st.done = true;
    }
  })();
  return true;
})()
`;

export class BrowserUpstream {
  constructor({ chromiumPath, portBase = 9800, timeoutMs = 120000 } = {}) {
    this.chromiumPath = chromiumPath;
    this.portBase = portBase;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.cdp = null;
    this.ready = false;
    this.queue = Promise.resolve();
    this.finalizing = null;
  }

  async start() {
    if (this.ready) return;
    const port = this.portBase + Math.floor(Math.random() * 400);
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bup-'));
    const args = [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--mute-audio',
      '--disable-extensions',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--headless=new',
      'https://chat.inceptionlabs.ai/',
    ];
    this.child = spawn(this.chromiumPath, args, { stdio: 'ignore' });
    this.profile = profile;
    this.child.on('error', (e) => {
      this.ready = false;
      console.log(`[browser] chromium failed to start: ${String(e).slice(0, 160)}`);
    });

    try {
      const ready = await waitForJsonVersion(port, 30000);
      if (!ready) throw new Error('browser CDP did not come up');
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const tabs = await r.json();
      const tab = tabs.find(t => t.type === 'page') || tabs[0];
      if (!tab?.webSocketDebuggerUrl) throw new Error('no page target');

      this.cdp = new CDP(tab.webSocketDebuggerUrl);
      await this.cdp.connect();
      await this.cdp.send('Page.enable');
      await this.cdp.send('Runtime.enable');

      // wait for the app (not the checkpoint) to load
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        const res = await this.cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }).catch(() => ({}));
        const title = res?.result?.value ?? '';
        if (title && !title.includes('Vercel Security Checkpoint')) break;
        await sleep(2500);
      }
      this.ready = true;
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  // Every page operation shares ONE tab. Running two at once (e.g. a probe
  // and a live request) makes them clobber each other's window.__payload and
  // the requests come back empty. All page work is serialised here.
  async _withLock(fn) {
    const prev = this._lock || Promise.resolve();
    let release;
    this._lock = new Promise((r) => { release = r; });
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      try { release(); } catch {}
    }
  }

  async reload() {
    if (!this.cdp) return;
    try { await this.cdp.send('Page.reload'); } catch {}
    await this.ensureAppReady();
  }

  // The tab must sit on the chat site for same-origin fetches to work.
  async ensureOnSite() {
    const res = await this.cdp.send('Runtime.evaluate', {
      expression: 'location.origin + "|" + document.readyState + "|" + (document.title || "")',
      returnByValue: true,
    }).catch(() => ({}));
    const v = String(res?.result?.value ?? '');
    const origin = v.split('|')[0] || '';
    const title = v.split('|')[2] || '';
    if (origin.includes('inceptionlabs.ai') && !/Vercel Security Checkpoint/i.test(title)) return true;
    console.log(`[browser] page is not on the chat site (${origin || 'unknown'}) — navigating back`);
    try {
      await this.cdp.send('Page.navigate', { url: 'https://chat.inceptionlabs.ai/' });
    } catch {}
    await this.ensureAppReady();
    return true;
  }

  async ensureAppReady() {
    if (!this.ready) await this.start();
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const res = await this.cdp.send('Runtime.evaluate', { expression: 'document.title + "|" + location.pathname', returnByValue: true }).catch(() => ({}));
      const v = String(res?.result?.value ?? '');
      if (v && !v.includes('Vercel')) return;
      try { await this.cdp.send('Page.reload'); } catch {}
      await sleep(2500);
    }
  }

  // run one completion through the browser context.
  // Probe the site's own API for the model list / chat configuration.
  // Runs same-origin inside the logged-in page, so no checkpoint involved.
  async probeSite() {
    return this._withLock(async () => {
      await this.ensureAppReady();
      await this.ensureOnSite();
    const expr = `(async () => {
      const paths = ['/api/models', '/api/chat/models', '/api/model', '/api/config', '/api/chat/config', '/api/settings', '/api/user', '/api/credits', '/api/session'];
      const out = [];
      for (const path of paths) {
        try {
          const r = await fetch(path, { credentials: 'include' });
          const t = await r.text();
          out.push({ path, status: r.status, body: t.slice(0, 2000) });
        } catch (e) {
          out.push({ path, error: String(e) });
        }
      }
      const uiLabels = Array.from(document.querySelectorAll('button,[role="menuitem"],[role="option"],select option,label'))
        .map(el => (el.textContent || '').trim())
        .filter(s => s && /mercury|lambda|coder|think|reason|effort|instant|diffus|model/i.test(s));
      return { out, uiLabels: Array.from(new Set(uiLabels)).slice(0, 60), url: location.href };
    })()`;
    const res = await this.cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (res?.exceptionDetails) {
      throw new Error('probe eval: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown'));
    }
    return res?.result?.value ?? {};
    });
  }

  async complete(body, bearer, { extra = null } = {}) {
    return this._withLock(() => this._completeLocked(body, bearer, { extra }));
  }

  async _completeLocked(body, bearer, { extra = null } = {}) {
    await this.ensureAppReady();
    await this.ensureOnSite();
    const run = async () => {
      // JSON.stringify output is valid JS — insert raw, no manual escaping.
      const expr = `window.__bearer = ${JSON.stringify(String(bearer))}; window.__payload = ${JSON.stringify(body)}; window.__extra = ${JSON.stringify(extra || null)}; ${JOB_SCRIPT}`;
      let res;
      try {
        res = await this.cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      } catch (e) {
        // CDP channel died — mark browser dead so the caller restarts it
        this.ready = false;
        throw e;
      }
      if (res?.exceptionDetails) {
        this.ready = false;
        throw new Error('page eval: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown'));
      }
      const v = res?.result?.value ?? {};
      const status = windowStatusOf(v);
      const chunks = Array.isArray(v.chunks) ? v.chunks : [];
      return {
        status,
        chunks,
        errBody: windowErrorOf(v),
        debug: {
          contentType: v.contentType || '',
          preview: v.preview || '',
          done: !!v.done,
          raw: JSON.stringify(v).slice(0, 800),
          title: await this.cdp.send('Runtime.evaluate', { expression: 'document.title + "|" + location.href', returnByValue: true }).then(r => r?.result?.value ?? '').catch(() => ''),
        },
      };
    };
    // serialize completions (one browser, one job at a time)
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        this.queue = this.queue.then(() => run().then(resolve, reject));
      });
    } catch (e) {
      // browser went stale: restart once and retry a single time
      await this.stop();
      await this.start();
      result = await new Promise((resolve, reject) => {
        this.queue = this.queue.then(() => run().then(resolve, reject));
      });
    }
    return result;
  }

  // Live streaming: yields upstream chunks as they arrive in the page.
  async *stream(body, bearer, { pollMs = 70, timeoutMs = 240000, stallMs = 60000, extra = null } = {}) {
    // hold the lock for the whole stream so nothing else touches the tab
    let release;
    const prev = this._lock || Promise.resolve();
    this._lock = new Promise((r) => { release = r; });
    await prev.catch(() => {});
    try {
      yield* this._streamLocked(body, bearer, { pollMs, timeoutMs, stallMs, extra });
    } finally {
      try { release(); } catch {}
    }
  }

  async *_streamLocked(body, bearer, { pollMs = 70, timeoutMs = 240000, stallMs = 60000, extra = null } = {}) {
    await this.ensureAppReady();
    await this.ensureOnSite();
    const prev = this.queue;
    let release;
    this.queue = new Promise((r) => { release = r; });
    await prev.catch(() => {});
    try {
      const expr = `window.__bearer = ${JSON.stringify(String(bearer))}; window.__payload = ${JSON.stringify(body)}; window.__extra = ${JSON.stringify(extra || null)}; ${STREAM_JOB}`;
      const started = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (started?.exceptionDetails) {
        throw new Error('page script failed to start: ' + (started.exceptionDetails.exception?.description || started.exceptionDetails.text || 'unknown').split('\n')[0]);
      }
      let idx = 0;
      let lastProgress = Date.now();
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const stRes = await this.cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify({ started: !!window.__stream, s: window.__stream?.status || 0, e: window.__stream?.error || '', d: !!window.__stream?.done, n: (window.__stream?.chunks || []).length })`,
          returnByValue: true,
        }).catch(() => null);
        const st = JSON.parse(stRes?.result?.value || '{}');
        if (st.started === false) {
          throw new Error('page job did not start (window.__stream missing)');
        }
        if ((st.n || 0) > idx) {
          const sliceRes = await this.cdp.send('Runtime.evaluate', {
            expression: `JSON.stringify((window.__stream?.chunks || []).slice(${idx}))`,
            returnByValue: true,
          }).catch(() => null);
          const arr = JSON.parse(sliceRes?.result?.value || '[]');
          for (const c of arr) { idx++; yield c; }
          lastProgress = Date.now();
        } else if (st.d) {
          lastProgress = Date.now();
        }
        // a dead page job must not hang the request for minutes
        if (Date.now() - lastProgress > stallMs) {
          throw new Error(`upstream stalled: no data for ${Math.round(stallMs / 1000)}s (status=${st.s || 0}, error=${String(st.e || '').slice(0, 200)})`);
        }
        if (st.d) {
          if (st.s && st.s !== 200) {
            const err = new Error(`upstream HTTP ${st.s}: ${String(st.e || '').slice(0, 300)}`);
            err.upstreamStatus = st.s;
            throw err;
          }
          return;
        }
        await new Promise(r => setTimeout(r, pollMs));
      }
      throw new Error('browser stream timeout');
    } finally {
      release();
    }
  }

  // Fields the upstream rejected (the request was retried without them).
  async droppedFields() {
    const res = await this.cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__stream?.dropped || window.__dropped || [])',
      returnByValue: true,
    }).catch(() => null);
    try { return JSON.parse(res?.result?.value || '[]'); } catch { return []; }
  }

  async stop() {
    if (this.finalizing) return this.finalizing;
    this.finalizing = (async () => {
      if (this.cdp) try { this.cdp.close(); } catch {}
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill('SIGKILL');
      }
      if (this.child) {
        await new Promise(res => {
          const t = setTimeout(() => res(), 3000);
          this.child.once('exit', () => { clearTimeout(t); res(); });
        });
      }
      if (this.profile) {
        for (let i = 0; i < 10; i++) {
          try { fs.rmSync(this.profile, { recursive: true, force: true }); break; }
          catch { await sleep(300); }
        }
      }
      this.ready = false;
    })();
    return this.finalizing;
  }
}

function windowStatusOf(v) {
  if (!v || typeof v !== 'object') return 0;
  if (Number.isInteger(v.status)) return v.status;
  if (v.error) return 502;
  return 0;
}

function windowErrorOf(v) {
  if (!v || typeof v !== 'object') return '';
  return v.error || '';
}
