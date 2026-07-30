import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from 'node:crypto';
import type { CatalogModel, ChannelConfig, SyncStatus } from './types';
import type { StorageService } from './storage';
import { createModelProviderId, getProtocolPath } from './models';

const VAULT_VERSION = 1;
const PROFILE_VERSION = 2;
const PBKDF2_ITERATIONS = 600_000;
const KEY_LENGTH = 32;
const AAD = Buffer.from('ai-manager:v1', 'utf8');

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

export class SyncService {
  private operationQueue: Promise<void> = Promise.resolve();
  private lastAppliedProfileAt = 0;
  private lastImportedVaultAt = 0;
  private locked = false;

  constructor(private readonly storage: StorageService) {
    storage.registerSyncKeys();
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      await this.applySyncedProfile();
      await this.importVaultWithLocalKey();
    });
  }

  getStatus(): SyncStatus {
    const hasVault = Boolean(this.storage.getSyncVault());
    return { enabled: hasVault, locked: hasVault && this.locked, hasVault };
  }

  async reconcile(): Promise<void> {
    await this.enqueue(async () => {
      await this.applySyncedProfile();
      const vault = this.storage.getSyncVault();
      if (vault && vault.updatedAt !== this.lastImportedVaultAt) await this.importVaultWithLocalKey();
    });
  }

  async enable(password: string): Promise<void> {
    await this.enqueue(async () => {
      if (this.getStatus().enabled) throw new Error('API Key 同步已经启用');
      const credentials = await this.readLocalCredentials();
      const { vault: created, key } = await createEncryptedVault(credentials, password);
      const current = this.storage.getSyncVault();
      const vault = { ...created, updatedAt: Math.max(created.updatedAt, (current?.updatedAt ?? 0) + 1) };
      await this.storage.saveSyncVault(vault);
      await this.saveProfileFromLocalInternal();
      await this.storage.saveSyncLocalKey(key.toString('base64'));
      this.lastImportedVaultAt = vault.updatedAt;
      this.locked = false;
    });
  }

  async unlock(password: string): Promise<void> {
    await this.enqueue(async () => {
      const vault = this.storage.getSyncVault();
      if (!vault) throw new Error('没有可解锁的同步保险库');
      const { credentials, key } = await unlockEncryptedVault(vault, password);
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
      await this.storage.saveSyncLocalKey(key.toString('base64'));
      this.lastImportedVaultAt = vault.updatedAt;
      this.locked = false;
    });
  }

  async reset(): Promise<void> {
    await this.enqueue(async () => {
      for (const channel of this.storage.getChannels()) await this.storage.deleteApiKey(channel.id);
      await this.storage.deleteSyncLocalKey();
      await this.storage.saveSyncVault(undefined);
      await this.storage.saveSyncProfile(undefined);
      this.lastAppliedProfileAt = 0;
      this.lastImportedVaultAt = 0;
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
    await this.enqueue(() => this.saveProfileFromLocalInternal());
  }

  applyPreference(model: CatalogModel): CatalogModel {
    const channel = this.storage.getChannels().find((item) => item.id === model.channelId);
    const preference = this.storage.getSyncProfile()?.models.find((item) => item.channelId === model.channelId && item.id === model.id);
    const protocol = preference?.metadataOverridden ? preference.protocol ?? model.protocol : model.protocol;
    const providerId = channel ? createModelProviderId(channel, model.id, protocol) : model.providerId;
    if (!preference) return { ...model, providerId };
    return {
      ...model,
      providerId,
      customAlias: preference.customAlias,
      enabled: Boolean(channel && getProtocolPath(channel, protocol) && preference.enabled),
      ...(preference.metadataOverridden ? {
        protocol,
        maxInputTokens: preference.maxInputTokens ?? model.maxInputTokens,
        maxOutputTokens: preference.maxOutputTokens ?? model.maxOutputTokens,
        toolCalling: preference.toolCalling ?? model.toolCalling,
        metadataOverridden: true,
      } : {}),
    };
  }

  private async saveProfileFromLocalInternal(): Promise<void> {
    if (!this.storage.getSyncVault()) return;
    const channelIds = new Set(this.storage.getChannels().map((channel) => channel.id));
    const previous = this.storage.getSyncProfile()?.models.filter((model) => channelIds.has(model.channelId)) ?? [];
    const preferences = new Map(previous.map((model) => [`${model.channelId}\0${model.id}`, model]));
    for (const model of this.storage.getModels()) preferences.set(`${model.channelId}\0${model.id}`, modelPreference(model));
    const profile: SyncProfile = {
      version: PROFILE_VERSION,
      updatedAt: Math.max(Date.now(), (this.storage.getSyncProfile()?.updatedAt ?? 0) + 1),
      channels: this.storage.getChannels().map(toSyncedChannel),
      models: [...preferences.values()],
    };
    await this.storage.saveSyncProfile(profile);
    this.lastAppliedProfileAt = profile.updatedAt;
  }

  private async applySyncedProfile(): Promise<void> {
    const profile = this.storage.getSyncProfile();
    if (!profile || (profile.version !== 1 && profile.version !== PROFILE_VERSION) || profile.updatedAt === this.lastAppliedProfileAt) return;
    const localChannels = new Map(this.storage.getChannels().map((channel) => [channel.id, channel]));
    const channels = profile.channels.map((channel) => {
      const local = localChannels.get(channel.id);
      return { ...channel, ...(local?.lastRefreshAt === undefined ? {} : { lastRefreshAt: local.lastRefreshAt }), ...(local?.lastRefreshError === undefined ? {} : { lastRefreshError: local.lastRefreshError }) };
    });
    const channelIds = new Set(channels.map((channel) => channel.id));
    const models = this.storage.getModels().filter((model) => channelIds.has(model.channelId)).map((model) => this.applyPreference(model));
    await this.storage.saveChannels(channels);
    await this.storage.saveModels(models);
    this.lastAppliedProfileAt = profile.updatedAt;
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

function modelPreference(model: CatalogModel): SyncedModelPreference {
  return {
    channelId: model.channelId,
    id: model.id,
    enabled: model.enabled,
    customAlias: model.customAlias,
    metadataOverridden: model.metadataOverridden,
    ...(model.metadataOverridden ? {
      protocol: model.protocol,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      toolCalling: model.toolCalling,
    } : {}),
  };
}

function toSyncedChannel(channel: ChannelConfig): SyncedChannelConfig {
  return {
    id: channel.id,
    name: channel.name,
    preset: channel.preset,
    baseUrl: channel.baseUrl,
    modelsPath: channel.modelsPath,
    chatPath: channel.chatPath,
    anthropicPath: channel.anthropicPath,
    geminiPath: channel.geminiPath,
    defaultProtocol: channel.defaultProtocol,
    authMode: channel.authMode,
    enabled: channel.enabled,
    timeoutMs: channel.timeoutMs,
    refreshIntervalMinutes: channel.refreshIntervalMinutes,
    defaultMaxInputTokens: channel.defaultMaxInputTokens,
    defaultMaxOutputTokens: channel.defaultMaxOutputTokens,
  };
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
    || tag.length !== 16) throw new Error('同步保险库格式不受支持');
  return salt;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256', (error, key) => error ? reject(error) : resolve(key)));
}
