import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { StorageService } from '../src/storage';
import { channel, model } from './fixtures';

describe('StorageService', () => {
  let values: Map<string, unknown>;
  let secrets: Map<string, string>;
  let storage: StorageService;

  beforeEach(() => {
    values = new Map();
    secrets = new Map();
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
    } as any);
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
});
