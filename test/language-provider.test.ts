import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class TextPart { constructor(readonly value: string) {} }
  class ToolCallPart { constructor(readonly callId: string, readonly name: string, readonly input: object) {} }
  class ToolResultPart { constructor(readonly callId: string, readonly content: readonly unknown[]) {} }
  class EventEmitter {
    event = (): { dispose: () => void } => ({ dispose: () => undefined });
    fire(): void {}
    dispose(): void {}
  }
  return {
    EventEmitter,
    window: { showErrorMessage: vi.fn() },
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  };
});

import * as vscode from 'vscode';
import { AiManagerLanguageProvider } from '../src/language-provider';
import { channel, model } from './fixtures';

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
const messages = [{ role: 1, name: undefined, content: [new vscode.LanguageModelTextPart('hi')] }];

/** 每次调用都要返回新的 Response，响应体只能被读取一次。 */
function routedFetch(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    const factory = routes[url];
    if (!factory) throw new Error(`未预期的请求：${url}`);
    return Promise.resolve(factory());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const failure = (status: number) => (): Response => new Response('', { status });
const openaiSuccess = (): Response => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: '你好' } }] })}\n\ndata: [DONE]\n\n`,
  { status: 200 },
);
const responsesSuccess = (): Response => new Response(
  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你好' })}\n\n`,
  { status: 200 },
);
const anthropicSuccess = (): Response => new Response(
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } })}\n\n`,
  { status: 200 },
);

const CHAT_URL = 'https://example.com/v1/chat/completions';
const RESPONSES_URL = 'https://example.com/v1/responses';
const ANTHROPIC_URL = 'https://example.com/v1/messages';

function createProvider(overrides: Partial<ReturnType<typeof model>> = {}) {
  const target = model({ providerId: 'provider-1', protocol: 'openai', ...overrides });
  const app = {
    onDidChange: () => ({ dispose: () => undefined }),
    storage: {
      getModels: () => [target],
      getChannels: () => [channel()],
      getApiKey: async () => 'secret',
    },
    applyDetectedProtocol: vi.fn(async () => undefined),
  };
  const provider = new AiManagerLanguageProvider(app as any, { appendLine: vi.fn() } as any);
  return { provider, app };
}

function respond(provider: AiManagerLanguageProvider): Promise<void> {
  return provider.provideLanguageModelChatResponse(
    { id: 'provider-1' } as any,
    messages as any,
    { tools: [] } as any,
    { report: () => undefined },
    token as any,
  );
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('模型配置', () => {
  it('仅为声明 effort 档位的模型提供原生下拉配置', () => {
    const { provider } = createProvider({ reasoningEfforts: ['max'] });
    const information = provider.provideLanguageModelChatInformation({ silent: true } as any, token as any) as any[];
    expect(information[0]?.configurationSchema.properties.reasoningEffort).toMatchObject({
      title: '推理强度',
      enum: ['default', 'max'],
      enumItemLabels: ['default', 'max'],
      default: 'default',
    });

    const withoutEffort = createProvider().provider.provideLanguageModelChatInformation({ silent: true } as any, token as any) as any[];
    expect(withoutEffort[0]?.configurationSchema).toBeUndefined();
  });
});

describe('协议自动回退', () => {
  it('404 遍历其余已配置协议并把结果写回目录', async () => {
    const fetchMock = routedFetch({
      [CHAT_URL]: failure(404),
      [RESPONSES_URL]: failure(404),
      [ANTHROPIC_URL]: anthropicSuccess,
    });
    const { provider, app } = createProvider();

    await respond(provider);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([CHAT_URL, RESPONSES_URL, ANTHROPIC_URL]);
    expect(app.applyDetectedProtocol).toHaveBeenCalledWith('channel-1', 'model-1', 'anthropic');
  });

  it('503 只试一个同族协议且不写回目录', async () => {
    const fetchMock = routedFetch({ [CHAT_URL]: failure(503), [RESPONSES_URL]: responsesSuccess });
    const { provider, app } = createProvider();

    await respond(provider);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([CHAT_URL, RESPONSES_URL]);
    expect(app.applyDetectedProtocol).not.toHaveBeenCalled();
  });

  it('同族协议也失败时抛出原始错误且不再继续遍历', async () => {
    const fetchMock = routedFetch({ [CHAT_URL]: failure(503), [RESPONSES_URL]: failure(503) });
    const { provider, app } = createProvider();

    await expect(respond(provider)).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(app.applyDetectedProtocol).not.toHaveBeenCalled();
  });

  it('其他状态码不触发回退', async () => {
    const fetchMock = routedFetch({ [CHAT_URL]: failure(500) });
    const { provider } = createProvider();

    await expect(respond(provider)).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('用户手动覆盖协议后不再自动回退', async () => {
    const fetchMock = routedFetch({ [CHAT_URL]: failure(404) });
    const { provider } = createProvider({ metadataOverridden: true });

    await expect(respond(provider)).rejects.toMatchObject({ status: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('首选协议成功时不发起额外请求', async () => {
    const fetchMock = routedFetch({ [CHAT_URL]: openaiSuccess });
    const { provider } = createProvider();

    await respond(provider);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
