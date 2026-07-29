import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { migrateModelSchema } from '../src/migration';
import { model } from './fixtures';

describe('migrateModelSchema', () => {
  it('清除旧别名并为已有模型分配稳定 ID、关闭启用状态', async () => {
    let saved: any[] = [];
    const storage = {
      getSchemaVersion: () => 1,
      getLegacyAliases: () => [{ id: 'old-alias', name: '旧别名' }],
      getModels: () => [
        { ...model({ id: 'one', enabled: true }), providerId: undefined, catalogOrder: undefined },
        { ...model({ id: 'two', enabled: true }), providerId: undefined, catalogOrder: undefined },
      ],
      completeModelSchemaMigration: async (models: any[]) => { saved = models; },
    };
    const aliases = await migrateModelSchema(storage as any);
    expect(aliases).toEqual([{ id: 'old-alias', name: '旧别名' }]);
    expect(saved.map((item) => item.enabled)).toEqual([false, false]);
    expect(saved.map((item) => item.catalogOrder)).toEqual([0, 1]);
    expect(saved.every((item) => typeof item.providerId === 'string' && item.providerId.length > 0)).toBe(true);
  });

  it('schema v2 不重复迁移', async () => {
    const complete = vi.fn();
    const result = await migrateModelSchema({ getSchemaVersion: () => 2, completeModelSchemaMigration: complete } as any);
    expect(result).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});
