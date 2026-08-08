import type { CatalogModel, ChannelConfig, ChatBindingRecord, ChatSettingKey } from './types';
import { isReasoningEffort } from './reasoning-effort';

export interface VersionedRecord<T> {
  revision: number;
  deviceId: string;
  value?: T;
  deleted?: true;
}

export interface ChannelRefreshState {
  lastRefreshAt?: number;
  lastRefreshError?: string;
}

export interface SharedChatSetting {
  setting: ChatSettingKey;
  hadValue: boolean;
  value?: unknown;
}

export interface SharedStateV3 {
  version: 3;
  clock: number;
  syncGeneration: number;
  channels: Record<string, VersionedRecord<Omit<ChannelConfig, 'lastRefreshAt' | 'lastRefreshError'>>>;
  refresh: Record<string, VersionedRecord<ChannelRefreshState>>;
  models: Record<string, VersionedRecord<CatalogModel>>;
  bindings: Record<string, VersionedRecord<ChatBindingRecord>>;
  chatSettings: Record<string, VersionedRecord<SharedChatSetting>>;
  chatErrors: Record<string, VersionedRecord<string>>;
}

export interface SharedStoreChange {
  source: 'local' | 'external' | 'remote';
  revision: number;
}

export function createEmptySharedState(): SharedStateV3 {
  return {
    version: 3,
    clock: 0,
    syncGeneration: 0,
    channels: {},
    refresh: {},
    models: {},
    bindings: {},
    chatSettings: {},
    chatErrors: {},
  };
}

export function modelRecordKey(channelId: string, modelId: string): string {
  return `${channelId}\0${modelId}`;
}

export function mergeSharedStates(left: SharedStateV3, right: SharedStateV3): SharedStateV3 {
  return {
    version: 3,
    clock: Math.max(left.clock, right.clock),
    syncGeneration: Math.max(left.syncGeneration, right.syncGeneration),
    channels: mergeRecordMaps(left.channels, right.channels),
    refresh: mergeRecordMaps(left.refresh, right.refresh),
    models: mergeRecordMaps(left.models, right.models),
    bindings: mergeRecordMaps(left.bindings, right.bindings),
    chatSettings: mergeRecordMaps(left.chatSettings, right.chatSettings),
    chatErrors: mergeRecordMaps(left.chatErrors, right.chatErrors),
  };
}

export function materializeChannels(state: SharedStateV3): ChannelConfig[] {
  return Object.values(state.channels).flatMap((record) => {
    if (record.deleted || !record.value) return [];
    const refresh = state.refresh[record.value.id];
    return [{
      ...record.value,
      ...(!refresh?.deleted && refresh?.value ? refresh.value : {}),
    }];
  });
}

// 以下三个函数必须返回副本：调用方原地修改会污染内部状态，并让 writeRecord 的
// 序列化判等误认为「无变化」而丢弃更新。SharedChatSetting.value 是 unknown，
// 可能是对象或数组，浅拷贝不足以隔离，统一使用 structuredClone。
export function materializeModels(state: SharedStateV3): CatalogModel[] {
  return Object.values(state.models).flatMap((record) => record.deleted || !record.value ? [] : [structuredClone(record.value)]);
}

export function materializeBindings(state: SharedStateV3): ChatBindingRecord[] {
  return Object.values(state.bindings).flatMap((record) => record.deleted || !record.value ? [] : [structuredClone(record.value)]);
}

export function materializeChatSettings(state: SharedStateV3): SharedChatSetting[] {
  return Object.values(state.chatSettings).flatMap((record) => record.deleted || !record.value ? [] : [structuredClone(record.value)]);
}

export function materializeChatErrors(state: SharedStateV3): Partial<Record<ChatSettingKey, string>> {
  return Object.fromEntries(Object.entries(state.chatErrors).flatMap(([key, record]) => (
    record.deleted || !record.value ? [] : [[key, record.value]]
  ))) as Partial<Record<ChatSettingKey, string>>;
}

/** 状态文件由更高版本的扩展写入。此时必须只读降级，不能当作损坏文件接管。 */
export class UnsupportedStateVersionError extends Error {
  constructor(readonly foundVersion: number) {
    super(`共享状态版本 ${foundVersion} 由更高版本的 AI Manager 写入，请升级扩展后再使用`);
    this.name = 'UnsupportedStateVersionError';
  }
}

