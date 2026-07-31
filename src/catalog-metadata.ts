import type { CatalogModel, CatalogModelMetadata } from './types';

export function catalogMetadataBaseline(model: CatalogModel): CatalogModelMetadata {
  return model.catalogMetadata ?? {
    protocol: model.protocol,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    toolCalling: model.toolCalling,
  };
}

export function catalogMetadataFrom(model: Pick<CatalogModel, 'protocol' | 'maxInputTokens' | 'maxOutputTokens' | 'toolCalling'>): CatalogModelMetadata {
  return {
    protocol: model.protocol,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    toolCalling: model.toolCalling,
  };
}
