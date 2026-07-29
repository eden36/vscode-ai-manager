import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  show: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: { showInformationMessage: mocks.show },
  commands: { executeCommand: mocks.execute },
}));

import { notifyCatalogChanges } from '../src/catalog-notifications';

beforeEach(() => {
  mocks.show.mockReset();
  mocks.execute.mockReset();
});

describe('notifyCatalogChanges', () => {
  it('首次初始化不提示', async () => {
    await notifyCatalogChanges([{ channelId: 'one', channelName: '渠道', initialized: true, added: ['a'], removed: [], reappeared: [] }]);
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it('后续变化提示数量并可打开 AI Manager', async () => {
    mocks.show.mockResolvedValue('打开 AI Manager');
    await notifyCatalogChanges([{ channelId: 'one', channelName: '渠道', initialized: false, added: ['a'], removed: ['b'], reappeared: ['c'] }]);
    expect(mocks.show).toHaveBeenCalledWith('AI Manager 模型目录有变化：新增 1，移除 1，重新出现 1。', '打开 AI Manager');
    expect(mocks.execute).toHaveBeenCalledWith('workbench.view.extension.aiManager');
  });
});
