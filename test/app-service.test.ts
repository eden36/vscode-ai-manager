import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = () => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  },
}));

import { AppService } from '../src/app-service';
import { channel } from './fixtures';

describe('AppService', () => {
  it('保存渠道后续失败时恢复渠道、凭据和同步数据', async () => {
    const originalChannel = channel();
    const originalProfile = { version: 2, updatedAt: 1, channels: [originalChannel], models: [] };
    const originalVault = { version: 1, updatedAt: 1 };
    let channels = [originalChannel];
    let apiKey: string | undefined = 'old-secret';
    let profile: unknown = originalProfile;
    let vault: unknown = originalVault;
    const storage = {
      getChannels: () => channels,
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
      getApiKey: async () => apiKey,
      saveApiKey: async (_channelId: string, value: string) => { apiKey = value; },
      deleteApiKey: async () => { apiKey = undefined; },
      getSyncProfile: () => profile,
      saveSyncProfile: async (value: unknown) => { profile = value; },
      getSyncVault: () => vault,
      saveSyncVault: async (value: unknown) => { vault = value; },
    };
    const sync = {
      assertUnlocked: () => undefined,
      saveCredential: async (_channelId: string, value: string) => {
        apiKey = value;
        vault = { version: 1, updatedAt: 2 };
      },
      saveProfileFromLocal: async () => {
        profile = { version: 2, updatedAt: 2 };
        throw new Error('模拟同步配置写入失败');
      },
    };
    const chatBindings = { reconcile: vi.fn() };
    const app = new AppService(storage as any, {} as any, chatBindings as any, sync as any);

    await expect(app.saveChannel({ id: originalChannel.id, name: '新名称', apiKey: 'new-secret' }))
      .rejects.toThrow('模拟同步配置写入失败');

    expect(channels).toEqual([originalChannel]);
    expect(apiKey).toBe('old-secret');
    expect(profile).toBe(originalProfile);
    expect(vault).toBe(originalVault);
    expect(chatBindings.reconcile).not.toHaveBeenCalled();
  });
});
