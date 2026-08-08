import { randomBytes } from 'node:crypto';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { StorageService } from '../src/storage';
import { createEmptySharedState } from '../src/shared-state';
import {
  decodeSharedState,
  decryptWithKey,
  encodeSharedState,
  encryptWithKey,
  mergeVaultPayloads,
  startSyncPolling,
  SyncService,
  type SyncedVaultBundleV2,
  type VaultPayloadV2,
} from '../src/sync';
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

function copySyncedValues(source: ReturnType<typeof createContext>, target: ReturnType<typeof createContext>): void {
  for (const key of source.syncKeys) {
    if (source.values.has(key)) target.values.set(key, structuredClone(source.values.get(key)));
    else target.values.delete(key);
  }
}

function vaultPayload(credentials: VaultPayloadV2['credentials'] = {}): VaultPayloadV2 {
  return { version: 2, clock: Object.values(credentials).reduce((max, record) => Math.max(max, record.revision), 0), credentials };
}

function decryptBundle(bundle: SyncedVaultBundleV2): VaultPayloadV2 {
  return decryptWithKey(bundle.vault, Buffer.from(bundle.key, 'base64'));
}

describe('同步保险库 V2', () => {
  it('使用随机 IV 加密并拒绝错误密钥或篡改密文', () => {
    const key = randomBytes(32);
    const salt = randomBytes(16);
    const payload = vaultPayload({ channel: { revision: 1, deviceId: 'device-a', value: 'top-secret' } });
    const vault = encryptWithKey(payload, key, salt);
    expect(JSON.stringify(vault)).not.toContain('top-secret');
    expect(decryptWithKey(vault, key)).toEqual(payload);
    expect(() => decryptWithKey(vault, randomBytes(32))).toThrow('同步保险库已损坏');

    const second = encryptWithKey(payload, key, salt);
    expect(second.cipher.iv).not.toBe(vault.cipher.iv);
    const tampered = { ...vault, cipher: { ...vault.cipher, ciphertext: `${vault.cipher.ciphertext.slice(0, -2)}AA` } };
    expect(() => decryptWithKey(tampered, key)).toThrow('同步保险库已损坏');
  });

  it('按记录合并不同渠道，并用墓碑阻止旧凭据复活', () => {
    const merged = mergeVaultPayloads(
      vaultPayload({
        one: { revision: 1, deviceId: 'device-a', value: 'one' },
        removed: { revision: 3, deviceId: 'device-a', deleted: true },
      }),
      vaultPayload({
        two: { revision: 2, deviceId: 'device-b', value: 'two' },
        removed: { revision: 2, deviceId: 'device-b', value: 'stale' },
      }),
    );

    expect(merged.credentials.one?.value).toBe('one');
    expect(merged.credentials.two?.value).toBe('two');
    expect(merged.credentials.removed).toMatchObject({ revision: 3, deleted: true });
  });
});

describe('同步状态快照 V4', () => {
  it('压缩完整状态并通过清单校验往返恢复', async () => {
    const state = createEmptySharedState();
    state.clock = 1;
    state.chatSettings['chat.defaultModel'] = {
      revision: 1,
      deviceId: 'device-a',
      value: { setting: 'chat.defaultModel', hadValue: true, value: 'ai-manager/model' },
    };
    const encoded = await encodeSharedState(state, 'snapshot-a');

    expect(encoded.manifest).toMatchObject({ version: 4, snapshotId: 'snapshot-a' });
    expect(await decodeSharedState(encoded.manifest, encoded.chunks)).toEqual(state);
    const corrupted = `${encoded.chunks[0]?.startsWith('A') ? 'B' : 'A'}${encoded.chunks[0]?.slice(1) ?? ''}`;
    await expect(decodeSharedState(encoded.manifest, [corrupted])).rejects.toThrow('同步状态校验失败');
  });

  it('重置清单不要求状态分块', async () => {
    const state = await decodeSharedState({
      version: 4,
      generation: 5,
      updatedAt: 1,
      snapshotId: 'reset-snapshot',
      chunkCount: 0,
      encoding: 'deflate-raw-base64',
      checksum: '',
      reset: true,
    }, []);

    expect(state).toMatchObject({ version: 3, syncGeneration: 5, channels: {}, models: {} });
  });
});

