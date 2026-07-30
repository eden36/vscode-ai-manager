import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { StorageService } from '../src/storage';
import { createEncryptedVault, decryptWithKey, encryptWithKey, SyncService, unlockEncryptedVault } from '../src/sync';
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

describe('SyncService', () => {
  let source: ReturnType<typeof createContext>;
  let storage: StorageService;

  beforeEach(async () => {
    source = createContext();
    storage = new StorageService(source.context as any);
    await storage.saveChannels([channel({ lastRefreshAt: 123, lastRefreshError: '本机错误' })]);
    await storage.saveModels([model({ customAlias: '同步别名', metadataOverridden: true, maxInputTokens: 64_000 })]);
    await storage.saveApiKey('channel-1', 'top-secret');
  });

  it('仅同步可移植配置和密文，并在新电脑解锁后恢复', async () => {
    const sync = new SyncService(storage);
    await sync.enable('correct horse battery staple');

    expect(source.syncKeys).toEqual(['aiManager.sync.profile.v1', 'aiManager.sync.vault.v1']);
    const profile = storage.getSyncProfile()!;
    expect(profile.version).toBe(2);
    expect(profile.channels[0]).not.toHaveProperty('lastRefreshAt');
    expect(profile.channels[0]).not.toHaveProperty('lastRefreshError');
    expect(profile.models[0]).toMatchObject({ customAlias: '同步别名', enabled: true, maxInputTokens: 64_000 });
    expect(profile.models[0]).not.toHaveProperty('providerId');
    expect(JSON.stringify(storage.getSyncVault())).not.toContain('top-secret');

    const syncedValues = new Map([...source.values].filter(([key]) => key.startsWith('aiManager.sync.')));
    const target = createContext(syncedValues);
    const targetStorage = new StorageService(target.context as any);
    const targetSync = new SyncService(targetStorage);
    await targetSync.initialize();
    expect(targetSync.getStatus()).toEqual({ enabled: true, locked: true, hasVault: true });
    expect(targetStorage.getChannels()).toHaveLength(1);
    expect(await targetStorage.getApiKey('channel-1')).toBeUndefined();

    await targetSync.unlock('correct horse battery staple');
    expect(await targetStorage.getApiKey('channel-1')).toBe('top-secret');
    expect(targetSync.applyPreference(model({ providerId: 'new-provider', customAlias: undefined, enabled: false })))
      .toMatchObject({ providerId: createModelProviderId(channel(), 'model-1'), customAlias: '同步别名', enabled: true, maxInputTokens: 64_000 });
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
      models: [],
    }]]));
    const targetStorage = new StorageService(target.context as any);
    await new SyncService(targetStorage).initialize();
    expect(targetStorage.getChannels()[0]).toMatchObject({
      defaultProtocol: 'openai',
      authMode: 'bearer',
      anthropicPath: '/zen/go/v1/messages',
    });
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
    expect(sync.getStatus()).toEqual({ enabled: false, locked: false, hasVault: false });
    expect(storage.getSyncProfile()).toBeUndefined();
    expect(await storage.getSyncLocalKey()).toBeUndefined();
    expect(await storage.getApiKey('channel-1')).toBeUndefined();
  });
});
