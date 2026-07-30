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
import type { ChatSettingKey } from '../src/types';
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
  it('为六类 Chat 设置写入对应格式的模型值', async () => {
    const { storage } = createStorage();
    await new ChatBindingService(storage as any).apply({
      chatDefault: { channelId: 'channel-1', modelId: 'model-1' },
      inlineChat: { channelId: 'channel-1', modelId: 'model-1' },
      planAgent: { channelId: 'channel-1', modelId: 'model-1' },
      implementAgent: { channelId: 'channel-1', modelId: 'model-1' },
      utility: { channelId: 'channel-1', modelId: 'model-1' },
      utilitySmall: { channelId: 'channel-1', modelId: 'model-1' },
    });

    const qualifiedName = '测试渠道： Model 1 (ai-manager)';
    expect(mocks.globals.get('chat.defaultModel')).toBe(qualifiedName);
    expect(mocks.globals.get('inlineChat.defaultModel')).toBe(qualifiedName);
    expect(mocks.globals.get('chat.planAgent.defaultModel')).toBe(qualifiedName);
    expect(mocks.globals.get('github.copilot.chat.implementAgent.model')).toBe(qualifiedName);
    expect(mocks.globals.get('chat.utilityModel')).toBe('ai-manager/provider-1');
    expect(mocks.globals.get('chat.utilitySmallModel')).toBe('ai-manager/provider-1');
  });

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

  it('在新电脑上识别由 VS Code 同步的 AI Manager 设置', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.utilityModel', 'ai-manager/provider-1');
    await new ChatBindingService(storage as any).reconcile();
    expect(data.bindings).toEqual([{
      setting: 'chat.utilityModel',
      providerId: 'provider-1',
      appliedValue: 'ai-manager/provider-1',
      previousHadGlobalValue: false,
    }]);
  });

  it('限定名称设置在别名变化时全部同步更新且保留备份', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.planAgent.defaultModel', 'Auto (Vendor Default)');
    const service = new ChatBindingService(storage as any);
    await service.apply({
      chatDefault: { channelId: 'channel-1', modelId: 'model-1' },
      inlineChat: { channelId: 'channel-1', modelId: 'model-1' },
      planAgent: { channelId: 'channel-1', modelId: 'model-1' },
      implementAgent: { channelId: 'channel-1', modelId: 'model-1' },
    });
    data.models[0]!.customAlias = '新别名';
    await service.reconcile();
    expect(mocks.globals.get('chat.defaultModel')).toBe('新别名 (ai-manager)');
    expect(mocks.globals.get('inlineChat.defaultModel')).toBe('新别名 (ai-manager)');
    expect(mocks.globals.get('chat.planAgent.defaultModel')).toBe('新别名 (ai-manager)');
    expect(mocks.globals.get('github.copilot.chat.implementAgent.model')).toBe('新别名 (ai-manager)');
    expect(data.bindings.find((binding) => binding.setting === 'chat.planAgent.defaultModel'))
      .toMatchObject({ previousGlobalValue: 'Auto (Vendor Default)' });
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

  it('六类 Chat 设置都能恢复应用前的值', async () => {
    const { data, storage } = createStorage();
    const selections = {
      chatDefault: { channelId: 'channel-1', modelId: 'model-1' },
      inlineChat: { channelId: 'channel-1', modelId: 'model-1' },
      planAgent: { channelId: 'channel-1', modelId: 'model-1' },
      implementAgent: { channelId: 'channel-1', modelId: 'model-1' },
      utility: { channelId: 'channel-1', modelId: 'model-1' },
      utilitySmall: { channelId: 'channel-1', modelId: 'model-1' },
    };
    const previousValues = new Map([
      ['chat.defaultModel', 'auto'],
      ['inlineChat.defaultModel', 'Default'],
      ['chat.planAgent.defaultModel', 'Auto (Vendor Default)'],
      ['github.copilot.chat.implementAgent.model', ''],
      ['chat.utilityModel', 'copilot/utility'],
      ['chat.utilitySmallModel', 'copilot/small'],
    ]);
    for (const [key, previousValue] of previousValues) mocks.globals.set(key, previousValue);

    const service = new ChatBindingService(storage as any);
    await service.apply(selections);
    for (const key of previousValues.keys()) await service.restore(key as ChatSettingKey);

    for (const [key, previousValue] of previousValues) expect(mocks.globals.get(key)).toBe(previousValue);
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
      .rejects.toThrow('VS Code 无法应用“Plan Agent 默认模型”模型值');
    expect(mocks.globals.get('chat.planAgent.defaultModel')).toBe('Auto (Vendor Default)');
    expect(data.bindings).toEqual([]);
    expect(mocks.openedSettings).toEqual(['@id:chat.planAgent.defaultModel']);
  });

  it('主 Chat 默认模型写入失败时回滚并打开对应设置', async () => {
    const { data, storage } = createStorage();
    mocks.globals.set('chat.defaultModel', 'auto');
    mocks.failSetting = 'chat.defaultModel';
    await expect(new ChatBindingService(storage as any).apply({ chatDefault: { channelId: 'channel-1', modelId: 'model-1' } }))
      .rejects.toThrow('当前版本不支持或组织策略已锁定');
    expect(mocks.globals.get('chat.defaultModel')).toBe('auto');
    expect(data.bindings).toEqual([]);
    expect(mocks.openedSettings).toEqual(['@id:chat.defaultModel']);
  });
});
