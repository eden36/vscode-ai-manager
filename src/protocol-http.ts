import * as vscode from 'vscode';
import type { ChannelConfig, ModelProtocol, ResolvedCandidate } from './types';
import { getProtocolPath } from './models';

export function apiKeyHeaders(channel: ChannelConfig, apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {};
  if (channel.authMode === 'anthropic-api-key') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  if (channel.authMode === 'google-api-key') return { 'x-goog-api-key': apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

export function protocolUrl(target: ResolvedCandidate, protocol: ModelProtocol): string {
  const path = getProtocolPath(target.channel, protocol);
  if (!path) throw new Error(`渠道未配置 ${protocol} 协议端点`);
  return joinEndpoint(target.channel.baseUrl, protocol === 'gemini'
    ? path.replace('{model}', encodeURIComponent(target.model.id))
    : path);
}

function joinEndpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Base URL 必须是无内嵌凭据的 HTTP 或 HTTPS 地址');
  return new URL(path.replace(/^\/+/, ''), `${url.toString().replace(/\/+$/, '')}/`).toString();
}

export function parseSseEvent(event: string): { event: string; data: string } | undefined {
  const lines = event.split(/\r?\n/);
  const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
  const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
  return data ? { event: name, data } : undefined;
}

export function createRequestControl(timeoutMs: number, token: vscode.CancellationToken): {
  controller: AbortController;
  armTimeout(): void;
  wasTimedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const armTimeout = (): void => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  };
  armTimeout();
  const cancellation = token.onCancellationRequested(() => controller.abort());
  return {
    controller,
    armTimeout,
    wasTimedOut: () => timedOut,
    dispose: () => { if (timeout) clearTimeout(timeout); cancellation.dispose(); },
  };
}
