import * as vscode from 'vscode';
import { classifyHttpError, readHttpErrorDetail, RequestError } from './errors';
import { apiKeyHeaders, createRequestControl, parseSseEvent, protocolUrl } from './protocol-http';
import type { ResolvedCandidate } from './types';
import { extractMessageText, normalizeMessageRole } from './message-roles';
import type { StreamResult } from './openai-client';
import { openAiToolParameters } from './openai-client';

type ResponsesInputItem =
  | { role: 'user' | 'assistant'; content: Array<{ type: 'input_text' | 'output_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/** Responses API 把系统提示放在顶层 instructions，工具调用与结果是独立条目而非消息角色。 */
export function convertResponsesMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): {
  instructions?: string;
  input: ResponsesInputItem[];
} {
  const input: ResponsesInputItem[] = [];
  const instructions: string[] = [];
  for (const message of messages) {
    const role = normalizeMessageRole(message);
    if (role === 'system') {
      const text = extractMessageText(message);
      if (text) instructions.push(text);
      continue;
    }
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelToolResultPart) {
        const output = part.content.map((item) => item instanceof vscode.LanguageModelTextPart ? item.value : JSON.stringify(item)).join('');
        input.push({ type: 'function_call_output', call_id: part.callId, output });
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        input.push({ type: 'function_call', call_id: part.callId, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
      }
    }
    const text = extractMessageText(message);
    if (!text) continue;
    if (role === 'assistant') input.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
    else input.push({ role: 'user', content: [{ type: 'input_text', text }] });
  }
  return {
    ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
    input,
  };
}

export class ResponsesClient {
  async streamChat(
    target: ResolvedCandidate,
    apiKey: string | undefined,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<StreamResult> {
    const converted = convertResponsesMessages(messages);
    if (converted.input.length === 0) throw new RequestError('请求消息为空', 'invalid-request');
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description ?? tool.name,
      parameters: openAiToolParameters(tool.inputSchema),
    }));
    return streamResponsesRequest(target, apiKey, {
      model: target.model.id,
      input: converted.input,
      stream: true,
      max_output_tokens: target.model.maxOutputTokens,
      ...(converted.instructions ? { instructions: converted.instructions } : {}),
      ...(tools?.length ? {
        tools,
        tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
      } : {}),
    }, progress, token);
  }
}

async function streamResponsesRequest(
  target: ResolvedCandidate,
  apiKey: string | undefined,
  body: object,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  token: vscode.CancellationToken,
): Promise<StreamResult> {
  const request = createRequestControl(target.channel.timeoutMs, token);
  let responseStarted = false;
  let streamed = false;
  try {
    const response = await fetch(protocolUrl(target, 'responses'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...apiKeyHeaders(target.channel, apiKey, 'responses') },
      body: JSON.stringify(body),
      signal: request.controller.signal,
    });
    request.armTimeout();
    if (!response.ok) throw classifyHttpError(response.status, await readHttpErrorDetail(response));
    if (!response.body) throw new RequestError('渠道未返回响应流', 'network');
    const calls = new Map<string, { callId: string; name: string; json: string }>();
    const consume = (raw: string): void => {
      const parsedEvent = parseSseEvent(raw);
      if (!parsedEvent) return;
      let payload: any;
      try { payload = JSON.parse(parsedEvent.data); } catch { throw new RequestError('渠道返回了无效的 Responses SSE 数据', 'network', undefined, false, responseStarted); }
      const type = typeof payload.type === 'string' ? payload.type : parsedEvent.event;
      if (type === 'error' || type === 'response.failed' || payload.error) {
        throw new RequestError('渠道在响应流中返回错误', 'server', undefined, false, responseStarted);
      }
      if (type === 'response.output_text.delta' && typeof payload.delta === 'string' && payload.delta) {
        responseStarted = streamed = true;
        progress.report(new vscode.LanguageModelTextPart(payload.delta));
        return;
      }
      if (type === 'response.output_item.added' && payload.item?.type === 'function_call') {
        responseStarted = true;
        const key = typeof payload.item.id === 'string' ? payload.item.id : String(payload.output_index ?? calls.size);
        calls.set(key, {
          callId: typeof payload.item.call_id === 'string' ? payload.item.call_id : crypto.randomUUID(),
          name: typeof payload.item.name === 'string' ? payload.item.name : '',
          json: typeof payload.item.arguments === 'string' ? payload.item.arguments : '',
        });
        return;
      }
      if (type === 'response.function_call_arguments.delta' && typeof payload.delta === 'string') {
        responseStarted = true;
        const key = typeof payload.item_id === 'string' ? payload.item_id : String(payload.output_index ?? '');
        const call = calls.get(key);
        if (call) call.json += payload.delta;
      }
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      request.armTimeout();
      buffer += decoder.decode(read.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';
      for (const event of events) consume(event);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    for (const call of calls.values()) {
      if (!call.name) throw new RequestError('模型返回了缺少名称的工具调用', 'invalid-request', undefined, false, responseStarted);
      let input: object;
      try { input = call.json ? JSON.parse(call.json) : {}; } catch { throw new RequestError('模型返回了无效的工具调用参数', 'invalid-request', undefined, false, responseStarted); }
      streamed = true;
      progress.report(new vscode.LanguageModelToolCallPart(call.callId, call.name, input));
    }
    return { streamed };
  } catch (error) {
    if (error instanceof RequestError) {
      throw responseStarted && !error.responseStarted
        ? new RequestError(error.message, error.category, error.status, error.retryable, true)
        : error;
    }
    if (error instanceof Error && error.name === 'AbortError') {
      const cancelled = token.isCancellationRequested && !request.wasTimedOut();
      throw new RequestError(cancelled ? '请求已取消' : '请求超时', cancelled ? 'cancelled' : 'timeout', undefined, !cancelled, responseStarted);
    }
    throw new RequestError('无法连接到渠道', 'network', undefined, true, responseStarted);
  } finally {
    request.dispose();
  }
}
