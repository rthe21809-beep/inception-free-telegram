#!/usr/bin/env node
// Offline tests for live-config merge + fallback.

import { mergeConfig } from './tgcloud/lib/live-config.js';

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const defaults = {
  mode: 'direct',
  providers: [],
  models: [],
  activeModelId: '',
  systemPrompt: 'Default prompt',
  showThinking: true,
  maxHistoryTurns: 12,
};

// no live -> falls back to embedded runtime config (which carries mode 'api')
{
  const out = mergeConfig(defaults, null);
  check(out.mode === 'api', 'falls back to embedded runtime mode');
  check(typeof out.systemPrompt === 'string' && out.systemPrompt.length > 0, 'fallback prompt present');
}

// live overrides
{
  const live = {
    mode: 'api',
    activeModelId: 'mercury-3',
    providers: [{ id: 'p', name: 'P', baseUrl: 'http://x', enabled: true, keys: [{ id: 'k', value: 'sk' }] }],
    models: [{ id: 'mercury-3', providerId: 'p', enabled: true, systemPrompt: 'Custom' }],
    settings: { defaultModelId: 'mercury-3', defaultSystemPrompt: 'Live prompt', maxHistoryTurns: 20, allowGroups: false },
  };
  const out = mergeConfig(defaults, live);
  check(out.mode === 'api', 'live sets mode api');
  check(out.providers.length === 1, 'live providers merged');
  check(out.activeModelId === 'mercury-3', 'live active model');
  check(out.systemPrompt === 'Live prompt', 'live system prompt wins');
  check(out.maxHistoryTurns === 20, 'live maxHistoryTurns wins');
  check(out.allowGroups === false, 'live allowGroups wins');
  check(out.showThinking === true, 'unset live keeps default showThinking');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall live-config checks passed');
process.exit(failures ? 1 : 0);
