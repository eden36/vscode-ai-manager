import * as vscode from 'vscode';
import { AppService } from './app-service';
import { notifyCatalogChanges } from './catalog-notifications';
import { CatalogService } from './catalog';
import { ChatBindingService, type ChatSettingSelections } from './chat-settings';
import { AiManagerLanguageProvider } from './language-provider';
import { migrateModelSchema, offerLegacyChatSettingsCleanup } from './migration';
import { StorageService } from './storage';
import { DashboardWebviewProvider } from './webview-provider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('AI Manager');
  const storage = new StorageService(context);
  const legacyAliases = await migrateModelSchema(storage);
  const catalog = new CatalogService(storage);
  const chatBindings = new ChatBindingService(storage);
  await chatBindings.reconcile();
  const app = new AppService(storage, catalog, chatBindings);
  const dashboard = new DashboardWebviewProvider(context.extensionUri, app, chatBindings);
  const languageProvider = new AiManagerLanguageProvider(app, output);

  context.subscriptions.push(
    output,
    app,
    dashboard,
    languageProvider,
    vscode.window.registerWebviewViewProvider('aiManager.dashboard', dashboard),
    vscode.lm.registerLanguageModelChatProvider('ai-manager', languageProvider),
    vscode.commands.registerCommand('aiManager.open', () => vscode.commands.executeCommand('workbench.view.extension.aiManager')),
    vscode.commands.registerCommand('aiManager.showLogs', () => output.show()),
    vscode.commands.registerCommand('aiManager.refreshAll', async () => {
      const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在刷新全部模型目录…' }, () => app.refreshAll());
      await notifyCatalogChanges(summary.changes);
      if (summary.failures.length > 0) {
        void vscode.window.showWarningMessage(`模型目录刷新完成：成功 ${summary.changes.length} 个，失败 ${summary.failures.length} 个。请打开 AI Manager 查看原因。`);
      } else {
        void vscode.window.showInformationMessage(`模型目录刷新完成：成功 ${summary.changes.length} 个。`);
      }
    }),
    vscode.commands.registerCommand('aiManager.applyChatSettings', (selections?: ChatSettingSelections) => {
      if (selections) return chatBindings.apply(selections);
      return vscode.commands.executeCommand('workbench.view.extension.aiManager');
    }),
  );

  void offerLegacyChatSettingsCleanup(legacyAliases).catch((error: unknown) => {
    output.appendLine(`[${new Date().toISOString()}] 清理旧绑定失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
  });
  void app.refreshAll(false).then(async (summary) => {
    await notifyCatalogChanges(summary.changes);
    for (const failure of summary.failures) output.appendLine(`[${new Date().toISOString()}] 启动刷新失败 渠道=${failure.channelName} 类别=${failure.message}`);
  }).catch((error: unknown) => {
    output.appendLine(`[${new Date().toISOString()}] 启动刷新失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
  });
  const timer = setInterval(() => void app.refreshAll(true).then(async (summary) => {
    await notifyCatalogChanges(summary.changes);
    for (const failure of summary.failures) output.appendLine(`[${new Date().toISOString()}] 定时刷新失败 渠道=${failure.channelName} 类别=${failure.message}`);
  }).catch((error: unknown) => {
    output.appendLine(`[${new Date().toISOString()}] 定时刷新失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
  }), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {}
