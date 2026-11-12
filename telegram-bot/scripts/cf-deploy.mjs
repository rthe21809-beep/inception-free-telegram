#!/usr/bin/env node
// Deploy the admin panel + API to Cloudflare Pages using ONLY the REST API.
// No wrangler, no workerd binary — works in Termux (android arm64).
//
// What it does:
//   1. resolves your account id
//   2. creates/updates the Pages project "inception-panel"
//   3. binds the CONTROL_KV namespace + sets BOT_TOKEN / BOT_REPORT_SECRET
//   4. bundles functions/api/[[path]].js into dist/_worker.js (advanced mode)
//   5. uploads dist/ and creates a deployment
//
// Usage (from telegram-bot/):
//   export CLOUDFLARE_API_TOKEN=...
//   export CONTROL_KV_ID=...
//   export BOT_TOKEN=...
//   export BOT_REPORT_SECRET=...
//   node scripts/cf-deploy.mjs            # add --dry-run to build+hash only
//
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PANEL = join(ROOT, 'admin-panel');
const DIST = process.env.DIST_DIR || join(PANEL, 'dist');
const FN = join(PANEL, 'functions', 'api', '[[path]].js');
const API = 'https://api.cloudflare.com/client/v4';
const PROJECT = process.env.PROJECT_NAME || 'inception-panel';
const DRY = process.argv.includes('--dry-run');

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const KV_ID = process.env.CONTROL_KV_ID;
const BOT_TOKEN = process.env.BOT_TOKEN;
const REPORT_SECRET = process.env.BOT_REPORT_SECRET;

const die = (m) => { console.error('\nERROR: ' + m + '\n'); process.exit(1); };
const ok = (m) => console.log('    ' + m);

// ---------- 0. build the worker bundle ----------
// Direct upload does NOT run Pages' own bundler, so the Pages Function must be
// compiled into dist/_worker.js by hand (advanced mode). We ALSO inline every
// static file into that worker: env.ASSETS is not guaranteed to exist for
// direct uploads, and depending on it made the whole site 500.
async function buildWorker() {
  console.log('==> bundling API + static assets into dist/_worker.js');
  if (!existsSync(FN)) die('missing ' + FN);
  if (!existsSync(join(DIST, 'index.html'))) die('dist/index.html missing — run "npm run build" in admin-panel first.');

  const require = createRequire(join(PANEL, 'package.json'));
  const esbuildPath = require.resolve('esbuild');
  const esbuild = (await import(pathToFileURL(esbuildPath).href)).default;

  // collect static files (never the worker itself)
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
  };
  const assets = {};
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      const key = '/' + relative(DIST, p).split('\\').join('/');
      if (key === '/_worker.js') continue;
      const ext = extname(p).toLowerCase();
      const buf = readFileSync(p);
      const binary = !['.html', '.js', '.css', '.svg', '.json', '.txt'].includes(ext);
      assets[key] = {
        t: types[ext] || 'application/octet-stream',
        b: binary ? buf.toString('base64') : buf.toString('utf8'),
        e: binary ? 1 : 0,
      };
    }
  })(DIST);

  const wrapper = `
import { onRequest } from ${JSON.stringify(FN)};

const ASSETS = ${JSON.stringify(assets)};

function bytes(s, isB64) {
  if (!isB64) return new TextEncoder().encode(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function serveStatic(url, request) {
  let key = url.pathname;
  const hit = ASSETS[key] || ASSETS[key + '/index.html'] || ASSETS['/index.html'];
  if (!hit) return new Response('Not found', { status: 404 });
  const body = bytes(hit.b, hit.e);
  const headers = { 'content-type': hit.t };
  const immutable = key.startsWith('/assets/');
  headers['cache-control'] = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const resp = await onRequest({
          request, env, ctx,
          params: {}, data: {},
          functionPath: url.pathname,
          next: () => serveStatic(url, request),
          waitUntil: (p) => { if (ctx && ctx.waitUntil) ctx.waitUntil(p); },
          passThroughOnException: () => {},
        });
        if (resp) return resp;
        return new Response('Not found', { status: 404 });
      }
      return serveStatic(url, request);
    } catch (e) {
      // Never hide the failure: a blank 500 is undebuggable.
      return new Response(
        'WORKER ERROR: ' + String(e && (e.stack || e.message) || e),
        { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }
  },
};
`;
  await esbuild.build({
    stdin: { contents: wrapper, resolveDir: dirname(FN), loader: 'js', sourcefile: 'pages-worker-entry.js' },
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['worker', 'browser'],
    outfile: join(DIST, '_worker.js'),
    logLevel: 'warning',
  });
  const size = statSync(join(DIST, '_worker.js')).size;
  ok(`_worker.js ${(size / 1024).toFixed(1)} kB  (${Object.keys(assets).length} assets inlined)`);
  if (size > 900 * 1024) console.warn('    WARNING: close to the 1 MB worker limit');
}

