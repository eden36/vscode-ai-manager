import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { normalizeChannel } from './presets';
import {
  compareSharedStates,
  createEmptySharedState,
  materializeBindings,
  materializeChannels,
  materializeChatSettings,
  materializeChatErrors,
  materializeModels,
  mergeSharedStates,
  modelRecordKey,
  parseSharedState,
  serializeSharedState,
  UnsupportedStateVersionError,
  type SharedChatSetting,
  type SharedStateV3,
  type SharedStoreChange,
  type VersionedRecord,
} from './shared-state';
import type { EncryptedVaultV2, SyncedVaultBundleV2, SyncManifestV4 } from './sync';
import type { CatalogModel, ChannelConfig, ChatBindingRecord, ChatSettingKey } from './types';

const SYNC_MANIFEST_KEY = 'aiManager.sync.manifest.v4';
const SYNC_VAULT_BUNDLE_KEY = 'aiManager.sync.vaultBundle.v2';
const SYNC_CHUNK_PREFIX = 'aiManager.sync.chunk.v4.';
const SYNC_LOCAL_KEY = 'aiManager.sync.localKey.v2';
const VAULT_KEY_FILE = 'vault-key-v2';
const PROFILE_SNAPSHOTS_KEY = 'aiManager.profile.snapshots.v4';
const LEGACY_MANIFEST_KEY = 'aiManager.sync.manifest.v3';
const LEGACY_VAULT_KEY = 'aiManager.sync.vault.v2';
const LEGACY_ENCRYPTION_KEY = 'aiManager.sync.encryptionKey.v1';
const LEGACY_CHUNK_PREFIX = 'aiManager.sync.chunk.v3.';
const LEGACY_LOCAL_KEY = 'aiManager.sync.localKey.v1';
const LEGACY_VAULT_FILE = 'vault-v1.json';
const LEGACY_VAULT_KEY_FILE = 'vault-key-v1';
// 前缀刻意不使用 aiManager.sync.，避免与 setKeysForSync 注册的同步键混淆。
const PROFILE_APPLIED_RESET_KEY = 'aiManager.profile.appliedReset.v1';
const PROFILE_SYNC_ACKNOWLEDGED_KEY = 'aiManager.profile.syncAcknowledged.v1';
const PROFILE_SYNC_V4_INITIALIZED_KEY = 'aiManager.profile.syncV4Initialized.v1';
const STATE_FILE = 'state-v3.json';
const VAULT_FILE = 'vault-v2.json';
const LOCK_FILE = 'state.lock';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 8_000;
const MAX_SYNC_CHUNKS = 256;

// 多个窗口同时启动时锁冲突属于可恢复的临时状态，调用方据此重试，不必当作故障提示用户。
export class SharedStateLockBusyError extends Error {
  override readonly name = 'SharedStateLockBusyError';

  constructor(cause?: unknown) {
    super('共享状态正被其他 VS Code 窗口占用，请稍后重试', { cause });
  }
}

export interface StorageServiceOptions {
  directory?: string;
  deviceId?: string;
  appName?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  watch?: boolean;
}

interface SyncSnapshotRef {
  snapshotId: string;
  chunkCount: number;
}

