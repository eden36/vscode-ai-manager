import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { deflateRaw, inflateRaw } from 'node:zlib';
import type { SharedStateV3 } from './shared-state';
import { createEmptySharedState, parseSharedState, serializeSharedState } from './shared-state';
import type { CatalogModel, SyncStatus } from './types';
import type { StorageService } from './storage';
import { createModelProviderId, getProtocolPath } from './models';

const VAULT_VERSION = 1;
const MANIFEST_VERSION = 3;
const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const CHUNK_SIZE = 48 * 1024;
const AAD = Buffer.from('ai-manager:v1', 'utf8');
const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);

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
    throw new Error('同步保险库已损坏');
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
      try {
        await this.applyRemoteState();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : '同步状态读取失败';
      }
      await this.reconcileVault();
      await this.ensureAutomaticSync();
      if (this.getStatus().enabled && !this.lastError) await this.publishState();
    });
  }

  getStatus(): SyncStatus {
    const vault = this.storage.getSyncVault() ?? this.storage.getSyncedVault();
    const hasVault = Boolean(vault);
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
        await this.ensureAutomaticSync();
        if (this.getStatus().enabled) await this.publishState();
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : '同步失败';
      }
    });
  }

  async reset(): Promise<void> {
    await this.enqueue(async () => {
      for (const channel of this.storage.getChannels()) await this.storage.deleteApiKey(channel.id);
      await this.clearSyncKeys();
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
    if (this.getStatus().locked) throw new Error('同步密钥尚未就绪');
  }

  async saveProfileFromLocal(): Promise<void> {
    await this.enqueue(async () => {
      if (this.getStatus().enabled) await this.publishState();
    });
  }

  applyPreference(model: CatalogModel, channels = this.storage.getChannels()): CatalogModel {
    const channel = channels.find((item) => item.id === model.channelId);
    const preference = this.storage.getModels().find((item) => item.channelId === model.channelId && item.id === model.id);
    const protocol = preference?.metadataOverridden ? preference.protocol : model.protocol;
    const providerId = channel ? createModelProviderId(channel, model.id, protocol) : model.providerId;
    if (!preference) return { ...model, providerId };
    const enabled = Boolean(channel && getProtocolPath(channel, protocol) && preference.enabled);
    return {
      ...model,
      providerId,
      customAlias: preference.customAlias,
      enabled,
      toolCalling: enabled,
      ...(preference.metadataOverridden ? {
        protocol,
        maxInputTokens: preference.maxInputTokens,
        maxOutputTokens: preference.maxOutputTokens,
        metadataOverridden: true,
      } : {}),
    };
  }

  private async applyRemoteState(): Promise<boolean> {
    const manifest = this.storage.getSyncManifest();
    if (!manifest || manifest.version !== MANIFEST_VERSION) return false;
    this.storage.registerSyncKeys(manifest.chunkCount);
    if (manifest.generation < this.storage.getSyncGeneration()) return false;
    const key = manifestKey(manifest);
    if (key === this.lastAppliedManifest) return true;
    const chunks = Array.from({ length: manifest.chunkCount }, (_, index) => this.storage.getSyncChunk(index));
    if (chunks.some((chunk) => chunk === undefined)) throw new Error('同步状态分块尚未完整到达');
    const remote = await decodeSharedState(manifest, chunks as string[]);
    if (manifest.reset) {
      if (manifest.generation <= this.storage.getAppliedResetGeneration()) {
        this.lastAppliedManifest = key;
        return true;
      }
      await this.storage.mergeRemoteState(remote);
      await this.storage.saveSyncVault(undefined);
      await this.clearSyncKeys();
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
    this.lastAppliedManifest = manifestKey(manifest);
  }

  private async reconcileVault(): Promise<void> {
    const local = this.storage.getSyncVault();
    const remote = this.storage.getSyncedVault();
    try {
      if (remote && (!local || remote.updatedAt > local.updatedAt)) await this.storage.saveSyncVault(remote);
      else if (local && (!remote || local.updatedAt > remote.updatedAt)) await this.storage.saveSyncedVault(local);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : '同步保险库写入失败';
    }
    await this.importVaultWithLocalKey();
  }

  private async ensureAutomaticSync(): Promise<void> {
    if (this.storage.getSyncVault() ?? this.storage.getSyncedVault()) return;
    const credentials = await this.readLocalCredentials();
    const key = randomBytes(KEY_LENGTH);
    const salt = randomBytes(16);
    const created = encryptWithKey(credentials, key, salt);
    const current = this.storage.getSyncedVault();
    const vault: EncryptedVault = { ...created, updatedAt: Math.max(created.updatedAt, (current?.updatedAt ?? 0) + 1) };
    await this.storage.saveSyncVault(vault);
    await this.storage.saveSyncedVault(vault);
    await this.persistSyncKey(key);
    this.lastImportedVaultAt = vault.updatedAt;
    this.locked = false;
  }

  private async importVaultWithLocalKey(): Promise<void> {
    const vault = this.storage.getSyncVault();
    if (!vault) {
      if (await this.storage.getSyncLocalKey()) {
        for (const channel of this.storage.getChannels()) await this.storage.deleteApiKey(channel.id);
        await this.clearSyncKeys();
      }
      this.lastImportedVaultAt = 0;
      this.locked = false;
      return;
    }
    const key = await this.resolveSyncKey();
    if (!key) {
      this.locked = true;
      return;
    }
    try {
      const credentials = decryptWithKey(vault, key);
      await this.importCredentials(credentials);
      this.lastImportedVaultAt = vault.updatedAt;
      this.locked = false;
    } catch {
      await this.clearSyncKeys();
      this.locked = true;
    }
  }

  private async resolveSyncKey(): Promise<Buffer | undefined> {
    const encoded = await this.storage.getSyncLocalKey()
      ?? this.storage.getSyncedEncryptionKey()
      ?? await this.storage.readSharedVaultKey();
    if (!encoded) return undefined;
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== KEY_LENGTH) return undefined;
    await this.persistSyncKey(key);
    return key;
  }

  private async persistSyncKey(key: Buffer): Promise<void> {
    const encoded = key.toString('base64');
    await this.storage.saveSyncLocalKey(encoded);
    await this.storage.saveSyncedEncryptionKey(encoded);
    await this.storage.writeSharedVaultKey(encoded);
  }

  private async clearSyncKeys(): Promise<void> {
    await this.storage.deleteSyncLocalKey();
    await this.storage.saveSyncedEncryptionKey(undefined);
    await this.storage.deleteSharedVaultKey();
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

  private async requireLocalKey(): Promise<Buffer> {
    const key = await this.resolveSyncKey();
    if (!key || this.locked) throw new Error('同步密钥尚未就绪');
    return key;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

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
