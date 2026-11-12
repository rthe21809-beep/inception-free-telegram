// Verifies the deployed worker bundle (dist/_worker.js, produced by
// scripts/cf-deploy.mjs) serves the real panel + API with NO env.ASSETS
// dependency (direct uploads don't reliably provide that binding), enforces
// auth, and surfaces errors instead of a blank 500.
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIST = new URL('./admin-panel/dist/_worker.js', import.meta.url).pathname;

execFileSync(process.execPath, ['scripts/cf-deploy.mjs', '--dry-run'], { stdio: 'ignore' });
assert.ok(existsSync(DIST), 'cf-deploy --dry-run must emit dist/_worker.js');

const src = readFileSync(DIST, 'utf8');
assert.ok(!/from\s+"node:/.test(src), 'bundle must not import node: modules');
assert.ok(!/\brequire\(/.test(src), 'bundle must not call require()');
assert.ok(!/process\.env/.test(src), 'bundle must not read process.env');

// Deliberately NO ASSETS binding: this is what broke the live deploy.
const { default: worker } = await import(DIST);
const env = {
  BOT_TOKEN: '123:abc',
  BOT_REPORT_SECRET: 's3cret',
  CONTROL_KV: { async get() { return null; }, async put() {}, async delete() {} },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (p, init) => worker.fetch(new Request('https://x.dev' + p, init), env, ctx);

// 1. the panel itself must render
let r = await call('/');
assert.equal(r.status, 200, 'GET / must not 500 without env.ASSETS');
const html = await r.text();
assert.match(r.headers.get('content-type'), /text\/html/);
assert.match(html, /<div id="root"/, 'must serve the React mount point');

// 2. referenced JS/CSS must be served from the inlined assets
const js = html.match(/\/assets\/[^"]+\.js/);
assert.ok(js, 'index.html must reference a built js bundle');
r = await call(js[0]);
assert.equal(r.status, 200);
assert.ok((await r.text()).length > 10000, 'js bundle must be non-trivial');
assert.match(r.headers.get('cache-control'), /immutable/);

const css = html.match(/\/assets\/[^"]+\.css/);
assert.ok(css, 'index.html must reference a css bundle');
r = await call(css[0]);
assert.equal(r.status, 200);

// 3. api auth
r = await call('/api/runtime-config');
assert.equal(r.status, 401, 'api without bearer must be 401');

r = await call('/api/runtime-config', { headers: { Authorization: 'Bearer s3cret' } });
assert.equal(r.status, 200, 'api with bearer must be 200');
const body = await r.json();
assert.ok(body && typeof body === 'object', 'runtime-config returns an object');

r = await call('/api/runtime-config', { headers: { Authorization: 'Bearer wrong' } });
assert.equal(r.status, 401, 'wrong secret must be rejected');

// 4. security headers
r = await call('/api/runtime-config', { headers: { Authorization: 'Bearer s3cret' } });
assert.equal(r.headers.get('x-frame-options'), 'DENY');
assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

console.log('all worker bundle checks passed');
