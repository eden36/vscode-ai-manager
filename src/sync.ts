import { createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { deflateRaw, inflateRaw } from 'node:zlib';
import type { SharedStateV3 } from './shared-state';
import { createEmptySharedState, parseSharedState, serializeSharedState } from './shared-state';
import type { CatalogModel, ChannelConfig, SyncStatus } from './types';
import type { StorageService } from './storage';
import { createModelProviderId, getProtocolPath } from './models';

const VAULT_VERSION = 1;
const PROFILE_VERSION = 2;
const MANIFEST_VERSION = 3;
const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const CHUNK_SIZE = 48 * 1024;
const AAD = Buffer.from('ai-manager:v1', 'utf8');
const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);

export type SyncedChannelConfig = Omit<ChannelConfig, 'lastRefreshAt' | 'lastRefreshError'>;

export interface SyncedModelPreference {
  channelId: string;
  id: string;
  enabled: boolean;
  customAlias?: string;
  metadataOverridden?: boolean;
  protocol?: CatalogModel['protocol'];
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
}

export interface SyncProfile {
  version: 1 | 2;
  updatedAt: number;
  channels: SyncedChannelConfig[];
  models: SyncedModelPreference[];
}

export interface EncryptedVault {
  version: 1;
  updatedAt: number;
  kdf: {
    name: 'PBKDF2-SHA256';
    iterations: number;
    salt: string;
  };
  cipher: {
    name: 'AES-256-GCM';
    iv: string;
    tag: string;
    ciphertext: string;
  };
}

export interface SyncManifestV3 {
  version: 3;
  generation: number;
  updatedAt: number;
  chunkCount: number;
  encoding: 'deflate-raw-base64';
  checksum: string;
  reset?: true;
}

interface VaultPayload {
  credentials: Record<string, string>;
}

export async function createEncryptedVault(credentials: Record<string, string>, password: string): Promise<{ vault: EncryptedVault; key: Buffer }> {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return { vault: encryptWithKey(credentials, key, salt), key };
}

export async function unlockEncryptedVault(vault: EncryptedVault, password: string): Promise<{ credentials: Record<string, string>; key: Buffer }> {
  validatePassword(password);
  const salt = validateVault(vault);
  const key = await deriveKey(password, salt);
  return { credentials: decryptWithKey(vault, key), key };
}

export function encryptWithKey(credentials: Record<string, string>, key: Buffer, salt: Buffer, updatedAt = Date.now()): EncryptedVault {
  if (key.length !== KEY_LENGTH || salt.length !== 16) throw new Error('同步密钥格式错误');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ credentials } satisfies VaultPayload), 'utf8'), cipher.final()]);
  return {
    version: VAULT_VERSION,
    updatedAt,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: salt.toString('base64') },
    cipher: { name: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
  };
}

