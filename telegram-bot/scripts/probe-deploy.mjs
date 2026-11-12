// Bisection probe: deploys four isolated Pages projects to determine WHY the
// panel 500s with an empty body. Plain-text answers, one command.
//
//   A  static only, no _worker.js      -> is plain static serving OK?
//   B  trivial _worker.js only         -> does advanced mode work at all?
//   C  our real _worker.js + real dist -> is OUR bundle the problem?
//   D  real dist + trivial worker      -> are the assets fine next to a worker?
//
// env: CLOUDFLARE_API_TOKEN (required), CLOUDFLARE_ACCOUNT_ID (optional)
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, extname } from 'node:path';

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) { console.error('ERROR: set CLOUDFLARE_API_TOKEN'); process.exit(1); }
const API = 'https://api.cloudflare.com/client/v4';
const DIST = process.env.DIST_DIR || 'admin-panel/dist';
const BASE = process.env.PROBE_BASE || 'inception-panel-probe';

async function cf(path, init = {}) {
  const r = await fetch(API + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + TOKEN, ...(init.headers || {}) },
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok || (j && j.success === false)) {
    const errs = (j && j.errors || []).map((e) => e.message || JSON.stringify(e)).join('; ');
    throw new Error(`${init.method || 'GET'} ${path} -> ${r.status} ${errs || t.slice(0, 200)}`);
  }
  return j;
}

async function acct() {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
  const j = await cf('/accounts?per_page=1');
  if (!j.result?.length) throw new Error('no accounts on this token');
  return j.result[0].id;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function deploy(A, name, files) {
  await cf(`/accounts/${A}/pages/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, production_branch: 'main' }),
  }).catch((e) => { if (!/already exists|8000007|8000012/i.test(e.message)) throw e; });

  const form = new FormData();
  const manifest = {};
  for (const [p, buf] of Object.entries(files)) {
    const h = sha(buf);
    manifest[p] = h;
  }
  form.set('manifest', JSON.stringify(manifest));
  form.set('branch', 'main');
  for (const [p, buf] of Object.entries(files)) {
    const h = sha(buf);
    const type = extname(p) === '.html' ? 'text/html'
      : extname(p) === '.js' ? 'application/javascript'
      : extname(p) === '.css' ? 'text/css' : 'application/octet-stream';
    form.append(h, new Blob([buf], { type }), h);
  }
  const dep = await cf(`/accounts/${A}/pages/projects/${name}/deployments`, { method: 'POST', body: form });
  return { name, url: `https://${name}.pages.dev`, id: dep.result && dep.result.id };
}

const HELLO = Buffer.from(
  'export default { async fetch() { return new Response("WORKER OK", ' +
  '{ headers: { "content-type": "text/plain" } }); } };\n'
);
const HELLO_HTML = Buffer.from('<!doctype html><h1>STATIC OK</h1>\n');

function realDist() {
  if (!existsSync(join(DIST, '_worker.js'))) throw new Error(`missing ${DIST}/_worker.js — run npm run build + cf-deploy --dry-run`);
  const out = {};
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      out['/' + relative(DIST, p).split('\\').join('/')] = readFileSync(p);
    }
  })(DIST);
  return out;
}

async function stageInfo(A, name) {
  try {
    const j = await cf(`/accounts/${A}/pages/projects/${name}/deployments?per_page=1`);
    const d = j.result && j.result[0];
    if (!d) return 'no deployment';
    const st = d.latest_stage || {};
    const bits = [`stage=${st.name || '?'}/${st.status || '?'}`];
    if (d.deployment_trigger && d.deployment_trigger.metadata) {
      const m = d.deployment_trigger.metadata;
      if (m.commit_message) bits.push('msg=' + String(m.commit_message).slice(0, 60));
    }
    if (st.status === 'failure') bits.push('*** FAILED ***');
    return bits.join(' ');
  } catch (e) { return 'probe err: ' + e.message.slice(0, 80); }
}

const A = await acct();
console.log('account ' + A + '\n');

const real = realDist();
const staticOnly = Object.fromEntries(Object.entries(real).filter(([k]) => k !== '/_worker.js'));

// A: pure static.      -> is plain static serving OK on this account?
// B: trivial worker.   -> does Pages advanced mode work at all?
// C: our real bundle.  -> is OUR bundle the thing that dies?
// D: real files + hello worker -> are the real asset files OK?
const plan = [
  ['A', 'static only',          { '/index.html': HELLO_HTML }],
  ['B', 'hello worker',         { '/index.html': HELLO_HTML, '/_worker.js': HELLO }],
  ['C', 'real bundle',          real],
  ['D', 'real files+hello wkr', { ...staticOnly, '/_worker.js': HELLO }],
];
const urls = {};
for (const [k, label, files] of plan) {
  const name = `${BASE}-${k.toLowerCase()}`;
  const d = await deploy(A, name, files);
  urls[k] = d.url;
  console.log(`${k} ${label.padEnd(22)} ${d.url}   [${await stageInfo(A, name)}]`);
}

console.log('\nwaiting 25s for propagation…');
await new Promise((r) => setTimeout(r, 25000));

async function probe(url) {
  try {
    const r = await fetch(url + '/?probe=' + Date.now(), { redirect: 'manual' });
    const t = await r.text();
    return { code: r.status, len: t.length, body: t.slice(0, 60).replace(/\s+/g, ' ') };
  } catch (e) { return { code: 0, len: 0, body: String(e.message).slice(0, 60) }; }
}

const res = {};
for (const k of Object.keys(urls)) res[k] = await probe(urls[k]);
console.log('');
for (const k of Object.keys(urls)) {
  const r = res[k];
  console.log(`${k}  http=${r.code} bytes=${r.len}  ${r.body}`);
}

const okA = res.A.code === 200, okB = res.B.code === 200, okC = res.C.code === 200;
console.log('\n================ VERDICT ================');
if (!okA) {
  console.log('A (static only) is broken -> the PROJECT/ACCOUNT is the problem,');
  console.log('not our code. Re-create the project or check account limits.');
} else if (!okB) {
  console.log('Static works but a trivial _worker.js 500s.');
  console.log('-> Pages advanced mode is DISABLED/BROKEN for this account.');
  console.log('-> Fix: drop _worker.js, host API on a real Worker.');
} else if (!okC) {
  console.log('Trivial worker works, OUR bundle 500s -> bundle bug confirmed.');
  console.log('-> D tells you if the asset payload is the cause:');
  console.log('   D=' + res.D.code + '  (200 => assets fine, the problem is in worker code)');
} else {
  console.log('All variants 200 -> the deploy pipeline is fine now.');
  console.log('Re-run: bash scripts/termux-deploy-panel.sh');
}
console.log('=========================================');
