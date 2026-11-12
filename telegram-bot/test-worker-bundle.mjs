// Verifies that the deployed worker bundle (dist/_worker.js, produced by
// scripts/cf-deploy.mjs) routes /api/* to the Pages Function, falls through to
// static assets, enforces auth, and sets security headers — i.e. that a
// wrangler-free REST deploy produces a working panel.
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIST = new URL('./admin-panel/dist/_worker.js', import.meta.url).pathname;

if (!existsSync(DIST)) {
  execFileSync(process.execPath, ['scripts/cf-deploy.mjs', '--dry-run'], { stdio: 'ignore' });
}
assert.ok(existsSync(DIST), 'cf-deploy --dry-run must emit dist/_worker.js');

const { default: worker } = await import(DIST);
const env = {
  ASSETS: { fetch: (req) => new Response('STATIC:' + new URL(req.url).pathname) },
  BOT_TOKEN: '123:abc',
  BOT_REPORT_SECRET: 's3cret',
  CONTROL_KV: { async get() { return null; }, async put() {}, async delete() {} },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (p, init) => worker.fetch(new Request('https://x.dev' + p, init), env, ctx);
const auth = { Authorization: 'Bearer s3cret' };

let r = await call('/');
assert.equal(r.status, 200);
assert.equal(await r.text(), 'STATIC:/', 'static assets must pass through env.ASSETS');

r = await call('/assets/index.js');
assert.equal(await r.text(), 'STATIC:/assets/index.js');

r = await call('/api/runtime-config');
assert.equal(r.status, 401, 'api without bearer must be 401');

r = await call('/api/runtime-config', { headers: auth });
assert.equal(r.status, 200, 'api with bearer must be 200');
const body = await r.json();
assert.ok(body && typeof body === 'object', 'runtime-config returns an object');

r = await call('/api/runtime-config', { headers: { Authorization: 'Bearer wrong' } });
assert.equal(r.status, 401, 'wrong secret must be rejected');

r = await call('/api/runtime-config', { headers: auth });
assert.equal(r.headers.get('x-frame-options'), 'DENY', 'security headers must be set');
assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

const src = await import('node:fs').then((fs) => fs.readFileSync(DIST + '', 'utf8'));
assert.ok(!/from\s+"node:/.test(src), 'bundle must not import node: modules');
assert.ok(!/\brequire\(/.test(src), 'bundle must not call require()');

console.log('all worker bundle checks passed');
