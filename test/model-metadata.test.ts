import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchModelProtocols, resetModelProtocolCache } from '../src/model-metadata';
import { channel } from './fixtures';

const payload = {
  'opencode-go': {
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/zen/go/v1',
    models: {
      'glm-5.2': {},
      'grok-4.5': { provider: { npm: '@ai-sdk/openai' } },
      'minimax-m3': { provider: { npm: '@ai-sdk/anthropic' } },
      'gemini-3-flash': { provider: { npm: '@ai-sdk/google' } },
    },
  },
};

const goChannel = channel({ baseUrl: 'https://opencode.ai', chatPath: '/zen/go/v1/chat/completions' });

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => resetModelProtocolCache());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('fetchModelProtocols', () => {
  it('拉取失败时返回 undefined，不抛出异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await fetchModelProtocols(goChannel, 5_000)).toBeUndefined();
  });

  it('按模型级 AI SDK 包名映射协议，缺省时用 provider 级包名', async () => {
    stubFetch();
    const result = await fetchModelProtocols(goChannel, 5_000);
    expect(result?.get('grok-4.5')).toBe('responses');
    expect(result?.get('minimax-m3')).toBe('anthropic');
    expect(result?.get('gemini-3-flash')).toBe('gemini');
    expect(result?.get('glm-5.2')).toBe('openai');
  });

  it('命中缓存后不再重复请求元数据', async () => {
    const fetchMock = stubFetch();
    await fetchModelProtocols(goChannel, 5_000);
    await fetchModelProtocols(goChannel, 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('渠道端点匹配不到 provider 时返回 undefined', async () => {
    stubFetch();
    expect(await fetchModelProtocols(channel({ baseUrl: 'https://api.example.com' }), 5_000)).toBeUndefined();
  });
});
