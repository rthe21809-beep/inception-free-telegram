// The bot needs the panel URL and the shared report secret at runtime, but
// this repository is PUBLIC and that secret can read /api/runtime-config,
// which returns real provider API keys. So the credentials must never be
// committed. These checks fail loudly if a secret ever becomes trackable.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = here;
const secretFile = join(root, 'tgcloud', 'lib', 'host-secret.js');
const runtimeFile = join(root, 'tgcloud', 'lib', 'runtime-config.js');
const script = join(root, 'scripts', 'set-host-secret.mjs');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log(`PASS  ${n}`); } else { fail++; console.log(`FAIL  ${n} ${extra}`); } };

const placeholder = readFileSync(secretFile, 'utf8');

// 1. The committed placeholder must carry no credential at all.
ok('host-secret placeholder has empty reportUrl', /reportUrl:\s*''/.test(placeholder));
ok('host-secret placeholder has empty reportSecret', /reportSecret:\s*''/.test(placeholder));
// Strip comments first: the placeholder is allowed to *mention* an example
// URL in prose, but the exported value must be empty.
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('host-secret placeholder has no http url', !/https?:\/\//.test(codeOnly(placeholder)));
ok('host-secret placeholder has no long hex secret', !/[0-9a-f]{32,}/i.test(placeholder));

// 2. The runtime config (also public) must not carry them either.
const runtime = readFileSync(runtimeFile, 'utf8');
ok('runtime-config has no reportSecret field', !/^\s*reportSecret:/m.test(runtime), 'runtime-config.js still defines reportSecret');
ok('runtime-config has no reportUrl field', !/^\s*reportUrl:/m.test(runtime), 'runtime-config.js still defines reportUrl');

// 3. The injector fills and restores correctly, and refuses junk input.
try {
  execFileSync(process.execPath, [script, 'https://inception-panel.pages.dev'], {
    env: { ...process.env, BOT_REPORT_SECRET: 'deadbeef'.repeat(8) },
    stdio: 'pipe',
  });
  const filled = readFileSync(secretFile, 'utf8');
  ok('injector writes the panel url', filled.includes('https://inception-panel.pages.dev'));
  ok('injector writes the secret', filled.includes('deadbeef'.repeat(8)));
  ok('injector warns against committing', /DO NOT COMMIT/.test(filled));
} finally {
  execFileSync(process.execPath, [script, '--restore'], { stdio: 'pipe' });
}
ok('--restore returns to the placeholder', readFileSync(secretFile, 'utf8') === placeholder);

// 4. Missing secret / bad url must exit non-zero rather than write something broken.
let refused = 0;
for (const args of [['http://not-https.example'], ['https://ok.example']]) {
  try {
    execFileSync(process.execPath, [script, ...args], { env: { ...process.env, BOT_REPORT_SECRET: '' }, stdio: 'pipe' });
  } catch { refused++; }
}
ok('injector refuses a non-https url', refused >= 1);
ok('placeholder unchanged after refusals', readFileSync(secretFile, 'utf8') === placeholder);

// 5. git must not be tracking a filled-in copy of this file.
let tracked = '';
try {
  tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'tgcloud/lib/host-secret.js'], { cwd: root, stdio: 'pipe' }).toString();
} catch { tracked = ''; }
if (tracked.trim()) {
  let diff = '';
  try {
    diff = execFileSync('git', ['show', `:tgcloud/lib/host-secret.js`], { cwd: root, stdio: 'pipe' }).toString();
  } catch { diff = ''; }
  ok('committed host-secret is still the empty placeholder',
    /reportUrl:\s*''/.test(diff) && /reportSecret:\s*''/.test(diff),
    'the tracked version contains credentials — remove it from git history');
}

console.log(fail ? `\n${fail} FAILED` : '\nall secret-hygiene checks passed');
process.exit(fail ? 1 : 0);
