#!/usr/bin/env node
// Auto-register a free chat.inceptionlabs.ai account via Playwright (no captcha).
// Usage: node register-playwright.mjs [--output creds.json] [--count 1]

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUTPUT = arg('output', 'creds.json');
const COUNT = parseInt(arg('count', '1'), 10);

let playwright;
try {
  playwright = await import('playwright');
} catch {
  console.error('[!] playwright not installed. Run:  npm i playwright && npx playwright install chromium');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function loadExisting() {
  try {
    const d = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    return Array.isArray(d) ? d : (d.active || []);
  } catch { return []; }
}

function save(list) {
  fs.writeFileSync(OUTPUT, JSON.stringify({ active: list }, null, 2));
}

async function registerOne() {
  const pw = await playwright.chromium.launch({ headless: true });
  try {
    const ctx = await pw.newContext({ userAgent: UA, viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    await page.goto('https://chat.inceptionlabs.ai/auth', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // switch to register view
    const toggle = page.locator("div.mt-4.text-sm.text-center button[type='button']");
    await toggle.waitFor({ state: 'visible', timeout: 60000 });
    await toggle.click({ timeout: 10000 });

    await page.waitForSelector('input[autocomplete="name"]', { timeout: 30000 });
    const username = randomBytes(5).toString('hex');
    await page.fill('input[autocomplete="name"]', username);
    await page.fill('input[autocomplete="email"]', `${username}@example.com`);
    await page.fill('input[autocomplete="current-password"]', randomBytes(9).toString('hex') + 'Ab1!');

    await page.click("button[type='submit']");
    await page.waitForURL(/chat\.inceptionlabs\.ai\/(?!auth)/, { timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

    const cookies = await ctx.cookies();
    const dict = {};
    for (const c of cookies) dict[c.name] = c.value;
    const bearer = dict.token;
    if (!bearer) throw new Error('token cookie not found after registration');
    return { bearer, cookies: dict, created_at: Math.floor(Date.now() / 1000) };
  } finally {
    await pw.close();
  }
}

const list = loadExisting();
for (let i = 0; i < COUNT; i++) {
  const c = await registerOne();
  list.push(c);
  console.log(`registered account ${i + 1}/${COUNT} — token ${c.bearer.slice(0, 18)}…`);
}
save(list);
console.log(`saved ${list.length} account(s) -> ${OUTPUT}`);
