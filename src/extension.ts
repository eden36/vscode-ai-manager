import * as vscode from 'vscode';
import { AppService } from './app-service';
import { notifyCatalogChanges } from './catalog-notifications';
import { CatalogService } from './catalog';
import { ChatBindingService, type ChatSettingSelections } from './chat-settings';
import { AiManagerLanguageProvider } from './language-provider';
import { SharedStateLockBusyError, StorageService } from './storage';
import { startSyncPolling, SyncService } from './sync';
import { DashboardWebviewProvider } from './webview-provider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('AI Manager');
  // 共享状态可能被更高版本的扩展写成只读，也可能正被其他窗口占用。
  // 任一启动步骤失败都不能阻断激活，否则用户连管理界面都打不开，看不到升级或重试提示。
  const startupFailures: string[] = [];
  const runStartupStep = async (label: string, step: () => Promise<void>): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await step();
        return;
      } catch (error) {
        // 多个窗口同时启动会短暂争抢共享文件锁，重试即可完成；只有一直拿不到锁才提示用户。
        if (error instanceof SharedStateLockBusyError && attempt < 2) {
          output.appendLine(`[${new Date().toISOString()}] ${label}等待共享状态锁，准备第 ${attempt + 2} 次尝试`);
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        startupFailures.push(error instanceof Error ? error.message : `${label}失败`);
        output.appendLine(`[${new Date().toISOString()}] ${label}失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
        return;
      }
    }
  };

  const storage = new StorageService(context);
  const sync = new SyncService(storage);
  const catalog = new CatalogService(storage, sync);
  const chatBindings = new ChatBindingService(storage);
  const app = new AppService(storage, catalog, chatBindings, sync);
  const dashboard = new DashboardWebviewProvider(context.extensionUri, app, chatBindings, storage);
  const languageProvider = new AiManagerLanguageProvider(app, output);

  // 视图和命令必须先于共享状态初始化注册：切换 Profile 或多窗口并存时，初始化要等其他窗口
  // 释放文件锁，可能持续数十秒；此前若视图还没有提供程序，面板就是一片空白，用户也拿不到日志入口。
  context.subscriptions.push(
    output,
    storage,
    app,
    dashboard,
    languageProvider,
    chatBindings,
    vscode.window.registerWebviewViewProvider('aiManager.dashboard', dashboard),
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

  // 模型提供程序注册失败不能连带影响管理面板，否则用户既改不了配置也看不到原因。
  try {
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('ai-manager', languageProvider));
  } catch (error) {
    startupFailures.push(error instanceof Error ? error.message : '模型提供程序注册失败');
    output.appendLine(`[${new Date().toISOString()}] 模型提供程序注册失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
  }

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

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const runScheduledRefresh = (): void => {
    void app.refreshAll(true, true).then(async (summary) => {
      await notifyCatalogChanges(summary.changes);
      for (const failure of summary.failures) output.appendLine(`[${new Date().toISOString()}] 定时刷新失败 渠道=${failure.channelName} 类别=${failure.message}`);
    }).catch((error: unknown) => {
      output.appendLine(`[${new Date().toISOString()}] 定时刷新失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
    });
  };
  const syncRefreshTimer = (): void => {
    const hasEnabledChannels = storage.getChannels().some((channel) => channel.enabled);
    if (hasEnabledChannels && !refreshTimer) {
      refreshTimer = setInterval(runScheduledRefresh, 60_000);
    } else if (!hasEnabledChannels && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  };
  syncRefreshTimer();
  context.subscriptions.push(
    app.onDidChange(() => syncRefreshTimer()),
    { dispose: () => { if (refreshTimer) clearInterval(refreshTimer); } },
  );

  context.subscriptions.push(startSyncPolling(
    () => sync.reconcile(),
    (result) => {
      // 共享状态合并会通过 storage.onDidChange 刷新界面；仅保险库变化时需主动刷新状态。
      if (result.vaultChanged && !result.stateChanged) app.notifyExternalChange();
    },
    (error) => output.appendLine(`[${new Date().toISOString()}] 定时同步失败 类别=${error instanceof Error ? error.name : 'unknown'}`),
  ));

  // 初始化在后台进行：activate 不等待共享状态和同步，面板可以立即显示，数据就绪后再刷新一次。
  void (async () => {
    await runStartupStep('共享状态初始化', () => storage.initialize());
    await runStartupStep('同步初始化', () => sync.initialize());
    await runStartupStep('Chat 设置初始化', () => chatBindings.initialize());
    await runStartupStep('同步状态发布', () => sync.saveProfileFromLocal());
    if (startupFailures.length > 0) {
      void vscode.window.showWarningMessage(`AI Manager 启动未完成：${startupFailures[0]}。部分功能可能不可用，请打开 AI Manager 面板查看状态。`);
    }
    app.notifyExternalChange();
    const summary = await app.refreshAll(false, true);
    await notifyCatalogChanges(summary.changes);
    for (const failure of summary.failures) output.appendLine(`[${new Date().toISOString()}] 启动刷新失败 渠道=${failure.channelName} 类别=${failure.message}`);
  })().catch((error: unknown) => {
    output.appendLine(`[${new Date().toISOString()}] 启动初始化失败 类别=${error instanceof Error ? error.name : 'unknown'}`);
  });
}

export function deactivate(): void {}
