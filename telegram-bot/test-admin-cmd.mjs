#!/usr/bin/env node
// Offline tests for the in-bot /admin command (owner-only) + bot API wiring.

import { isOwner, handleAdminCommand } from './tgcloud/lib/admin-cmd.js';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// owner gating
check(isOwner(6940999328), 'owner id recognized');
check(!isOwner(111), 'non-owner rejected');
check(!isOwner(undefined), 'missing uid rejected');

// mock api + mock control-plane fetch
function mkApi() {
  const sent = [];
  return {
    sent,
    api: { sendMessage: async (m) => { sent.push(m); } },
  };
}

const cfg = { reportUrl: 'http://plane', reportSecret: 'sek' };

// non-owner gets the generic "unknown command" (existence hidden)
{
  const { api, sent } = mkApi();
  await handleAdminCommand(api, 1, { from: { id: 999 } }, cfg, '/admin providers');
  check(sent.length === 1 && sent[0].text.includes('Unknown command'), 'non-owner sees generic unknown-command');
}

// owner /admin providers calls bot API and formats list
{
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, auth: opts?.headers?.Authorization, body: opts?.body });
    return { ok: true, status: 200, json: async () => ({ providers: [{ id: 'inception', name: 'Inception', baseUrl: 'https://api.inceptionlabs.ai/v1', enabled: true, keys: [{ id: 'k1' }] }] }) };
  };
  try {
    const { api, sent } = mkApi();
    await handleAdminCommand(api, 1, { from: { id: 6940999328 } }, cfg, '/admin providers');
    check(calls.length === 1, 'owner command hit control plane once');
    check(calls[0].url === 'http://plane/api/bot/providers', 'correct bot endpoint');
    check(calls[0].auth === 'Bearer sek', 'bearer secret sent');
    check(sent[0].text.includes('Inception'), 'reply lists provider name');
    check(sent[0].parse_mode === 'HTML', 'reply uses HTML');
  } finally { global.fetch = orig; }
}

// owner /admin addprovider forwards fields
{
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ provider: { id: 'openai' } }) }; };
  try {
    const { api } = mkApi();
    await handleAdminCommand(api, 1, { from: { id: 6940999328 } }, cfg, '/admin addprovider openai https://api.openai.com/v1 sk-abc');
    check(calls[0].name === 'openai' && calls[0].baseUrl === 'https://api.openai.com/v1' && calls[0].key === 'sk-abc', 'addprovider forwards name/baseUrl/key');
  } finally { global.fetch = orig; }
}

// control-plane error surfaces as ⚠️
{
  const orig = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'name and baseUrl are required' }) });
  try {
    const { api, sent } = mkApi();
    await handleAdminCommand(api, 1, { from: { id: 6940999328 } }, cfg, '/admin addprovider');
    // missing args -> usage message (no fetch)
    check(sent[0].text.includes('Usage'), 'missing args -> usage');
  } finally { global.fetch = orig; }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall admin-cmd checks passed');
process.exit(failures ? 1 : 0);
