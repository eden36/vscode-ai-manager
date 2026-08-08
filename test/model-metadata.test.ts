import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchModelMetadata, resetModelMetadataCache } from '../src/model-metadata';
import { channel } from './fixtures';

const payload = {
  'opencode-go': {
    npm: '@ai-sdk/openai-compatible',
    api: 'https://opencode.ai/zen/go/v1',
    models: {
      'glm-5.2': { reasoning_options: [{ type: 'effort', values: ['high', 'max', 'high', 'turbo', 1] }] },
      'grok-4.5': { provider: { npm: '@ai-sdk/openai' }, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] },
      'minimax-m3': { provider: { npm: '@ai-sdk/anthropic' }, reasoning_options: [{ type: 'toggle', values: ['low'] }] },
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

beforeEach(() => resetModelMetadataCache());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('fetchModelMetadata', () => {
  it('拉取失败时返回 undefined，不抛出异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect(await fetchModelMetadata(goChannel, 5_000)).toBeUndefined();
  });

  it('按模型级 AI SDK 包名映射协议，缺省时用 provider 级包名', async () => {
    stubFetch();
    const result = await fetchModelMetadata(goChannel, 5_000);
    expect(result?.get('grok-4.5')?.protocol).toBe('responses');
    expect(result?.get('minimax-m3')?.protocol).toBe('anthropic');
    expect(result?.get('gemini-3-flash')?.protocol).toBe('gemini');
    expect(result?.get('glm-5.2')?.protocol).toBe('openai');
  });

  it('仅保留明确声明且受支持的 effort 档位，并去重保持顺序', async () => {
    stubFetch();
    const result = await fetchModelMetadata(goChannel, 5_000);
    expect(result?.get('glm-5.2')?.reasoningEfforts).toEqual(['high', 'max']);
    expect(result?.get('grok-4.5')?.reasoningEfforts).toEqual(['low', 'medium', 'high']);
    expect(result?.get('minimax-m3')?.reasoningEfforts).toBeUndefined();
    expect(result?.get('gemini-3-flash')?.reasoningEfforts).toBeUndefined();
  });

  it('命中缓存后不再重复请求元数据', async () => {
    const fetchMock = stubFetch();
    await fetchModelMetadata(goChannel, 5_000);
    await fetchModelMetadata(goChannel, 5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('渠道端点匹配不到 provider 时返回 undefined', async () => {
    stubFetch();
    expect(await fetchModelMetadata(channel({ baseUrl: 'https://api.example.com' }), 5_000)).toBeUndefined();
  });
});