export function parseSharedState(value: unknown): SharedStateV3 {
  if (isObject(value) && isNonNegativeInteger(value.version) && value.version > 3) {
    throw new UnsupportedStateVersionError(value.version);
  }
  if (!isObject(value) || value.version !== 3 || !isNonNegativeInteger(value.clock) || !isNonNegativeInteger(value.syncGeneration)) {
    throw new Error('共享状态格式错误');
  }
  return {
    version: 3,
    clock: value.clock,
    syncGeneration: value.syncGeneration,
    channels: parseRecordMap(value.channels, isChannelCore),
    refresh: parseRecordMap(value.refresh, isRefreshState),
    models: parseRecordMap(value.models, isCatalogModel),
    bindings: parseRecordMap(value.bindings, isChatBinding),
    chatSettings: parseRecordMap(value.chatSettings, isSharedChatSetting),
    chatErrors: value.chatErrors === undefined ? {} : parseRecordMap(value.chatErrors, isString),
  };
}

export function compareSharedStates(left: SharedStateV3, right: SharedStateV3): boolean {
  return serializeSharedState(left) === serializeSharedState(right);
}

export function serializeSharedState(state: SharedStateV3, pretty = false): string {
  return JSON.stringify({
    ...state,
    channels: sortRecordMap(state.channels),
    refresh: sortRecordMap(state.refresh),
    models: sortRecordMap(state.models),
    bindings: sortRecordMap(state.bindings),
    chatSettings: sortRecordMap(state.chatSettings),
    chatErrors: sortRecordMap(state.chatErrors),
  }, null, pretty ? 2 : undefined);
}

function mergeRecordMaps<T>(
  left: Record<string, VersionedRecord<T>>,
  right: Record<string, VersionedRecord<T>>,
): Record<string, VersionedRecord<T>> {
  const result = { ...left };
  for (const [key, candidate] of Object.entries(right)) {
    const current = result[key];
    if (!current || compareRecord(candidate, current) > 0) result[key] = candidate;
  }
  return result;
}

function compareRecord<T>(left: VersionedRecord<T>, right: VersionedRecord<T>): number {
  if (left.revision !== right.revision) return left.revision - right.revision;
  return left.deviceId.localeCompare(right.deviceId);
}

function sortRecordMap<T>(records: Record<string, VersionedRecord<T>>): Record<string, VersionedRecord<T>> {
  return Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right)));
}

// 共享文件在本机可被编辑，远端记录来自 Settings Sync，两者都不可信。
// 记录骨架非法时整体拒绝；单条记录内容非法时跳过该条，避免一条脏数据拖垮全部配置。
function parseRecordMap<T>(value: unknown, isValidValue?: (candidate: unknown) => boolean): Record<string, VersionedRecord<T>> {
  if (!isObject(value)) throw new Error('共享状态记录格式错误');
  const result: Record<string, VersionedRecord<T>> = {};
  for (const [key, record] of Object.entries(value)) {
    if (!isObject(record)
      || !isNonNegativeInteger(record.revision)
      || typeof record.deviceId !== 'string'
      || (record.deleted !== true && !Object.hasOwn(record, 'value'))) {
      throw new Error(`共享状态记录格式错误：${key}`);
    }
    if (record.deleted !== true && isValidValue && !isValidValue(record.value)) continue;
    result[key] = {
      revision: record.revision,
      deviceId: record.deviceId,
      ...(record.deleted === true ? { deleted: true } : { value: record.value as T }),
    };
  }
  return result;
}

function isChannelCore(value: unknown): boolean {
  return isObject(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.baseUrl === 'string';
}

function isCatalogModel(value: unknown): boolean {
  return isObject(value)
    && typeof value.channelId === 'string'
    && typeof value.id === 'string'
    && typeof value.providerId === 'string'
    && typeof value.maxInputTokens === 'number'
    && typeof value.maxOutputTokens === 'number'
    && (value.reasoningEfforts === undefined
      || (Array.isArray(value.reasoningEfforts) && value.reasoningEfforts.every(isReasoningEffort)));
}

function isRefreshState(value: unknown): boolean {
  return isObject(value)
    && (value.lastRefreshAt === undefined || typeof value.lastRefreshAt === 'number')
    && (value.lastRefreshError === undefined || typeof value.lastRefreshError === 'string');
}

function isChatBinding(value: unknown): boolean {
  return isObject(value)
    && typeof value.setting === 'string'
    && typeof value.providerId === 'string'
    && typeof value.appliedValue === 'string'
    && typeof value.previousHadGlobalValue === 'boolean';
}

function isSharedChatSetting(value: unknown): boolean {
  return isObject(value) && typeof value.setting === 'string' && typeof value.hadValue === 'boolean';
}

function isString(value: unknown): boolean {
  return typeof value === 'string';
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
