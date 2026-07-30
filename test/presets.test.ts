import { describe, expect, it } from 'vitest';
import { CHANNEL_PRESETS, createChannelDefaults, isChannelPreset, PRESET_VALUES } from '../src/presets';
import type { ChannelPreset } from '../src/types';

const EXPECTED_PRESETS: Array<[
  ChannelPreset,
  string,
  string,
  string,
  'openai' | 'anthropic' | 'gemini',
  'bearer' | 'anthropic-api-key' | 'google-api-key',
]> = [
  ['openai', 'https://api.openai.com', '/v1/models', '/v1/chat/completions', 'openai', 'bearer'],
  ['anthropic', 'https://api.anthropic.com', '/v1/models', '/v1/messages', 'anthropic', 'anthropic-api-key'],
  ['gemini', 'https://generativelanguage.googleapis.com', '/v1beta/models', '/v1beta/models/{model}:streamGenerateContent?alt=sse', 'gemini', 'google-api-key'],
  ['openrouter', 'https://openrouter.ai', '/api/v1/models', '/api/v1/chat/completions', 'openai', 'bearer'],
  ['deepseek', 'https://api.deepseek.com', '/models', '/chat/completions', 'openai', 'bearer'],
  ['siliconflow', 'https://api.siliconflow.cn', '/v1/models?type=text&sub_type=chat', '/v1/chat/completions', 'openai', 'bearer'],
  ['mistral', 'https://api.mistral.ai', '/v1/models', '/v1/chat/completions', 'openai', 'bearer'],
  ['groq', 'https://api.groq.com/openai', '/v1/models', '/v1/chat/completions', 'openai', 'bearer'],
  ['together', 'https://api.together.xyz', '/v1/models', '/v1/chat/completions', 'openai', 'bearer'],
  ['xai', 'https://api.x.ai', '/v1/language-models', '/v1/chat/completions', 'openai', 'bearer'],
];

describe('渠道预设', () => {
  it('按界面顺序提供全部预设', () => {
    expect(CHANNEL_PRESETS.map((preset) => preset.id)).toEqual([
      'custom', 'opencode-go', 'opencode-console', 'openai', 'anthropic', 'gemini', 'openrouter',
      'deepseek', 'siliconflow', 'mistral', 'groq', 'together', 'xai',
    ]);
  });

  it.each(EXPECTED_PRESETS)('为 %s 提供正确默认值', (preset, baseUrl, modelsPath, chatPath, defaultProtocol, authMode) => {
    expect(createChannelDefaults(preset)).toMatchObject({ preset, baseUrl, modelsPath, chatPath, defaultProtocol, authMode });
  });

  it('从同一份元数据生成默认值映射并拒绝未知预设', () => {
    expect(Object.keys(PRESET_VALUES)).toEqual(CHANNEL_PRESETS.map((preset) => preset.id));
    expect(isChannelPreset('deepseek')).toBe(true);
    expect(isChannelPreset('unknown')).toBe(false);
  });
});
