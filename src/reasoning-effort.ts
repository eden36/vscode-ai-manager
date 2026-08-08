import type { CatalogModel, ReasoningEffort } from './types';

export const REASONING_EFFORT_VALUES: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

interface ReasoningEffortRequestOptions {
  modelConfiguration?: Record<string, unknown>;
  modelOptions?: Record<string, unknown>;
}

export interface ReasoningEffortConfigurationSchema {
  type: 'object';
  properties: {
    reasoningEffort: {
      type: 'string';
      title: string;
      enum: string[];
      enumItemLabels: string[];
      enumDescriptions: string[];
      default: 'default';
      group: 'navigation';
    };
  };
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORT_VALUES as readonly string[]).includes(value);
}

export function reasoningEffortConfigurationSchema(efforts: readonly ReasoningEffort[]): ReasoningEffortConfigurationSchema | undefined {
  if (efforts.length === 0) return undefined;
  return {
    type: 'object',
    properties: {
      reasoningEffort: {
        type: 'string',
        title: '推理强度',
        enum: ['default', ...efforts],
        enumItemLabels: ['default', ...efforts],
        enumDescriptions: ['不指定推理强度，由模型服务决定', ...efforts.map((effort) => `发送 ${effort} 推理强度`)],
        default: 'default',
        group: 'navigation',
      },
    },
  };
}

export function resolveReasoningEffort(
  model: Pick<CatalogModel, 'reasoningEfforts'>,
  options: ReasoningEffortRequestOptions,
): ReasoningEffort | undefined {
  const value = options.modelConfiguration?.reasoningEffort ?? options.modelOptions?.reasoningEffort;
  return isReasoningEffort(value) && model.reasoningEfforts?.includes(value) ? value : undefined;
}
