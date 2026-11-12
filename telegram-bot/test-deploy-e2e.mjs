// Runs scripts/cf-deploy.mjs end to end against a stubbed Cloudflare API.
//
// This exists because `node --check` passed while the deployer referenced an
// undefined mimeFor(): syntax checks cannot catch that, and the real API only
// reported it as "FAILED: mimeFor is not defined" on the user's phone.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'depl-'));
const rec = join(dir, 'calls.json');
const stub = join(dir, 'stub.mjs');

// Stub fetch: record every call, answer like the Pages API does.
writeFileSync(stub, `
import { writeFileSync } from 'node:fs';
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  let parsed = null;
  if (typeof body === 'string') { try { parsed = JSON.parse(body); } catch {} }
  let form = null;
  if (body && typeof body.entries === 'function') {
    form = {};
    for (const [k, v] of body.entries()) form[k] = typeof v === 'string' ? v : '[blob]';
  }
  calls.push({ url: u, method, parsed, form, isFormData: body && typeof body.append === 'function' });
  writeFileSync(${JSON.stringify(rec)}, JSON.stringify(calls));
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('/upload-token')) return json({ success: true, result: { jwt: 'fake.jwt.token' } });
  if (u.includes('/pages/assets/check-missing')) return json({ success: true, result: (parsed && parsed.hashes) || [] });
  if (u.includes('/pages/assets/upload')) return json({ success: true, result: null });
  if (u.includes('/pages/assets/upsert-hashes')) return json({ success: true, result: null });
  if (u.includes('/pages/projects') && method === 'GET') return json({ success: true, result: { name: 'inception-panel', production_branch: 'main', kv_namespaces: [], env_vars: {} } });
  if (u.includes('/deployments') && method === 'POST') return json({ success: true, result: { id: 'd1', url: 'https://abc12345.inception-panel.pages.dev', environment: 'production' } });
  if (u.includes('/pages/projects') && method === 'PATCH') return json({ success: true, result: {} });
  // the verification fetch of the live site
  if (u.startsWith('https://inception-panel.pages.dev')) return new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } });
  if (u.includes('/accounts')) return json({ success: true, result: [{ id: 'acct123', name: 'test' }] });
  return json({ success: true, result: {} });
};
`);

const r = spawnSync(process.execPath, ['--import', stub, 'scripts/cf-deploy.mjs'], {
  encoding: 'utf8',
  env: { ...process.env, CLOUDFLARE_API_TOKEN: 'fake-token', CONTROL_KV_ID: 'fake-kv', BOT_TOKEN: 'fake-bot', BOT_REPORT_SECRET: 'fake-secret' },
});

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n} ${extra}`); } };

const out = (r.stdout || '') + (r.stderr || '');
ok('deployer exits 0', r.status === 0, `status=${r.status}\n${out.slice(-1200)}`);
ok('no "is not defined" error', !/is not defined/.test(out), out.slice(-400));

let calls = [];
try { calls = JSON.parse(readFileSync(rec, 'utf8')); } catch {}
const by = (s) => calls.find((c) => c.url.includes(s));
ok('got a JWT from upload-token', !!by('/upload-token'));
ok('called check-missing', !!by('/pages/assets/check-missing'));
ok('uploaded assets', !!by('/pages/assets/upload'));

const up = by('/pages/assets/upload');
if (up && Array.isArray(up.parsed)) {
  ok('every asset has a 32-hex key', up.parsed.every((a) => /^[0-9a-f]{32}$/.test(a.key)));
  ok('every asset has base64 flag', up.parsed.every((a) => a.base64 === true));
  ok('every asset has a contentType', up.parsed.every((a) => a.metadata && typeof a.metadata.contentType === 'string' && a.metadata.contentType.length > 0));
  ok('no octet-stream for html/js', up.parsed.every((a) => a.metadata.contentType !== 'application/octet-stream'));
} else if (up && Array.isArray(up.parsed) && up.parsed.length === 0) {
  ok('upload payload is a JSON array', false, 'upload happened but payload was empty');
} else { ok('upload payload is a JSON array', false); }

const dep = calls.find((c) => c.url.includes('/deployments') && c.method === 'POST');
ok('created the deployment', !!dep);
ok('deployment sent as FormData', !!(dep && dep.isFormData));
ok('deployed to main branch', !!(dep && dep.form && dep.form.branch === 'main'), dep && dep.form && JSON.stringify(dep.form.branch));
let man = null;
try { man = JSON.parse(dep.form.manifest); } catch {}
ok('manifest is keyed with leading slash', !!man && Object.keys(man).length > 0 && Object.keys(man).every((k) => k.startsWith('/')), man && Object.keys(man).join(','));
ok('manifest values are blake3 keys', !!man && Object.values(man).every((v) => /^[0-9a-f]{32}$/.test(v)));

console.log(fail ? `\n${fail} FAILED` : '\nall deploy e2e checks passed');
process.exit(fail ? 1 : 0);
