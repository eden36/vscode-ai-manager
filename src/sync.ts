import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { deflateRaw, inflateRaw } from 'node:zlib';
import type { SharedStateV3 } from './shared-state';
import { createEmptySharedState, parseSharedState, serializeSharedState } from './shared-state';
import type { CatalogModel, SyncStatus } from './types';
import type { StorageService } from './storage';
import { createModelProviderId, getProtocolPath } from './models';

const VAULT_VERSION = 2;
const MANIFEST_VERSION = 4;
const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const CHUNK_SIZE = 48 * 1024;
const MAX_SYNC_CHUNKS = 256;
const AAD = Buffer.from('ai-manager:v2', 'utf8');
const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);

export interface VersionedCredential {
  revision: number;
  deviceId: string;
  value?: string;
  deleted?: true;
}

export interface VaultPayloadV2 {
  version: 2;
  clock: number;
  credentials: Record<string, VersionedCredential>;
}

export interface EncryptedVaultV2 {
  version: 2;
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

export interface SyncedVaultBundleV2 {
  version: 2;
  generation: number;
  key: string;
  vault: EncryptedVaultV2;
}

export interface SyncManifestV4 {
  version: 4;
  generation: number;
  updatedAt: number;
  snapshotId: string;
  chunkCount: number;
  encoding: 'deflate-raw-base64';
  checksum: string;
  reset?: true;
}

export interface SyncReconcileResult {
  stateChanged: boolean;
  vaultChanged: boolean;
}

export function startSyncPolling(
  run: () => Promise<SyncReconcileResult>,
  onResult: (result: SyncReconcileResult) => void,
  onError: (error: unknown) => void,
  intervalMs = 30_000,
): { dispose(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void run().then(onResult, onError).finally(() => { running = false; });
  }, intervalMs);
  return { dispose: () => clearInterval(timer) };
}

export function encryptWithKey(
  payload: VaultPayloadV2,
  key: Buffer,
  salt: Buffer,
  updatedAt = Date.now(),
): EncryptedVaultV2 {
  if (key.length !== KEY_LENGTH || salt.length !== 16) throw new Error('同步密钥格式错误');
  validateVaultPayload(payload);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    version: VAULT_VERSION,
    updatedAt,
    kdf: { name: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: salt.toString('base64') },
    cipher: { name: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') },
  };
}

