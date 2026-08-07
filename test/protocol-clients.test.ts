import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class TextPart { constructor(readonly value: string) {} }
  class ToolCallPart { constructor(readonly callId: string, readonly name: string, readonly input: object) {} }
  class ToolResultPart { constructor(readonly callId: string, readonly content: readonly unknown[]) {} }
  class DataPart {
    constructor(readonly data: Uint8Array, readonly mimeType: string) {}
    static json(value: unknown, mimeType = 'application/json') { return new DataPart(new TextEncoder().encode(JSON.stringify(value)), mimeType); }
  }
  return {
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelDataPart: DataPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  };
});

import * as vscode from 'vscode';
import { apiKeyHeaders, isOpenCodeHostname, usesAnthropicApiKeyAuth, usesGoogleApiKeyAuth } from '../src/protocol-http';
import { AnthropicClient, convertAnthropicMessages } from '../src/anthropic-client';
import { convertGeminiMessages, GeminiClient } from '../src/gemini-client';
import { convertResponsesMessages, ResponsesClient } from '../src/responses-client';
import { channel, model } from './fixtures';

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

function eventResponse(events: Array<{ event?: string; data: unknown }>): Response {
  return new Response(events.map(({ event, data }) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join(''), { status: 200 });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('protocol-http auth', () => {
  it('仅匹配 opencode.ai 及其子域', () => {
    expect(isOpenCodeHostname('opencode.ai')).toBe(true);
    expect(isOpenCodeHostname('console.opencode.ai')).toBe(true);
    expect(isOpenCodeHostname('evilopencode.ai')).toBe(false);
    expect(isOpenCodeHostname('notopencode.ai')).toBe(false);
  });

  it('自定义渠道仅在 OpenCode 主机名上使用协议专用认证头', () => {
    const opencodeHost = channel({ preset: 'custom', baseUrl: 'https://console.opencode.ai' });
    const otherHost = channel({ preset: 'custom', baseUrl: 'https://evilopencode.ai' });
    expect(usesAnthropicApiKeyAuth(opencodeHost)).toBe(true);
    expect(usesGoogleApiKeyAuth(opencodeHost)).toBe(true);
    expect(usesAnthropicApiKeyAuth(otherHost)).toBe(false);
    expect(usesGoogleApiKeyAuth(otherHost)).toBe(false);
    expect(apiKeyHeaders(otherHost, 'secret', 'anthropic')).toEqual({ Authorization: 'Bearer secret' });
  });
});

describe('AnthropicClient', () => {
  it('OpenCode Go 的 Anthropic 端点使用 x-api-key 认证', () => {
    expect(apiKeyHeaders(channel({ preset: 'opencode-go' }), 'secret', 'anthropic')).toEqual({
      'x-api-key': 'secret',
      'anthropic-version': '2023-06-01',
    });
    expect(apiKeyHeaders(channel({ preset: 'opencode-go' }), 'secret', 'openai')).toEqual({
      Authorization: 'Bearer secret',
    });
    expect(apiKeyHeaders(channel({ preset: 'opencode-go' }), 'secret', 'gemini')).toEqual({
      'x-goog-api-key': 'secret',
    });
  });

  it('转换消息并解析文本和流式工具调用', async () => {
    const target = { channel: channel({ preset: 'opencode-go', anthropicPath: '/zen/go/v1/messages' }), model: model({ protocol: 'anthropic' }) };
    const fetchMock = vi.fn().mockResolvedValue(eventResponse([
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'read_file' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } } },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const parts: unknown[] = [];
    await new AnthropicClient().streamChat(target, 'secret', [{ role: 1, name: undefined, content: [new vscode.LanguageModelTextPart('hi')] } as any], { tools: [{ name: 'read_file', description: '读取', inputSchema: {} }] } as any, { report: (part) => parts.push(part) }, token as any);
    expect(parts).toEqual([expect.objectContaining({ value: '你好' }), expect.objectContaining({ callId: 'call-1', name: 'read_file', input: { path: 'README.md' } })]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.com/zen/go/v1/messages');
    expect((init.headers as Record<string, string>)).toMatchObject({ 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('将工具调用和结果转换为 Messages 内容块', () => {
    const result = convertAnthropicMessages([
      { role: 2, content: [new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a' })] } as any,
      { role: 1, content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('ok')])] } as any,
    ]);
    expect(result.messages).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
    ]);
  });

  it('将 System 角色消息提取到 system 字段', () => {
    const result = convertAnthropicMessages([
      { role: 3, content: [new vscode.LanguageModelTextPart('你是提交信息助手')] } as any,
      { role: 1, content: [new vscode.LanguageModelTextPart('生成提交说明')] } as any,
    ]);
    expect(result.system).toBe('你是提交信息助手');
    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '生成提交说明' }] },
    ]);
  });
});

