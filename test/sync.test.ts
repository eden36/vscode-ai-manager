import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { StorageService } from '../src/storage';
import { createEmptySharedState } from '../src/shared-state';
import { createEncryptedVault, decodeSharedState, decryptWithKey, encodeSharedState, encryptWithKey, SyncService, unlockEncryptedVault } from '../src/sync';
import { createModelProviderId } from '../src/models';
import { channel, model } from './fixtures';

function createContext(initialValues = new Map<string, unknown>()) {
  const values = initialValues;
  const secrets = new Map<string, string>();
  let syncKeys: readonly string[] = [];
  return {
    values,
    secrets,
    get syncKeys() { return syncKeys; },
    context: {
      globalState: {
        get: (key: string, fallback?: unknown) => values.has(key) ? values.get(key) : fallback,
        update: async (key: string, value: unknown) => {
          if (value === undefined) values.delete(key);
          else values.set(key, value);
        },
        setKeysForSync: (keys: readonly string[]) => { syncKeys = keys; },
      },
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
      },
    },
  };
}

describe('同步保险库', () => {
  it('使用随机 IV 加密并拒绝错误密码或篡改密文', async () => {
    const password = 'correct horse battery staple';
    const { vault, key } = await createEncryptedVault({ channel: 'top-secret' }, password);
    expect(JSON.stringify(vault)).not.toContain('top-secret');
    expect((await unlockEncryptedVault(vault, password)).credentials).toEqual({ channel: 'top-secret' });
    await expect(unlockEncryptedVault(vault, 'incorrect-password')).rejects.toThrow('同步主密码错误或保险库已损坏');

    const second = encryptWithKey({ channel: 'top-secret' }, key, Buffer.from(vault.kdf.salt, 'base64'));
    expect(second.cipher.iv).not.toBe(vault.cipher.iv);
    const tampered = { ...vault, cipher: { ...vault.cipher, ciphertext: `${vault.cipher.ciphertext.slice(0, -2)}AA` } };
    expect(() => decryptWithKey(tampered, key)).toThrow('同步主密码错误或保险库已损坏');
  });

  it('支持空保险库', async () => {
    const { vault, key } = await createEncryptedVault({}, 'empty vault password');
    expect(decryptWithKey(vault, key)).toEqual({});
  });

  it('同步主密码不限制长度但不能为空', async () => {
    const { vault } = await createEncryptedVault({ channel: 'top-secret' }, '1');
    expect((await unlockEncryptedVault(vault, '1')).credentials).toEqual({ channel: 'top-secret' });
    await expect(createEncryptedVault({}, '')).rejects.toThrow('同步主密码不能为空');
  });
});

describe('同步状态分块', () => {
  it('压缩完整状态并通过清单校验往返恢复', async () => {
    const state = createEmptySharedState();
    state.clock = 1;
    state.chatSettings['chat.defaultModel'] = {
      revision: 1,
      deviceId: 'device-a',
      value: { setting: 'chat.defaultModel', hadValue: true, value: 'ai-manager/model' },
    };

    const encoded = await encodeSharedState(state);

    expect(await decodeSharedState(encoded.manifest, encoded.chunks)).toEqual(state);
    const corrupted = `${encoded.chunks[0]?.startsWith('A') ? 'B' : 'A'}${encoded.chunks[0]?.slice(1) ?? ''}`;
    await expect(decodeSharedState(encoded.manifest, [corrupted]))
      .rejects.toThrow('同步状态校验失败');
  });

  it('识别重置代次且不要求状态分块', async () => {
    const state = await decodeSharedState({
      version: 3,
      generation: 5,
      updatedAt: 1,
      chunkCount: 0,
      encoding: 'deflate-raw-base64',
      checksum: '',
      reset: true,
    }, []);

    expect(state).toMatchObject({ version: 3, syncGeneration: 5, channels: {}, models: {} });
  });
});

