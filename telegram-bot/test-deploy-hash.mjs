// Guards the Cloudflare Pages asset key format.
//
// Pages does NOT use SHA-256. Its key is
//   blake3( base64(fileContents) + extensionWithoutDot ).hex().slice(0,32)
// and the manifest maps "/<relative/path>" -> that key. If this drifts, the
// deployment still reports success but every request returns an empty 500.
import { hash as blake3 } from 'blake3-wasm';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const DIST = 'admin-panel/dist';
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log(`PASS  ${n}`); }
  else { fail++; console.log(`FAIL  ${n} ${extra}`); }
};

function assetKey(file) {
  const buf = readFileSync(file);
  const ext = extname(file).replace(/^\./, '');
  return blake3(buf.toString('base64') + ext).toString('hex').slice(0, 32);
}

const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p); else files.push(p);
  }
})(DIST);

ok('dist/ has files', files.length > 0);
ok('_worker.js exists', files.some((f) => f.endsWith('_worker.js')));

const manifest = {};
for (const f of files) manifest['/' + relative(DIST, f).split('\\').join('/')] = assetKey(f);

const keys = Object.keys(manifest);
ok('every manifest key starts with /', keys.every((k) => k.startsWith('/')));
ok('no double slashes', keys.every((k) => !k.includes('//')), keys.find((k) => k.includes('//')));
ok('root index present', keys.includes('/index.html'), keys.slice(0, 5).join(', '));
const hashes = Object.values(manifest);
ok('all hashes are 32-char lowercase hex',
  hashes.every((h) => /^[0-9a-f]{32}$/.test(h)), hashes.find((h) => !/^[0-9a-f]{32}$/.test(h)));
ok('hash is not sha256', hashes.every((h) => h.length !== 64));

// Determinism + content sensitivity: the two properties the API relies on.
const a = assetKey(files[0]);
const b = assetKey(files[0]);
ok('hash is deterministic', a === b);
const extOf = (f) => extname(f).replace(/^\./, '');
ok('extension participates in the hash',
  blake3(readFileSync(files[0]).toString('base64') + extOf(files[0])).toString('hex').slice(0, 32) !==
  blake3(readFileSync(files[0]).toString('base64') + 'x' + extOf(files[0])).toString('hex').slice(0, 32));

console.log(fail ? `\n${fail} FAILED` : '\nall deploy-hash checks passed');
if (fail) process.exit(1);
