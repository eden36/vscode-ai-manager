import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { resolveSharedStorageDirectory, StorageService } from '../src/storage';
import { channel, model } from './fixtures';

function chatBinding(setting: string): any {
  return { setting, providerId: `provider-${setting}`, appliedValue: `value-${setting}`, previousHadGlobalValue: false };
}

function isolatedStorage(directory: string, deviceId: string): StorageService {
  return new StorageService({
    globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined, setKeysForSync: () => undefined },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
  } as any, { directory, deviceId, watch: false });
}

describe('StorageService', () => {
  let values: Map<string, unknown>;
  let secrets: Map<string, string>;
  let storage: StorageService;
  let storageDirectory: string;

  beforeEach(async () => {
    values = new Map();
    secrets = new Map();
    storageDirectory = await mkdtemp(path.join(os.tmpdir(), 'ai-manager-storage-'));
    storage = new StorageService({
      globalState: {
        get: (key: string, fallback: unknown) => values.get(key) ?? fallback,
        update: async (key: string, value: unknown) => { values.set(key, value); },
      },
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => { secrets.set(key, value); },
        delete: async (key: string) => { secrets.delete(key); },
      },
    } as any, { directory: storageDirectory, deviceId: 'storage-test', watch: false });
    await storage.initialize();
  });

  afterEach(async () => {
    storage.dispose();
    await rm(storageDirectory, { recursive: true, force: true });
  });

  it('将渠道配置和密钥保存到不同存储', async () => {
    await storage.saveChannels([channel()]);
    await storage.saveApiKey('channel-1', 'top-secret');
    expect(JSON.stringify(storage.getChannels())).not.toContain('top-secret');
    expect(await storage.getApiKey('channel-1')).toBe('top-secret');
  });

  it('删除凭据后不再报告凭据存在', async () => {
    await storage.saveApiKey('channel-1', 'top-secret');
    await storage.deleteApiKey('channel-1');
    expect(await storage.hasApiKey('channel-1')).toBe(false);
  });

  it('串行执行原子模型更新并保留并发变更', async () => {
    await Promise.all([
      storage.updateModels((models) => [...models, model({ id: 'one', providerId: 'one' })]),
      storage.updateModels((models) => [...models, model({ id: 'two', providerId: 'two' })]),
    ]);
    expect(storage.getModels().map((item) => item.id)).toEqual(['one', 'two']);
  });

  it('同一发行版的不同 Profile 通过共享文件立即收敛', async () => {
    const other = new StorageService({
      globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined, setKeysForSync: () => undefined },
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    } as any, { directory: storageDirectory, deviceId: 'other-profile', watch: true });
    await other.initialize();

    await storage.saveChannels([channel()]);
    await vi.waitFor(() => expect(other.getChannels()).toHaveLength(1));

    other.dispose();
  });

  it('共享文件损坏时保留副本并重新建立有效状态', async () => {
    storage.dispose();
    await writeFile(path.join(storageDirectory, 'state-v3.json'), '{broken', 'utf8');
    const recovered = new StorageService({
      globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined, setKeysForSync: () => undefined },
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    } as any, { directory: storageDirectory, deviceId: 'recovery', watch: false });

    await recovered.initialize();

    expect(recovered.getLastError()).toContain('JSON');
    expect((await readdir(storageDirectory)).some((name) => name.startsWith('state-v3.json.corrupt-'))).toBe(true);
    recovered.dispose();
  });

  it('共享文件版本过新时只读降级，不改名也不覆盖', async () => {
    storage.dispose();
    const statePath = path.join(storageDirectory, 'state-v3.json');
    const future = JSON.stringify({ version: 4, clock: 7, syncGeneration: 0, channels: {} });
    await writeFile(statePath, future, 'utf8');
    const outdated = isolatedStorage(storageDirectory, 'outdated');

    await outdated.initialize();

    expect(outdated.isReadOnly()).toBe(true);
    expect(outdated.getLastError()).toContain('请升级扩展');
    expect((await readdir(storageDirectory)).some((name) => name.startsWith('state-v3.json.corrupt-'))).toBe(false);
    await expect(outdated.saveChannels([channel()])).rejects.toThrow('请升级扩展');
    expect(await readFile(statePath, 'utf8')).toBe(future);
    outdated.dispose();
  });

  it('保险库读取失败不会被状态文件读取成功掩盖', async () => {
    storage.dispose();
    await writeFile(path.join(storageDirectory, 'vault-v1.json'), '{broken', 'utf8');
    const recovered = isolatedStorage(storageDirectory, 'vault-recovery');
    await recovered.initialize();

    await recovered.saveChannels([channel()]);

    expect(recovered.getLastError()).toContain('JSON');
    recovered.dispose();
  });

  it('不同 Profile 写入不同 Chat 绑定时互不覆盖', async () => {
    const other = isolatedStorage(storageDirectory, 'other-profile');
    await other.initialize();

    await storage.upsertChatBindings([chatBinding('chat.defaultModel')]);
    await other.upsertChatBindings([chatBinding('chat.utilityModel')]);
    await storage.upsertChatBindings([chatBinding('inlineChat.defaultModel')]);

    expect(storage.getChatBindings().map((item) => item.setting).sort())
      .toEqual(['chat.defaultModel', 'chat.utilityModel', 'inlineChat.defaultModel']);
    other.dispose();
  });

  it('初始化时共享文件被占用不抛出，后续写入自行恢复', async () => {
    storage.dispose();
    await storage.saveChannels([channel()]);
    // 模拟另一个窗口长时间持有文件锁：初始化必须降级，否则扩展无法激活。
    await writeFile(path.join(storageDirectory, 'state.lock'), String(Date.now()), 'utf8');
    const blocked = isolatedStorage(storageDirectory, 'blocked');

    await expect(blocked.initialize()).resolves.toBeUndefined();
    expect(blocked.getLastError()).toContain('其他 VS Code 窗口');
    expect(blocked.getChannels()).toEqual([]);

    await rm(path.join(storageDirectory, 'state.lock'), { force: true });
    await blocked.updateChannels((channels) => channels);

    expect(blocked.getChannels()).toHaveLength(1);
    blocked.dispose();
  }, 10_000);

  it('保险库读取失败时保留已加载的保险库，不误判为已删除', async () => {
    const vaultPath = path.join(storageDirectory, 'vault-v1.json');
    await storage.saveSyncVault({ version: 1, updatedAt: 1 } as any);
    const watched = new StorageService({
      globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined, setKeysForSync: () => undefined },
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    } as any, { directory: storageDirectory, deviceId: 'watched', watch: true });
    await watched.initialize();
    expect(watched.getSyncVault()).toBeDefined();

    await writeFile(vaultPath, '{broken', 'utf8');

    await vi.waitFor(() => expect(watched.getLastError()).toContain('JSON'));
    expect(watched.getSyncVault()).toBeDefined();
    watched.dispose();
  });

  it('其他 Profile 单独更新保险库时同机可见', async () => {
    const watched = new StorageService({
      globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined, setKeysForSync: () => undefined },
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined },
    } as any, { directory: storageDirectory, deviceId: 'watched', watch: true });
    await watched.initialize();

    await storage.saveSyncVault({ version: 1, updatedAt: 7 } as any);

    await vi.waitFor(() => expect(watched.getSyncVault()).toMatchObject({ updatedAt: 7 }));
    watched.dispose();
  });

  it('只读降级时拒绝写入共享保险库', async () => {
    storage.dispose();
    await writeFile(
      path.join(storageDirectory, 'state-v3.json'),
      JSON.stringify({ version: 4, clock: 1, syncGeneration: 0, channels: {} }),
      'utf8',
    );
    const outdated = isolatedStorage(storageDirectory, 'outdated-vault');
    await outdated.initialize();

    await expect(outdated.saveSyncVault({ version: 1, updatedAt: 1 } as any)).rejects.toThrow('请升级扩展');
    outdated.dispose();
  });

  it('写入内容未变化时不发出变更通知', async () => {
    let changes = 0;
    storage.onDidChange(() => { changes += 1; });

    await storage.saveChannels([channel()]);
    await storage.saveChannels([channel()]);

    expect(changes).toBe(1);
  });

  it('同步确认标记默认未确认且可持久化', async () => {
    expect(storage.getSyncAcknowledged()).toBe(false);
    await storage.saveSyncAcknowledged(true);
    expect(storage.getSyncAcknowledged()).toBe(true);
    expect(values.get('aiManager.profile.syncAcknowledged.v1')).toBe(true);
  });
});

describe('resolveSharedStorageDirectory', () => {
  it('按平台和 VS Code 发行版隔离共享目录', () => {
    expect(resolveSharedStorageDirectory('Visual Studio Code', 'win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'C:\\Users\\test'))
      .toBe(path.join('C:\\Users\\test\\AppData\\Roaming', 'AI Manager', 'visual-studio-code'));
    expect(resolveSharedStorageDirectory('Code - Insiders', 'darwin', {}, '/Users/test'))
      .toBe(path.join('/Users/test', 'Library', 'Application Support', 'AI Manager', 'code-insiders'));
    expect(resolveSharedStorageDirectory('VSCodium', 'linux', { XDG_CONFIG_HOME: '/config' }, '/home/test'))
      .toBe(path.join('/config', 'ai-manager', 'vscodium'));
  });
});
