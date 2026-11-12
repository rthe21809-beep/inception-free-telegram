#!/usr/bin/env node
// Fill tgcloud/lib/host-secret.js from the environment.
//
// The panel URL and the shared secret are credentials, and this repository is
// public, so they are never committed. This script writes them into
// tgcloud/lib/host-secret.js immediately before `npx tgcloud push`, which is
// the only moment they need to exist.
//
// Usage (from telegram-bot/):
//   export BOT_REPORT_SECRET=...
//   node scripts/set-host-secret.mjs https://inception-panel.pages.dev
//
// Or rely on scripts/termux-deploy-panel.sh, which calls this for you.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'tgcloud', 'lib', 'host-secret.js');

const EMPTY = `// Where the bot finds the control plane, and how it proves who it is.
//
// reportUrl    your Cloudflare Pages URL, e.g. https://inception-panel.pages.dev
// reportSecret the same BOT_REPORT_SECRET you set on Cloudflare
//
// These stay EMPTY in git on purpose. This repository is public, and
// reportSecret can read /api/runtime-config, which hands back real API keys.
// Fill them locally — never commit the filled-in version:
//
//   export BOT_REPORT_SECRET=...
//   node scripts/set-host-secret.mjs https://inception-panel.pages.dev
//
// The Termux deploy script does this for you before \`npx tgcloud push\`.
// Empty values are harmless: the bot just runs on its embedded config and
// reports that no model provider is configured yet.

export const hostSecret = {
  reportUrl: '',
  reportSecret: '',
};
`;

if (process.argv[2] === '--restore') {
  writeFileSync(target, EMPTY);
  console.log('restored tgcloud/lib/host-secret.js to the empty placeholder');
  process.exit(0);
}

const url = String(process.argv[2] || process.env.PANEL_URL || '').trim().replace(/\/+$/, '');
const secret = String(process.env.BOT_REPORT_SECRET || '').trim();

if (!url || !/^https:\/\/[^\s/]+$/.test(url)) {
  console.error('usage: node scripts/set-host-secret.mjs https://your-panel.pages.dev');
  console.error('       (set BOT_REPORT_SECRET in the environment)');
  process.exit(1);
}
if (!secret) {
  console.error('BOT_REPORT_SECRET is not set in the environment.');
  process.exit(1);
}
if (/\s/.test(secret)) {
  console.error('BOT_REPORT_SECRET must not contain whitespace.');
  process.exit(1);
}

const existing = readFileSync(target, 'utf8');
if (!existing.includes('export const hostSecret')) {
  console.error(`${target} does not look like the host-secret module; refusing to overwrite.`);
  process.exit(1);
}

const body = `// GENERATED LOCALLY — DO NOT COMMIT.
// Filled by scripts/set-host-secret.mjs right before \`npx tgcloud push\`.
// The placeholder version of this file in git is empty on purpose.

export const hostSecret = {
  reportUrl: ${JSON.stringify(url)},
  reportSecret: ${JSON.stringify(secret)},
};
`;
writeFileSync(target, body);
console.log('wrote host credentials into tgcloud/lib/host-secret.js');
console.log(`  reportUrl = ${url}`);
console.log(`  reportSecret = ${secret.slice(0, 6)}… (${secret.length} chars)`);