export function decryptWithKey(vault: EncryptedVaultV2, key: Buffer): VaultPayloadV2 {
  validateVault(vault);
  if (key.length !== KEY_LENGTH) throw new Error('同步密钥格式错误');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(vault.cipher.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(vault.cipher.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(vault.cipher.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    const payload = JSON.parse(plaintext) as VaultPayloadV2;
    validateVaultPayload(payload);
    return payload;
  } catch {
    throw new Error('同步保险库已损坏');
  }
}

export function mergeVaultPayloads(left: VaultPayloadV2, right: VaultPayloadV2): VaultPayloadV2 {
  const credentials = { ...left.credentials };
  for (const [channelId, candidate] of Object.entries(right.credentials)) {
    const current = credentials[channelId];
    if (!current || compareCredential(candidate, current) > 0) credentials[channelId] = candidate;
  }
  return { version: 2, clock: Math.max(left.clock, right.clock), credentials };
}

export async function encodeSharedState(
  state: SharedStateV3,
  snapshotId: string = randomUUID(),
): Promise<{ manifest: SyncManifestV4; chunks: string[] }> {
  const compressed = await deflate(Buffer.from(serializeSharedState(state), 'utf8'));
  const payload = compressed.toString('base64');
  const chunks = Array.from({ length: Math.ceil(payload.length / CHUNK_SIZE) }, (_, index) => payload.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
  return {
    manifest: {
      version: MANIFEST_VERSION,
      generation: state.syncGeneration,
      updatedAt: Date.now(),
      snapshotId,
      chunkCount: chunks.length,
      encoding: 'deflate-raw-base64',
      checksum: createHash('sha256').update(compressed).digest('hex'),
    },
    chunks,
  };
}

export async function decodeSharedState(manifest: SyncManifestV4, chunks: readonly string[]): Promise<SharedStateV3> {
  validateManifest(manifest);
  if (manifest.reset) return { ...createEmptySharedState(), syncGeneration: manifest.generation };
  if (chunks.length !== manifest.chunkCount || chunks.some((chunk) => typeof chunk !== 'string')) throw new Error('同步状态分块不完整');
  const compressed = Buffer.from(chunks.join(''), 'base64');
  if (createHash('sha256').update(compressed).digest('hex') !== manifest.checksum) throw new Error('同步状态校验失败');
  return parseSharedState(JSON.parse((await inflate(compressed)).toString('utf8')));
}

export class SyncService {
  private operationQueue: Promise<void> = Promise.resolve();
  private lastPublishedState = '';
  private lastAppliedManifest = '';
  private locked = false;
  private lastError: string | undefined;
  private consecutiveFailures = 0;

  constructor(private readonly storage: StorageService) {
    storage.registerSyncKeys();
  }

  async initialize(): Promise<void> {
    await this.enqueue(() => this.synchronize(false));
  }

  getStatus(): SyncStatus {
    const hasVault = Boolean(this.storage.getSyncVault() ?? this.storage.getSyncedVaultBundle());
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

  async reconcile(): Promise<SyncReconcileResult> {
    return this.enqueue(() => this.synchronize(false));
  }

  async reset(): Promise<void> {
    await this.enqueue(async () => {
      for (const channel of this.storage.getChannels()) await this.storage.deleteApiKey(channel.id);
      const generation = await this.storage.incrementSyncGeneration();
      const manifest: SyncManifestV4 = {
        version: MANIFEST_VERSION,
        generation,
        updatedAt: Date.now(),
        snapshotId: randomUUID(),
        chunkCount: 0,
        encoding: 'deflate-raw-base64',
        checksum: '',
        reset: true,
      };
      await this.storage.saveSyncSnapshot(manifest, []);
      await this.storage.saveSyncedVaultBundle(undefined);
      await this.storage.saveLocalVaultBundle(undefined);
      await this.storage.saveAppliedResetGeneration(generation);
      await this.finishV4Initialization();
      this.lastPublishedState = '';
      this.lastAppliedManifest = manifestKey(manifest);
      this.locked = false;
      this.lastError = undefined;
      this.consecutiveFailures = 0;
    });
  }

  async saveCredential(channelId: string, apiKey: string | undefined): Promise<void> {
    await this.enqueue(async () => {
      await this.applyRemoteState();
      await this.reconcileVault();
      const normalized = apiKey?.trim() || undefined;
      const previous = await this.storage.getApiKey(channelId);
      try {
        const bundle = await this.storage.updateSyncVaultBundle(async (current) => {
          const base = current ?? this.createBundle(createEmptyVaultPayload(), this.storage.getSyncGeneration());
          const payload = decryptBundle(base);
          payload.clock += 1;
          payload.credentials[channelId] = {
            revision: payload.clock,
            deviceId: this.storage.deviceId,
            ...(normalized ? { value: normalized } : { deleted: true }),
          };
          return this.encryptBundle(payload, base.key, base.generation, Buffer.from(base.vault.kdf.salt, 'base64'));
        });
        if (normalized) await this.storage.saveApiKey(channelId, normalized);
        else await this.storage.deleteApiKey(channelId);
        await this.storage.saveSyncedVaultBundle(bundle);
        this.locked = false;
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
    await this.enqueue(() => this.synchronize(true));
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

  private async synchronize(throwOnError: boolean): Promise<SyncReconcileResult> {
    try {
      const stateChanged = await this.applyRemoteState();
      const vaultChanged = await this.reconcileVault();
      await this.publishState();
      await this.finishV4Initialization();
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      return { stateChanged, vaultChanged };
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= 3) this.lastError = error instanceof Error ? error.message : '同步失败';
      if (throwOnError) throw error;
      return { stateChanged: false, vaultChanged: false };
    }
  }

  private async applyRemoteState(): Promise<boolean> {
    const manifest = this.storage.getSyncManifest();
    if (!manifest) return false;
    validateManifest(manifest);
    this.storage.registerSyncKeys(manifest);
    if (manifest.generation < this.storage.getSyncGeneration()) return false;
    const key = manifestKey(manifest);
    if (key === this.lastAppliedManifest) return false;
    const chunks = Array.from({ length: manifest.chunkCount }, (_, index) => this.storage.getSyncChunk(manifest.snapshotId, index));
    if (chunks.some((chunk) => chunk === undefined)) throw new Error('同步状态分块尚未完整到达');
    const remote = await decodeSharedState(manifest, chunks as string[]);
    if (manifest.reset) {
      if (manifest.generation <= this.storage.getAppliedResetGeneration()) {
        this.lastAppliedManifest = key;
        return false;
      }
      const changed = await this.storage.mergeRemoteState(remote);
      await this.storage.saveSyncedVaultBundle(undefined);
      await this.storage.saveLocalVaultBundle(undefined);
      for (const channel of this.storage.getChannels()) await this.storage.deleteApiKey(channel.id);
      await this.storage.saveAppliedResetGeneration(manifest.generation);
      this.lastAppliedManifest = key;
      this.locked = false;
      return changed;
    }
    const changed = await this.storage.mergeRemoteState(remote);
    this.lastAppliedManifest = key;
    this.lastPublishedState = serializeSharedState(remote);
    return changed;
  }

  private async publishState(): Promise<void> {
    const state = syncPayloadState(this.storage.getSharedState());
    const serialized = serializeSharedState(state);
    const current = this.storage.getSyncManifest();
    if (current?.reset
      && current.generation === state.syncGeneration
      && !this.storage.getSyncVault()
      && !this.storage.getSyncedVaultBundle()) return;
    if (serialized === this.lastPublishedState
      && current?.generation === state.syncGeneration
      && !current.reset) return;
    const { manifest, chunks } = await encodeSharedState(state);
    await this.storage.saveSyncSnapshot(manifest, chunks);
    this.lastPublishedState = serialized;
    this.lastAppliedManifest = manifestKey(manifest);
  }

  private async reconcileVault(): Promise<boolean> {
    const remote = this.storage.getSyncedVaultBundle();
    const generation = this.storage.getSyncGeneration();
    if (remote) validateBundle(remote);
    if (remote && remote.generation > generation) throw new Error('同步保险库代次超前，等待状态分块到达');
    const applicableRemote = remote?.generation === generation ? remote : undefined;
    const localCredentials = await this.readLocalCredentials();
    const manifest = this.storage.getSyncManifest();
    if (!applicableRemote
      && !this.storage.getSyncVault()
      && Object.keys(localCredentials).length === 0
      && manifest?.reset
      && manifest.generation === generation) return false;
    let changed = false;
    const bundle = await this.storage.updateSyncVaultBundle(async (local) => {
      if (local) validateBundle(local);
      const localPayload = local?.generation === generation ? decryptBundle(local) : createEmptyVaultPayload();
      const remotePayload = applicableRemote ? decryptBundle(applicableRemote) : createEmptyVaultPayload();
      const merged = mergeVaultPayloads(localPayload, remotePayload);
      for (const [channelId, apiKey] of Object.entries(localCredentials)) {
        if (merged.credentials[channelId]) continue;
        merged.clock += 1;
        merged.credentials[channelId] = { revision: merged.clock, deviceId: this.storage.deviceId, value: apiKey };
      }
      if (serializeVaultPayload(localPayload) !== serializeVaultPayload(merged)) changed = true;
      const preferred = applicableRemote ?? (local?.generation === generation ? local : undefined);
      if (preferred && serializeVaultPayload(decryptBundle(preferred)) === serializeVaultPayload(merged)) return preferred;
      changed = true;
      const key = preferred?.key ?? randomBytes(KEY_LENGTH).toString('base64');
      const salt = preferred ? Buffer.from(preferred.vault.kdf.salt, 'base64') : randomBytes(16);
      return this.encryptBundle(merged, key, generation, salt);
    });
    if (!applicableRemote || serializeBundle(applicableRemote) !== serializeBundle(bundle)) {
      await this.storage.saveSyncedVaultBundle(bundle);
      changed = true;
    }
    await this.importCredentials(decryptBundle(bundle));
    this.locked = false;
    return changed;
  }

  private createBundle(payload: VaultPayloadV2, generation: number): SyncedVaultBundleV2 {
    const key = randomBytes(KEY_LENGTH).toString('base64');
    return this.encryptBundle(payload, key, generation, randomBytes(16));
  }

  private encryptBundle(payload: VaultPayloadV2, encodedKey: string, generation: number, salt: Buffer): SyncedVaultBundleV2 {
    const key = decodeBundleKey(encodedKey);
    return { version: 2, generation, key: encodedKey, vault: encryptWithKey(payload, key, salt) };
  }

  private async importCredentials(payload: VaultPayloadV2): Promise<void> {
    for (const channel of this.storage.getChannels()) {
      const record = payload.credentials[channel.id];
      if (!record) continue;
      if (!record.deleted && record.value) await this.storage.saveApiKey(channel.id, record.value);
      else await this.storage.deleteApiKey(channel.id);
    }
  }

  private async readLocalCredentials(): Promise<Record<string, string>> {
    const entries = await Promise.all(this.storage.getChannels().map(async (channel) => [channel.id, await this.storage.getApiKey(channel.id)] as const));
    return Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry[1])));
  }

  private async finishV4Initialization(): Promise<void> {
    if (this.storage.getSyncV4Initialized()) return;
    await this.storage.clearLegacySyncData();
    await this.storage.saveSyncV4Initialized(true);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function createEmptyVaultPayload(): VaultPayloadV2 {
  return { version: 2, clock: 0, credentials: {} };
}

function decryptBundle(bundle: SyncedVaultBundleV2): VaultPayloadV2 {
  validateBundle(bundle);
  return decryptWithKey(bundle.vault, decodeBundleKey(bundle.key));
}

function decodeBundleKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_LENGTH) throw new Error('同步密钥格式错误');
  return key;
}

function compareCredential(left: VersionedCredential, right: VersionedCredential): number {
  if (left.revision !== right.revision) return left.revision - right.revision;
  return left.deviceId.localeCompare(right.deviceId);
}

function serializeVaultPayload(payload: VaultPayloadV2): string {
  return JSON.stringify({
    ...payload,
    credentials: Object.fromEntries(Object.entries(payload.credentials).sort(([left], [right]) => left.localeCompare(right))),
  });
}

function serializeBundle(bundle: SyncedVaultBundleV2): string {
  return JSON.stringify(bundle);
}

function syncPayloadState(state: SharedStateV3): SharedStateV3 {
  const payload = { ...state, refresh: {} };
  const clock = [payload.channels, payload.models, payload.bindings, payload.chatSettings, payload.chatErrors]
    .flatMap((records) => Object.values(records))
    .reduce((max, record) => Math.max(max, record.revision), 0);
  return { ...payload, clock };
}

function manifestKey(manifest: SyncManifestV4): string {
  return `${manifest.generation}\0${manifest.snapshotId}\0${manifest.checksum}`;
}

function validateVault(vault: EncryptedVaultV2): void {
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
    || typeof vault.updatedAt !== 'number'
    || typeof vault.cipher.ciphertext !== 'string') {
    throw new Error('同步保险库格式错误');
  }
}

function validateVaultPayload(payload: VaultPayloadV2): void {
  if (!payload || payload.version !== 2 || !Number.isInteger(payload.clock) || payload.clock < 0
    || !payload.credentials || typeof payload.credentials !== 'object' || Array.isArray(payload.credentials)) {
    throw new Error('同步保险库格式错误');
  }
  for (const [channelId, record] of Object.entries(payload.credentials)) {
    if (!channelId || !record || !Number.isInteger(record.revision) || record.revision < 0
      || typeof record.deviceId !== 'string'
      || (record.deleted !== true && typeof record.value !== 'string')) {
      throw new Error('同步保险库格式错误');
    }
  }
}

function validateBundle(bundle: SyncedVaultBundleV2): void {
  if (bundle?.version !== 2 || !Number.isInteger(bundle.generation) || bundle.generation < 0 || typeof bundle.key !== 'string') {
    throw new Error('同步保险库格式错误');
  }
  decodeBundleKey(bundle.key);
  validateVault(bundle.vault);
}

function validateManifest(manifest: SyncManifestV4): void {
  if (manifest.version !== MANIFEST_VERSION
    || !Number.isInteger(manifest.generation)
    || manifest.generation < 0
    || !/^[a-zA-Z0-9-]{1,80}$/.test(manifest.snapshotId)
    || !Number.isInteger(manifest.chunkCount)
    || manifest.chunkCount < 0
    || manifest.chunkCount > MAX_SYNC_CHUNKS
    || manifest.encoding !== 'deflate-raw-base64'
    || typeof manifest.checksum !== 'string') {
    throw new Error('同步状态清单格式错误');
  }
}
