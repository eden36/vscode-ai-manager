export type ChannelPreset = 'custom' | 'opencode-go' | 'opencode-console';
export type ModelProtocol = 'openai' | 'anthropic' | 'gemini' | 'unknown';
export type ChannelAuthMode = 'bearer' | 'anthropic-api-key' | 'google-api-key';
export type ChatSettingKey =
  | 'chat.defaultModel'
  | 'inlineChat.defaultModel'
  | 'chat.planAgent.defaultModel'
  | 'github.copilot.chat.implementAgent.model'
  | 'chat.utilityModel'
  | 'chat.utilitySmallModel';

export interface ChannelConfig {
  id: string;
  name: string;
  preset: ChannelPreset;
  baseUrl: string;
  modelsPath: string;
  chatPath: string;
  anthropicPath?: string;
  geminiPath?: string;
  defaultProtocol: Exclude<ModelProtocol, 'unknown'>;
  authMode: ChannelAuthMode;
  enabled: boolean;
  timeoutMs: number;
  refreshIntervalMinutes: number;
  defaultMaxInputTokens: number;
  defaultMaxOutputTokens: number;
  lastRefreshAt?: number;
  lastRefreshError?: string;
}

export interface CatalogModel {
  channelId: string;
  id: string;
  providerId: string;
  name: string;
  customAlias?: string;
  enabled: boolean;
  catalogOrder: number;
  protocol: ModelProtocol;
  available: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  lastSeenAt: number;
  metadataOverridden?: boolean;
}

export interface ChatModelTarget {
  channelId: string;
  modelId: string;
}

export interface ResolvedCandidate {
  channel: ChannelConfig;
  model: CatalogModel;
}

export interface ChatBindingRecord {
  setting: ChatSettingKey;
  providerId: string;
  appliedValue: string;
  previousHadGlobalValue: boolean;
  previousGlobalValue?: unknown;
}

export interface CatalogChange {
  channelId: string;
  channelName: string;
  initialized: boolean;
  added: string[];
  removed: string[];
  reappeared: string[];
}

export interface CatalogRefreshFailure {
  channelId: string;
  channelName: string;
  message: string;
}

export interface CatalogRefreshSummary {
  changes: CatalogChange[];
  failures: CatalogRefreshFailure[];
}

export interface DashboardState {
  channels: Array<ChannelConfig & { hasCredential: boolean }>;
  models: CatalogModel[];
  chatBindings: Partial<Record<ChatSettingKey, ChatModelTarget>>;
  sync: SyncStatus;
}

export interface SyncStatus {
  enabled: boolean;
  locked: boolean;
  hasVault: boolean;
}
