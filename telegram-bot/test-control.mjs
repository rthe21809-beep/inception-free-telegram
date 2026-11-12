#!/usr/bin/env node
// Offline tests for the control-plane state store (no network).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadControlStateFile } from './collector/lib/control-store-node.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'control-test-'));
const file = path.join(dir, 'control.json');

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

const state = loadControlStateFile(file);

// owner/admin
check(state.isOwner(6940999328), 'owner recognized');
check(state.roleOf(6940999328) === 'owner', 'owner role');

// providers
const p = state.addProvider({ name: 'Inception', baseUrl: 'https://api.inceptionlabs.ai/v1', key: 'sk-test-1234' });
check(state.findProvider('inception') === p, 'provider found by id');
check(p.keys.length === 1, 'first key added');

const k2 = state.addKey('inception', 'sk-test-5678');
check(p.keys.length === 2, 'second key added');
check(k2.id && k2.value === 'sk-test-5678', 'key value kept in state');

state.removeKey('inception', k2.id);
check(p.keys.length === 1, 'key removed');

// models
const m = state.addModel({ id: 'mercury-3', providerId: 'inception', upstreamId: 'mercury-3', label: 'Mercury 3' });
check(state.findModel('mercury-3') === m, 'model added');

state.setActiveModel('mercury-3');
check(state.state.settings.defaultModelId === 'mercury-3', 'active model set');

state.setModelPrompt('mercury-3', 'You are terse.');
check(m.systemPrompt === 'You are terse.', 'model prompt set');

state.toggleModel('mercury-3', false);
check(m.enabled === false, 'model disabled');
state.toggleModel('mercury-3', true);
check(m.enabled === true, 'model re-enabled');

// admins
state.addAdmin(123, 'helper');
check(state.isAdmin(123), 'admin added & recognized');
check(!state.isAdmin(999), 'non-admin not recognized');
const adminsAfterRemoval = state.removeAdmin(123);
check(adminsAfterRemoval.length === 0, 'admin removed');

// settings
state.setSetting('allowGroups', false);
check(state.state.settings.allowGroups === false, 'boolean setting set');
state.setSetting('maxHistoryTurns', 20);
check(state.state.settings.maxHistoryTurns === 20, 'number setting set');

// users / logs
state.touchUser(42, { username: 'alice', firstName: 'A', provider: 'inception', model: 'mercury-3', tokensIn: 10, tokensOut: 5, charIn: 100, charOut: 200, status: 'ok' });
state.touchUser(42, { username: 'alice', provider: 'inception', tokensIn: 20, tokensOut: 10, charIn: 50, charOut: 60, status: 'ok' });
check(state.state.users[42].messages === 2, 'user messages counted');
check(state.state.users[42].tokensIn === 30, 'tokens aggregated');
state.addLog({ uid: 42, username: 'alice', provider: 'inception', model: 'mercury-3', tokensIn: 10, tokensOut: 5, status: 'ok', preview: 'hi' });
check(state.userLogs(42).length === 1, 'user logs returned');
check(state.topUsers(5)[0].id === 42, 'top users sorted');

// sanitize never leaks full keys
const snap = state.sanitize();
const keys = snap.providers[0].keys;
check(keys[0].value.startsWith('sk-…'), 'sanitized keys masked');

// persistence
state.save();
const state2 = loadControlStateFile(file);
check(state2.state.providers.length === 1, 'state persisted & reloaded');
check(state2.state.users[42].messages === 2, 'users persisted');

console.log(failures ? `\n${failures} check(s) failed` : '\nall control checks passed');
process.exit(failures ? 1 : 0);
