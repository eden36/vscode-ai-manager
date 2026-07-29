import type { ChannelConfig, ChannelPreset } from './types';

export const PRESET_VALUES: Record<ChannelPreset, Pick<ChannelConfig, 'baseUrl' | 'modelsPath' | 'chatPath'>> = {
  custom: {
    baseUrl: '',
    modelsPath: '/v1/models',
    chatPath: '/v1/chat/completions',
  },
  'opencode-go': {
    baseUrl: 'https://opencode.ai',
    modelsPath: '/zen/go/v1/models',
    chatPath: '/zen/go/v1/chat/completions',
  },
  'opencode-console': {
    baseUrl: 'https://console.opencode.ai',
    modelsPath: '/inference/openai/v1/models',
    chatPath: '/inference/openai/v1/chat/completions',
  },
};

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
