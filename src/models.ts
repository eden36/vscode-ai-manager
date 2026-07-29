import type { CatalogModel, ChannelConfig } from './types';

export function getModelDisplayName(model: CatalogModel, channel: ChannelConfig): string {
  return model.customAlias?.trim() || `${channel.name}： ${model.name}`;
}

export function isModelUsable(model: CatalogModel, channel: ChannelConfig | undefined): boolean {
  return Boolean(channel?.enabled && model.enabled && model.available && model.protocol === 'openai');
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
