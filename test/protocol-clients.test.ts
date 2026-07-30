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
import { AnthropicClient, convertAnthropicMessages } from '../src/anthropic-client';
import { convertGeminiMessages, GeminiClient } from '../src/gemini-client';
import { channel, model } from './fixtures';

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };

function eventResponse(events: Array<{ event?: string; data: unknown }>): Response {
  return new Response(events.map(({ event, data }) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`).join(''), { status: 200 });
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AnthropicClient', () => {
  it('转换消息并解析文本和流式工具调用', async () => {
    const target = { channel: channel({ preset: 'opencode-go', anthropicPath: '/zen/go/v1/messages' }), model: model({ protocol: 'anthropic' }) };
    const fetchMock = vi.fn().mockResolvedValue(eventResponse([
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'read_file' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"README.md"}' } } },
    ]));
    vi.stubGlobal('fetch', fetchMock);
    const parts: unknown[] = [];
    await new AnthropicClient().streamChat(target, 'secret', [], { tools: [{ name: 'read_file', description: '读取', inputSchema: {} }] } as any, { report: (part) => parts.push(part) }, token as any);
    expect(parts).toEqual([expect.objectContaining({ value: '你好' }), expect.objectContaining({ callId: 'call-1', name: 'read_file', input: { path: 'README.md' } })]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.com/zen/go/v1/messages');
    expect((init.headers as Record<string, string>)).toMatchObject({ Authorization: 'Bearer secret', 'anthropic-version': '2023-06-01' });
  });

  it('将工具调用和结果转换为 Messages 内容块', () => {
    const result = convertAnthropicMessages([
      { role: 2, content: [new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a' })] } as any,
      { role: 1, content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('ok')])] } as any,
    ]);
    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
    ]);
  });
});

describe('GeminiClient', () => {
  it('解析文本、工具调用并输出可往返的思考签名', async () => {
    const target = { channel: channel({ authMode: 'google-api-key' }), model: model({ id: 'gemini-test', protocol: 'gemini' }) };
    const fetchMock = vi.fn().mockResolvedValue(eventResponse([{ data: { candidates: [{ content: { parts: [
      { text: '完成' },
      { functionCall: { name: 'read_file', args: { path: 'README.md' } }, thoughtSignature: 'signature-1' },
    ] } }] } }]));
    vi.stubGlobal('fetch', fetchMock);
    const parts: any[] = [];
    await new GeminiClient().streamChat(target, 'secret', [], {} as any, { report: (part) => parts.push(part) }, token as any);
    expect(parts[0]).toMatchObject({ value: '完成' });
    expect(parts[1]).toMatchObject({ name: 'read_file', input: { path: 'README.md' } });
    const converted = convertGeminiMessages([{ role: 2, content: [parts[1], parts[2]] } as any]);
    expect(converted[0]?.parts[0]).toMatchObject({ functionCall: { name: 'read_file' }, thoughtSignature: 'signature-1' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret');
  });

  it('将工具结果关联回函数名', () => {
    const result = convertGeminiMessages([
      { role: 2, content: [new vscode.LanguageModelToolCallPart('call-1', 'read_file', {})] } as any,
      { role: 1, content: [new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('ok')])] } as any,
    ]);
    expect(result[1]?.parts[0]).toEqual({ functionResponse: { name: 'read_file', response: { result: 'ok' } } });
  });
});
