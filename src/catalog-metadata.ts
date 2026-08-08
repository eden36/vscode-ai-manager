import type { CatalogModel, CatalogModelMetadata } from './types';

export function catalogMetadataBaseline(model: CatalogModel): CatalogModelMetadata {
  return model.catalogMetadata ?? {
    protocol: model.protocol,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
    reasoningEfforts: model.reasoningEfforts,
  };
}

export function catalogMetadataFrom(model: Pick<CatalogModel, 'protocol' | 'maxInputTokens' | 'maxOutputTokens' | 'supportsTools' | 'reasoningEfforts'>): CatalogModelMetadata {
  return {
    protocol: model.protocol,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
    reasoningEfforts: model.reasoningEfforts,
  };
}
