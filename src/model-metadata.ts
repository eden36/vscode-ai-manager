import { isReasoningEffort } from './reasoning-effort';
import type { ChannelConfig, ModelProtocol, ReasoningEffort } from './types';

const METADATA_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** models.dev 用 AI SDK 包名标记每个模型实际使用的接口协议，模型级配置会覆盖 provider 级默认值。 */
function protocolFromNpm(npm: unknown): ModelProtocol {
  if (npm === '@ai-sdk/anthropic') return 'anthropic';
  if (npm === '@ai-sdk/openai') return 'responses';
  if (npm === '@ai-sdk/google' || npm === '@ai-sdk/google-vertex') return 'gemini';
  return 'openai';
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

let cache: { fetchedAt: number; payload: Record<string, unknown> } | undefined;
let pending: Promise<Record<string, unknown> | undefined> | undefined;

export interface RemoteModelMetadata {
  protocol: ModelProtocol;
  reasoningEfforts?: ReasoningEffort[];
}

/** 缓存是模块级的，测试需要显式清空以保持用例互相独立。 */
export function resetModelMetadataCache(): void {
  cache = undefined;
  pending = undefined;
}

async function loadMetadata(timeoutMs: number): Promise<Record<string, unknown> | undefined> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.payload;
  pending ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(METADATA_URL, { signal: controller.signal });
      if (!response.ok) return undefined;
      const payload = objectValue(await response.json());
      cache = { fetchedAt: Date.now(), payload };
      return payload;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => { pending = undefined; });
  return pending;
}

/**
 * 按渠道的 chat 端点匹配 models.dev 中的 provider，返回该 provider 下每个模型的协议与推理强度档位。
 * 拉取失败或匹配不到时返回 undefined，调用方回落到本地推断规则。
 */
export async function fetchModelMetadata(channel: ChannelConfig, timeoutMs: number): Promise<Map<string, RemoteModelMetadata> | undefined> {
  let chatEndpoint: string;
  try {
    chatEndpoint = new URL(channel.chatPath.replace(/^\/+/, ''), `${channel.baseUrl.replace(/\/+$/, '')}/`).toString();
  } catch {
    return undefined;
  }
  const payload = await loadMetadata(timeoutMs);
  if (!payload) return undefined;
  for (const entry of Object.values(payload)) {
    const provider = objectValue(entry);
    const api = typeof provider.api === 'string' ? provider.api.replace(/\/+$/, '') : '';
    if (!api || !chatEndpoint.startsWith(`${api}/`)) continue;
    const fallback = protocolFromNpm(provider.npm);
    const result = new Map<string, RemoteModelMetadata>();
    for (const [modelId, rawModel] of Object.entries(objectValue(provider.models))) {
      const model = objectValue(rawModel);
      const override = objectValue(model.provider).npm;
      const efforts = Array.isArray(model.reasoning_options)
        ? model.reasoning_options.flatMap((option) => {
          const value = objectValue(option);
          if (value.type !== 'effort' || !Array.isArray(value.values)) return [];
          return value.values.filter(isReasoningEffort);
        })
        : [];
      const reasoningEfforts = [...new Set(efforts)];
      result.set(modelId, {
        protocol: override === undefined ? fallback : protocolFromNpm(override),
        ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
      });
    }
    return result.size > 0 ? result : undefined;
  }
  return undefined;
}
