import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  globals: new Map<string, unknown>(),
  updates: [] as Array<[string, unknown]>,
  failSetting: undefined as string | undefined,
  openedSettings: [] as string[],
}));

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => ({ globalValue: mocks.globals.get(key) }),
      update: async (key: string, value: unknown) => {
        if (mocks.failSetting === key) throw new Error('模拟写入失败');
        mocks.updates.push([key, value]);
        if (value === undefined) mocks.globals.delete(key);
        else mocks.globals.set(key, value);
      },
    }),
  },
  window: {
    showWarningMessage: async (_message: string, _options: unknown, action: string) => action,
    showInformationMessage: async () => undefined,
  },
  commands: { executeCommand: async (_command: string, query: string) => { mocks.openedSettings.push(query); } },
}));

import { ChatBindingService } from '../src/chat-settings';
import { channel, model } from './fixtures';

function createStorage() {
  const data = {
    channels: [channel()],
    models: [model()],
    bindings: [] as any[],
  };
  return {
    data,
    storage: {
      getChannels: () => data.channels,
      getModels: () => data.models,
      getChatBindings: () => data.bindings,
      saveChatBindings: async (bindings: any[]) => { data.bindings = bindings; },
    },
  };
}

beforeEach(() => {
  mocks.globals.clear();
  mocks.updates.length = 0;
  mocks.failSetting = undefined;
  mocks.openedSettings.length = 0;
});

describe('ChatBindingService', () => {
  it('只修改已选择项目并保存绑定前的全局值', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.utilityModel', 'copilot/original');
    mocks.globals.set('chat.utilitySmallModel', 'copilot/small');
    await new ChatBindingService(storage as any).apply({ utility: { channelId: 'channel-1', modelId: 'model-1' } });
    expect(mocks.globals.get('chat.utilityModel')).toBe('ai-manager/provider-1');
    expect(mocks.globals.get('chat.utilitySmallModel')).toBe('copilot/small');
    expect(data.bindings[0]).toMatchObject({ previousHadGlobalValue: true, previousGlobalValue: 'copilot/original' });
  });

  it('切换 AI Manager 模型时保留首次绑定前的值', async () => {
    const { data, storage } = createStorage();
    data.models.push(model({ id: 'model-2', providerId: 'provider-2', catalogOrder: 1 }));
    mocks.globals.set('chat.utilityModel', 'copilot/original');
    const service = new ChatBindingService(storage as any);
    await service.apply({ utility: { channelId: 'channel-1', modelId: 'model-1' } });
    await service.apply({ utility: { channelId: 'channel-1', modelId: 'model-2' } });
    expect(data.bindings[0]).toMatchObject({ providerId: 'provider-2', previousGlobalValue: 'copilot/original' });
  });

  it('模型失效时恢复原设置并清除绑定', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.utilityModel', 'copilot/original');
    const service = new ChatBindingService(storage as any);
    await service.apply({ utility: { channelId: 'channel-1', modelId: 'model-1' } });
    data.models[0]!.available = false;
    await service.reconcile();
    expect(mocks.globals.get('chat.utilityModel')).toBe('copilot/original');
    expect(data.bindings).toEqual([]);
  });

  it('用户手动修改设置后不覆盖用户值', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.utilityModel', 'copilot/original');
    const service = new ChatBindingService(storage as any);
    await service.apply({ utility: { channelId: 'channel-1', modelId: 'model-1' } });
    mocks.globals.set('chat.utilityModel', 'manual/model');
    data.models[0]!.enabled = false;
    await service.reconcile();
    expect(mocks.globals.get('chat.utilityModel')).toBe('manual/model');
    expect(data.bindings).toEqual([]);
  });

  it('Plan Agent 别名变化时同步更新且保留备份', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.planAgent.defaultModel', 'Auto (Vendor Default)');
    const service = new ChatBindingService(storage as any);
    await service.apply({ planAgent: { channelId: 'channel-1', modelId: 'model-1' } });
    data.models[0]!.customAlias = '新别名';
    await service.reconcile();
    expect(mocks.globals.get('chat.planAgent.defaultModel')).toBe('新别名 (ai-manager)');
    expect(data.bindings[0]).toMatchObject({ previousGlobalValue: 'Auto (Vendor Default)' });
  });

  it('允许主动恢复绑定前设置', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.utilityModel', 'copilot/original');
    const service = new ChatBindingService(storage as any);
    await service.apply({ utility: { channelId: 'channel-1', modelId: 'model-1' } });
    await service.restore('chat.utilityModel');
    expect(mocks.globals.get('chat.utilityModel')).toBe('copilot/original');
    expect(data.bindings).toEqual([]);
  });

  it('多项设置写入失败时回滚已修改项', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.utilityModel', 'copilot/original');
    mocks.globals.set('chat.utilitySmallModel', 'copilot/small');
    mocks.failSetting = 'chat.utilitySmallModel';
    await expect(new ChatBindingService(storage as any).apply({
      utility: { channelId: 'channel-1', modelId: 'model-1' },
      utilitySmall: { channelId: 'channel-1', modelId: 'model-1' },
    })).rejects.toThrow('模拟写入失败');
    expect(mocks.globals.get('chat.utilityModel')).toBe('copilot/original');
    expect(data.bindings).toEqual([]);
  });

  it('Plan Agent 写入失败时回滚并打开对应设置', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.planAgent.defaultModel', 'Auto (Vendor Default)');
    mocks.failSetting = 'chat.planAgent.defaultModel';
    await expect(new ChatBindingService(storage as any).apply({ planAgent: { channelId: 'channel-1', modelId: 'model-1' } }))
      .rejects.toThrow('VS Code 未接受 Plan Agent 动态模型值');
    expect(mocks.globals.get('chat.planAgent.defaultModel')).toBe('Auto (Vendor Default)');
    expect(data.bindings).toEqual([]);
    expect(mocks.openedSettings).toEqual(['@id:chat.planAgent.defaultModel']);
  });
});
