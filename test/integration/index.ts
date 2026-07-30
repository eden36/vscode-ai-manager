import assert from 'node:assert/strict';
import * as vscode from 'vscode';

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('saltcoreyan.ai-manager');
  assert.ok(extension, 'AI Manager 扩展应已加载');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of ['aiManager.open', 'aiManager.refreshAll', 'aiManager.applyChatSettings', 'aiManager.showLogs']) {
    assert.ok(commands.includes(command), `应注册命令 ${command}`);
  }

  const models = await vscode.lm.selectChatModels({ vendor: 'ai-manager' });
  assert.ok(Array.isArray(models), 'AI Manager Language Model Provider 应可被查询');
}
