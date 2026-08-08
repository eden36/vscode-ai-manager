import { describe, expect, it } from 'vitest';
import {
  createEmptySharedState,
  materializeChannels,
  materializeModels,
  mergeSharedStates,
  modelRecordKey,
  parseSharedState,
  serializeSharedState,
  UnsupportedStateVersionError,
} from '../src/shared-state';
import { channel, model } from './fixtures';

describe('共享状态合并', () => {
  it('按记录逻辑版本合并并使用设备 ID 稳定解决并发冲突', () => {
    const left = createEmptySharedState();
    const right = createEmptySharedState();
    const key = modelRecordKey('channel-1', 'model-1');
    left.models[key] = { revision: 2, deviceId: 'device-a', value: model({ customAlias: '设备 A' }) };
    right.models[key] = { revision: 2, deviceId: 'device-b', value: model({ customAlias: '设备 B' }) };

    const merged = mergeSharedStates(left, right);

    expect(materializeModels(merged)[0]?.customAlias).toBe('设备 B');
  });

  it('保留删除标记，防止旧设备恢复已删除记录', () => {
    const active = createEmptySharedState();
    const removed = createEmptySharedState();
    const key = modelRecordKey('channel-1', 'model-1');
    active.models[key] = { revision: 4, deviceId: 'device-a', value: model() };
    removed.models[key] = { revision: 5, deviceId: 'device-b', deleted: true };

    const merged = mergeSharedStates(active, removed);

    expect(materializeModels(merged)).toEqual([]);
    expect(merged.models[key]).toMatchObject({ revision: 5, deleted: true });
  });

  it('独立合并渠道配置和刷新状态', () => {
    const state = createEmptySharedState();
    const core = channel();
    delete core.lastRefreshAt;
    delete core.lastRefreshError;
    state.channels['channel-1'] = { revision: 2, deviceId: 'device-a', value: core };
    state.refresh['channel-1'] = {
      revision: 3,
      deviceId: 'device-b',
      value: { lastRefreshAt: 123, lastRefreshError: '远端错误' },
    };

    expect(materializeChannels(state)[0]).toMatchObject({
      id: 'channel-1',
      lastRefreshAt: 123,
      lastRefreshError: '远端错误',
    });
  });

  it('版本过新时抛出专用错误，不与格式损坏混淆', () => {
    expect(() => parseSharedState({ version: 4, clock: 0, syncGeneration: 0 }))
      .toThrow(UnsupportedStateVersionError);
    expect(() => parseSharedState({ version: 3, clock: -1, syncGeneration: 0 }))
      .toThrow('共享状态格式错误');
  });

  it('物化结果与内部状态隔离，避免调用方原地修改污染共享状态', () => {
    const state = createEmptySharedState();
    const key = modelRecordKey('channel-1', 'model-1');
    state.models[key] = { revision: 1, deviceId: 'device-a', value: model({ customAlias: '原始别名' }) };

    const materialized = materializeModels(state)[0]!;
    materialized.customAlias = '被调用方修改';

    expect(materializeModels(state)[0]?.customAlias).toBe('原始别名');
  });

  it('跳过字段非法的记录，但保留同一状态中的有效记录', () => {
    const valid = modelRecordKey('channel-1', 'model-1');
    const parsed = parseSharedState({
      version: 3,
      clock: 2,
      syncGeneration: 0,
      channels: {},
      refresh: {},
      models: {
        [valid]: { revision: 1, deviceId: 'device-a', value: model() },
        broken: { revision: 2, deviceId: 'device-a', value: { channelId: 'channel-1', id: 'model-2' } },
        'broken-effort': { revision: 3, deviceId: 'device-a', value: model({ id: 'model-3', reasoningEfforts: ['turbo'] as any }) },
      },
      bindings: {},
      chatSettings: {},
    });

    expect(Object.keys(parsed.models)).toEqual([valid]);
  });

  it('跳过字段非法的绑定、共享设置和刷新记录', () => {
    const parsed = parseSharedState({
      version: 3,
      clock: 2,
      syncGeneration: 0,
      channels: {},
      refresh: {
        'channel-1': { revision: 1, deviceId: 'device-a', value: { lastRefreshAt: 1 } },
        'channel-2': { revision: 1, deviceId: 'device-a', value: { lastRefreshAt: '不是时间戳' } },
      },
      models: {},
      bindings: {
        'chat.defaultModel': { revision: 1, deviceId: 'device-a', value: { setting: 'chat.defaultModel', providerId: 'p', appliedValue: 'v', previousHadGlobalValue: false } },
        'chat.utilityModel': { revision: 1, deviceId: 'device-a', value: { setting: 'chat.utilityModel' } },
      },
      chatSettings: {
        'chat.defaultModel': { revision: 1, deviceId: 'device-a', value: { setting: 'chat.defaultModel', hadValue: false } },
        'inlineChat.defaultModel': { revision: 1, deviceId: 'device-a', value: { hadValue: false } },
      },
      chatErrors: {
        'chat.defaultModel': { revision: 1, deviceId: 'device-a', value: '写入失败' },
        'chat.utilityModel': { revision: 1, deviceId: 'device-a', value: { message: '不是字符串' } },
      },
    });

    expect(Object.keys(parsed.refresh)).toEqual(['channel-1']);
    expect(Object.keys(parsed.bindings)).toEqual(['chat.defaultModel']);
    expect(Object.keys(parsed.chatSettings)).toEqual(['chat.defaultModel']);
    expect(Object.keys(parsed.chatErrors)).toEqual(['chat.defaultModel']);
  });

  it('序列化时固定记录顺序，避免等价状态反复同步', () => {
    const left = createEmptySharedState();
    const right = createEmptySharedState();
    left.models.b = { revision: 1, deviceId: 'device', value: model({ id: 'b' }) };
    left.models.a = { revision: 1, deviceId: 'device', value: model({ id: 'a' }) };
    right.models.a = left.models.a;
    right.models.b = left.models.b;

    expect(serializeSharedState(left)).toBe(serializeSharedState(right));
  });
});
