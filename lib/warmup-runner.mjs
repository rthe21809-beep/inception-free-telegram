// Runs warmup.mjs as a subprocess and reports success.
// Throttled: won't re-run within 30s unless force=true.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let lastAttempt = 0;

export async function runWarmup(credsPath, { force = false, extraArgs = [] } = {}) {
  const now = Date.now();
  if (!force && now - lastAttempt < 30_000) return false;
  lastAttempt = now;

  return new Promise(resolve => {
    const child = spawn(
      process.execPath,
      [path.join(__dirname, '..', 'warmup.mjs'), '--output', credsPath, ...extraArgs],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    const t = setTimeout(() => child.kill('SIGKILL'), 150_000);
    child.on('close', code => {
      clearTimeout(t);
      console.log('[warmup]', out.trim().split('\n').slice(-4).join(' | '));
      resolve(code === 0);
    });
  });
}
