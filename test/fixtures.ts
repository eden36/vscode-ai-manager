import type { CatalogModel, ChannelConfig } from '../src/types';

export function channel(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
  return {
    id: 'channel-1',
    name: '测试渠道',
    preset: 'custom',
    baseUrl: 'https://example.com',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    anthropicPath: '/v1/messages',
    geminiPath: '/v1beta/models/{model}:streamGenerateContent?alt=sse',
    defaultProtocol: 'openai',
    authMode: 'bearer',
    enabled: true,
    timeoutMs: 15_000,
    refreshIntervalMinutes: 360,
    defaultMaxInputTokens: 128_000,
    defaultMaxOutputTokens: 8_192,
    ...overrides,
  };
}

export function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    channelId: 'channel-1',
    id: 'model-1',
    providerId: 'provider-1',
    name: 'Model 1',
    enabled: true,
    catalogOrder: 0,
    protocol: 'openai',
    available: true,
    maxInputTokens: 128_000,
    maxOutputTokens: 8_192,
    toolCalling: true,
    lastSeenAt: 1,
    ...overrides,
  };
}