describe('SyncService', () => {
  let source: ReturnType<typeof createContext>;
  let storage: StorageService;
  let storageDirectories: string[];

  async function createTestStorage(context: unknown): Promise<StorageService> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-manager-sync-'));
    storageDirectories.push(directory);
    const result = new StorageService(context as any, { directory, deviceId: `device-${storageDirectories.length}`, watch: false });
    await result.initialize();
    return result;
  }

  beforeEach(async () => {
    storageDirectories = [];
    source = createContext();
    storage = await createTestStorage(source.context);
    await storage.saveChannels([channel({ lastRefreshAt: 123, lastRefreshError: '本机错误' })]);
    await storage.saveModels([model({ customAlias: '同步别名', metadataOverridden: true, maxInputTokens: 64_000 })]);
    await storage.saveApiKey('channel-1', 'top-secret');
  });

  afterEach(async () => {
    storage.dispose();
    await Promise.all(storageDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('同步完整共享状态和密文，并在新电脑解锁后恢复', async () => {
    const sync = new SyncService(storage);
    await sync.enable('correct horse battery staple');

    const manifest = storage.getSyncManifest()!;
    expect(source.syncKeys.slice(0, 2)).toEqual(['aiManager.sync.manifest.v3', 'aiManager.sync.vault.v2']);
    expect(source.syncKeys.filter((key) => key.startsWith('aiManager.sync.chunk.v3.')))
      .toHaveLength(manifest.chunkCount);
    const remoteState = await decodeSharedState(
      manifest,
      Array.from({ length: manifest.chunkCount }, (_, index) => storage.getSyncChunk(index)!),
    );
    expect(remoteState.version).toBe(3);
    // 刷新时间和刷新错误只留在本机，避免其他设备显示不属于自己的错误并反复触发全量上传。
    expect(remoteState.refresh).toEqual({});
    expect(storage.getChannels()[0]).toMatchObject({ lastRefreshAt: 123, lastRefreshError: '本机错误' });
    expect(Object.values(remoteState.models)[0]?.value).toMatchObject({ customAlias: '同步别名', enabled: true, maxInputTokens: 64_000 });
    expect(JSON.stringify(storage.getSyncVault())).not.toContain('top-secret');

    const syncedValues = new Map([...source.values].filter(([key]) => key.startsWith('aiManager.sync.')));
    const target = createContext(syncedValues);
    const targetStorage = await createTestStorage(target.context);
    const targetSync = new SyncService(targetStorage);
    await targetSync.initialize();
    expect(targetSync.getStatus()).toEqual({
      enabled: true,
      locked: true,
      hasVault: true,
      localShared: true,
      cloudState: 'synced',
    });
    expect(targetStorage.getChannels()).toHaveLength(1);
    expect(await targetStorage.getApiKey('channel-1')).toBeUndefined();

    await targetSync.unlock('correct horse battery staple');
    expect(await targetStorage.getApiKey('channel-1')).toBe('top-secret');
    expect(targetSync.applyPreference(model({ providerId: 'new-provider', customAlias: undefined, enabled: false })))
      .toMatchObject({ providerId: createModelProviderId(channel(), 'model-1'), customAlias: '同步别名', enabled: true, maxInputTokens: 64_000 });
  });

  it('刷新状态变化不重新上传同步数据，远端清单未变化时不重复解码', async () => {
    const sync = new SyncService(storage);
    await sync.enable('correct horse battery staple');
    const published = storage.getSyncManifest()!;
    const readChunk = vi.spyOn(storage, 'getSyncChunk');

    await storage.updateChannels((channels) => channels.map((item) => ({ ...item, lastRefreshAt: 456, lastRefreshError: '新的本机错误' })));
    await sync.reconcile();

    expect(storage.getSyncManifest()).toEqual(published);
    expect(readChunk).not.toHaveBeenCalled();
    expect(storage.getChannels()[0]).toMatchObject({ lastRefreshAt: 456, lastRefreshError: '新的本机错误' });

    await storage.updateChannels((channels) => channels.map((item) => ({ ...item, name: '改名后的渠道' })));
    await sync.reconcile();

    expect(storage.getSyncManifest()!.updatedAt).not.toBe(published.updatedAt);
    readChunk.mockRestore();
  });

  it('将版本 1 渠道配置迁移为多协议默认值', async () => {
    const legacyChannel: any = channel({ preset: 'opencode-go' });
    delete legacyChannel.defaultProtocol;
    delete legacyChannel.authMode;
    delete legacyChannel.anthropicPath;
    delete legacyChannel.geminiPath;
    const target = createContext(new Map([['aiManager.sync.profile.v1', {
      version: 1,
      updatedAt: 1,
      channels: [legacyChannel],
      models: [{
        channelId: 'channel-1',
        id: 'model-1',
        enabled: true,
        customAlias: '旧版同步别名',
      }],
    }]]));
    const targetStorage = await createTestStorage(target.context);
    const targetSync = new SyncService(targetStorage);
    await targetSync.initialize();
    expect(targetStorage.getChannels()[0]).toMatchObject({
      defaultProtocol: 'openai',
      authMode: 'bearer',
      anthropicPath: '/zen/go/v1/messages',
    });
    expect(targetSync.applyPreference(model({ enabled: false, customAlias: undefined })))
      .toMatchObject({ enabled: true, customAlias: '旧版同步别名' });
  });

  it('应用同步配置时使用新渠道地址更新模型标识', async () => {
    const oldChannel = channel({ baseUrl: 'https://old.example.com' });
    const newChannel = channel({ baseUrl: 'https://new.example.com' });
    const target = createContext(new Map([
      ['aiManager.channels', [oldChannel]],
      ['aiManager.models', [model({ providerId: createModelProviderId(oldChannel, 'model-1') })]],
      ['aiManager.sync.profile.v1', { version: 2, updatedAt: 1, channels: [newChannel], models: [] }],
    ]));
    const targetStorage = await createTestStorage(target.context);
    await new SyncService(targetStorage).initialize();
    expect(targetStorage.getModels()[0]?.providerId).toBe(createModelProviderId(newChannel, 'model-1'));
  });

  it('远端分块损坏时保留本机有效状态并报告错误', async () => {
    source.values.set('aiManager.sync.manifest.v3', {
      version: 3,
      generation: 0,
      updatedAt: 1,
      chunkCount: 1,
      encoding: 'deflate-raw-base64',
      checksum: 'invalid',
    });
    source.values.set('aiManager.sync.chunk.v3.0', 'broken');
    const sync = new SyncService(storage);

    await expect(sync.initialize()).resolves.toBeUndefined();

    expect(storage.getChannels()).toHaveLength(1);
    expect(sync.getStatus()).toMatchObject({ cloudState: 'error', error: '同步状态校验失败' });
  });

  it('重置清单只回放一次，不清除之后重新保存的凭据', async () => {
    const sync = new SyncService(storage);
    await sync.enable('correct horse battery staple');
    await sync.reset();

    await storage.saveApiKey('channel-1', 'new-secret');
    await sync.reconcile();
    await sync.reconcile();

    expect(await storage.getApiKey('channel-1')).toBe('new-secret');
  });

  it('同机每个 Profile 各自清理一次私有凭据', async () => {
    const sync = new SyncService(storage);
    await sync.enable('correct horse battery staple');
    await sync.reset();

    // 同一台设备的另一个 Profile：共享状态目录相同，globalState 与 SecretStorage 独立。
    const other = createContext(new Map([...source.values].filter(([key]) => key.startsWith('aiManager.sync.'))));
    const otherStorage = new StorageService(other.context as any, { directory: storage.directory, deviceId: 'profile-b', watch: false });
    await otherStorage.initialize();
    await otherStorage.saveApiKey('channel-1', 'profile-b-secret');
    const otherSync = new SyncService(otherStorage);

    await otherSync.initialize();
    expect(await otherStorage.getApiKey('channel-1')).toBeUndefined();

    await otherStorage.saveApiKey('channel-1', 'profile-b-new');
    await otherSync.reconcile();

    expect(await otherStorage.getApiKey('channel-1')).toBe('profile-b-new');
    otherStorage.dispose();
  });

  it('修改主密码后旧密钥失效，重置时清除同步数据和本机凭据', async () => {
    const sync = new SyncService(storage);
    await sync.enable('correct horse battery staple');
    const oldVault = storage.getSyncVault()!;
    const oldKey = Buffer.from((await storage.getSyncLocalKey())!, 'base64');

    await sync.changePassword('another secure password');
    expect(() => decryptWithKey(storage.getSyncVault()!, oldKey)).toThrow('同步主密码错误或保险库已损坏');
    expect(storage.getSyncVault()!.updatedAt).toBeGreaterThan(oldVault.updatedAt);

    await sync.reset();
    expect(sync.getStatus()).toEqual({
      enabled: false,
      locked: false,
      hasVault: false,
      localShared: true,
      cloudState: 'waiting',
    });
    expect(storage.getSyncProfile()).toBeUndefined();
    expect(await storage.getSyncLocalKey()).toBeUndefined();
    expect(await storage.getApiKey('channel-1')).toBeUndefined();
  });
});
