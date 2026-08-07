import type { CatalogModel, CatalogModelMetadata } from './types';

export function catalogMetadataBaseline(model: CatalogModel): CatalogModelMetadata {
  return model.catalogMetadata ?? {
    protocol: model.protocol,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
  };
}

export function catalogMetadataFrom(model: Pick<CatalogModel, 'protocol' | 'maxInputTokens' | 'maxOutputTokens' | 'supportsTools'>): CatalogModelMetadata {
  return {
    protocol: model.protocol,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    supportsTools: model.supportsTools,
  };
}