describe('同步轮询', () => {
  it('每 30 秒执行且上一次未完成时不重入', async () => {
    vi.useFakeTimers();
    let resolveRun: ((result: { stateChanged: boolean; vaultChanged: boolean }) => void) | undefined;
    const run = vi.fn(() => new Promise<{ stateChanged: boolean; vaultChanged: boolean }>((resolve) => { resolveRun = resolve; }));
    const onResult = vi.fn();
    const polling = startSyncPolling(run, onResult, vi.fn());

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);

    resolveRun?.({ stateChanged: true, vaultChanged: false });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith({ stateChanged: true, vaultChanged: false });

    polling.dispose();
    vi.useRealTimers();
  });
});

describe('SyncService', () => {
  let source: ReturnType<typeof createContext>;
  let storage: StorageService;
  let storageDirectories: string[];

  async function createTestStorage(context: unknown, deviceId?: string, directory?: string): Promise<StorageService> {
    const storageDirectory = directory ?? await mkdtemp(path.join(os.tmpdir(), 'ai-manager-sync-'));
    if (!directory) storageDirectories.push(storageDirectory);
    const result = new StorageService(context as any, {
      directory: storageDirectory,
      deviceId: deviceId ?? `device-${storageDirectories.length}`,
      watch: false,
    });
    await result.initialize();
    return result;
  }

  beforeEach(async () => {
    storageDirectories = [];
    source = createContext();
    storage = await createTestStorage(source.context, 'device-source');
    await storage.saveChannels([channel({ lastRefreshAt: 123, lastRefreshError: '本机错误' })]);
    await storage.saveModels([model({ customAlias: '同步别名', metadataOverridden: true, maxInputTokens: 64_000 })]);
    await storage.saveApiKey('channel-1', 'top-secret');
  });

  afterEach(async () => {
    storage.dispose();
    await Promise.all(storageDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('以本机数据建立新版同步并清理旧同步键', async () => {
    source.values.set('aiManager.sync.manifest.v3', { version: 3, chunkCount: 1 });
    source.values.set('aiManager.sync.chunk.v3.0', 'legacy');
    source.values.set('aiManager.sync.vault.v2', { version: 1 });
    source.values.set('aiManager.sync.encryptionKey.v1', 'legacy-key');
    source.secrets.set('aiManager.sync.localKey.v1', 'legacy-local-key');
    await writeFile(path.join(storage.directory, 'vault-v1.json'), 'legacy-vault', 'utf8');
    await writeFile(path.join(storage.directory, 'vault-key-v1'), 'legacy-shared-key', 'utf8');
    const sync = new SyncService(storage);

    await sync.initialize();

    expect(sync.getStatus()).toMatchObject({ enabled: true, locked: false, cloudState: 'synced' });
    expect(storage.getSyncManifest()).toMatchObject({ version: 4 });
    expect(storage.getSyncedVaultBundle()).toMatchObject({ version: 2 });
    expect(source.syncKeys.some((key) => key.startsWith('aiManager.sync.chunk.v4.'))).toBe(true);
    expect(source.values.has('aiManager.sync.manifest.v3')).toBe(false);
    expect(source.values.has('aiManager.sync.chunk.v3.0')).toBe(false);
    expect(source.values.has('aiManager.sync.vault.v2')).toBe(false);
    expect(source.secrets.has('aiManager.sync.localKey.v1')).toBe(false);
    await expect(access(path.join(storage.directory, 'vault-v1.json'))).rejects.toThrow();
    await expect(access(path.join(storage.directory, 'vault-key-v1'))).rejects.toThrow();
    expect(await storage.getApiKey('channel-1')).toBe('top-secret');
  });

  it('在新电脑恢复完整共享状态和密文凭据', async () => {
    const sync = new SyncService(storage);
    await sync.initialize();
    const target = createContext();
    copySyncedValues(source, target);
    const targetStorage = await createTestStorage(target.context, 'device-target');
    const targetSync = new SyncService(targetStorage);

    await targetSync.initialize();

    expect(targetStorage.getChannels()).toHaveLength(1);
    expect(await targetStorage.getApiKey('channel-1')).toBe('top-secret');
    expect(targetSync.applyPreference(model({ providerId: 'new-provider', customAlias: undefined, enabled: false })))
      .toMatchObject({ providerId: createModelProviderId(channel(), 'model-1'), customAlias: '同步别名', enabled: true });
  });

  it('发布本机修改前先合并尚未应用的远端状态', async () => {
    const sourceSync = new SyncService(storage);
    await sourceSync.initialize();
    const target = createContext();
    copySyncedValues(source, target);
    const targetStorage = await createTestStorage(target.context, 'device-target');
    const targetSync = new SyncService(targetStorage);
    await targetSync.initialize();

    await storage.updateChannels((channels) => [...channels, channel({ id: 'remote', name: '远端渠道' })]);
    await sourceSync.saveProfileFromLocal();
    copySyncedValues(source, target);
    await targetStorage.updateChannels((channels) => [...channels, channel({ id: 'local', name: '本机渠道' })]);
    await targetSync.saveProfileFromLocal();

    expect(targetStorage.getChannels().map((item) => item.id).sort()).toEqual(['channel-1', 'local', 'remote']);
    const manifest = targetStorage.getSyncManifest()!;
    const decoded = await decodeSharedState(
      manifest,
      Array.from({ length: manifest.chunkCount }, (_, index) => targetStorage.getSyncChunk(manifest.snapshotId, index)!),
    );
    expect(Object.values(decoded.channels).filter((record) => !record.deleted)).toHaveLength(3);
  });

  it('合并两台电脑离线修改的不同凭据', async () => {
    await storage.saveChannels([
      channel(),
      channel({ id: 'channel-2', name: '渠道 2' }),
    ]);
    const sourceSync = new SyncService(storage);
    await sourceSync.initialize();
    const target = createContext();
    copySyncedValues(source, target);
    const targetStorage = await createTestStorage(target.context, 'device-target');
    const targetSync = new SyncService(targetStorage);
    await targetSync.initialize();

    await sourceSync.saveCredential('channel-1', 'source-new');
    await targetSync.saveCredential('channel-2', 'target-new');
    copySyncedValues(source, target);
    await targetSync.reconcile();

    expect(await targetStorage.getApiKey('channel-1')).toBe('source-new');
    expect(await targetStorage.getApiKey('channel-2')).toBe('target-new');
    const bundle = targetStorage.getSyncedVaultBundle()!;
    expect(decryptBundle(bundle).credentials).toMatchObject({
      'channel-1': { value: 'source-new' },
      'channel-2': { value: 'target-new' },
    });
  });

  it('同机多个窗口并发保存不同凭据时在文件锁内合并', async () => {
    await storage.saveChannels([
      channel(),
      channel({ id: 'channel-2', name: '渠道 2' }),
    ]);
    const firstSync = new SyncService(storage);
    await firstSync.initialize();
    const other = createContext(source.values);
    const otherStorage = await createTestStorage(other.context, 'device-source', storage.directory);
    const otherSync = new SyncService(otherStorage);
    await otherSync.initialize();

    await Promise.all([
      firstSync.saveCredential('channel-1', 'window-one'),
      otherSync.saveCredential('channel-2', 'window-two'),
    ]);
    await firstSync.reconcile();

    const bundle = storage.getSyncedVaultBundle()!;
    expect(decryptBundle(bundle).credentials).toMatchObject({
      'channel-1': { value: 'window-one' },
      'channel-2': { value: 'window-two' },
    });
    otherStorage.dispose();
  });

  it('远端快照缺块时不覆盖本机状态，连续失败后报告错误', async () => {
    const sync = new SyncService(storage);
    await sync.initialize();
    const originalManifest = storage.getSyncManifest()!;
    source.values.set('aiManager.sync.manifest.v4', {
      ...originalManifest,
      snapshotId: 'missing-snapshot',
      updatedAt: originalManifest.updatedAt + 1,
    });

    await sync.reconcile();
    await sync.reconcile();
    expect(sync.getStatus().cloudState).toBe('synced');
    await sync.reconcile();

    expect(storage.getChannels()).toHaveLength(1);
    expect(storage.getSyncManifest()?.snapshotId).toBe('missing-snapshot');
    expect(sync.getStatus()).toMatchObject({ cloudState: 'error', error: '同步状态分块尚未完整到达' });
  });

  it('远端快照分块陆续到达时不误报错误', async () => {
    const publisher = new SyncService(storage);
    await publisher.initialize();
    await storage.updateChannels((channels) => channels.map((item) => ({ ...item, name: '远端渠道名' })));
    await publisher.saveProfileFromLocal();
    const publishedManifest = storage.getSyncManifest()!;
    const publishedChunks = Array.from(
      { length: publishedManifest.chunkCount },
      (_, index) => storage.getSyncChunk(publishedManifest.snapshotId, index)!,
    );

    const consumer = createContext();
    const consumerStorage = await createTestStorage(consumer.context, 'device-consumer');
    await consumerStorage.saveChannels([channel()]);
    const sync = new SyncService(consumerStorage);
    await sync.initialize();
    consumer.values.set('aiManager.sync.manifest.v4', {
      ...publishedManifest,
      updatedAt: publishedManifest.updatedAt + 1,
    });

    await sync.reconcile();
    await sync.reconcile();
    expect(sync.getStatus().cloudState).toBe('synced');
    expect(consumerStorage.getChannels()[0]?.name).toBe('测试渠道');

    for (let index = 0; index < publishedChunks.length; index += 1) {
      consumer.values.set(`aiManager.sync.chunk.v4.${publishedManifest.snapshotId}.${index}`, publishedChunks[index]);
    }
    await sync.reconcile();
    expect(sync.getStatus().cloudState).toBe('synced');
    expect(sync.getStatus().error).toBeUndefined();
    expect(consumerStorage.getChannels()[0]?.name).toBe('远端渠道名');
    consumerStorage.dispose();
  });

  it('只保留当前发布端最近两个快照', async () => {
    const sync = new SyncService(storage);
    await sync.initialize();
    for (const name of ['第一次', '第二次', '第三次']) {
      await storage.updateChannels((channels) => channels.map((item) => ({ ...item, name })));
      await sync.saveProfileFromLocal();
    }

    const snapshotIds = new Set([...source.values.keys()]
      .filter((key) => key.startsWith('aiManager.sync.chunk.v4.'))
      .map((key) => key.split('.')[4]));
    expect(snapshotIds.size).toBeLessThanOrEqual(2);
  });

  it('重置清除同步凭据和本机凭据，但保留渠道配置', async () => {
    const sync = new SyncService(storage);
    await sync.initialize();

    await sync.reset();
    await sync.reconcile();
    await sync.saveProfileFromLocal();

    expect(sync.getStatus()).toEqual({ enabled: false, locked: false, hasVault: false, localShared: true, cloudState: 'waiting' });
    expect(storage.getSyncManifest()).toMatchObject({ version: 4, reset: true });
    expect(storage.getSyncedVaultBundle()).toBeUndefined();
    expect(await storage.getApiKey('channel-1')).toBeUndefined();
    expect(storage.getChannels()).toHaveLength(1);
  });

  it('远端重置只清理一次，之后重新保存的凭据不会被旧重置重复删除', async () => {
    const sourceSync = new SyncService(storage);
    await sourceSync.initialize();
    const target = createContext();
    copySyncedValues(source, target);
    const targetStorage = await createTestStorage(target.context, 'device-target');
    const targetSync = new SyncService(targetStorage);
    await targetSync.initialize();

    await sourceSync.reset();
    copySyncedValues(source, target);
    await targetSync.reconcile();
    expect(await targetStorage.getApiKey('channel-1')).toBeUndefined();

    await targetSync.saveCredential('channel-1', 'new-secret');
    await targetSync.reconcile();
    expect(await targetStorage.getApiKey('channel-1')).toBe('new-secret');
  });
});
