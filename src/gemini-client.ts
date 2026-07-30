import * as vscode from 'vscode';
import { classifyHttpError, RequestError } from './errors';
import type { StreamResult } from './openai-client';
import { apiKeyHeaders, createRequestControl, parseSseEvent, protocolUrl } from './protocol-http';
import type { ResolvedCandidate } from './types';

const SIGNATURE_MIME = 'application/vnd.ai-manager.gemini-tool-signature+json';

interface GeminiPart { text?: string; functionCall?: { name: string; args: object }; functionResponse?: { name: string; response: object }; thoughtSignature?: string }

export function convertGeminiMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> {
  const callNames = new Map<string, string>();
  for (const message of messages) for (const part of message.content) if (part instanceof vscode.LanguageModelToolCallPart) callNames.set(part.callId, part.name);
  const result: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = [];
  for (const message of messages) {
    const role = message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'model' : 'user';
    const signatures = new Map<string, string>();
    for (const part of message.content) {
      if (!(part instanceof vscode.LanguageModelDataPart) || part.mimeType !== SIGNATURE_MIME) continue;
      try {
        const value = JSON.parse(new TextDecoder().decode(part.data));
        if (typeof value.callId === 'string' && typeof value.signature === 'string') signatures.set(value.callId, value.signature);
      } catch { /* 忽略无效的内部元数据。 */ }
    }
    const parts: GeminiPart[] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart && part.value) parts.push({ text: part.value });
      else if (part instanceof vscode.LanguageModelToolCallPart) parts.push({ functionCall: { name: part.name, args: part.input }, ...(signatures.get(part.callId) ? { thoughtSignature: signatures.get(part.callId) } : {}) });
      else if (part instanceof vscode.LanguageModelToolResultPart) {
        const text = part.content.map((item) => item instanceof vscode.LanguageModelTextPart ? item.value : JSON.stringify(item)).join('');
        parts.push({ functionResponse: { name: callNames.get(part.callId) ?? part.callId, response: { result: text } } });
      }
    }
    if (!parts.length) continue;
    const previous = result.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else result.push({ role, parts });
  }
  return result;
}

export class GeminiClient {
  async streamChat(target: ResolvedCandidate, apiKey: string | undefined, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<StreamResult> {
    const declarations = options.tools?.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema ?? {} }));
    const body = {
      contents: convertGeminiMessages(messages),
      generationConfig: { maxOutputTokens: target.model.maxOutputTokens },
      ...(declarations?.length ? {
        tools: [{ functionDeclarations: declarations }],
        toolConfig: { functionCallingConfig: { mode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'ANY' : 'AUTO' } },
      } : {}),
    };
    return streamGeminiRequest(target, apiKey, body, progress, token);
  }
}

async function streamGeminiRequest(target: ResolvedCandidate, apiKey: string | undefined, body: object, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<StreamResult> {
  const request = createRequestControl(target.channel.timeoutMs, token);
  let responseStarted = false;
  let streamed = false;
  try {
    const response = await fetch(protocolUrl(target, 'gemini'), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...apiKeyHeaders(target.channel, apiKey) }, body: JSON.stringify(body), signal: request.controller.signal });
    request.armTimeout();
    if (!response.ok) throw classifyHttpError(response.status);
    if (!response.body) throw new RequestError('渠道未返回响应流', 'network');
    const seenCalls = new Set<string>();
    const consume = (raw: string): void => {
      const event = parseSseEvent(raw);
      if (!event || event.data === '[DONE]') return;
      let payload: any;
      try { payload = JSON.parse(event.data); } catch { throw new RequestError('渠道返回了无效的 Gemini SSE 数据', 'network', undefined, false, responseStarted); }
      if (payload.error) throw new RequestError('渠道在响应流中返回错误', 'server', undefined, false, responseStarted);
      for (const [candidateIndex, candidate] of (payload.candidates ?? []).entries()) {
        for (const [partIndex, part] of (candidate.content?.parts ?? []).entries()) {
          if (typeof part.text === 'string' && part.text) { responseStarted = streamed = true; progress.report(new vscode.LanguageModelTextPart(part.text)); }
          if (part.functionCall?.name) {
            const signature = String(part.thoughtSignature ?? '');
            const key = `${candidateIndex}:${partIndex}:${part.functionCall.name}:${JSON.stringify(part.functionCall.args ?? {})}:${signature}`;
            if (seenCalls.has(key)) continue;
            seenCalls.add(key); responseStarted = streamed = true;
            const callId = crypto.randomUUID();
            progress.report(new vscode.LanguageModelToolCallPart(callId, part.functionCall.name, part.functionCall.args ?? {}));
            if (signature) progress.report(vscode.LanguageModelDataPart.json({ callId, signature }, SIGNATURE_MIME));
          }
        }
      }
    };
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const read = await reader.read(); if (read.done) break;
      request.armTimeout(); buffer += decoder.decode(read.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() ?? '';
      for (const event of events) consume(event);
    }
    buffer += decoder.decode(); if (buffer.trim()) consume(buffer);
    return { streamed };
  } catch (error) {
    if (error instanceof RequestError) throw responseStarted && !error.responseStarted ? new RequestError(error.message, error.category, error.status, error.retryable, true) : error;
    if (error instanceof Error && error.name === 'AbortError') throw new RequestError(token.isCancellationRequested && !request.wasTimedOut() ? '请求已取消' : '请求超时', token.isCancellationRequested && !request.wasTimedOut() ? 'cancelled' : 'timeout', undefined, !token.isCancellationRequested, responseStarted);
    throw new RequestError('无法连接到渠道', 'network', undefined, true, responseStarted);
  } finally { request.dispose(); }
}
