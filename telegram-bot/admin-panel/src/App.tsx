import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type { ChatLog, Model, PanelState, Provider, Settings, Stats, UserStat } from './types';

type Tab = 'dashboard' | 'providers' | 'models' | 'admins' | 'users' | 'logs' | 'settings';

export default function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [tab, setTab] = useState<Tab>('dashboard');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await api.state();
      setState(s);
      const st = await api.stats();
      setStats(st);
      setError('');
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const reloadState = async (nextTab?: Tab) => {
    await load();
    if (nextTab) setTab(nextTab);
  };

  if (error) {
    return (
      <div style={styles.center}>
        <h3>Unauthorized</h3>
        <p style={{ color: '#c0392b' }}>{error}</p>
        <p>Open this from Telegram (the bot's admin panel) so we can verify your identity.</p>
      </div>
    );
  }

  if (!state) return <div style={styles.center}>Loading…</div>;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'providers', label: 'Providers' },
    { id: 'models', label: 'Models' },
    { id: 'users', label: 'Users' },
    { id: 'logs', label: 'Logs' },
    { id: 'admins', label: 'Admins' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <h2 style={{ margin: 0 }}>Inception Bot · Admin</h2>
        <span style={styles.role} data-role={state.role}>{state.role}</span>
      </header>
      <nav style={styles.nav}>
        {tabs.map(t => (
          <button key={t.id} style={tab === t.id ? styles.tabActive : styles.tab} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main style={styles.main}>
        {tab === 'dashboard' && <Dashboard stats={stats} state={state} onOpen={(t) => setTab(t)} />}
        {tab === 'providers' && <Providers state={state} onChanged={() => reloadState('providers')} />}
        {tab === 'models' && <Models state={state} onChanged={() => reloadState('models')} />}
        {tab === 'users' && <Users />}
        {tab === 'logs' && <Logs />}
        {tab === 'admins' && <Admins state={state} onChanged={() => reloadState('admins')} />}
        {tab === 'settings' && <SettingsView state={state} onChanged={() => reloadState('settings')} />}
      </main>
    </div>
  );
}

/* ------------------------------- Dashboard ------------------------------- */

function Dashboard({ stats, state, onOpen }: { stats: Stats | null; state: PanelState; onOpen: (t: Tab) => void }) {
  const active = state.models.find(m => m.id === state.settings.defaultModelId);
  return (
    <div>
      <div style={styles.grid}>
        <Card label="Users" value={stats?.totalUsers ?? 0} />
        <Card label="Messages" value={stats?.totalMessages ?? 0} />
        <Card label="Tokens in" value={stats?.totalTokensIn ?? 0} />
        <Card label="Tokens out" value={stats?.totalTokensOut ?? 0} />
        <Card label="Chars" value={stats?.totalChars ?? 0} />
        <Card label="API calls" value={stats?.totalLogs ?? 0} />
      </div>
      <div style={styles.block}>
        <strong>Active model:</strong> {active ? `${active.label} (${active.providerId})` : 'none configured'}
      </div>
      <div style={styles.block}>
        <strong>Providers:</strong> {state.providers.length} · <strong>Models:</strong> {state.models.length} ·{' '}
        <strong>Admins:</strong> {state.admins.length}
      </div>
      <div style={styles.block}>
        <button style={styles.btn} onClick={() => onOpen('providers')}>Manage providers</button>{' '}
        <button style={styles.btn} onClick={() => onOpen('models')}>Manage models</button>
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: number }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardValue}>{value.toLocaleString()}</div>
      <div style={styles.cardLabel}>{label}</div>
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

  const submit = async () => {
    try {
      await api.addProvider({ name, baseUrl, key });
      setName(''); setBaseUrl(''); setKey('');
      onChanged();
    } catch (e) { setErr(String((e as Error).message)); }
  };

  const toggle = async (p: Provider) => {
    try { await api.toggleProvider(p.id, !p.enabled); onChanged(); } catch (e) { setErr(String((e as Error).message)); }
  };

  const remove = async (p: Provider) => {
    if (!confirm(`Remove provider "${p.name}" and its models?`)) return;
    try { await api.removeProvider(p.id); onChanged(); } catch (e) { setErr(String((e as Error).message)); }
  };

  const addKey = async () => {
    try { await api.addKey(keyFor, newKey); setNewKey(''); onChanged(); } catch (e) { setErr(String((e as Error).message)); }
  };

  const removeKey = async (p: Provider, kid: string) => {
    try { await api.removeKey(p.id, kid); onChanged(); } catch (e) { setErr(String((e as Error).message)); }
  };

  return (
    <div>
      {err && <div style={styles.err}>{err}</div>}
      <div style={styles.block}>
        <h3>Add provider</h3>
        <input style={styles.input} placeholder="Name (e.g. inception)" value={name} onChange={e => setName(e.target.value)} />
        <input style={styles.input} placeholder="Base URL (e.g. https://api.inceptionlabs.ai/v1)" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
        <input style={styles.input} placeholder="Optional first API key" value={key} onChange={e => setKey(e.target.value)} />
        <button style={styles.btn} onClick={submit}>Add provider</button>
      </div>

      {state.providers.map(p => (
        <div key={p.id} style={styles.blockBorder}>
          <div style={styles.rowBetween}>
            <strong>{p.name}</strong>
            <div>
              <button style={styles.btnSmall} onClick={() => toggle(p)}>{p.enabled ? 'Disable' : 'Enable'}</button>{' '}
              <button style={styles.btnDanger} onClick={() => remove(p)}>Remove</button>
            </div>
          </div>
          <div style={styles.muted}>{p.baseUrl} · {p.keys.length} key(s)</div>
          {p.keys.map(k => (
            <div key={k.id} style={styles.rowBetween}>
              <code style={styles.code}>{k.value || 'sk-…'}</code>
              <button style={styles.btnDanger} onClick={() => removeKey(p, k.id)}>✕</button>
            </div>
          ))}
          <div style={styles.row}>
            <input style={styles.input} placeholder="New API key" value={keyFor === p.id ? newKey : ''} onChange={e => { setKeyFor(p.id); setNewKey(e.target.value); }} />
            <button style={styles.btnSmall} onClick={addKey}>Add key</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------- Models --------------------------------- */

function Models({ state, onChanged }: { state: PanelState; onChanged: () => void }) {
  const [form, setForm] = useState({ id: '', providerId: '', upstreamId: '', label: '', temperature: '' });
  const [promptFor, setPromptFor] = useState('');
  const [promptText, setPromptText] = useState('');
  const [err, setErr] = useState('');

  const submit = async () => {
    try {
      await api.addModel({
        id: form.id,
        providerId: form.providerId,
        upstreamId: form.upstreamId || undefined,
        label: form.label || undefined,
        temperature: form.temperature ? Number(form.temperature) : undefined,
      });
      setForm({ id: '', providerId: '', upstreamId: '', label: '', temperature: '' });
      onChanged();
    } catch (e) { setErr(String((e as Error).message)); }
  };

  const setActive = async (m: Model) => { try { await api.setActive(m.id); onChanged(); } catch (e) { setErr(String((e as Error).message)); } };
  const toggle = async (m: Model) => { try { await api.toggleModel(m.id, !m.enabled); onChanged(); } catch (e) { setErr(String((e as Error).message)); } };
  const remove = async (m: Model) => { try { await api.removeModel(m.id); onChanged(); } catch (e) { setErr(String((e as Error).message)); } };
  const savePrompt = async () => { try { await api.setPrompt(promptFor, promptText); setPromptFor(''); onChanged(); } catch (e) { setErr(String((e as Error).message)); } };

  return (
    <div>
      {err && <div style={styles.err}>{err}</div>}
      <div style={styles.block}>
        <h3>Add model</h3>
        <div style={styles.grid2}>
          <input style={styles.input} placeholder="Model id (e.g. mercury-3)" value={form.id} onChange={e => setForm({ ...form, id: e.target.value })} />
          <select style={styles.input} value={form.providerId} onChange={e => setForm({ ...form, providerId: e.target.value })}>
            <option value="">— provider —</option>
            {state.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input style={styles.input} placeholder="Upstream model id (optional)" value={form.upstreamId} onChange={e => setForm({ ...form, upstreamId: e.target.value })} />
          <input style={styles.input} placeholder="Label (optional)" value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} />
          <input style={styles.input} placeholder="Temperature (optional)" value={form.temperature} onChange={e => setForm({ ...form, temperature: e.target.value })} />
        </div>
        <button style={styles.btn} onClick={submit}>Add model</button>
      </div>

      {state.models.map(m => (
        <div key={m.id} style={styles.blockBorder}>
          <div style={styles.rowBetween}>
            <div>
              <strong>{m.label}</strong> {m.id === state.settings.defaultModelId && <span style={styles.badge}>active</span>}
              <div style={styles.muted}>{m.id} · {m.providerId} · {m.upstreamId}</div>
            </div>
            <div>
              <button style={styles.btnSmall} onClick={() => setActive(m)}>Set active</button>{' '}
              <button style={styles.btnSmall} onClick={() => toggle(m)}>{m.enabled ? 'Disable' : 'Enable'}</button>{' '}
              <button style={styles.btnDanger} onClick={() => remove(m)}>Remove</button>
            </div>
          </div>
          <div style={styles.row}>
            <button style={styles.btnSmall} onClick={() => { setPromptFor(m.id); setPromptText(m.systemPrompt || ''); }}>✎ custom instructions</button>
            <span style={styles.muted}>{m.systemPrompt ? m.systemPrompt.slice(0, 80) + '…' : 'default system prompt'}</span>
          </div>
        </div>
      ))}

      {promptFor && (
        <div style={styles.blockBorder}>
          <h4>Custom instructions · {promptFor}</h4>
          <textarea style={styles.textarea} rows={4} value={promptText} onChange={e => setPromptText(e.target.value)} />
          <div>
            <button style={styles.btn} onClick={savePrompt}>Save instructions</button>{' '}
            <button style={styles.btn} onClick={() => setPromptFor('')}>Cancel</button>
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
  const add = async () => {
    try { await api.addAdmin(Number(uid)); setUid(''); onChanged(); } catch (e) { setErr(String((e as Error).message)); }
  };
  const remove = async (id: number) => {
    try { await api.removeAdmin(id); onChanged(); } catch (e) { setErr(String((e as Error).message)); }
  };
  return (
    <div>
      {err && <div style={styles.err}>{err}</div>}
      <div style={styles.block}>
        <strong>Owner:</strong> {state.ownerId}
      </div>
      <div style={styles.block}>
        <h3>Admins</h3>
        {state.admins.map(a => (
          <div key={a.id} style={styles.rowBetween}>
            <span>{a.username || 'user'} <code style={styles.code}>{a.id}</code></span>
            <button style={styles.btnDanger} onClick={() => remove(a.id)}>Remove</button>
          </div>
        ))}
        {state.admins.length === 0 && <div style={styles.muted}>No additional admins yet.</div>}
      </div>
      <div style={styles.block}>
        <input style={styles.input} placeholder="Telegram user id" inputMode="numeric" value={uid} onChange={e => setUid(e.target.value)} />
        <button style={styles.btn} onClick={add}>Add admin</button>
      </div>
    </div>
  );
}

/* --------------------------------- Users --------------------------------- */

function Users() {
  const [users, setUsers] = useState<UserStat[]>([]);
  const [selected, setSelected] = useState<UserStat | null>(null);
  const [logs, setLogs] = useState<ChatLog[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    void api.users().then(r => setUsers(r.users)).catch((e: unknown) => setErr(String((e as Error).message)));
  }, []);

  const openUser = async (u: UserStat) => {
    setSelected(u);
    try { const r = await api.user(u.id); setLogs(r.logs); } catch (e) { setErr(String((e as Error).message)); }
  };

  return (
    <div>
      {err && <div style={styles.err}>{err}</div>}
      <div style={styles.grid}>
        {users.map(u => (
          <div key={u.id} style={styles.blockBorder} onClick={() => openUser(u)}>
            <strong>{u.firstName || u.username || u.id}</strong>
            <div style={styles.muted}>{u.messages} messages · {u.tokensIn + u.tokensOut} tokens</div>
          </div>
        ))}
      </div>
      {selected && (
        <div style={styles.blockBorder}>
          <h4>User {selected.id} — last {logs.length} calls</h4>
          {logs.length === 0 && <div style={styles.muted}>No logs.</div>}
          {logs.map(l => (
            <div key={l.ts} style={styles.logRow}>
              <div style={styles.muted}>{new Date(l.ts).toISOString()} · {l.provider} · {l.model} · {l.status}</div>
              <div>{l.preview}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Logs --------------------------------- */

function Logs() {
  const [logs, setLogs] = useState<ChatLog[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => { void api.logs(200).then(r => setLogs(r.logs)).catch((e: unknown) => setErr(String((e as Error).message))); }, []);
  return (
    <div>
      {err && <div style={styles.err}>{err}</div>}
      {logs.map(l => (
        <div key={l.ts} style={styles.blockBorder}>
          <div style={styles.muted}>
            {new Date(l.ts).toISOString()} · {l.username || l.uid} · {l.provider} · {l.model} · {l.status} · {l.tokensIn}+{l.tokensOut} tok
          </div>
          <div>{l.preview}</div>
        </div>
      ))}
      {logs.length === 0 && <div style={styles.muted}>No logs yet.</div>}
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
    <div>
      {err && <div style={styles.err}>{err}</div>}
      <div style={styles.block}>
        <label style={styles.rowBetween}>
          <span>Show thinking</span>
          <input type="checkbox" checked={s.showThinking} onChange={e => set('showThinking', e.target.checked)} />
        </label>
        <label style={styles.rowBetween}>
          <span>Allow groups</span>
          <input type="checkbox" checked={s.allowGroups} onChange={e => set('allowGroups', e.target.checked)} />
        </label>
        <label style={styles.rowBetween}>
          <span>History turns</span>
          <input style={styles.input} type="number" value={s.maxHistoryTurns} onChange={e => set('maxHistoryTurns', Number(e.target.value))} />
        </label>
        <label style={styles.rowBetween}>
          <span>Thinking preview chars</span>
          <input style={styles.input} type="number" value={s.thinkingPreviewChars} onChange={e => set('thinkingPreviewChars', Number(e.target.value))} />
        </label>
        <div>
          <div style={{ margin: '8px 0' }}>Default system prompt</div>
          <textarea style={styles.textarea} rows={3} value={s.defaultSystemPrompt} onChange={e => set('defaultSystemPrompt', e.target.value)} />
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- styles -------------------------------- */

const styles: Record<string, React.CSSProperties> = {
  page: { fontFamily: '-apple-system, Segoe UI, Roboto, sans-serif', maxWidth: 860, margin: '0 auto', padding: 12 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 4px' },
  role: { textTransform: 'uppercase', fontSize: 12, fontWeight: 700, color: '#fff', background: '#2c3e50', padding: '3px 8px', borderRadius: 4 },
  nav: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  tab: { background: '#fff', border: '1px solid #ccc', padding: '6px 12px', borderRadius: 6, cursor: 'pointer' },
  tabActive: { background: '#2c3e50', color: '#fff', border: '1px solid #2c3e50', padding: '6px 12px', borderRadius: 6, cursor: 'pointer' },
  main: { display: 'flex', flexDirection: 'column', gap: 12 },
  center: { maxWidth: 480, margin: '80px auto', textAlign: 'center' as const, padding: 20 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px,1fr))', gap: 10 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  card: { border: '1px solid #e0e0e0', borderRadius: 8, padding: 12 },
  cardValue: { fontSize: 24, fontWeight: 700 },
  cardLabel: { fontSize: 12, color: '#888' },
  block: { background: '#fafafa', border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 12 },
  blockBorder: { border: '1px solid #e0e0e0', borderRadius: 8, padding: 12, marginBottom: 10 },
  row: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 },
  rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  input: { flex: 1, padding: '6px 8px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14 },
  textarea: { width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 6, fontSize: 14 },
  btn: { background: '#2c3e50', color: '#fff', border: 'none', padding: '8px 14px', borderRadius: 6, cursor: 'pointer' },
  btnSmall: { background: '#ecf0f1', border: '1px solid #bdc3c7', borderRadius: 5, padding: '4px 10px', cursor: 'pointer' },
  btnDanger: { background: '#e74c3c', color: '#fff', border: 'none', borderRadius: 5, padding: '4px 10px', cursor: 'pointer' },
  muted: { color: '#888', fontSize: 13 },
  code: { background: '#f0f0f0', padding: '2px 6px', borderRadius: 4, fontSize: 12 },
  badge: { background: '#2ecc71', color: '#fff', fontSize: 11, padding: '2px 6px', borderRadius: 4, marginLeft: 6 },
  err: { background: '#fdecea', color: '#c0392b', padding: 8, borderRadius: 6, marginBottom: 10 },
  logRow: { borderBottom: '1px solid #f0f0f0', padding: '6px 0' },
};
