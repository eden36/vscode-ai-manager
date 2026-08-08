import { describe, expect, it } from 'vitest';
import { reasoningEffortConfigurationSchema, resolveReasoningEffort } from '../src/reasoning-effort';
import { model } from './fixtures';

describe('reasoning-effort', () => {
  it('生成包含默认项和原始档位名称的原生配置 schema', () => {
    expect(reasoningEffortConfigurationSchema(['minimal', 'high', 'max'])).toMatchObject({
      properties: {
        reasoningEffort: {
          title: '推理强度',
          enum: ['default', 'minimal', 'high', 'max'],
          enumItemLabels: ['default', 'minimal', 'high', 'max'],
          default: 'default',
        },
      },
    });
    expect(reasoningEffortConfigurationSchema([])).toBeUndefined();
  });

  it('原生配置优先于 modelOptions，并只接受模型声明的档位', () => {
    const target = model({ reasoningEfforts: ['low', 'high'] });
    expect(resolveReasoningEffort(target, { modelConfiguration: { reasoningEffort: 'high' }, modelOptions: { reasoningEffort: 'low' } })).toBe('high');
    expect(resolveReasoningEffort(target, { modelConfiguration: { reasoningEffort: 'default' }, modelOptions: { reasoningEffort: 'low' } })).toBeUndefined();
    expect(resolveReasoningEffort(target, { modelConfiguration: { reasoningEffort: 'max' } })).toBeUndefined();
    expect(resolveReasoningEffort(model(), { modelOptions: { reasoningEffort: 'high' } })).toBeUndefined();
  });
});
