import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = () => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  },
}));

import { AppService } from '../src/app-service';
import { CHANNEL_PRESETS } from '../src/presets';
import { channel, model } from './fixtures';

describe('AppService', () => {
  it.each(CHANNEL_PRESETS.filter((preset) => !['custom', 'opencode-go', 'opencode-console'].includes(preset.id)))('保存 $label 预设', async ({ id, values }) => {
    let channels: ReturnType<typeof channel>[] = [];
    const storage = {
      getChannels: () => channels,
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
      getApiKey: async () => undefined,
      deleteApiKey: async () => undefined,
      getSyncVault: () => undefined,
      saveSyncVault: async () => undefined,
    };
    const sync = { assertUnlocked: () => undefined, saveProfileFromLocal: async () => undefined };
    const app = new AppService(storage as any, {} as any, { reconcile: vi.fn() } as any, sync as any);

    const saved = await app.saveChannel({ preset: id, name: `测试 ${id}` });

    expect(saved).toMatchObject({ preset: id, ...values });
  });

  it('未知预设回退到通用预设', async () => {
    let channels: ReturnType<typeof channel>[] = [];
    const storage = {
      getChannels: () => channels,
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
      getApiKey: async () => undefined,
      deleteApiKey: async () => undefined,
      getSyncVault: () => undefined,
      saveSyncVault: async () => undefined,
    };
    const sync = { assertUnlocked: () => undefined, saveProfileFromLocal: async () => undefined };
    const app = new AppService(storage as any, {} as any, { reconcile: vi.fn() } as any, sync as any);

    const saved = await app.saveChannel({ preset: 'unknown' as any, name: '未知预设', baseUrl: 'https://example.com' });

    expect(saved).toMatchObject({ preset: 'custom', baseUrl: 'https://example.com', chatPath: '/v1/chat/completions' });
  });

  it('保存渠道后续失败时恢复渠道、凭据和同步数据', async () => {
    const originalChannel = channel();
    const originalVault = { version: 1, updatedAt: 1 };
    let channels = [originalChannel];
    let apiKey: string | undefined = 'old-secret';
    let vault: unknown = originalVault;
    const storage = {
      getChannels: () => channels,
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
      getApiKey: async () => apiKey,
      saveApiKey: async (_channelId: string, value: string) => { apiKey = value; },
      deleteApiKey: async () => { apiKey = undefined; },
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
        throw new Error('模拟同步配置写入失败');
      },
    };
    const chatBindings = { reconcile: vi.fn() };
    const app = new AppService(storage as any, {} as any, chatBindings as any, sync as any);

    await expect(app.saveChannel({ id: originalChannel.id, name: '新名称', apiKey: 'new-secret' }))
      .rejects.toThrow('模拟同步配置写入失败');

    expect(channels).toEqual([originalChannel]);
    expect(apiKey).toBe('old-secret');
    expect(vault).toBe(originalVault);
    expect(chatBindings.reconcile).not.toHaveBeenCalled();
  });

  it('保存与目录基线一致的元数据时清除覆盖标记', async () => {
    let models = [model({
      metadataOverridden: true,
      protocol: 'openai',
      maxInputTokens: 64_000,
      catalogMetadata: {
        protocol: 'anthropic',
        maxInputTokens: 128_000,
        maxOutputTokens: 8_192,
        toolCalling: true,
      },
    })];
    const storage = {
      getChannels: () => [channel()],
      updateModels: async (update: (value: typeof models) => typeof models) => { models = update(models); return models; },
    };
    const sync = { saveProfileFromLocal: async () => undefined };
    const app = new AppService(storage as any, {} as any, { reconcile: vi.fn() } as any, sync as any);

    await app.saveModel({
      channelId: 'channel-1',
      id: 'model-1',
      protocol: 'anthropic',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
    });

    expect(models[0]).toMatchObject({
      protocol: 'anthropic',
      maxInputTokens: 128_000,
      metadataOverridden: false,
    });
  });

  it('启用模型时同步声明工具调用能力', async () => {
    let models = [model({ enabled: false, toolCalling: false })];
    const storage = {
      getChannels: () => [channel()],
      updateModels: async (update: (value: typeof models) => typeof models) => { models = update(models); return models; },
    };
    const sync = { saveProfileFromLocal: async () => undefined };
    const app = new AppService(storage as any, {} as any, { reconcile: vi.fn() } as any, sync as any);

    await app.saveModel({ channelId: 'channel-1', id: 'model-1', enabled: true });

    expect(models[0]).toMatchObject({ enabled: true, toolCalling: true });
  });

  it('getDashboardState 暴露只读状态', async () => {
    const storage = {
      getChannels: () => [],
      getModels: () => [],
      isReadOnly: () => true,
      getLastError: () => '状态版本过高',
      hasApiKey: async () => false,
      getChatApplicationErrors: () => ({}),
    };
    const sync = { getStatus: () => ({ enabled: false, locked: false, hasVault: false, localShared: true, cloudState: 'waiting' as const }) };
    const app = new AppService(storage as any, {} as any, { getSelections: () => ({}), getChatApplicationErrors: () => ({}) } as any, sync as any);

    const state = await app.getDashboardState();

    expect(state.readOnly).toBe(true);
    expect(state.readOnlyReason).toBe('状态版本过高');
  });
});
