import type { CatalogChange, CatalogModel, CatalogRefreshSummary, ChannelConfig, ModelProtocol } from './types';
import { catalogMetadataFrom } from './catalog-metadata';
export { catalogMetadataBaseline } from './catalog-metadata';
import { classifyHttpError, RequestError, safeErrorMessage } from './errors';
import { createModelProviderId, getProtocolPath } from './models';
import { StorageService } from './storage';
import type { SyncService } from './sync';
import { apiKeyHeaders } from './protocol-http';
import { fetchModelProtocols } from './model-metadata';

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function positiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

export function inferProtocol(
  raw: Record<string, unknown>,
  channel?: ChannelConfig,
  protocolOverrides?: ReadonlyMap<string, ModelProtocol>,
): ModelProtocol {
  const explicit = [raw.apiType, raw.api_type, raw.protocol, raw.endpoint, raw.api]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (explicit.includes('anthropic') || explicit.includes('/messages')) return 'anthropic';
  if (explicit.includes('gemini') || explicit.includes('generatecontent')) return 'gemini';
  if (explicit.includes('openai') || explicit.includes('chat-completions') || explicit.includes('chat/completions')) return 'openai';
  const rawId = typeof raw.id === 'string' ? raw.id : '';
  const override = protocolOverrides?.get(rawId);
  if (override) return override;
  const modelId = rawId.toLowerCase();
  if (channel?.preset === 'opencode-go' && (/^minimax-/.test(modelId) || /^qwen3\.[5-9]/.test(modelId))) return 'anthropic';
  return channel?.defaultProtocol ?? 'openai';
}

