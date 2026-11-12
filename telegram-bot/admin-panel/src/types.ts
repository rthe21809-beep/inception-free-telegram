export interface ApiKey {
  id: string;
  value?: string;
  created: string;
  lastUsedAt: string | null;
  errors: number;
}

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  createdAt: string;
  keys: ApiKey[];
}

export interface Model {
  id: string;
  providerId: string;
  upstreamId: string;
  label: string;
  enabled: boolean;
  temperature?: number;
  systemPrompt: string;
  createdAt: string;
}

export interface Admin {
  id: number;
  username: string;
  addedAt: string;
}

export interface Settings {
  showThinking: boolean;
  thinkingPreviewChars: number;
  maxHistoryTurns: number;
  allowGroups: boolean;
  defaultSystemPrompt: string;
  defaultModelId: string;
}

export interface UserStat {
  id: number;
  username: string;
  firstName: string;
  messages: number;
  tokensIn: number;
  tokensOut: number;
  charIn: number;
  charOut: number;
  lastSeen: number;
  firstSeen: number;
  providersUsed: Record<string, number>;
}

export interface ChatLog {
  ts: number;
  uid: number;
  username: string;
  provider: string;
  keyId: string;
  model: string;
  promptChars: number;
  outputChars: number;
  tokensIn: number;
  tokensOut: number;
  status: string;
  preview: string;
}

export interface PanelState {
  ownerId: number;
  role: 'owner' | 'admin';
  settings: Settings;
  providers: Provider[];
  models: Model[];
  admins: Admin[];
  configEpoch: number;
}

export interface Stats {
  totalUsers: number;
  totalMessages: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalChars: number;
  totalLogs: number;
  lastLog: string | null;
}
