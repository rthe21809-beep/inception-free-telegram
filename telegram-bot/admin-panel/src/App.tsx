import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import './styles.css';
import type { ChatLog, Model, PanelState, Provider, Settings, Stats, UserStat } from './types';

type Tab = 'dashboard' | 'providers' | 'models' | 'admins' | 'users' | 'logs' | 'settings';

const TABS: { id: Tab; label: string; ico: string }[] = [
  { id: 'dashboard', label: 'Home', ico: '◧' },
  { id: 'providers', label: 'Providers', ico: '◈' },
  { id: 'models', label: 'Models', ico: '◇' },
  { id: 'users', label: 'Users', ico: '◉' },
  { id: 'logs', label: 'Logs', ico: '≡' },
  { id: 'admins', label: 'Admins', ico: '♦' },
  { id: 'settings', label: 'Settings', ico: '⚙' },
];

export default function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      const st = await api.stats();
      setStats(st);
      setError('');
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) {
    return (
      <div className="center-full anim-fade">
        <h2>◈</h2>
        <h2>Access denied</h2>
        <p>{error}</p>
        <p>This panel is restricted. Open it from Telegram via the bot's /admin button.</p>
      </div>
    );
  }

  if (!state || loading) {
    return (
      <div className="main">
        <div className="skeleton" /><div className="skeleton" /><div className="skeleton" />
        <div className="loading" style={{ height: 120 }}><div className="spinner" /><span>Loading…</span></div>
      </div>
    );
  }

  return (
    <>
      <header className="header anim-in">
        <h1>◈ Inception Admin</h1>
        <span className="role-badge">{state.role}</span>
      </header>

      <main className="main anim-in-right" key={tab}>
        {tab === 'dashboard' && <Dashboard stats={stats} state={state} onOpen={setTab} />}
        {tab === 'providers' && <Providers state={state} onChanged={load} />}
        {tab === 'models' && <Models state={state} onChanged={load} />}
        {tab === 'users' && <Users />}
        {tab === 'logs' && <Logs />}
        {tab === 'admins' && <Admins state={state} onChanged={load} />}
        {tab === 'settings' && <SettingsView state={state} onChanged={load} />}
      </main>

      <nav className="nav">
        {TABS.map(t => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            <span className="ico">{t.ico}</span>
            {t.label}
            <span className="dot" />
          </button>
        ))}
      </nav>
    </>
  );
}