describe('ResponsesClient', () => {
  it('调用 Responses 端点并解析文本与流式工具调用', async () => {
    const target = { channel: channel({ preset: 'opencode-go', responsesPath: '/zen/go/v1/responses' }), model: model({ id: 'grok-4.5', protocol: 'responses' }) };
    const fetchMock = vi.fn().mockResolvedValue(eventResponse([
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '你好' } },
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read_file' } } },
      { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"path":"README.md"}' } },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const parts: unknown[] = [];
    await new ResponsesClient().streamChat(target, 'secret', [{ role: 1, name: undefined, content: [new vscode.LanguageModelTextPart('hi')] } as any], { tools: [{ name: 'read_file', description: '读取', inputSchema: {} }] } as any, { report: (part) => parts.push(part) }, token as any);
    expect(parts).toEqual([
      expect.objectContaining({ value: '你好' }),
      expect.objectContaining({ callId: 'call-1', name: 'read_file', input: { path: 'README.md' } }),
    ]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.com/zen/go/v1/responses');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'grok-4.5', stream: true, max_output_tokens: 8_192 });
    expect(body.tools).toEqual([{ type: 'function', name: 'read_file', description: '读取', parameters: { type: 'object', properties: {} } }]);
  });

  it('把 System 消息提取为 instructions，工具调用与结果转成独立条目', () => {
    const result = convertResponsesMessages([
      { role: 3, content: [new vscode.LanguageModelTextPart('你是助手')] } as any,
      { role: 2, content: [new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a' })] } as any,
      { role: 1, content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('ok')])] } as any,
      { role: 1, content: [new vscode.LanguageModelTextPart('继续')] } as any,
    ]);
    expect(result.instructions).toBe('你是助手');
    expect(result.input).toEqual([
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'ok' },
      { role: 'user', content: [{ type: 'input_text', text: '继续' }] },
    ]);
  });
});

describe('GeminiClient', () => {
  it('OpenCode 的 Gemini 端点使用 x-goog-api-key 认证', () => {
    expect(apiKeyHeaders(channel({ preset: 'opencode-go', geminiPath: '/zen/v1beta/models/{model}:streamGenerateContent?alt=sse' }), 'secret', 'gemini')).toEqual({
      'x-goog-api-key': 'secret',
    });
    expect(apiKeyHeaders(channel({ preset: 'opencode-go' }), 'secret', 'openai')).toEqual({
      Authorization: 'Bearer secret',
    });
  });

  it('解析文本、工具调用并输出可往返的思考签名', async () => {
    const target = { channel: channel({ authMode: 'google-api-key' }), model: model({ id: 'gemini-test', protocol: 'gemini' }) };
    const fetchMock = vi.fn().mockResolvedValue(eventResponse([{ data: { candidates: [{ content: { parts: [
      { text: '完成' },
      { functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'signature-1' },
    ] } }] } }]));
    vi.stubGlobal('fetch', fetchMock);
    const parts: any[] = [];
    await new GeminiClient().streamChat(target, 'secret', [{ role: 1, name: undefined, content: [new vscode.LanguageModelTextPart('hi')] } as any], {} as any, { report: (part) => parts.push(part) }, token as any);
    expect(parts[0]).toMatchObject({ value: '完成' });
    expect(parts[1]).toMatchObject({ name: 'read_file', input: { path: 'README.md' } });
    const converted = convertGeminiMessages([{ role: 2, content: [parts[1], parts[2]] } as any]);
    expect(converted.contents[0]?.parts[0]).toMatchObject({ functionCall: { name: 'read_file' }, thoughtSignature: 'signature-1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
  });

  it('将工具结果关联回函数名', () => {
    const result = convertGeminiMessages([
      { role: 2, content: [new vscode.LanguageModelToolCallPart('call-1', 'read_file', {})] } as any,
      { role: 1, content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('ok')])] } as any,
    ]);
    expect(result.contents[1]?.parts[0]).toEqual({ functionResponse: { name: 'read_file', response: { result: 'ok' } } });
  });

  it('将 System 角色消息提取到 systemInstruction', () => {
    const result = convertGeminiMessages([
      { role: 3, content: [new vscode.LanguageModelTextPart('你是提交信息助手')] } as any,
      { role: 1, content: [new vscode.LanguageModelTextPart('生成提交说明')] } as any,
    ]);
    expect(result.systemInstruction).toEqual({ parts: [{ text: '你是提交信息助手' }] });
    expect(result.contents).toEqual([{ role: 'user', parts: [{ text: '生成提交说明' }] }]);
  });
});
