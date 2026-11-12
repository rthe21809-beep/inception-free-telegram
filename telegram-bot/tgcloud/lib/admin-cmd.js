// In-bot /admin command — OWNER ONLY (6940999328). Invisible to everyone else:
// non-owners get the generic "unknown command" path, so the command's
// existence is not revealed.
//
// Commands talk to the control plane's /api/bot/* endpoints (Bearer secret),
// so changes apply live (the bot pulls runtime config on the next message).

const OWNER_ID = 6940999328;

export function isOwner(uid) {
  return Number(uid) === OWNER_ID;
}

async function callBotApi(cfg, op, body = {}) {
  const url = String(cfg.reportUrl || '').replace(/\/+$/, '');
  if (!url || !cfg.reportSecret) throw new Error('control plane not configured');
  const res = await fetch(`${url}/api/bot/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.reportSecret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const HELP = `🛠 <b>Admin panel (owner only)</b>

<b>Providers</b>
/admin providers — list
/admin addprovider &lt;name&gt; &lt;baseUrl&gt; [key]
/admin delprovider &lt;id&gt;
/admin toggleprovider &lt;id&gt; &lt;on|off&gt;
/admin addkey &lt;providerId&gt; &lt;key&gt;
/admin delkey &lt;providerId&gt; &lt;keyId&gt;

<b>Models</b>
/admin models — list (+ active)
/admin addmodel &lt;id&gt; &lt;providerId&gt; [upstreamId] [label]
/admin delmodel &lt;id&gt;
/admin activemodel &lt;id&gt;
/admin togglemodel &lt;id&gt; &lt;on|off&gt;
/admin prompt &lt;id&gt; &lt;text…&gt;

<b>Admins (owner only)</b>
/admin admins — list
/admin addadmin &lt;userId&gt; [username]
/admin deladmin &lt;userId&gt;

<b>Analytics</b>
/admin stats · /admin users · /admin user &lt;uid&gt; · /admin logs [n]

<b>Settings</b>
/admin settings — show
/admin set &lt;key&gt; &lt;value&gt;

Changes apply live — no redeploy needed.`;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function handleAdminCommand(api, chatId, message, cfg, text) {
  const uid = message.from?.id;
  if (!isOwner(uid)) {
    // do not reveal the command exists
    await api.sendMessage({ chat_id: chatId, text: 'Unknown command. Try /help.' });
    return;
  }

  const parts = String(text || '').trim().split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();
  const args = parts.slice(2);

  const send = (t, html = true) => api.sendMessage({ chat_id: chatId, text: t, parse_mode: html ? 'HTML' : undefined });

  try {
    if (!sub || sub === 'help') return await send(HELP);

    switch (sub) {
      case 'providers': {
        const r = await callBotApi(cfg, 'providers');
        if (!r.providers.length) return await send('No providers yet. Add one:\n/admin addprovider inception https://api.inceptionlabs.ai/v1 sk-…');
        const lines = r.providers.map(p => `${p.enabled ? '✅' : '⛔'} <code>${esc(p.id)}</code> — ${esc(p.name)}\n   ${esc(p.baseUrl)} · ${p.keys.length} key(s)`);
        return await send(`<b>Providers</b>\n\n${lines.join('\n\n')}`);
      }
      case 'addprovider': {
        const [name, baseUrl, key] = args;
        if (!name || !baseUrl) return await send('Usage: /admin addprovider &lt;name&gt; &lt;baseUrl&gt; [key]');
        const r = await callBotApi(cfg, 'providers/add', { name, baseUrl, key });
        return await send(`✅ Provider <code>${esc(r.provider.id)}</code> added.`);
      }
      case 'delprovider': {
        if (!args[0]) return await send('Usage: /admin delprovider &lt;id&gt;');
        await callBotApi(cfg, 'providers/remove', { id: args[0] });
        return await send(`✅ Provider <code>${esc(args[0])}</code> removed.`);
      }
      case 'toggleprovider': {
        if (!args[0]) return await send('Usage: /admin toggleprovider &lt;id&gt; &lt;on|off&gt;');
        await callBotApi(cfg, 'providers/toggle', { id: args[0], enabled: args[1] !== 'off' });
        return await send(`✅ Provider <code>${esc(args[0])}</code> toggled.`);
      }
      case 'addkey': {
        const [pid, key] = args;
        if (!pid || !key) return await send('Usage: /admin addkey &lt;providerId&gt; &lt;key&gt;');
        await callBotApi(cfg, 'keys/add', { id: pid, key });
        return await send(`✅ Key added to <code>${esc(pid)}</code>.`);
      }
      case 'delkey': {
        const [pid, kid] = args;
        if (!pid || !kid) return await send('Usage: /admin delkey &lt;providerId&gt; &lt;keyId&gt;');
        await callBotApi(cfg, 'keys/remove', { id: pid, keyId: kid });
        return await send(`✅ Key removed.`);
      }
      case 'models': {
        const r = await callBotApi(cfg, 'models');
        if (!r.models.length) return await send('No models yet. Add one:\n/admin addmodel mercury-3 inception mercury-3 "Mercury 3"');
        const lines = r.models.map(m => `${m.id === r.activeModelId ? '⭐' : m.enabled ? '✅' : '⛔'} <code>${esc(m.id)}</code> — ${esc(m.label)} (${esc(m.providerId)}${m.upstreamId && m.upstreamId !== m.id ? ' → ' + esc(m.upstreamId) : ''})`);
        return await send(`<b>Models</b> (⭐ = active)\n\n${lines.join('\n')}`);
      }
      case 'addmodel': {
        const [id, providerId, upstreamId, label] = args;
        if (!id || !providerId) return await send('Usage: /admin addmodel &lt;id&gt; &lt;providerId&gt; [upstreamId] [label]');
        const r = await callBotApi(cfg, 'models/add', { id, providerId, upstreamId: upstreamId || undefined, label: label || undefined });
        return await send(`✅ Model <code>${esc(r.model.id)}</code> added.`);
      }
      case 'delmodel': {
        if (!args[0]) return await send('Usage: /admin delmodel &lt;id&gt;');
        await callBotApi(cfg, 'models/remove', { id: args[0] });
        return await send(`✅ Model <code>${esc(args[0])}</code> removed.`);
      }
      case 'activemodel': {
        if (!args[0]) return await send('Usage: /admin activemodel &lt;id&gt;');
        await callBotApi(cfg, 'models/active', { id: args[0] });
        return await send(`⭐ Active model: <code>${esc(args[0])}</code>`);
      }
      case 'togglemodel': {
        if (!args[0]) return await send('Usage: /admin togglemodel &lt;id&gt; &lt;on|off&gt;');
        await callBotApi(cfg, 'models/toggle', { id: args[0], enabled: args[1] !== 'off' });
        return await send(`✅ Model <code>${esc(args[0])}</code> toggled.`);
      }
      case 'prompt': {
        const id = args[0];
        const prompt = args.slice(1).join(' ');
        if (!id || !prompt) return await send('Usage: /admin prompt &lt;id&gt; &lt;text…&gt;');
        await callBotApi(cfg, 'models/prompt', { id, prompt });
        return await send(`✅ Custom instructions saved for <code>${esc(id)}</code>.`);
      }
      case 'admins': {
        const r = await callBotApi(cfg, 'admins');
        const lines = r.admins.map(a => `• <code>${a.id}</code> ${esc(a.username || '')}`);
        return await send(`<b>Owner:</b> ${r.owner}\n<b>Admins:</b>\n${lines.join('\n') || '— none —'}`);
      }
      case 'addadmin': {
        if (!args[0]) return await send('Usage: /admin addadmin &lt;userId&gt; [username]');
        await callBotApi(cfg, 'admins/add', { id: Number(args[0]), username: args.slice(1).join(' ') });
        return await send(`✅ Admin added: <code>${esc(args[0])}</code>`);
      }
      case 'deladmin': {
        if (!args[0]) return await send('Usage: /admin deladmin &lt;userId&gt;');
        await callBotApi(cfg, 'admins/remove', { id: Number(args[0]) });
        return await send(`✅ Admin removed.`);
      }
      case 'stats': {
        const r = await callBotApi(cfg, 'stats');
        return await send(`📊 <b>Stats</b>\nUsers: ${r.totalUsers}\nMessages: ${r.totalMessages}\nTokens in: ${r.totalTokensIn}\nTokens out: ${r.totalTokensOut}\nAPI calls: ${r.totalLogs}`);
      }
      case 'users': {
        const r = await callBotApi(cfg, 'users', { limit: 15 });
        const lines = r.users.map(u => `• <code>${u.id}</code> ${esc(u.username || u.firstName || '')} — ${u.messages} msg, ${u.tokensIn + u.tokensOut} tok`);
        return await send(`<b>Users</b> (total ${r.total})\n\n${lines.join('\n') || '— none —'}`);
      }
      case 'user': {
        if (!args[0]) return await send('Usage: /admin user &lt;uid&gt;');
        const r = await callBotApi(cfg, 'user', { uid: Number(args[0]) });
        if (!r.user) return await send('User not found.');
        const logs = r.logs.slice(0, 8).map(l => `  ${new Date(l.ts).toLocaleString()} ${l.status} ${esc((l.preview || '').slice(0, 40))}`);
        return await send(`<b>User ${r.user.id}</b> ${esc(r.user.username || '')}\n${r.user.messages} messages · ${r.user.tokensIn + r.user.tokensOut} tokens\n\n<b>Recent:</b>\n${logs.join('\n') || '—'}`);
      }
      case 'logs': {
        const n = parseInt(args[0] || '15', 10);
        const r = await callBotApi(cfg, 'logs', { limit: Math.min(n, 50) });
        const lines = r.logs.map(l => `• ${new Date(l.ts).toLocaleString()} <code>${l.uid}</code> ${l.status} ${esc((l.preview || '').slice(0, 50))}`);
        return await send(`<b>Logs</b>\n\n${lines.join('\n') || '— none —'}`);
      }
      case 'settings': {
        const r = await callBotApi(cfg, 'settings');
        const s = r.settings;
        return await send(`<b>Settings</b>\nshowThinking: ${s.showThinking}\nmaxHistoryTurns: ${s.maxHistoryTurns}\nallowGroups: ${s.allowGroups}\nthinkingPreviewChars: ${s.thinkingPreviewChars}\ndefaultModelId: <code>${esc(s.defaultModelId)}</code>\n\ndefault prompt:\n${esc(s.defaultSystemPrompt)}`);
      }
      case 'set': {
        const [key, ...rest] = args;
        const value = rest.join(' ');
        if (!key || !value) return await send('Usage: /admin set &lt;key&gt; &lt;value&gt;\nKeys: showThinking, maxHistoryTurns, allowGroups, thinkingPreviewChars, defaultSystemPrompt, defaultModelId');
        await callBotApi(cfg, 'settings/set', { key, value });
        return await send(`✅ Setting <code>${esc(key)}</code> updated.`);
      }
      default:
        return await send(HELP);
    }
  } catch (e) {
    return await send(`⚠️ ${esc(String(e?.message || e).slice(0, 200))}`);
  }
}