export class StorageService implements vscode.Disposable {
  private state = createEmptySharedState();
  private vault: EncryptedVaultV2 | undefined;
  private initialized = false;
  private stateWriteQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(change: SharedStoreChange) => void>();
  private watcher: FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private lastSerializedState = '';
  private lastSerializedVault = '';
  private stateError: string | undefined;
  private vaultError: string | undefined;
  private watchError: string | undefined;
  private readOnlyReason: string | undefined;
  readonly directory: string;
  readonly deviceId: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly options: StorageServiceOptions = {},
  ) {
    const environment = options.environment ?? process.env;
    this.deviceId = options.deviceId ?? vscode.env?.machineId ?? 'unknown-device';
    // 开发模式默认使用按 Profile 隔离的 globalStorage，避免调试污染真实用户目录；
    // 需要人工验证跨 Profile 行为时用 AI_MANAGER_SHARED_DIR 指向一个共享的测试目录。
    this.directory = options.directory
      ?? environment.AI_MANAGER_SHARED_DIR
      ?? (context.extensionMode !== undefined
        && context.extensionMode !== vscode.ExtensionMode.Production
        && context.globalStorageUri
        ? path.join(context.globalStorageUri.fsPath, 'shared-state')
        : resolveSharedStorageDirectory(
          options.appName ?? vscode.env?.appName ?? 'Visual Studio Code',
          options.platform ?? process.platform,
          environment,
          options.homeDirectory ?? os.homedir(),
        ));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const disk = await this.readStateFile(false);
    const diskVault = await this.readVaultFile(false);
    if (disk) this.state = disk;
    if (diskVault) this.vault = diskVault.vault;
    if ((!disk || !diskVault) && !this.readOnlyReason) {
      try {
        await this.withLock(async () => {
          const lockedDisk = await this.readStateFile(true);
          if (lockedDisk) {
            this.state = lockedDisk;
          } else if (!this.readOnlyReason) {
            this.state = createEmptySharedState();
            await this.writeStateFile(this.state);
          }
          const lockedVault = await this.readVaultFile(true);
          this.vault = lockedVault?.vault;
        });
      } catch (error) {
        // 首次创建或修复文件时若其他窗口正在写入，不能阻断扩展激活。
        this.stateError = error instanceof Error ? error.message : '共享状态初始化失败';
      }
    }
    this.lastSerializedState = serializeSharedState(this.state);
    this.lastSerializedVault = JSON.stringify(this.vault);
    this.initialized = true;
    if (this.options.watch !== false) this.startWatcher();
  }

  dispose(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watcher?.close();
    this.listeners.clear();
  }

  onDidChange(listener: (change: SharedStoreChange) => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  // 三个来源分别记录：任一来源恢复不代表其他来源已恢复，不能共用一个字段整体清空。
  getLastError(): string | undefined {
    return this.readOnlyReason ?? this.stateError ?? this.vaultError ?? this.watchError;
  }

  isReadOnly(): boolean {
    return this.readOnlyReason !== undefined;
  }

  getSharedState(): SharedStateV3 {
    return structuredClone(this.state);
  }

  getSyncGeneration(): number {
    return this.state.syncGeneration;
  }

  getChannels(): ChannelConfig[] {
    return materializeChannels(this.state).map(normalizeChannel);
  }

  getModels(): CatalogModel[] {
    return materializeModels(this.state);
  }

  async saveChannels(channels: ChannelConfig[]): Promise<void> {
    await this.updateSharedState((state) => {
      this.replaceChannels(state, channels);
    });
  }

  async updateChannels(update: (channels: ChannelConfig[]) => ChannelConfig[]): Promise<ChannelConfig[]> {
    let updated: ChannelConfig[] = [];
    await this.updateSharedState((state) => {
      updated = update(materializeChannels(state).map(normalizeChannel));
      this.replaceChannels(state, updated);
    });
    return updated;
  }

  async saveModels(models: CatalogModel[]): Promise<void> {
    await this.updateSharedState((state) => this.replaceRecords(
      state,
      state.models,
      models,
      (model) => modelRecordKey(model.channelId, model.id),
    ));
  }

  async updateModels(update: (models: CatalogModel[]) => CatalogModel[]): Promise<CatalogModel[]> {
    let updated: CatalogModel[] = [];
    await this.updateSharedState((state) => {
      updated = update(materializeModels(state));
      this.replaceRecords(state, state.models, updated, (model) => modelRecordKey(model.channelId, model.id));
    });
    return updated;
  }

  getChatBindings(): ChatBindingRecord[] {
    return materializeBindings(this.state);
  }

  // Chat 绑定与共享设置按键增量写入：调用方持有的快照在等待锁期间可能已经过期，
  // 整表替换会把其他 Profile 新增的记录标记为删除。
  async upsertChatBindings(bindings: readonly ChatBindingRecord[]): Promise<void> {
    if (bindings.length === 0) return;
    await this.updateSharedState((state) => {
      for (const binding of bindings) this.writeRecord(state, state.bindings, binding.setting, binding);
    });
  }

  async deleteChatBindings(settings: readonly ChatSettingKey[]): Promise<void> {
    if (settings.length === 0) return;
    await this.updateSharedState((state) => {
      for (const setting of settings) this.deleteRecord(state, state.bindings, setting);
    });
  }

  getSharedChatSettings(): SharedChatSetting[] {
    return materializeChatSettings(this.state);
  }

  async upsertSharedChatSettings(settings: readonly SharedChatSetting[]): Promise<void> {
    if (settings.length === 0) return;
    await this.updateSharedState((state) => {
      for (const setting of settings) this.writeRecord(state, state.chatSettings, setting.setting, setting);
    });
  }

  getChatApplicationErrors(): Partial<Record<ChatSettingKey, string>> {
    return materializeChatErrors(this.state);
  }

  async saveChatApplicationError(setting: ChatSettingKey, message: string | undefined): Promise<void> {
    await this.updateSharedState((state) => {
      if (message) this.writeRecord(state, state.chatErrors, setting, message);
      else this.deleteRecord(state, state.chatErrors, setting);
    });
  }

  async getApiKey(channelId: string): Promise<string | undefined> {
    return this.context.secrets.get(this.secretKey(channelId));
  }

  async hasApiKey(channelId: string): Promise<boolean> {
    return Boolean(await this.getApiKey(channelId));
  }

  async saveApiKey(channelId: string, apiKey: string): Promise<void> {
    const value = apiKey.trim();
    if (value) await this.context.secrets.store(this.secretKey(channelId), value);
  }

  async deleteApiKey(channelId: string): Promise<void> {
    await this.context.secrets.delete(this.secretKey(channelId));
  }

  getSyncVault(): EncryptedVaultV2 | undefined {
    return this.vault;
  }

  async saveSyncVault(vault: EncryptedVaultV2 | undefined): Promise<void> {
    await this.enqueueStateWrite(async () => {
      await this.ensureInitialized();
      if (this.readOnlyReason) throw new Error(this.readOnlyReason);
      await this.withLock(async () => {
        this.vault = vault;
        if (vault) await this.writeVaultFile(vault);
        else await rm(path.join(this.directory, VAULT_FILE), { force: true });
        this.lastSerializedVault = JSON.stringify(vault);
      });
    });
  }

  async updateSyncVaultBundle(
    update: (current: SyncedVaultBundleV2 | undefined) => Promise<SyncedVaultBundleV2>,
  ): Promise<SyncedVaultBundleV2> {
    return this.enqueueStateWrite(async () => {
      await this.ensureInitialized();
      if (this.readOnlyReason) throw new Error(this.readOnlyReason);
      let updated!: SyncedVaultBundleV2;
      await this.withLock(async () => {
        const diskVault = await this.readVaultFile(false);
        const encodedKey = await this.readSharedVaultKey();
        const current = diskVault?.vault && encodedKey
          ? { version: 2 as const, generation: this.state.syncGeneration, key: encodedKey, vault: diskVault.vault }
          : undefined;
        updated = await update(current);
        this.vault = updated.vault;
        // 每个窗口启动和每次定时同步都会走到这里，内容未变化时重写文件只会持续争抢文件锁，
        // 并让其他窗口反复触发文件监听。
        const serialized = JSON.stringify(updated.vault);
        if (!diskVault || JSON.stringify(diskVault.vault) !== serialized) await this.writeVaultFile(updated.vault);
        if (encodedKey !== updated.key) await this.atomicWrite(VAULT_KEY_FILE, `${updated.key}\n`);
        this.lastSerializedVault = serialized;
      });
      await this.saveSyncLocalKey(updated.key);
      return updated;
    });
  }

  async saveLocalVaultBundle(bundle: SyncedVaultBundleV2 | undefined): Promise<void> {
    await this.enqueueStateWrite(async () => {
      await this.ensureInitialized();
      if (this.readOnlyReason) throw new Error(this.readOnlyReason);
      await this.withLock(async () => {
        this.vault = bundle?.vault;
        if (bundle) {
          await this.writeVaultFile(bundle.vault);
          await this.atomicWrite(VAULT_KEY_FILE, `${bundle.key}\n`);
        } else {
          await rm(path.join(this.directory, VAULT_FILE), { force: true });
          await rm(path.join(this.directory, VAULT_KEY_FILE), { force: true });
        }
        this.lastSerializedVault = JSON.stringify(bundle?.vault);
      });
      if (bundle) await this.saveSyncLocalKey(bundle.key);
      else await this.deleteSyncLocalKey();
    });
  }

  getSyncedVaultBundle(): SyncedVaultBundleV2 | undefined {
    return this.context.globalState.get<SyncedVaultBundleV2>(SYNC_VAULT_BUNDLE_KEY);
  }

  async saveSyncedVaultBundle(bundle: SyncedVaultBundleV2 | undefined): Promise<void> {
    await this.context.globalState.update(SYNC_VAULT_BUNDLE_KEY, bundle);
  }

  getSyncManifest(): SyncManifestV4 | undefined {
    return this.context.globalState.get<SyncManifestV4>(SYNC_MANIFEST_KEY);
  }

  getSyncChunk(snapshotId: string, index: number): string | undefined {
    return this.context.globalState.get<string>(this.syncChunkKey(snapshotId, index));
  }

  async saveSyncSnapshot(manifest: SyncManifestV4, chunks: readonly string[]): Promise<void> {
    const previous = this.getLocalSnapshots();
    const current = { snapshotId: manifest.snapshotId, chunkCount: chunks.length };
    const retained = [current, ...previous.filter((item) => item.snapshotId !== current.snapshotId)].slice(0, 2);
    this.registerSyncKeys(manifest, [...previous, current]);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.context.globalState.update(this.syncChunkKey(manifest.snapshotId, index), chunks[index]);
    }
    await this.context.globalState.update(SYNC_MANIFEST_KEY, manifest);
    await this.context.globalState.update(PROFILE_SNAPSHOTS_KEY, retained);
    for (const stale of previous.filter((item) => !retained.some((kept) => kept.snapshotId === item.snapshotId))) {
      for (let index = 0; index < stale.chunkCount; index += 1) {
        await this.context.globalState.update(this.syncChunkKey(stale.snapshotId, index), undefined);
      }
    }
    this.registerSyncKeys(manifest, retained);
  }

  registerSyncKeys(manifest = this.getSyncManifest(), snapshots = this.getLocalSnapshots()): void {
    const manifestReference = manifest
      && typeof manifest.snapshotId === 'string'
      && /^[a-zA-Z0-9-]{1,80}$/.test(manifest.snapshotId)
      && Number.isInteger(manifest.chunkCount)
      && manifest.chunkCount >= 0
      && manifest.chunkCount <= MAX_SYNC_CHUNKS
      ? [{ snapshotId: manifest.snapshotId, chunkCount: manifest.chunkCount }]
      : [];
    const references = [...manifestReference, ...snapshots];
    const unique = references.filter((item, index) => references.findIndex((candidate) => candidate.snapshotId === item.snapshotId) === index);
    this.context.globalState.setKeysForSync([
      SYNC_MANIFEST_KEY,
      SYNC_VAULT_BUNDLE_KEY,
      ...unique.flatMap((item) => Array.from({ length: item.chunkCount }, (_, index) => this.syncChunkKey(item.snapshotId, index))),
    ]);
  }

  async clearLegacySyncData(): Promise<void> {
    const manifest = this.context.globalState.get<{ chunkCount?: unknown }>(LEGACY_MANIFEST_KEY);
    const chunkCount = Number.isInteger(manifest?.chunkCount)
      && Number(manifest?.chunkCount) >= 0
      && Number(manifest?.chunkCount) <= MAX_SYNC_CHUNKS
      ? Number(manifest?.chunkCount)
      : 0;
    const legacyKeys = [
      LEGACY_MANIFEST_KEY,
      LEGACY_VAULT_KEY,
      LEGACY_ENCRYPTION_KEY,
      ...Array.from({ length: chunkCount }, (_, index) => `${LEGACY_CHUNK_PREFIX}${index}`),
    ];
    const currentManifest = this.getSyncManifest();
    const currentSnapshots = this.getLocalSnapshots();
    const currentChunkKeys = currentManifest
      && typeof currentManifest.snapshotId === 'string'
      && /^[a-zA-Z0-9-]{1,80}$/.test(currentManifest.snapshotId)
      && Number.isInteger(currentManifest.chunkCount)
      && currentManifest.chunkCount >= 0
      && currentManifest.chunkCount <= MAX_SYNC_CHUNKS
      ? Array.from({ length: currentManifest.chunkCount }, (_, index) => this.syncChunkKey(currentManifest.snapshotId, index))
      : [];
    this.context.globalState.setKeysForSync([
      ...legacyKeys,
      SYNC_MANIFEST_KEY,
      SYNC_VAULT_BUNDLE_KEY,
      ...currentChunkKeys,
    ]);
    for (const key of legacyKeys) await this.context.globalState.update(key, undefined);
    await this.context.secrets.delete(LEGACY_LOCAL_KEY);
    await rm(path.join(this.directory, LEGACY_VAULT_FILE), { force: true });
    await rm(path.join(this.directory, LEGACY_VAULT_KEY_FILE), { force: true });
    this.registerSyncKeys(currentManifest, currentSnapshots);
  }

  // 已执行的重置代次属于单个 Profile：共享状态跨 Profile 与跨设备传播，
  // 一旦携带该标记，先执行的 Profile 会让其他 Profile 跳过各自 SecretStorage 的清理。
  getAppliedResetGeneration(): number {
    return this.context.globalState.get<number>(PROFILE_APPLIED_RESET_KEY, 0);
  }

  async saveAppliedResetGeneration(generation: number): Promise<void> {
    await this.context.globalState.update(PROFILE_APPLIED_RESET_KEY, generation);
  }

  getSyncAcknowledged(): boolean {
    return this.context.globalState.get<boolean>(PROFILE_SYNC_ACKNOWLEDGED_KEY, false);
  }

  async saveSyncAcknowledged(acknowledged: boolean): Promise<void> {
    await this.context.globalState.update(PROFILE_SYNC_ACKNOWLEDGED_KEY, acknowledged);
  }

  getSyncV4Initialized(): boolean {
    return this.context.globalState.get<boolean>(PROFILE_SYNC_V4_INITIALIZED_KEY, false);
  }

  async saveSyncV4Initialized(initialized: boolean): Promise<void> {
    await this.context.globalState.update(PROFILE_SYNC_V4_INITIALIZED_KEY, initialized);
  }

  async getSyncLocalKey(): Promise<string | undefined> {
    return this.context.secrets.get(SYNC_LOCAL_KEY);
  }

  async saveSyncLocalKey(key: string): Promise<void> {
    await this.context.secrets.store(SYNC_LOCAL_KEY, key);
  }

  async deleteSyncLocalKey(): Promise<void> {
    await this.context.secrets.delete(SYNC_LOCAL_KEY);
  }

  async readSharedVaultKey(): Promise<string | undefined> {
    try {
      const raw = await readFile(path.join(this.directory, VAULT_KEY_FILE), 'utf8');
      const trimmed = raw.trim();
      return trimmed || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.vaultError = error instanceof Error ? error.message : '共享密钥读取失败';
      return undefined;
    }
  }

  async writeSharedVaultKey(key: string): Promise<void> {
    await this.ensureInitialized();
    await this.atomicWrite(VAULT_KEY_FILE, `${key}\n`);
  }

  async deleteSharedVaultKey(): Promise<void> {
    await rm(path.join(this.directory, VAULT_KEY_FILE), { force: true });
  }

  async mergeRemoteState(remote: SharedStateV3): Promise<boolean> {
    let changed = false;
    await this.updateSharedState((state) => {
      const merged = mergeSharedStates(state, remote);
      changed = !compareSharedStates(state, merged);
      if (changed) Object.assign(state, merged);
    }, 'remote');
    return changed;
  }

  async incrementSyncGeneration(): Promise<number> {
    let generation = 0;
    await this.updateSharedState((state) => {
      state.syncGeneration += 1;
      generation = state.syncGeneration;
    });
    return generation;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async updateSharedState(
    mutate: (state: SharedStateV3) => void,
    source: SharedStoreChange['source'] = 'local',
  ): Promise<void> {
    await this.enqueueStateWrite(async () => {
      await this.ensureInitialized();
      if (this.readOnlyReason) throw new Error(this.readOnlyReason);
      const changed = await this.withLock(async () => {
        const disk = await this.readStateFile(true);
        if (disk) this.state = mergeSharedStates(this.state, disk);
        const before = serializeSharedState(this.state);
        mutate(this.state);
        const after = serializeSharedState(this.state);
        if (after === before) return false;
        await this.writeStateFile(this.state);
        this.lastSerializedState = after;
        return true;
      });
      if (changed) this.emitChange(source);
    });
  }

  private replaceChannels(state: SharedStateV3, channels: ChannelConfig[]): void {
    const cores = channels.map(normalizeChannel).map(channelCore);
    this.replaceRecords(state, state.channels, cores, (channel) => channel.id);
    const activeIds = new Set(channels.map((channel) => channel.id));
    for (const channel of channels) {
      const refresh = {
        ...(channel.lastRefreshAt === undefined ? {} : { lastRefreshAt: channel.lastRefreshAt }),
        ...(channel.lastRefreshError === undefined ? {} : { lastRefreshError: channel.lastRefreshError }),
      };
      this.writeRecord(state, state.refresh, channel.id, refresh);
    }
    for (const key of Object.keys(state.refresh)) {
      if (!activeIds.has(key)) this.deleteRecord(state, state.refresh, key);
    }
  }

  private replaceRecords<T>(
    state: SharedStateV3,
    records: Record<string, VersionedRecord<T>>,
    values: readonly T[],
    keyOf: (value: T) => string,
  ): void {
    const active = new Set<string>();
    for (const value of values) {
      const key = keyOf(value);
      active.add(key);
      this.writeRecord(state, records, key, value);
    }
    for (const key of Object.keys(records)) {
      if (!active.has(key)) this.deleteRecord(state, records, key);
    }
  }

  private writeRecord<T>(
    state: SharedStateV3,
    records: Record<string, VersionedRecord<T>>,
    key: string,
    value: T,
  ): void {
    const current = records[key];
    if (!current?.deleted && current?.value !== undefined && JSON.stringify(current.value) === JSON.stringify(value)) return;
    state.clock += 1;
    records[key] = { revision: state.clock, deviceId: this.deviceId, value };
  }

  private deleteRecord<T>(
    state: SharedStateV3,
    records: Record<string, VersionedRecord<T>>,
    key: string,
  ): void {
    const current = records[key];
    if (!current || current.deleted) return;
    state.clock += 1;
    records[key] = { revision: state.clock, deviceId: this.deviceId, deleted: true };
  }

  // preserveCorrupt 只能在已持有文件锁时为 true：重命名目标文件会与其他窗口的写入竞争。
  private async readStateFile(preserveCorrupt: boolean): Promise<SharedStateV3 | undefined> {
    try {
      const content = await readFile(path.join(this.directory, STATE_FILE), 'utf8');
      const state = parseSharedState(JSON.parse(content));
      this.stateError = undefined;
      return state;
    } catch (error) {
      if (isMissingFile(error)) {
        this.stateError = undefined;
        return undefined;
      }
      if (error instanceof UnsupportedStateVersionError) {
        this.readOnlyReason = error.message;
        this.stateError = error.message;
        return undefined;
      }
      this.stateError = error instanceof Error ? error.message : '共享状态读取失败';
      if (preserveCorrupt) await this.preserveCorruptFile(STATE_FILE);
      return undefined;
    }
  }

  // 返回 undefined 表示读取失败，`{ vault: undefined }` 表示文件确实不存在。
  // 两者不可混同：把读取失败当作保险库已删除，会让同步误判为未启用并清除本机凭据。
  private async readVaultFile(preserveCorrupt: boolean): Promise<{ vault: EncryptedVaultV2 | undefined } | undefined> {
    try {
      const vault = JSON.parse(await readFile(path.join(this.directory, VAULT_FILE), 'utf8')) as EncryptedVaultV2;
      this.vaultError = undefined;
      return { vault };
    } catch (error) {
      if (isMissingFile(error)) {
        this.vaultError = undefined;
        return { vault: undefined };
      }
      this.vaultError = error instanceof Error ? error.message : '共享保险库读取失败';
      if (preserveCorrupt) await this.preserveCorruptFile(VAULT_FILE);
      return undefined;
    }
  }

  private async writeStateFile(state: SharedStateV3): Promise<void> {
    await this.atomicWrite(STATE_FILE, `${serializeSharedState(state, true)}\n`);
  }

  private async writeVaultFile(vault: EncryptedVaultV2): Promise<void> {
    await this.atomicWrite(VAULT_FILE, `${JSON.stringify(vault, null, 2)}\n`);
  }

  private async atomicWrite(fileName: string, content: string): Promise<void> {
    const target = path.join(this.directory, fileName);
    const temporary = path.join(this.directory, `${fileName}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async preserveCorruptFile(fileName: string): Promise<void> {
    const source = path.join(this.directory, fileName);
    const target = path.join(this.directory, `${fileName}.corrupt-${Date.now()}`);
    await rename(source, target).catch(() => undefined);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.directory, LOCK_FILE);
    const started = Date.now();
    while (true) {
      // 只有获取锁本身的 EEXIST 才重试；operation 抛出的同名错误一旦被当作锁冲突，
      // 会在锁已释放的情况下重复执行业务逻辑。
      let handle: FileHandle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (!isFileExists(error)) throw error;
        if (await this.isLockAbandoned(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() - started >= LOCK_WAIT_MS) throw new SharedStateLockBusyError(error);
        // 退避时间加随机抖动，避免多个窗口在同一时刻反复争抢同一把锁。
        await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 50));
        continue;
      }
      try {
        await handle.writeFile(`${Date.now()} ${process.pid}`, 'utf8');
        return await operation();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    }
  }

  // 窗口崩溃或被强制关闭会残留锁文件。只按 mtime 判断要等满 LOCK_STALE_MS，
  // 这段时间内新窗口的写入全部失败，因此锁文件同时记录持有者进程号，用于立即识别已退出的持有者。
  private async isLockAbandoned(lockPath: string): Promise<boolean> {
    const info = await stat(lockPath).catch(() => undefined);
    if (!info) return false;
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
    const owner = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim().split(' ')[1]);
    if (!Number.isInteger(owner) || owner <= 0) return false;
    try {
      process.kill(owner, 0);
      return false;
    } catch (error) {
      // EPERM 表示进程存在但无权访问，只有 ESRCH 才能确认持有者已退出。
      return isNodeError(error) && error.code === 'ESRCH';
    }
  }

  private startWatcher(): void {
    this.watcher = watch(this.directory, (_event, fileName) => {
      // 部分平台在合并事件时不提供文件名，此时按可能变化处理，避免漏掉其他 Profile 的写入。
      if (fileName !== null && fileName !== STATE_FILE && fileName !== VAULT_FILE) return;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => void this.reloadExternal(), 100);
    });
    this.watcher.on('error', (error) => {
      this.watchError = `共享状态监听失败：${error.message}`;
    });
  }

  private async reloadExternal(): Promise<void> {
    await this.enqueueStateWrite(async () => {
      // 保险库单独更新时状态文件不会变化，因此状态未变也必须继续检查保险库，
      // 否则同一台设备上其他 Profile 保存的凭据无法传播过来。
      let stateChanged = false;
      const disk = await this.readStateFile(false);
      if (disk && serializeSharedState(disk) !== this.lastSerializedState) {
        const merged = mergeSharedStates(this.state, disk);
        stateChanged = !compareSharedStates(this.state, merged);
        this.state = merged;
        this.lastSerializedState = serializeSharedState(merged);
      }
      const result = await this.readVaultFile(false);
      let vaultChanged = false;
      if (result) {
        const serializedVault = JSON.stringify(result.vault);
        vaultChanged = serializedVault !== this.lastSerializedVault;
        this.vault = result.vault;
        this.lastSerializedVault = serializedVault;
      }
      if (stateChanged || vaultChanged) this.emitChange('external');
    });
  }

  private emitChange(source: SharedStoreChange['source']): void {
    const change = { source, revision: this.state.clock } satisfies SharedStoreChange;
    for (const listener of this.listeners) listener(change);
  }

  private secretKey(channelId: string): string {
    return `aiManager.channel.${channelId}.apiKey`;
  }

  private getLocalSnapshots(): SyncSnapshotRef[] {
    const value = this.context.globalState.get<unknown>(PROFILE_SNAPSHOTS_KEY);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as Partial<SyncSnapshotRef>;
      return typeof candidate.snapshotId === 'string'
        && Number.isInteger(candidate.chunkCount)
        && Number(candidate.chunkCount) >= 0
        && Number(candidate.chunkCount) <= MAX_SYNC_CHUNKS
        ? [{ snapshotId: candidate.snapshotId, chunkCount: Number(candidate.chunkCount) }]
        : [];
    });
  }

  private syncChunkKey(snapshotId: string, index: number): string {
    return `${SYNC_CHUNK_PREFIX}${snapshotId}.${index}`;
  }

  private enqueueStateWrite<T>(operation: () => PromiseLike<T>): Promise<T> {
    const result = this.stateWriteQueue.then(operation);
    this.stateWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function resolveSharedStorageDirectory(
  appName: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const variant = appName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-') || 'vscode';
  if (platform === 'win32') {
    return path.join(environment.APPDATA || path.join(homeDirectory, 'AppData', 'Roaming'), 'AI Manager', variant);
  }
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', 'AI Manager', variant);
  }
  return path.join(environment.XDG_CONFIG_HOME || path.join(homeDirectory, '.config'), 'ai-manager', variant);
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isFileExists(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function channelCore(channel: ChannelConfig): Omit<ChannelConfig, 'lastRefreshAt' | 'lastRefreshError'> {
  return {
    id: channel.id,
    name: channel.name,
    preset: channel.preset,
    baseUrl: channel.baseUrl,
    modelsPath: channel.modelsPath,
    chatPath: channel.chatPath,
    anthropicPath: channel.anthropicPath,
    geminiPath: channel.geminiPath,
    responsesPath: channel.responsesPath,
    defaultProtocol: channel.defaultProtocol,
    authMode: channel.authMode,
    enabled: channel.enabled,
    timeoutMs: channel.timeoutMs,
    refreshIntervalMinutes: channel.refreshIntervalMinutes,
    defaultMaxInputTokens: channel.defaultMaxInputTokens,
    defaultMaxOutputTokens: channel.defaultMaxOutputTokens,
  };
}