export function decryptWithKey(vault: EncryptedVault, key: Buffer): Record<string, string> {
  validateVault(vault);
  if (key.length !== KEY_LENGTH) throw new Error('同步密钥格式错误');
  try {
    const iv = Buffer.from(vault.cipher.iv, 'base64');
    const tag = Buffer.from(vault.cipher.tag, 'base64');
    const ciphertext = Buffer.from(vault.cipher.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plaintext) as Partial<VaultPayload>;
    if (!payload.credentials || typeof payload.credentials !== 'object' || Array.isArray(payload.credentials)) throw new Error();
    const credentials = Object.fromEntries(Object.entries(payload.credentials).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    if (Object.keys(credentials).length !== Object.keys(payload.credentials).length) throw new Error();
    return credentials;
  } catch {
    throw new Error('同步主密码错误或保险库已损坏');
  }
}

export async function encodeSharedState(state: SharedStateV3): Promise<{ manifest: SyncManifestV3; chunks: string[] }> {
  const compressed = await deflate(Buffer.from(serializeSharedState(state), 'utf8'));
  const payload = compressed.toString('base64');
  const chunks = Array.from({ length: Math.ceil(payload.length / CHUNK_SIZE) }, (_, index) => payload.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
  return {
    manifest: {
      version: MANIFEST_VERSION,
      generation: state.syncGeneration,
      updatedAt: Date.now(),
      chunkCount: chunks.length,
      encoding: 'deflate-raw-base64',
      checksum: createHash('sha256').update(compressed).digest('hex'),
    },
    chunks,
  };
}

export async function decodeSharedState(manifest: SyncManifestV3, chunks: readonly string[]): Promise<SharedStateV3> {
  validateManifest(manifest);
  if (manifest.reset) return { ...createEmptySharedState(), syncGeneration: manifest.generation };
  if (chunks.length !== manifest.chunkCount || chunks.some((chunk) => typeof chunk !== 'string')) throw new Error('同步状态分块不完整');
  const compressed = Buffer.from(chunks.join(''), 'base64');
  const checksum = createHash('sha256').update(compressed).digest('hex');
  if (checksum !== manifest.checksum) throw new Error('同步状态校验失败');
  return parseSharedState(JSON.parse((await inflate(compressed)).toString('utf8')));
}

export class SyncService {
  private operationQueue: Promise<void> = Promise.resolve();
  private lastAppliedLegacyProfileAt = 0;
  private lastImportedVaultAt = 0;
  private lastPublishedState = '';
  private lastAppliedManifest = '';
  private locked = false;
  private lastError: string | undefined;

  constructor(private readonly storage: StorageService) {
    storage.registerSyncKeys();
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      let remoteApplied = false;
      try {
        remoteApplied = await this.applyRemoteState();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : '同步状态读取失败';
      }
      try {
        if (!remoteApplied) await this.applyLegacyProfile();
      } catch (error) {
        // 旧版配置迁移失败不能中断初始化，否则凭据无法导入，同步会一直显示为未解锁。
        this.lastError = error instanceof Error ? error.message : '同步配置迁移失败';
      }
      await this.reconcileVault();
      if (this.getStatus().enabled && !this.lastError) await this.publishState();
    });
  }

  getStatus(): SyncStatus {
    const hasVault = Boolean(this.storage.getSyncVault());
    const error = this.lastError ?? this.storage.getLastError();
    return {
      enabled: hasVault,
      locked: hasVault && this.locked,
      hasVault,
      localShared: true,
      cloudState: error ? 'error' : hasVault ? 'synced' : 'waiting',
      ...(error ? { error } : {}),
    };
  }

  async reconcile(): Promise<void> {
    await this.enqueue(async () => {
      this.lastError = undefined;
      try {
        await this.applyRemoteState();
        await this.reconcileVault();
        if (this.getStatus().enabled) await this.publishState();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : '同步失败';
      }
    });
  }

  async enable(password: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.getStatus().enabled) throw new Error('API Key 同步已经启用');
      const credentials = await this.readLocalCredentials();
      const { vault: created, key } = await createEncryptedVault(credentials, password);
      const current = this.storage.getSyncedVault();
      const vault = { ...created, updatedAt: Math.max(created.updatedAt, (current?.updatedAt ?? 0) + 1) };
      await this.storage.saveSyncVault(vault);
      await this.storage.saveSyncedVault(vault);
      await this.storage.saveSyncLocalKey(key.toString('base64'));
      this.lastImportedVaultAt = vault.updatedAt;
      this.locked = false;
      await this.publishState();
    });
  }

  async unlock(password: string): Promise<void> {
    await this.enqueue(async () => {
      const vault = this.storage.getSyncVault() ?? this.storage.getSyncedVault();
      if (!vault) throw new Error('没有可解锁的同步保险库');
      const { credentials, key } = await unlockEncryptedVault(vault, password);
      if (!this.storage.getSyncVault()) await this.storage.saveSyncVault(vault);
      await this.importCredentials(credentials);
      await this.storage.saveSyncLocalKey(key.toString('base64'));
      this.lastImportedVaultAt = vault.updatedAt;
      this.locked = false;
    });
  }

  async changePassword(password: string): Promise<void> {
    await this.enqueue(async () => {
      const credentials = await this.decryptCurrentVault();
      const current = this.storage.getSyncVault()!;
      const { vault: created, key } = await createEncryptedVault(credentials, password);
      const vault = { ...created, updatedAt: Math.max(created.updatedAt, current.updatedAt + 1) };
      await this.storage.saveSyncVault(vault);
      await this.storage.saveSyncedVault(vault);
      await this.storage.saveSyncLocalKey(key.toString('base64'));
      this.lastImportedVaultAt = vault.updatedAt;
      this.locked = false;
    });
  }

  async reset(): Promise<void> {
    await this.enqueue(async () => {
      for (const channel of this.storage.getChannels()) await this.storage.deleteApiKey(channel.id);
      await this.storage.deleteSyncLocalKey();
      const generation = await this.storage.incrementSyncGeneration();
      await this.storage.saveSyncChunks([]);
      await this.storage.saveSyncManifest({
        version: MANIFEST_VERSION,
        generation,
        updatedAt: Date.now(),
        chunkCount: 0,
        encoding: 'deflate-raw-base64',
        checksum: '',
        reset: true,
      });
      await this.storage.saveSyncedVault(undefined);
      await this.storage.saveSyncVault(undefined);
      await this.storage.saveAppliedResetGeneration(generation);
      this.lastImportedVaultAt = 0;
      this.lastPublishedState = '';
      this.locked = false;
    });
  }

  async saveCredential(channelId: string, apiKey: string | undefined): Promise<void> {
    await this.enqueue(async () => {
      const normalized = apiKey?.trim() || undefined;
      if (!this.getStatus().enabled) {
        if (normalized) await this.storage.saveApiKey(channelId, normalized);
        else await this.storage.deleteApiKey(channelId);
        return;
      }
      const vault = this.storage.getSyncVault()!;
      const key = await this.requireLocalKey();
      const credentials = decryptWithKey(vault, key);
      if (normalized) credentials[channelId] = normalized;
      else delete credentials[channelId];
      const previous = await this.storage.getApiKey(channelId);
      try {
        if (normalized) await this.storage.saveApiKey(channelId, normalized);
        else await this.storage.deleteApiKey(channelId);
        const updated = encryptWithKey(credentials, key, Buffer.from(vault.kdf.salt, 'base64'), Math.max(Date.now(), vault.updatedAt + 1));
        await this.storage.saveSyncVault(updated);
        await this.storage.saveSyncedVault(updated);
        this.lastImportedVaultAt = updated.updatedAt;
      } catch (error) {
        if (previous) await this.storage.saveApiKey(channelId, previous);
        else await this.storage.deleteApiKey(channelId);
        throw error;
      }
    });
  }

  assertUnlocked(): void {
    if (this.getStatus().locked) throw new Error('请先解锁 API Key 同步');
  }

  async saveProfileFromLocal(): Promise<void> {
    await this.enqueue(async () => {
      if (this.getStatus().enabled) await this.publishState();
    });
  }

  applyPreference(model: CatalogModel, channels = this.storage.getChannels()): CatalogModel {
    const channel = channels.find((item) => item.id === model.channelId);
    const preference = this.storage.getModels().find((item) => item.channelId === model.channelId && item.id === model.id);
    const legacyPreference = preference ? undefined : this.storage.getSyncProfile()?.models
      .find((item) => item.channelId === model.channelId && item.id === model.id);
    const protocol = preference?.metadataOverridden
      ? preference.protocol
      : legacyPreference?.metadataOverridden
        ? legacyPreference.protocol ?? model.protocol
        : model.protocol;
    const providerId = channel ? createModelProviderId(channel, model.id, protocol) : model.providerId;
    if (!preference) {
      if (!legacyPreference) return { ...model, providerId };
      return {
        ...model,
        providerId,
        customAlias: legacyPreference.customAlias,
        enabled: Boolean(channel && getProtocolPath(channel, protocol) && legacyPreference.enabled),
        ...(legacyPreference.metadataOverridden ? {
          protocol,
          maxInputTokens: legacyPreference.maxInputTokens ?? model.maxInputTokens,
          maxOutputTokens: legacyPreference.maxOutputTokens ?? model.maxOutputTokens,
          toolCalling: legacyPreference.toolCalling ?? model.toolCalling,
          metadataOverridden: true,
        } : {}),
      };
    }
    return {
      ...model,
      providerId,
      customAlias: preference.customAlias,
      enabled: Boolean(channel && getProtocolPath(channel, protocol) && preference.enabled),
      ...(preference.metadataOverridden ? {
        protocol,
        maxInputTokens: preference.maxInputTokens,
        maxOutputTokens: preference.maxOutputTokens,
        toolCalling: preference.toolCalling,
        metadataOverridden: true,
      } : {}),
    };
  }

  private async applyRemoteState(): Promise<boolean> {
    const manifest = this.storage.getSyncManifest();
    if (!manifest || manifest.version !== MANIFEST_VERSION) return false;
    this.storage.registerSyncKeys(manifest.chunkCount);
    if (manifest.generation < this.storage.getSyncGeneration()) return false;
    // 定时协调每分钟触发一次，而清单只在远端真正变化后才更新：
    // 跳过未变化的清单可以省掉整份状态的解压和校验和计算。
    const key = manifestKey(manifest);
    if (key === this.lastAppliedManifest) return true;
    const chunks = Array.from({ length: manifest.chunkCount }, (_, index) => this.storage.getSyncChunk(index));
    if (chunks.some((chunk) => chunk === undefined)) throw new Error('同步状态分块尚未完整到达');
    const remote = await decodeSharedState(manifest, chunks as string[]);
    if (manifest.reset) {
      // 重置清单会长期留在同步数据中，必须按 Profile 记录已执行代次，否则每次协调都会重复清除凭据。
      if (manifest.generation <= this.storage.getAppliedResetGeneration()) {
        this.lastAppliedManifest = key;
        return true;
      }
      await this.storage.mergeRemoteState(remote);
      await this.storage.saveSyncVault(undefined);
      await this.storage.deleteSyncLocalKey();
      for (const channel of this.storage.getChannels()) await this.storage.deleteApiKey(channel.id);
      await this.storage.saveAppliedResetGeneration(manifest.generation);
      this.lastAppliedManifest = key;
      this.locked = false;
      return true;
    }
    await this.storage.mergeRemoteState(remote);
    this.lastAppliedManifest = key;
    this.lastPublishedState = serializeSharedState(remote);
    return true;
  }

  private async publishState(): Promise<void> {
    const state = syncPayloadState(this.storage.getSharedState());
    const serialized = serializeSharedState(state);
    const currentManifest = this.storage.getSyncManifest();
    if (serialized === this.lastPublishedState
      && currentManifest?.generation === state.syncGeneration
      && !currentManifest.reset) return;
    const { manifest, chunks } = await encodeSharedState(state);
    await this.storage.saveSyncChunks(chunks);
    await this.storage.saveSyncManifest(manifest);
    const vault = this.storage.getSyncVault();
    if (vault) await this.storage.saveSyncedVault(vault);
    this.lastPublishedState = serialized;
    // 记住自己刚写出的清单，避免下一次协调重新解码本 Profile 发布的数据。
    this.lastAppliedManifest = manifestKey(manifest);
  }

  private async reconcileVault(): Promise<void> {
    const local = this.storage.getSyncVault();
    const remote = this.storage.getSyncedVault();
    try {
      if (remote && (!local || remote.updatedAt > local.updatedAt)) await this.storage.saveSyncVault(remote);
      else if (local && (!remote || local.updatedAt > remote.updatedAt)) await this.storage.saveSyncedVault(local);
    } catch (error) {
      // 共享状态只读降级或写入失败时仍要继续导入本 Profile 凭据，否则会被误判为未解锁。
      this.lastError = error instanceof Error ? error.message : '同步保险库写入失败';
    }
    await this.importVaultWithLocalKey();
  }

  private async applyLegacyProfile(): Promise<void> {
    const profile = this.storage.getSyncProfile();
    if (!profile || (profile.version !== 1 && profile.version !== PROFILE_VERSION) || profile.updatedAt === this.lastAppliedLegacyProfileAt) return;
    const localChannels = new Map(this.storage.getChannels().map((channel) => [channel.id, channel]));
    const channels = profile.channels.map((channel) => {
      const local = localChannels.get(channel.id);
      return {
        ...channel,
        ...(local?.lastRefreshAt === undefined ? {} : { lastRefreshAt: local.lastRefreshAt }),
        ...(local?.lastRefreshError === undefined ? {} : { lastRefreshError: local.lastRefreshError }),
      };
    });
    const preferences = new Map(profile.models.map((model) => [`${model.channelId}\0${model.id}`, model]));
    const models = this.storage.getModels()
      .filter((model) => channels.some((channel) => channel.id === model.channelId))
      .map((model) => {
        const preference = preferences.get(`${model.channelId}\0${model.id}`);
        const channel = channels.find((item) => item.id === model.channelId);
        if (!preference) return { ...model, providerId: channel ? createModelProviderId(channel, model.id, model.protocol) : model.providerId };
        const protocol = preference.metadataOverridden ? preference.protocol ?? model.protocol : model.protocol;
        return {
          ...model,
          providerId: channel ? createModelProviderId(channel, model.id, protocol) : model.providerId,
          customAlias: preference.customAlias,
          enabled: preference.enabled,
          ...(preference.metadataOverridden ? {
            protocol,
            maxInputTokens: preference.maxInputTokens ?? model.maxInputTokens,
            maxOutputTokens: preference.maxOutputTokens ?? model.maxOutputTokens,
            toolCalling: preference.toolCalling ?? model.toolCalling,
            metadataOverridden: true,
          } : {}),
        };
      });
    await this.storage.saveChannels(channels);
    await this.storage.saveModels(models);
    this.lastAppliedLegacyProfileAt = profile.updatedAt;
  }

  private async importVaultWithLocalKey(): Promise<void> {
    const vault = this.storage.getSyncVault();
    if (!vault) {
      if (await this.storage.getSyncLocalKey()) {
        for (const channel of this.storage.getChannels()) await this.storage.deleteApiKey(channel.id);
        await this.storage.deleteSyncLocalKey();
      }
      this.lastImportedVaultAt = 0;
      this.locked = false;
      return;
    }
    const encodedKey = await this.storage.getSyncLocalKey();
    if (!encodedKey) {
      this.locked = true;
      return;
    }
    try {
      const credentials = decryptWithKey(vault, Buffer.from(encodedKey, 'base64'));
      await this.importCredentials(credentials);
      this.lastImportedVaultAt = vault.updatedAt;
      this.locked = false;
    } catch {
      await this.storage.deleteSyncLocalKey();
      this.locked = true;
    }
  }

  private async importCredentials(credentials: Record<string, string>): Promise<void> {
    for (const channel of this.storage.getChannels()) {
      const apiKey = credentials[channel.id];
      if (apiKey) await this.storage.saveApiKey(channel.id, apiKey);
      else await this.storage.deleteApiKey(channel.id);
    }
  }

  private async readLocalCredentials(): Promise<Record<string, string>> {
    const entries = await Promise.all(this.storage.getChannels().map(async (channel) => [channel.id, await this.storage.getApiKey(channel.id)] as const));
    return Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry[1])));
  }

  private async decryptCurrentVault(): Promise<Record<string, string>> {
    const vault = this.storage.getSyncVault();
    if (!vault) throw new Error('没有可更新的同步保险库');
    return decryptWithKey(vault, await this.requireLocalKey());
  }

  private async requireLocalKey(): Promise<Buffer> {
    const encoded = await this.storage.getSyncLocalKey();
    if (!encoded || this.locked) throw new Error('请先解锁 API Key 同步');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_LENGTH) throw new Error('请先解锁 API Key 同步');
    return key;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

