import * as vscode from 'vscode';
import type { CatalogChange } from './types';

export async function notifyCatalogChanges(changes: readonly CatalogChange[]): Promise<void> {
  const changed = changes.filter((change) => !change.initialized && (change.added.length > 0 || change.removed.length > 0 || change.reappeared.length > 0));
  if (changed.length === 0) return;
  const added = changed.reduce((total, change) => total + change.added.length, 0);
  const removed = changed.reduce((total, change) => total + change.removed.length, 0);
  const reappeared = changed.reduce((total, change) => total + change.reappeared.length, 0);
  const summary = [added ? `新增 ${added}` : '', removed ? `移除 ${removed}` : '', reappeared ? `重新出现 ${reappeared}` : ''].filter(Boolean).join('，');
  const choice = await vscode.window.showInformationMessage(`AI Manager 模型目录有变化：${summary}。`, '打开 AI Manager');
  if (choice === '打开 AI Manager') await vscode.commands.executeCommand('workbench.view.extension.aiManager');
}
