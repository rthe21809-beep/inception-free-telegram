import type { Admin, ApiKey, ChatLog, Model, PanelState, Provider, Settings, Stats, UserStat } from './types';

// The Telegram Mini App supplies the user's initData. We forward it as a
// header; the control plane verifies its HMAC and resolves the role.
function initData(): string {
  try {
    const wa = window.Telegram?.WebApp;
    if (wa?.initData) return wa.initData;
  } catch { /* not in Telegram -> empty */ }
  return '';
}

export const AUTH_HEADER = initData();

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': AUTH_HEADER,
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as T;
}

const get = <T,>(p: string) => request<T>(p);
const post = <T,>(p: string, body: unknown) =>
  request<T>(p, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  state: () => get<PanelState>('/api/state'),
  stats: () => get<Stats>('/api/stats'),

  // providers
  providers: () => get<{ providers: Provider[] }>('/api/providers'),
  addProvider: (body: { name: string; baseUrl: string; key?: string }) =>
    post<{ provider: Provider }>('/api/providers/add', body),
  removeProvider: (id: string) => post<{ provider: Provider }>('/api/providers/remove', { id }),
  toggleProvider: (id: string, enabled: boolean) =>
    post<{ provider: Provider }>('/api/providers/toggle', { id, enabled }),
  addKey: (id: string, key: string) => post<{ key: ApiKey }>('/api/providers/keys/add', { id, key }),
  removeKey: (id: string, keyId: string) =>
    post<{ provider: Provider }>('/api/providers/keys/remove', { id, keyId }),

  // models
  models: () => get<{ models: Model[]; activeModelId: string }>('/api/models'),
  addModel: (body: { id: string; providerId: string; upstreamId?: string; label?: string; systemPrompt?: string; temperature?: number }) =>
    post<{ model: Model }>('/api/models/add', body),
  removeModel: (id: string) => post<{ model: Model }>('/api/models/remove', { id }),
  setActive: (id: string) => post<{ model: Model }>('/api/models/active', { id }),
  toggleModel: (id: string, enabled: boolean) =>
    post<{ model: Model }>('/api/models/toggle', { id, enabled }),
  setPrompt: (id: string, prompt: string) => post<{ model: Model }>('/api/models/prompt', { id, prompt }),
  setTemperature: (id: string, temperature: number | undefined) =>
    post<{ model: Model }>('/api/models/temperature', { id, temperature }),

  // admins
  addAdmin: (id: number, username?: string) => post<{ admins: Admin[] }>('/api/admins/add', { id, username }),
  removeAdmin: (id: number) => post<{ admins: Admin[] }>('/api/admins/remove', { id }),

  // settings
  settings: () => get<{ settings: Settings }>('/api/settings'),
  setSetting: (key: keyof Settings, value: unknown) =>
    post<{ settings: Settings }>('/api/settings/set', { key, value }),

  // analytics
  users: () => get<{ users: UserStat[]; total: number }>('/api/users'),
  user: (uid: number) => get<{ user: UserStat | null; logs: ChatLog[] }>(`/api/users/${uid}`),
  logs: (limit = 100) => get<{ logs: ChatLog[] }>(`/api/logs?limit=${limit}`),
};
