import * as vscode from 'vscode';
import { classifyHttpError, RequestError } from './errors';
import { joinEndpoint } from './catalog';
import type { ResolvedCandidate } from './types';
import { apiKeyHeaders, createRequestControl } from './protocol-http';

interface OpenAIMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

interface PendingToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamResult {
  streamed: boolean;
}

function textValue(part: unknown): string | undefined {
  return part instanceof vscode.LanguageModelTextPart ? part.value : undefined;
}

export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (const message of messages) {
    const text = message.content.map(textValue).filter((value): value is string => value !== undefined).join('');
    const toolResults = message.content.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart);
    for (const toolResult of toolResults) {
      const content = (toolResult.content ?? []).map((part) => textValue(part) ?? JSON.stringify(part)).join('');
      result.push({ role: 'tool', tool_call_id: toolResult.callId ?? '', content });
    }
    const toolCalls = message.content.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      result.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 ? {
          tool_calls: toolCalls.map((call) => ({
            id: call.callId ?? crypto.randomUUID(),
            type: 'function' as const,
            function: { name: call.name ?? '', arguments: JSON.stringify(call.input ?? {}) },
          })),
        } : {}),
      });
    } else if (text) {
      result.push({ role: 'user', content: text });
    }
  }
  return result;
}

export class OpenAIClient {
  async streamChat(
    target: ResolvedCandidate,
    apiKey: string | undefined,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<StreamResult> {
    const request = createRequestControl(target.channel.timeoutMs, token);
    let streamed = false;
    let responseStarted = false;
    try {
      const tools = options.tools?.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? {} },
      }));
      const response = await fetch(joinEndpoint(target.channel.baseUrl, target.channel.chatPath), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...apiKeyHeaders(target.channel, apiKey),
        },
        body: JSON.stringify({
          model: target.model.id,
          messages: convertMessages(messages),
          stream: true,
          ...(tools && tools.length > 0 ? {
            tools,
            tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
          } : {}),
        }),
        signal: request.controller.signal,
      });
      request.armTimeout();
      if (!response.ok) {
        if (response.status === 400) {
          const errorCode = await response.clone().json().then((payload: any) => String(payload?.error?.code ?? payload?.error?.type ?? '')).catch(() => '');
          if (/model.*(not.*found|invalid|unavailable)/i.test(errorCode)) {
            throw new RequestError('模型不可用（HTTP 400）', 'model-unavailable', 400, true);
          }
        }
        throw classifyHttpError(response.status);
      }
      if (!response.body) throw new RequestError('渠道未返回响应流', 'network');

      const pending = new Map<number, PendingToolCall>();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consumeEvent = (event: string): void => {
        const data = event.split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
          .trim();
        if (!data || data === '[DONE]') return;
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new RequestError('渠道返回了无效的 SSE 数据', 'network', undefined, false, responseStarted);
        }
        if (parsed?.error) throw new RequestError('渠道在响应流中返回错误', 'server', undefined, false, responseStarted);
        const delta = parsed.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          responseStarted = true;
          streamed = true;
          progress.report(new vscode.LanguageModelTextPart(delta.content));
        }
        for (const call of delta?.tool_calls ?? []) {
          responseStarted = true;
          const index = typeof call.index === 'number' ? call.index : pending.size;
          const current = pending.get(index) ?? { id: '', name: '', arguments: '' };
          if (typeof call.id === 'string') current.id = mergeDelta(current.id, call.id);
          if (typeof call.function?.name === 'string') current.name = mergeDelta(current.name, call.function.name);
          if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments;
          pending.set(index, current);
        }
      };
      while (true) {
        const read = await reader.read();
        if (read.done) break;
        request.armTimeout();
        buffer += decoder.decode(read.value, { stream: true });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? '';
        for (const event of events) consumeEvent(event);
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeEvent(buffer);
      for (const call of pending.values()) {
        if (!call.name) throw new RequestError('模型返回了缺少名称的工具调用', 'invalid-request', undefined, false, responseStarted);
        let input: object = {};
        try {
          input = call.arguments ? JSON.parse(call.arguments) : {};
        } catch {
          throw new RequestError('模型返回了无效的工具调用参数', 'invalid-request');
        }
        streamed = true;
        progress.report(new vscode.LanguageModelToolCallPart(call.id || crypto.randomUUID(), call.name, input));
      }
      return { streamed };
    } catch (error) {
      if (error instanceof RequestError) {
        throw responseStarted && !error.responseStarted
          ? new RequestError(error.message, error.category, error.status, error.retryable, true)
          : error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        if (token.isCancellationRequested && !request.wasTimedOut()) throw new RequestError('请求已取消', 'cancelled', undefined, false, responseStarted);
        throw new RequestError('请求超时', 'timeout', undefined, true, responseStarted);
      }
      throw new RequestError('无法连接到渠道', 'network', undefined, true, responseStarted);
    } finally {
      request.dispose();
    }
  }
}

function mergeDelta(current: string, delta: string): string {
  if (!current) return delta;
  return delta.startsWith(current) ? delta : `${current}${delta}`;
}
