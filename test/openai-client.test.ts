import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class TextPart {
    constructor(readonly value: string) {}
  }
  class ToolCallPart {
    constructor(readonly callId: string, readonly name: string, readonly input: object) {}
  }
  class ToolResultPart {
    constructor(readonly callId: string, readonly content: readonly unknown[]) {}
  }
  return {
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  };
});

import * as vscode from 'vscode';
import { RequestError } from '../src/errors';
import { OpenAIClient } from '../src/openai-client';
import { channel, model } from './fixtures';

const target = { channel: channel(), model: model() };
const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
};

function sseResponse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenAIClient', () => {
  it('解析文本和流式工具调用', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] } }] },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const parts: unknown[] = [];
    await new OpenAIClient().streamChat(
      target,
      'secret-key',
      [{ role: 1, name: undefined, content: [new vscode.LanguageModelTextPart('读取文件')] } as any],
      { tools: [{ name: 'read_file', description: '读取文件', inputSchema: { type: 'object' } }] } as any,
      { report: (part: unknown) => parts.push(part) },
      token as any,
    );
    expect(parts).toEqual([
      expect.objectContaining({ value: '你好' }),
      expect.objectContaining({ callId: 'call-1', name: 'read_file', input: { path: 'README.md' } }),
    ]);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(request.body)).not.toContain('secret-key');
    expect((request.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });

  it('解析没有末尾换行的最后一个 SSE 事件并转发必选工具模式', async () => {
    const response = new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '完成' } }] })}`, { status: 200 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const parts: unknown[] = [];
    await new OpenAIClient().streamChat(
      target,
      undefined,
      [],
      { tools: [{ name: 'read_file', description: '读取文件', inputSchema: {} }], toolMode: vscode.LanguageModelChatToolMode.Required } as any,
      { report: (part: unknown) => parts.push(part) },
      token as any,
    );
    expect(parts).toEqual([expect.objectContaining({ value: '完成' })]);
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({ tool_choice: 'required' });
  });

  it('拒绝无效 SSE JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('data: {broken}\n\n', { status: 200 })));
    await expect(new OpenAIClient().streamChat(target, undefined, [], {} as any, { report: () => undefined }, token as any))
      .rejects.toMatchObject({ category: 'network' });
  });

  it('将 429 标记为可降级错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    await expect(new OpenAIClient().streamChat(target, undefined, [], {} as any, { report: () => undefined }, token as any))
      .rejects.toMatchObject({ category: 'rate-limit', retryable: true, responseStarted: false });
  });

  it('识别 HTTP 400 中的模型不存在错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'model_not_found' } }), { status: 400 })));
    await expect(new OpenAIClient().streamChat(target, undefined, [], {} as any, { report: () => undefined }, token as any))
      .rejects.toMatchObject({ category: 'model-unavailable', retryable: true });
  });

  it('流式输出后发生错误时设置 responseStarted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: '已输出' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'broken', arguments: '{' } }] } }] },
    ])));
    try {
      await new OpenAIClient().streamChat(target, undefined, [], {} as any, { report: () => undefined }, token as any);
      throw new Error('预期请求失败');
    } catch (error) {
      expect(error).toBeInstanceOf(RequestError);
      expect(error).toMatchObject({ responseStarted: true });
    }
  });
});
