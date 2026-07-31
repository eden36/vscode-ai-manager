import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogService, catalogMetadataBaseline, inferProtocol, joinEndpoint, parseModelCatalog } from '../src/catalog';
import { createModelProviderId } from '../src/models';
import { createChannelDefaults } from '../src/presets';
import type { ChannelPreset } from '../src/types';
import { channel, model } from './fixtures';

describe('parseModelCatalog', () => {
  it('解析 OpenAI 目录并使用渠道默认值', () => {
    const result = parseModelCatalog({ data: [{ id: 'gpt-test' }] }, channel(), 123);
    expect(result).toEqual([expect.objectContaining({
      id: 'gpt-test',
      protocol: 'openai',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      lastSeenAt: 123,
    })]);
  });

  it('读取模型能力与限制元数据', () => {
    const [result] = parseModelCatalog({ models: [{ id: 'tools', limits: { context: 200_000, output: 16_000 }, capabilities: { tools: true } }] }, channel());
    expect(result).toMatchObject({ maxInputTokens: 200_000, maxOutputTokens: 16_000, toolCalling: true });
  });

  it('只在 OpenCode Go 预设中保守标记已知 Messages 系列', () => {
    const go = channel({ preset: 'opencode-go' });
    const consoleChannel = channel({ preset: 'opencode-console' });
    expect(parseModelCatalog({ data: [{ id: 'minimax-m3' }, { id: 'qwen3.7-plus' }, { id: 'kimi-k3' }] }, go).map((item) => item.protocol))
      .toEqual(['anthropic', 'anthropic', 'openai']);
    expect(parseModelCatalog({ data: [{ id: 'minimax-m3' }] }, consoleChannel)[0]?.protocol).toBe('openai');
  });

  it('显式协议优先于模型 ID 推断', () => {
    expect(inferProtocol({ id: 'x', apiType: 'gemini-generateContent' })).toBe('gemini');
    expect(inferProtocol({ id: 'x', endpoint: '/v1/messages' })).toBe('anthropic');
  });

  it('使用渠道默认协议并规范化 Gemini 模型名称', () => {
    const geminiChannel = channel({ defaultProtocol: 'gemini', authMode: 'google-api-key' });
    expect(parseModelCatalog({ models: [{ name: 'models/gemini-test', displayName: 'Gemini Test' }] }, geminiChannel)[0])
      .toMatchObject({ id: 'gemini-test', name: 'Gemini Test', protocol: 'gemini' });
  });

  it('按原生 Anthropic 和 Gemini 预设解析协议', () => {
    const anthropicChannel = channel(createChannelDefaults('anthropic'));
    const geminiChannel = channel(createChannelDefaults('gemini'));
    expect(parseModelCatalog({ data: [{ id: 'claude-test' }] }, anthropicChannel)[0]?.protocol).toBe('anthropic');
    expect(parseModelCatalog({ models: [{ name: 'models/gemini-test' }] }, geminiChannel)[0]?.protocol).toBe('gemini');
  });

  it.each<ChannelPreset>(['openai', 'openrouter', 'deepseek', 'siliconflow', 'mistral', 'groq', 'together', 'xai'])('按 %s 预设解析 OpenAI 协议', (preset) => {
    expect(parseModelCatalog({ data: [{ id: 'model-test' }] }, channel(createChannelDefaults(preset)))[0]?.protocol).toBe('openai');
  });

  it('忽略目录中的重复模型 ID', () => {
    const result = parseModelCatalog({ data: [{ id: 'same' }, { id: 'same' }, { id: 'other' }] }, channel());
    expect(result.map((item) => item.id)).toEqual(['same', 'other']);
  });
});

describe('catalogMetadataBaseline', () => {
  it('优先使用目录基线元数据', () => {
    expect(catalogMetadataBaseline(model({
      protocol: 'openai',
      maxInputTokens: 64_000,
      catalogMetadata: {
        protocol: 'anthropic',
        maxInputTokens: 128_000,
        maxOutputTokens: 8_192,
        toolCalling: false,
      },
    }))).toEqual({
      protocol: 'anthropic',
      maxInputTokens: 128_000,
      maxOutputTokens: 8_192,
      toolCalling: false,
    });
  });
});

describe('joinEndpoint', () => {
  it('安全拼接接口地址', () => {
    expect(joinEndpoint('https://example.com/base', '/v1/models')).toBe('https://example.com/base/v1/models');
  });

  it('拒绝内嵌凭据和非 HTTP 协议', () => {
    expect(() => joinEndpoint('https://user:secret@example.com', '/models')).toThrow('无内嵌凭据');
    expect(() => joinEndpoint('file:///tmp', '/models')).toThrow('HTTP 或 HTTPS');
  });
});