// 刷新时间和刷新失败原因属于本机运行状态：跨设备传播会让其他设备显示不属于自己的错误，
// 而刷新时间每次刷新都会变化，会让整份状态反复重新编码并写入 Settings Sync。
// 逻辑时钟同样会随本机刷新增长，因此改用实际同步记录的最大版本，既保持载荷稳定，
// 也保证接收方后续写入的版本仍高于合并进来的全部记录。
function syncPayloadState(state: SharedStateV3): SharedStateV3 {
  const payload = { ...state, refresh: {} };
  const clock = [payload.channels, payload.models, payload.bindings, payload.chatSettings, payload.chatErrors]
    .flatMap((records) => Object.values(records))
    .reduce((max, record) => Math.max(max, record.revision), 0);
  return { ...payload, clock };
}

function manifestKey(manifest: SyncManifestV3): string {
  return `${manifest.generation}\0${manifest.updatedAt}\0${manifest.checksum}`;
}

function validatePassword(password: string): void {
  if (password.length === 0) throw new Error('同步主密码不能为空');
}

function validateVault(vault: EncryptedVault): Buffer {
  const salt = Buffer.from(vault?.kdf?.salt ?? '', 'base64');
  const iv = Buffer.from(vault?.cipher?.iv ?? '', 'base64');
  const tag = Buffer.from(vault?.cipher?.tag ?? '', 'base64');
  if (vault?.version !== VAULT_VERSION
    || vault.kdf?.name !== 'PBKDF2-SHA256'
    || vault.kdf.iterations !== PBKDF2_ITERATIONS
    || vault.cipher?.name !== 'AES-256-GCM'
    || salt.length !== 16
    || iv.length !== 12
    || tag.length !== 16
    || typeof vault.cipher.ciphertext !== 'string') {
    throw new Error('同步保险库格式错误');
  }
  return salt;
}

function validateManifest(manifest: SyncManifestV3): void {
  if (manifest.version !== MANIFEST_VERSION
    || !Number.isInteger(manifest.generation)
    || manifest.generation < 0
    || !Number.isInteger(manifest.chunkCount)
    || manifest.chunkCount < 0
    || manifest.encoding !== 'deflate-raw-base64'
    || typeof manifest.checksum !== 'string') {
    throw new Error('同步状态清单格式错误');
  }
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256', (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