export function parseModelCatalog(
  payload: unknown,
  channel: ChannelConfig,
  now = Date.now(),
  protocolOverrides?: ReadonlyMap<string, ModelProtocol>,
): CatalogModel[] {
  const root = objectValue(payload);
  const items = Array.isArray(payload) ? payload : Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const seen = new Set<string>();
  return items.flatMap((entry, catalogOrder) => {
    const raw = objectValue(entry);
    const rawId = typeof raw.id === 'string' ? raw.id.trim() : typeof raw.name === 'string' ? raw.name.trim() : '';
    const protocol = inferProtocol(raw, channel, protocolOverrides);
    const id = protocol === 'gemini' ? rawId.replace(/^models\//, '') : rawId;
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const limits = objectValue(raw.limits ?? raw.limit);
    const capabilities = objectValue(raw.capabilities);
    const maxInputTokens = positiveNumber(
      raw.maxInputTokens,
      raw.max_input_tokens,
      raw.contextWindow,
      raw.context_window,
      raw.context_length,
      limits.context,
      limits.input,
    ) ?? channel.defaultMaxInputTokens;
    const maxOutputTokens = positiveNumber(
      raw.maxOutputTokens,
      raw.max_output_tokens,
      limits.output,
      limits.completion,
    ) ?? channel.defaultMaxOutputTokens;
    const toolCalling = raw.toolCalling === true
      || raw.tool_calling === true
      || capabilities.toolCalling === true
      || capabilities.tool_calling === true
      || capabilities.tools === true;
    return [{
      channelId: channel.id,
      id,
      providerId: '',
      name: typeof raw.displayName === 'string' ? raw.displayName : typeof raw.name === 'string' ? raw.name.replace(/^models\//, '') : id,
      enabled: false,
      catalogOrder,
      protocol,
      available: true,
      maxInputTokens,
      maxOutputTokens,
      toolCalling,
      lastSeenAt: now,
    }];
  });
}

export function joinEndpoint(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Base URL 必须是无内嵌凭据的 HTTP 或 HTTPS 地址');
  }
  return new URL(path.replace(/^\/+/, ''), `${url.toString().replace(/\/+$/, '')}/`).toString();
}

export class CatalogService {
  private readonly refreshing = new Map<string, Promise<{ models: CatalogModel[]; change: CatalogChange }>>();

  constructor(private readonly storage: StorageService, private readonly sync?: SyncService) {}

  async refreshChannel(channelId: string): Promise<{ models: CatalogModel[]; change: CatalogChange }> {
    const active = this.refreshing.get(channelId);
    if (active) return active;
    const task = this.performRefresh(channelId).finally(() => this.refreshing.delete(channelId));
    this.refreshing.set(channelId, task);
    return task;
  }

  async refreshAll(dueOnly = false): Promise<CatalogRefreshSummary> {
    const now = Date.now();
    const channels = this.storage.getChannels().filter((channel) => channel.enabled && (!dueOnly
      || !channel.lastRefreshAt
      || now - channel.lastRefreshAt >= channel.refreshIntervalMinutes * 60_000));
    const results = await Promise.allSettled(channels.map((channel) => this.refreshChannel(channel.id)));
    return {
      changes: results.flatMap((result) => result.status === 'fulfilled' ? [result.value.change] : []),
      failures: results.flatMap((result, index) => result.status === 'rejected' ? [{
        channelId: channels[index]!.id,
        channelName: channels[index]!.name,
        message: safeErrorMessage(result.reason),
      }] : []),
    };
  }

  private async performRefresh(channelId: string): Promise<{ models: CatalogModel[]; change: CatalogChange }> {
    const channel = this.storage.getChannels().find((item) => item.id === channelId);
    if (!channel) throw new Error('渠道不存在');
    try {
      const apiKey = await this.storage.getApiKey(channel.id);
      const payload = await this.fetchJsonWithRetry(joinEndpoint(channel.baseUrl, channel.modelsPath), apiKey, channel);
      if (!this.hasRecognizedCatalogShape(payload)) throw new Error('模型目录格式不受支持');
      const protocolOverrides = await fetchModelProtocols(channel, channel.timeoutMs);
      const discovered = parseModelCatalog(payload, channel, Date.now(), protocolOverrides);
      let merged: CatalogModel[] = [];
      let change: CatalogChange | undefined;
      await this.storage.updateModels((allModels) => {
        const currentChannel = this.storage.getChannels().find((item) => item.id === channel.id);
        if (!currentChannel) throw new RequestError('渠道已删除，刷新结果已丢弃', 'cancelled');
        if (currentChannel.baseUrl !== channel.baseUrl || currentChannel.modelsPath !== channel.modelsPath) {
          throw new RequestError('渠道配置已变更，请重新刷新', 'cancelled');
        }
        const previous = allModels.filter((model) => model.channelId === channel.id);
        const previousById = new Map(previous.map((model) => [model.id, model]));
        const discoveredIds = new Set(discovered.map((model) => model.id));
        merged = discovered.map((model) => {
          const old = previousById.get(model.id);
          const catalogMetadata = catalogMetadataFrom(model);
          const protocol = old?.metadataOverridden ? old.protocol : model.protocol;
          const enabled = getProtocolPath(channel, protocol) ? old?.enabled ?? false : false;
          const stable = {
            ...model,
            catalogMetadata,
            providerId: createModelProviderId(channel, model.id, protocol),
            customAlias: old?.customAlias,
            enabled,
            toolCalling: enabled,
          };
          const mergedModel = old?.metadataOverridden
            ? { ...stable, protocol: old.protocol, maxInputTokens: old.maxInputTokens, maxOutputTokens: old.maxOutputTokens, metadataOverridden: true }
            : stable;
          return this.sync?.applyPreference(mergedModel) ?? mergedModel;
        });
        for (const old of previous) {
          if (!discoveredIds.has(old.id)) merged.push({ ...old, available: false });
        }
        change = {
          channelId: channel.id,
          channelName: currentChannel.name,
          initialized: previous.length === 0,
          added: discovered.filter((model) => !previousById.has(model.id)).map((model) => model.id),
          removed: previous.filter((model) => model.available && !discoveredIds.has(model.id)).map((model) => model.id),
          reappeared: discovered.filter((model) => previousById.get(model.id)?.available === false).map((model) => model.id),
        };
        return [...allModels.filter((model) => model.channelId !== channel.id), ...merged];
      });
      await this.sync?.saveProfileFromLocal();
      await this.updateRefreshStatus(channel.id, Date.now(), undefined);
      return { models: merged, change: change! };
    } catch (error) {
      await this.updateRefreshStatus(channel.id, channel.lastRefreshAt, safeErrorMessage(error));
      throw error;
    }
  }

  private async fetchJsonWithRetry(url: string, apiKey: string | undefined, channel: ChannelConfig): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), channel.timeoutMs);
      try {
        const response = await fetch(url, {
          headers: apiKeyHeaders(channel, apiKey),
          signal: controller.signal,
        });
        if (!response.ok) throw classifyHttpError(response.status);
        return await response.json();
      } catch (error) {
        lastError = error instanceof Error && error.name === 'AbortError'
          ? new RequestError('刷新模型目录超时', 'timeout', undefined, true)
          : error;
        if (lastError instanceof RequestError && !lastError.retryable) break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  private async updateRefreshStatus(channelId: string, lastRefreshAt: number | undefined, error: string | undefined): Promise<void> {
    await this.storage.updateChannels((channels) => channels.map((channel) => channel.id === channelId
      ? { ...channel, ...(lastRefreshAt === undefined ? {} : { lastRefreshAt }), lastRefreshError: error }
      : channel));
  }

  private hasRecognizedCatalogShape(payload: unknown): boolean {
    if (Array.isArray(payload)) return true;
    const root = objectValue(payload);
    return Array.isArray(root.data) || Array.isArray(root.models);
  }
}