describe('CatalogService 目录合并', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('保留模型配置并报告移除、新增和重新出现', async () => {
    let models = [
      model({ id: 'kept', providerId: 'stable-kept', customAlias: '保留别名', enabled: true, catalogOrder: 0 }),
      model({ id: 'removed', providerId: 'stable-removed', enabled: true, catalogOrder: 1 }),
      model({ id: 'back', providerId: 'stable-back', enabled: true, available: false, catalogOrder: 2 }),
    ];
    let channels = [channel()];
    const storage = {
      getChannels: () => channels,
      getModels: () => models,
      getApiKey: async () => undefined,
      saveModels: async (value: typeof models) => { models = value; },
      saveChannels: async (value: typeof channels) => { channels = value; },
      updateModels: async (update: (value: typeof models) => typeof models) => { models = update(models); return models; },
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: 'kept' }, { id: 'new' }, { id: 'back' }] }), { status: 200 })));
    const result = await new CatalogService(storage as any).refreshChannel('channel-1');
    expect(result.change).toMatchObject({ initialized: false, added: ['new'], removed: ['removed'], reappeared: ['back'] });
    expect(models.find((item) => item.id === 'kept')).toMatchObject({
      providerId: createModelProviderId(channel(), 'kept'),
      customAlias: '保留别名',
      enabled: true,
      catalogMetadata: {
        protocol: 'openai',
        maxInputTokens: 128_000,
        maxOutputTokens: 8_192,
        toolCalling: false,
      },
    });
    expect(models.find((item) => item.id === 'new')).toMatchObject({ enabled: false, available: true });
    expect(models.find((item) => item.id === 'removed')).toMatchObject({ providerId: 'stable-removed', available: false });
    expect(models.find((item) => item.id === 'back')).toMatchObject({ providerId: createModelProviderId(channel(), 'back'), enabled: true, available: true });
  });

  it('合法空目录会将已有模型标记为不可用', async () => {
    let models = [model({ id: 'removed', available: true })];
    let channels = [channel()];
    const storage = {
      getChannels: () => channels,
      getModels: () => models,
      getApiKey: async () => undefined,
      updateModels: async (update: (value: typeof models) => typeof models) => { models = update(models); return models; },
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const result = await new CatalogService(storage as any).refreshChannel('channel-1');
    expect(result.change.removed).toEqual(['removed']);
    expect(models[0]?.available).toBe(false);
  });

  it('刷新时更新目录基线并保留用户覆盖的元数据', async () => {
    let models = [model({
      id: 'kept',
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
    let channels = [channel()];
    const storage = {
      getChannels: () => channels,
      getModels: () => models,
      getApiKey: async () => undefined,
      updateModels: async (update: (value: typeof models) => typeof models) => { models = update(models); return models; },
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'kept', limits: { context: 200_000, output: 16_000 }, capabilities: { tools: true } }],
    }), { status: 200 })));
    await new CatalogService(storage as any).refreshChannel('channel-1');
    expect(models[0]).toMatchObject({
      metadataOverridden: true,
      protocol: 'openai',
      maxInputTokens: 64_000,
      catalogMetadata: {
        protocol: 'openai',
        maxInputTokens: 200_000,
        maxOutputTokens: 16_000,
        toolCalling: true,
      },
    });
  });

  it('汇总全渠道刷新失败而不是静默丢弃', async () => {
    let channels = [channel()];
    let models: ReturnType<typeof model>[] = [];
    const storage = {
      getChannels: () => channels,
      getModels: () => models,
      getApiKey: async () => undefined,
      updateModels: async (update: (value: typeof models) => typeof models) => { models = update(models); return models; },
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    const summary = await new CatalogService(storage as any).refreshAll();
    expect(summary.changes).toEqual([]);
    expect(summary.failures).toEqual([expect.objectContaining({ channelId: 'channel-1', message: '认证失败（HTTP 401）' })]);
  });

  it('渠道在请求期间被删除时丢弃刷新结果', async () => {
    let channels = [channel()];
    let models: ReturnType<typeof model>[] = [];
    let resolveFetch!: (response: Response) => void;
    const storage = {
      getChannels: () => channels,
      getModels: () => models,
      getApiKey: async () => undefined,
      updateModels: async (update: (value: typeof models) => typeof models) => { models = update(models); return models; },
      updateChannels: async (update: (value: typeof channels) => typeof channels) => { channels = update(channels); return channels; },
    };
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const refresh = new CatalogService(storage as any).refreshChannel('channel-1');
    await Promise.resolve();
    channels = [];
    resolveFetch(new Response(JSON.stringify({ data: [{ id: 'late' }] }), { status: 200 }));
    await expect(refresh).rejects.toMatchObject({ category: 'cancelled' });
    expect(models).toEqual([]);
  });
});
