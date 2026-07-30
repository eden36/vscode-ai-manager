import * as vscode from 'vscode';
import { classifyHttpError, RequestError } from './errors';
import { apiKeyHeaders, createRequestControl, parseSseEvent, protocolUrl } from './protocol-http';
import type { ResolvedCandidate } from './types';
import type { StreamResult } from './openai-client';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: object }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export function convertAnthropicMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const converted: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = [];
  for (const message of messages) {
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user';
    const content: AnthropicBlock[] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart && part.value) content.push({ type: 'text', text: part.value });
      else if (part instanceof vscode.LanguageModelToolCallPart) content.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input });
      else if (part instanceof vscode.LanguageModelToolResultPart) {
        const text = part.content.map((item) => item instanceof vscode.LanguageModelTextPart ? item.value : JSON.stringify(item)).join('');
        content.push({ type: 'tool_result', tool_use_id: part.callId, content: text });
      }
    }
    if (!content.length) continue;
    const previous = converted.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else converted.push({ role, content });
  }
  return converted;
}

export class AnthropicClient {
  async streamChat(target: ResolvedCandidate, apiKey: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<StreamResult> {
    const tools = options.tools?.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema ?? {} }));
    return streamAnthropicRequest(target, apiKey, {
      model: target.model.id,
      max_tokens: target.model.maxOutputTokens,
      messages: convertAnthropicMessages(messages),
      stream: true,
      ...(tools?.length ? { tools, tool_choice: { type: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'any' : 'auto' } } : {}),
    }, progress, token);
  }
}

async function streamAnthropicRequest(target: ResolvedCandidate, apiKey: string | undefined, body: object, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<StreamResult> {
  const request = createRequestControl(target.channel.timeoutMs, token);
  let responseStarted = false;
  let streamed = false;
  try {
    const response = await fetch(protocolUrl(target, 'anthropic'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'anthropic-version': '2023-06-01', ...apiKeyHeaders(target.channel, apiKey) },
      body: JSON.stringify(body), signal: request.controller.signal,
    });
    request.armTimeout();
    if (!response.ok) throw classifyHttpError(response.status);
    if (!response.body) throw new RequestError('渠道未返回响应流', 'network');
    const calls = new Map<number, { id: string; name: string; json: string }>();
    const consume = (raw: string): void => {
      const parsedEvent = parseSseEvent(raw);
      if (!parsedEvent) return;
      let payload: any;
      try { payload = JSON.parse(parsedEvent.data); } catch { throw new RequestError('渠道返回了无效的 Anthropic SSE 数据', 'network', undefined, false, responseStarted); }
      if (parsedEvent.event === 'error' || payload.type === 'error') throw new RequestError('渠道在响应流中返回错误', 'server', undefined, false, responseStarted);
      if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
        responseStarted = true;
        const initialInput = payload.content_block.input && Object.keys(payload.content_block.input).length
          ? JSON.stringify(payload.content_block.input)
          : '';
        calls.set(payload.index, { id: payload.content_block.id ?? crypto.randomUUID(), name: payload.content_block.name ?? '', json: initialInput });
      }
      const delta = payload.type === 'content_block_delta' ? payload.delta : undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
        responseStarted = streamed = true;
        progress.report(new vscode.LanguageModelTextPart(delta.text));
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        responseStarted = true;
        const call = calls.get(payload.index);
        if (call) call.json += delta.partial_json;
      }
    };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      request.armTimeout(); buffer += decoder.decode(read.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() ?? '';
      for (const event of events) consume(event);
    }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
    for (const call of calls.values()) {
      if (!call.name) throw new RequestError('模型返回了缺少名称的工具调用', 'invalid-request', undefined, false, responseStarted);
      let input: object;
      try { input = call.json ? JSON.parse(call.json) : {}; } catch { throw new RequestError('模型返回了无效的工具调用参数', 'invalid-request', undefined, false, responseStarted); }
      streamed = true; progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, input));
    }
    return { streamed };
  } catch (error) {
    if (error instanceof RequestError) throw responseStarted && !error.responseStarted ? new RequestError(error.message, error.category, error.status, error.retryable, true) : error;
    if (error instanceof Error && error.name === 'AbortError') throw new RequestError(token.isCancellationRequested && !request.wasTimedOut() ? '请求已取消' : '请求超时', token.isCancellationRequested && !request.wasTimedOut() ? 'cancelled' : 'timeout', undefined, !token.isCancellationRequested, responseStarted);
    throw new RequestError('无法连接到渠道', 'network', undefined, true, responseStarted);
  } finally { request.dispose(); }
}