/* ------------------------------- Dashboard ------------------------------- */
function Dashboard({ stats, state, onOpen }: { stats: Stats | null; state: PanelState; onOpen: (t: Tab) => void }) {
  const active = state.models.find(m => m.id === state.settings.defaultModelId);
  const cards = [
    { l: 'Users', v: stats?.totalUsers ?? 0 },
    { l: 'Messages', v: stats?.totalMessages ?? 0 },
    { l: 'Tokens in', v: stats?.totalTokensIn ?? 0 },
    { l: 'Tokens out', v: stats?.totalTokensOut ?? 0 },
    { l: 'Chars', v: stats?.totalChars ?? 0 },
    { l: 'API calls', v: stats?.totalLogs ?? 0 },
  ];
  return (
    <div className="stagger">
      <div className="grid">
        {cards.map(c => (
          <div className="stat" key={c.l}><div className="v">{c.v.toLocaleString()}</div><div className="l">{c.l}</div></div>
        ))}
      </div>
      <div className="card">
        <div className="row between"><span className="muted">Active model</span></div>
        <div style={{ marginTop: 6, fontWeight: 700 }}>{active ? `${active.label} · ${active.providerId}` : 'none configured'}</div>
      </div>
      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <span><b>{state.providers.length}</b> <span className="muted">providers</span></span>
          <span><b>{state.models.length}</b> <span className="muted">models</span></span>
          <span><b>{state.admins.length}</b> <span className="muted">admins</span></span>
        </div>
        <div className="btn-row">
          <button className="btn-ghost" onClick={() => onOpen('providers')}>Providers</button>
          <button className="btn-ghost" onClick={() => onOpen('models')}>Models</button>
          <button className="btn-ghost" onClick={() => onOpen('settings')}>Settings</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Providers ------------------------------- */
function Providers({ state, onChanged }: { state: PanelState; onChanged: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [keyFor, setKeyFor] = useState('');
  const [newKey, setNewKey] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); onChanged(); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  return (
    <div className="stagger">
      {err && <div className="err">{err}</div>}
      <div className="card">
        <div className="h3">Add provider</div>
        <input className="input" placeholder="Name (e.g. inception)" value={name} onChange={e => setName(e.target.value)} />
        <input className="input" placeholder="Base URL (https://api.inceptionlabs.ai/v1)" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
        <input className="input" placeholder="Optional first API key" value={key} onChange={e => setKey(e.target.value)} />
        <button className="btn" disabled={busy} onClick={() => run(async () => { await api.addProvider({ name, baseUrl, key }); setName(''); setBaseUrl(''); setKey(''); })}>Add provider</button>
      </div>

      {state.providers.map(p => (
        <div className="card" key={p.id}>
          <div className="row between">
            <div><b>{p.name}</b> {p.enabled ? '' : <span className="badge">off</span>}</div>
            <label className="switch">
              <input type="checkbox" checked={p.enabled} onChange={() => run(() => api.toggleProvider(p.id, !p.enabled))} />
              <span className="track" />
            </label>
          </div>
          <div className="muted" style={{ margin: '4px 0 8px' }}>{p.baseUrl} · {p.keys.length} key(s)</div>
          {p.keys.map(k => (
            <div className="row between" key={k.id} style={{ marginBottom: 6 }}>
              <code className="code">{k.value || 'sk-…'}</code>
              <button className="btn-danger" onClick={() => run(() => api.removeKey(p.id, k.id))}>Remove</button>
            </div>
          ))}
          <div className="row" style={{ marginTop: 8 }}>
            <input className="input" style={{ marginBottom: 0 }} placeholder="New API key" value={keyFor === p.id ? newKey : ''} onChange={e => { setKeyFor(p.id); setNewKey(e.target.value); }} />
            <button className="btn-ghost" style={{ flexShrink: 0 }} onClick={() => run(async () => { await api.addKey(p.id, newKey); setNewKey(''); setKeyFor(''); })}>Add</button>
          </div>
          <div className="btn-row">
            <button className="btn-danger" onClick={() => { if (confirm(`Remove provider "${p.name}" and its models?`)) run(() => api.removeProvider(p.id)); }}>Delete provider</button>
          </div>
        </div>
      ))}
      {state.providers.length === 0 && <div className="card muted">No providers yet — add one above.</div>}
    </div>
  );
}

/* --------------------------------- Models --------------------------------- */
function Models({ state, onChanged }: { state: PanelState; onChanged: () => void }) {
  const [form, setForm] = useState({ id: '', providerId: '', upstreamId: '', label: '', temperature: '' });
  const [promptFor, setPromptFor] = useState('');
  const [promptText, setPromptText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); onChanged(); } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(false); }
  };

  return (
    <div className="stagger">
      {err && <div className="err">{err}</div>}
      <div className="card">
        <div className="h3">Add model</div>
        <input className="input" placeholder="Model id (e.g. mercury-3)" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} />
        <select className="input" value={form.providerId} onChange={e => setForm({ ...form, providerId: e.target.value })}>
          <option value="">— provider —</option>
          {state.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input className="input" placeholder="Upstream id (optional)" value={form.upstreamId} onChange={e => setForm({ ...form, upstreamId: e.target.value })} />
        <input className="input" placeholder="Label (optional)" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} />
        <input className="input" placeholder="Temperature (optional)" value={form.temperature} onChange={e => setForm({ ...form, temperature: e.target.value })} />
        <button className="btn" disabled={busy} onClick={() => run(async () => {
          await api.addModel({ id: form.id, providerId: form.providerId, upstreamId: form.upstreamId || undefined, label: form.label || undefined, temperature: form.temperature ? Number(form.temperature) : undefined });
          setForm({ id: '', providerId: '', upstreamId: '', label: '', temperature: '' });
        })}>Add model</button>
      </div>

      {state.models.map(m => (
        <div className="card" key={m.id}>
          <div className="row between">
            <div>
              <b>{m.label}</b> {m.id === state.settings.defaultModelId && <span className="badge">active</span>} {m.enabled ? '' : <span className="badge">off</span>}
              <div className="muted" style={{ marginTop: 2 }}>{m.id} · {m.providerId}{m.upstreamId && m.upstreamId !== m.id ? ` → ${m.upstreamId}` : ''}</div>
            </div>
            <label className="switch">
              <input type="checkbox" checked={m.enabled} onChange={() => run(() => api.toggleModel(m.id, !m.enabled))} />
              <span className="track" />
            </label>
          </div>
          <div className="btn-row">
            <button className="btn-ghost" onClick={() => run(() => api.setActive(m.id))}>Set active</button>
            <button className="btn-ghost" onClick={() => { setPromptFor(m.id); setPromptText(m.systemPrompt || ''); }}>Instructions</button>
            <button className="btn-danger" onClick={() => run(() => api.removeModel(m.id))}>Delete</button>
          </div>
          {m.systemPrompt && <div className="faint" style={{ marginTop: 8 }}>“{m.systemPrompt.slice(0, 90)}{m.systemPrompt.length > 90 ? '…' : ''}”</div>}
        </div>
      ))}
      {state.models.length === 0 && <div className="card muted">No models yet.</div>}

      {promptFor && (
        <div className="card anim-in">
          <div className="h3">Custom instructions · {promptFor}</div>
          <textarea className="input" rows={4} value={promptText} onChange={e => setPromptText(e.target.value)} />
          <div className="btn-row">
            <button className="btn" style={{ width: 'auto' }} onClick={() => run(async () => { await api.setPrompt(promptFor, promptText); setPromptFor(''); })}>Save</button>
            <button className="btn-ghost" onClick={() => setPromptFor('')}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Admins -------------------------------- */
function Admins({ state, onChanged }: { state: PanelState; onChanged: () => void }) {
  const [uid, setUid] = useState('');
  const [err, setErr] = useState('');
  const isOwner = state.role === 'owner';
  return (
    <div className="stagger">
      {err && <div className="err">{err}</div>}
      <div className="card"><div className="row between"><span className="muted">Owner</span><b>{state.ownerId}</b></div></div>
      <div className="card">
        <div className="h3">Admins</div>
        {state.admins.map(a => (
          <div className="row between" key={a.id} style={{ marginBottom: 8 }}>
            <span><code className="code">{a.id}</code> {a.username}</span>
            {isOwner && <button className="btn-danger" onClick={async () => { try { await api.removeAdmin(a.id); onChanged(); } catch (e) { setErr(String((e as Error).message)); } }}>Remove</button>}
          </div>
        ))}
        {state.admins.length === 0 && <div className="muted">No additional admins.</div>}
      </div>
      {isOwner && (
        <div className="card">
          <div className="h3">Add admin</div>
          <input className="input" placeholder="Telegram user id" inputMode="numeric" value={uid} onChange={e => setUid(e.target.value)} />
          <button className="btn" onClick={async () => { try { await api.addAdmin(Number(uid)); setUid(''); onChanged(); } catch (e) { setErr(String((e as Error).message)); } }}>Add admin</button>
        </div>
      )}
    </div>
  );
}

/* --------------------------------- Users --------------------------------- */
function Users() {
  const [users, setUsers] = useState<UserStat[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<UserStat | null>(null);
  const [logs, setLogs] = useState<ChatLog[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { void api.users().then(r => { setUsers(r.users); setTotal(r.total); }).catch((e: unknown) => setErr(String((e as Error).message))); }, []);
  const openUser = async (u: UserStat) => {
    setSelected(u);
    try { const r = await api.user(u.id); setLogs(r.logs); } catch (e) { setErr(String((e as Error).message)); }
  };
  return (
    <div className="stagger">
      {err && <div className="err">{err}</div>}
      <div className="card muted">Total users: <b>{total}</b></div>
      {users.map(u => (
        <div className="card" key={u.id} onClick={() => openUser(u)} style={{ cursor: 'pointer' }}>
          <b>{u.firstName || u.username || u.id}</b>
          <div className="muted" style={{ marginTop: 2 }}>{u.messages} messages · {u.tokensIn + u.tokensOut} tokens</div>
        </div>
      ))}
      {users.length === 0 && <div className="card muted">No users yet.</div>}
      {selected && (
        <div className="card anim-in">
          <div className="h3">User {selected.id} — recent calls</div>
          {logs.slice(0, 20).map(l => (
            <div className="log-row" key={l.ts}>
              <div className="faint">{new Date(l.ts).toLocaleString()} · {l.provider} · {l.model} · {l.status}</div>
              <div>{l.preview}</div>
            </div>
          ))}
          {logs.length === 0 && <div className="muted">No logs.</div>}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Logs --------------------------------- */
function Logs() {
  const [logs, setLogs] = useState<ChatLog[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { void api.logs(150).then(r => setLogs(r.logs)).catch((e: unknown) => setErr(String((e as Error).message))); }, []);
  return (
    <div className="stagger">
      {err && <div className="err">{err}</div>}
      {logs.map(l => (
        <div className="card" key={l.ts} style={{ padding: '10px 14px' }}>
          <div className="faint">{new Date(l.ts).toLocaleString()} · {l.username || l.uid} · {l.provider} · {l.model} · {l.status} · {l.tokensIn}+{l.tokensOut} tok</div>
          <div style={{ marginTop: 3 }}>{l.preview}</div>
        </div>
      ))}
      {logs.length === 0 && <div className="card muted">No logs yet.</div>}
    </div>
  );
}

/* -------------------------------- Settings ------------------------------- */
function SettingsView({ state, onChanged }: { state: PanelState; onChanged: () => void }) {
  const s = state.settings;
  const [err, setErr] = useState('');
  const set = async (key: keyof Settings, value: unknown) => {
    try { await api.setSetting(key, value); onChanged(); } catch (e) { setErr(String((e as Error).message)); }
  };
  return (
    <div className="stagger">
      {err && <div className="err">{err}</div>}
      <div className="card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <span>Show thinking</span>
          <label className="switch"><input type="checkbox" checked={s.showThinking} onChange={e => set('showThinking', e.target.checked)} /><span className="track" /></label>
        </div>
        <div className="row between" style={{ marginBottom: 12 }}>
          <span>Allow groups</span>
          <label className="switch"><input type="checkbox" checked={s.allowGroups} onChange={e => set('allowGroups', e.target.checked)} /><span className="track" /></label>
        </div>
        <div className="row between" style={{ marginBottom: 8 }}>
          <span className="muted">History turns</span>
          <input className="input" style={{ width: 90, marginBottom: 0, textAlign: 'right' }} type="number" value={s.maxHistoryTurns} onChange={e => set('maxHistoryTurns', Number(e.target.value))} />
        </div>
        <div className="row between">
          <span className="muted">Preview chars</span>
          <input className="input" style={{ width: 90, marginBottom: 0, textAlign: 'right' }} type="number" value={s.thinkingPreviewChars} onChange={e => set('thinkingPreviewChars', Number(e.target.value))} />
        </div>
      </div>
      <div className="card">
        <div className="h3">Default system prompt</div>
        <textarea className="input" rows={3} value={s.defaultSystemPrompt} onChange={e => set('defaultSystemPrompt', e.target.value)} />
      </div>
    </div>
  );
}
