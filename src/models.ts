import { createHash } from 'node:crypto';
import type { CatalogModel, ChannelConfig, ModelProtocol } from './types';

export function createModelProviderId(channel: ChannelConfig, modelId: string, protocol: ModelProtocol = 'openai'): string {
  const baseUrl = new URL(channel.baseUrl).toString().replace(/\/+$/, '');
  const modelsPath = `/${channel.modelsPath.replace(/^\/+/, '')}`;
  const chatPath = `/${channel.chatPath.replace(/^\/+/, '')}`;
  const identity = protocol === 'openai'
    ? `ai-manager:model:v1\0${baseUrl}\0${modelsPath}\0${chatPath}\0${modelId}`
    : `ai-manager:model:v2\0${baseUrl}\0${modelsPath}\0${protocol}\0${getProtocolPath(channel, protocol) ?? ''}\0${modelId}`;
  const bytes = createHash('sha256').update(identity, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getModelDisplayName(model: CatalogModel, channel: ChannelConfig): string {
  return model.customAlias?.trim() || `${channel.name}： ${model.name}`;
}

export function isModelUsable(model: CatalogModel, channel: ChannelConfig | undefined): boolean {
  return Boolean(channel?.enabled && model.enabled && model.available && channel && getProtocolPath(channel, model.protocol));
}

export function modelReportsToolCalling(model: CatalogModel): boolean {
  return model.enabled;
}

export function getProtocolPath(channel: ChannelConfig, protocol: ModelProtocol): string | undefined {
  if (protocol === 'openai') return channel.chatPath;
  if (protocol === 'anthropic') return channel.anthropicPath;
  if (protocol === 'gemini') return channel.geminiPath?.includes('{model}') ? channel.geminiPath : undefined;
  return undefined;
}

export function sortCatalogModels(models: readonly CatalogModel[]): CatalogModel[] {
  return [...models].sort((left, right) => left.catalogOrder - right.catalogOrder
    || left.name.localeCompare(right.name));
}

export function getExposedModels(channels: readonly ChannelConfig[], models: readonly CatalogModel[]): CatalogModel[] {
  return sortCatalogModels(models.filter((model) => isModelUsable(model, channels.find((channel) => channel.id === model.channelId))));
}

export function estimateTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of value) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4) + nonAscii);
}
