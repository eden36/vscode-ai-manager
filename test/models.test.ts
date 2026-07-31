import { describe, expect, it } from 'vitest';
import { createModelProviderId, estimateTokens, getExposedModels, getModelDisplayName, modelReportsToolCalling, sortCatalogModels } from '../src/models';
import { channel, model } from './fixtures';

describe('模型显示与排序', () => {
  it('相同渠道和模型在不同设备生成相同 providerId', () => {
    const first = channel({ id: 'device-a-channel', name: '设备 A' });
    const second = channel({ id: 'device-b-channel', name: '设备 B' });
    expect(createModelProviderId(first, 'gpt-test')).toBe(createModelProviderId(second, 'gpt-test'));
    expect(createModelProviderId(first, 'gpt-test')).not.toBe(createModelProviderId(first, 'other-model'));
    expect(createModelProviderId(first, 'gpt-test')).not.toBe(createModelProviderId(channel({ baseUrl: 'https://other.example.com' }), 'gpt-test'));
    expect(createModelProviderId(first, 'claude-test', 'anthropic')).toBe(createModelProviderId(second, 'claude-test', 'anthropic'));
    expect(createModelProviderId(first, 'claude-test', 'anthropic')).not.toBe(createModelProviderId(first, 'claude-test', 'gemini'));
  });

  it('使用自定义别名或渠道名加模型名作为默认值', () => {
    expect(getModelDisplayName(model(), channel())).toBe('测试渠道： Model 1');
    expect(getModelDisplayName(model({ customAlias: '快速模型' }), channel())).toBe('快速模型');
  });

  it('启停状态不改变模型的目录顺序', () => {
    const sorted = sortCatalogModels([
      model({ id: 'disabled-first', enabled: false, catalogOrder: 0 }),
      model({ id: 'enabled-second', enabled: true, catalogOrder: 1 }),
      model({ id: 'enabled-third', enabled: true, catalogOrder: 2 }),
    ]);
    expect(sorted.map((item) => item.id)).toEqual(['disabled-first', 'enabled-second', 'enabled-third']);
  });

  it('暴露渠道与模型均启用、可用且已配置协议端点的模型', () => {
    const exposed = getExposedModels([channel()], [
      model(),
      model({ id: 'disabled', enabled: false }),
      model({ id: 'missing', available: false }),
      model({ id: 'anthropic', protocol: 'anthropic' }),
    ]);
    expect(exposed.map((item) => item.id)).toEqual(['model-1', 'anthropic']);
  });

  it('仅对已启用模型声明工具调用能力', () => {
    expect(modelReportsToolCalling(model({ enabled: true }))).toBe(true);
    expect(modelReportsToolCalling(model({ enabled: false }))).toBe(false);
  });
});

describe('estimateTokens', () => {
  it('分别估算 ASCII 和非 ASCII 文本', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abc你')).toBe(2);
  });
});
