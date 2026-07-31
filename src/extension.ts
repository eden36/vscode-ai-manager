import * as vscode from 'vscode';
import { AppService } from './app-service';
import { notifyCatalogChanges } from './catalog-notifications';
import { CatalogService } from './catalog';
import { ChatBindingService, type ChatSettingSelections } from './chat-settings';
import { AiManagerLanguageProvider } from './language-provider';
import { StorageService } from './storage';
import { SyncService } from './sync';
import { DashboardWebviewProvider } from './webview-provider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('AI Manager');
  // 共享状态可能被更高版本的扩展写成只读，也可能正被其他窗口占用。
  // 任一启动步骤失败都不能阻断激活，否则用户连管理界面都打不开，看不到升级或重试提示。
  const startupFailures: string[] = [];
  const runStartupStep = async (label: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      startupFailures.push(error instanceof Error ? error.message : `${label}失败`);
      output.appendLine(`[${new Date().toISOString()}] ${label}失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
    }
  };

  const storage = new StorageService(context);
  await runStartupStep('共享状态初始化', () => storage.initialize());
  const sync = new SyncService(storage);
  await runStartupStep('同步初始化', () => sync.initialize());
  const catalog = new CatalogService(storage, sync);
  const chatBindings = new ChatBindingService(storage);
  await runStartupStep('Chat 设置初始化', () => chatBindings.initialize());
  await runStartupStep('同步状态发布', () => sync.saveProfileFromLocal());
  const app = new AppService(storage, catalog, chatBindings, sync);
  const dashboard = new DashboardWebviewProvider(context.extensionUri, app, chatBindings);
  const languageProvider = new AiManagerLanguageProvider(app, output);

  context.subscriptions.push(
    output,
    storage,
    app,
    dashboard,
    languageProvider,
    chatBindings,
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
    vscode.commands.registerCommand('aiManager.resetSync', async () => {
      if (await vscode.window.showWarningMessage(
        '重置将清除共享保险库、当前 Profile 解密密钥和所有 API Key；渠道、模型和 Chat 设置仍保留在本机共享文件中。其他 Profile 和设备联网后也会清除凭据。此操作无法撤销，是否继续？',
        { modal: true },
        '重置同步凭据',
      ) !== '重置同步凭据') return;
      await app.resetSync();
      app.notifyExternalChange();
      void vscode.window.showInformationMessage('同步凭据已重置。');
    }),
  );

  context.subscriptions.push(storage.onDidChange((change) => {
    void (async () => {
      if (change.source === 'local') {
        await sync.saveProfileFromLocal();
        // 手动修改 VS Code Chat 设置也会写入共享状态，此时没有其他环节刷新面板。
        app.notifyExternalChange();
        return;
      }
      if (change.source === 'external') await sync.reconcile();
      await chatBindings.applySharedSettings();
      await chatBindings.reconcile();
      app.notifyExternalChange();
    })().catch((error: unknown) => {
      output.appendLine(`[${new Date().toISOString()}] 共享状态应用失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
    });
  }));

  if (startupFailures.length > 0) {
    void vscode.window.showWarningMessage(`AI Manager 启动未完成：${startupFailures[0]}。部分功能可能不可用，请打开 AI Manager 面板查看状态。`);
  }

  void app.refreshAll(false, true).then(async (summary) => {
    await notifyCatalogChanges(summary.changes);
    for (const failure of summary.failures) output.appendLine(`[${new Date().toISOString()}] 启动刷新失败 渠道=${failure.channelName} 类别=${failure.message}`);
  }).catch((error: unknown) => {
    output.appendLine(`[${new Date().toISOString()}] 启动刷新失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
  });
  const timer = setInterval(() => void app.refreshAll(true, true).then(async (summary) => {
    await notifyCatalogChanges(summary.changes);
    for (const failure of summary.failures) output.appendLine(`[${new Date().toISOString()}] 定时刷新失败 渠道=${failure.channelName} 类别=${failure.message}`);
  }).catch((error: unknown) => {
    output.appendLine(`[${new Date().toISOString()}] 定时刷新失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
  }), 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

export function deactivate(): void {}
