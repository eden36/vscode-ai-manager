import type { ChannelConfig, ChannelPreset } from './types';

type ChannelPresetValues = Pick<ChannelConfig, 'baseUrl' | 'modelsPath' | 'chatPath' | 'anthropicPath' | 'geminiPath' | 'responsesPath' | 'defaultProtocol' | 'authMode'>;

export const CHANNEL_PRESETS = [
  { id: 'custom', label: '通用 OpenAI-compatible', values: {
    baseUrl: '',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    anthropicPath: '/v1/messages',
    geminiPath: '/v1beta/models/{model}:streamGenerateContent?alt=sse',
    responsesPath: '/v1/responses',
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'opencode-go', label: 'OpenCode Go', values: {
    baseUrl: 'https://opencode.ai',
    modelsPath: '/zen/go/v1/models',
    chatPath: '/zen/go/v1/chat/completions',
    anthropicPath: '/zen/go/v1/messages',
    geminiPath: undefined,
    responsesPath: '/zen/go/v1/responses',
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'opencode-console', label: 'OpenCode Console', values: {
    baseUrl: 'https://console.opencode.ai',
    modelsPath: '/inference/openai/v1/models',
    chatPath: '/inference/openai/v1/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: '/inference/openai/v1/responses',
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'openai', label: 'OpenAI', values: {
    baseUrl: 'https://api.openai.com',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: '/v1/responses',
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'anthropic', label: 'Anthropic', values: {
    baseUrl: 'https://api.anthropic.com',
    modelsPath: '/v1/models',
    chatPath: '/v1/messages',
    anthropicPath: '/v1/messages',
    geminiPath: undefined,
    responsesPath: undefined,
    defaultProtocol: 'anthropic',
    authMode: 'anthropic-api-key',
  } },
  { id: 'gemini', label: 'Google Gemini', values: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    modelsPath: '/v1beta/models',
    chatPath: '/v1beta/models/{model}:streamGenerateContent?alt=sse',
    anthropicPath: undefined,
    geminiPath: '/v1beta/models/{model}:streamGenerateContent?alt=sse',
    responsesPath: undefined,
    defaultProtocol: 'gemini',
    authMode: 'google-api-key',
  } },
  { id: 'openrouter', label: 'OpenRouter', values: {
    baseUrl: 'https://openrouter.ai',
    modelsPath: '/api/v1/models',
    chatPath: '/api/v1/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: undefined,
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'deepseek', label: 'DeepSeek', values: {
    baseUrl: 'https://api.deepseek.com',
    modelsPath: '/models',
    chatPath: '/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: undefined,
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'siliconflow', label: 'SiliconFlow（硅基流动）', values: {
    baseUrl: 'https://api.siliconflow.cn',
    modelsPath: '/v1/models?type=text&sub_type=chat',
    chatPath: '/v1/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: undefined,
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'mistral', label: 'Mistral', values: {
    baseUrl: 'https://api.mistral.ai',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: undefined,
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'groq', label: 'Groq', values: {
    baseUrl: 'https://api.groq.com/openai',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: undefined,
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'together', label: 'Together AI', values: {
    baseUrl: 'https://api.together.xyz',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: undefined,
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
  { id: 'xai', label: 'xAI', values: {
    baseUrl: 'https://api.x.ai',
    modelsPath: '/v1/language-models',
    chatPath: '/v1/chat/completions',
    anthropicPath: undefined,
    geminiPath: undefined,
    responsesPath: undefined,
    defaultProtocol: 'openai',
    authMode: 'bearer',
  } },
] as const satisfies readonly { id: ChannelPreset; label: string; values: ChannelPresetValues }[];

export const PRESET_VALUES = Object.fromEntries(
  CHANNEL_PRESETS.map(({ id, values }) => [id, values]),
) as Record<ChannelPreset, ChannelPresetValues>;

export function isChannelPreset(value: unknown): value is ChannelPreset {
  return typeof value === 'string' && CHANNEL_PRESETS.some((preset) => preset.id === value);
}

export function createChannelDefaults(preset: ChannelPreset = 'custom'): Omit<ChannelConfig, 'id' | 'name'> {
  return {
    preset,
    ...PRESET_VALUES[preset],
    enabled: true,
    timeoutMs: 15_000,
    refreshIntervalMinutes: 360,
    defaultMaxInputTokens: 128_000,
    defaultMaxOutputTokens: 8_192,
  };
}

export function normalizeChannel(channel: ChannelConfig): ChannelConfig {
  return { ...(PRESET_VALUES[channel.preset] ?? PRESET_VALUES.custom), ...channel };
}