// ---------- cloudflare REST ----------
async function cf(path, init = {}) {
  const isForm = init.body instanceof FormData;
  const res = await fetch(API + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(isForm ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  if (!res.ok || (json && json.success === false)) {
    const errs = json?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || text.slice(0, 300);
    const e = new Error(`${init.method || 'GET'} ${path} -> HTTP ${res.status} ${errs}`);
    e.status = res.status;
    throw e;
  }
  return json;
}

async function main() {
  await buildWorker();

  if (DRY) { console.log('\n--dry-run: stopping before any network call.'); return; }

  if (!TOKEN) die('CLOUDFLARE_API_TOKEN is not set.');
  if (!KV_ID) die('CONTROL_KV_ID is not set.');

  console.log('==> 1/5 resolving account');
  let acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!acct) {
    const r = await cf('/accounts');
    const list = r.result || [];
    if (!list.length) die('This token cannot see any Cloudflare account. Check the token permissions (Account -> Cloudflare Pages -> Edit).');
    acct = list[0].id;
    if (list.length > 1) ok('multiple accounts: ' + list.map((a) => `${a.name}=${a.id}`).join(', ') + ' — using first');
  }
  ok('account ' + acct);

  console.log(`==> 2/5 ensuring project "${PROJECT}"`);
  try {
    await cf(`/accounts/${acct}/pages/projects/${PROJECT}`);
    ok('exists');
  } catch (e) {
    if (e.status !== 404) throw e;
    ok('creating…');
    await cf(`/accounts/${acct}/pages/projects`, {
      method: 'POST',
      body: JSON.stringify({ name: PROJECT, production_branch: 'main' }),
    });
  }

  console.log('==> 3/5 binding KV + secrets');
  const env_vars = {};
  if (BOT_TOKEN) env_vars.BOT_TOKEN = { type: 'secret_text', value: BOT_TOKEN };
  if (REPORT_SECRET) env_vars.BOT_REPORT_SECRET = { type: 'secret_text', value: REPORT_SECRET };
  await cf(`/accounts/${acct}/pages/projects/${PROJECT}`, {
    method: 'PATCH',
    body: JSON.stringify({
      deployment_configs: {
        production: {
          compatibility_date: '2024-09-01',
          kv_namespaces: { CONTROL_KV: { namespace_id: KV_ID } },
          env_vars,
        },
      },
    }),
  });
  ok(`CONTROL_KV bound; secrets: ${Object.keys(env_vars).join(', ') || '(none exported)'}`);

  console.log('==> 4/5 hashing dist/');
  const files = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  })(DIST);
  if (!files.length) die('dist/ is empty.');

  const manifest = {};
  const blobs = new Map();
  for (const f of files) {
    const buf = readFileSync(f);
    const hash = createHash('sha256').update(buf).digest('hex');
    const key = '/' + relative(DIST, f).split('\\').join('/');
    manifest[key] = hash;
    if (!blobs.has(hash)) blobs.set(hash, { buf, key });
  }
  ok(`${files.length} files / ${blobs.size} unique`);

  console.log('==> 5/5 uploading deployment');
  const form = new FormData();
  form.set('manifest', JSON.stringify(manifest));
  form.set('branch', 'main');
  for (const [hash, { buf, key }] of blobs) {
    const type = extname(key) === '.html' ? 'text/html'
      : extname(key) === '.css' ? 'text/css'
      : extname(key) === '.js' ? 'application/javascript'
      : extname(key) === '.svg' ? 'image/svg+xml'
      : extname(key) === '.json' ? 'application/json'
      : 'application/octet-stream';
    form.append(hash, new Blob([buf], { type }), hash);
  }
  const dep = await cf(`/accounts/${acct}/pages/projects/${PROJECT}/deployments`, { method: 'POST', body: form });

  // dep.result.url is the *per-deploy* hash alias — it changes on every push and
  // is useless for config. The canonical URL is always <project>.pages.dev.
  const stable = `https://${PROJECT}.pages.dev`;
  console.log('\nDONE. Panel deployed.');
  console.log('  canonical URL : ' + stable);
  if (dep.result?.url && !dep.result.url.includes(`${PROJECT}.pages.dev`)) {
    console.log('  preview alias : ' + dep.result.url + '  (per-deploy, do not use)');
  } else if (dep.result?.url && dep.result.url !== stable && /[0-9a-f]{8}\./.test(dep.result.url)) {
    console.log('  deploy alias  : ' + dep.result.url + '  (per-deploy, do not use)');
  }
  console.log('\nUse the canonical URL as reportUrl in tgcloud/lib/runtime-config.js\n');
}

main().catch((e) => { console.error('\nFAILED: ' + e.message + '\n'); process.exit(1); });
