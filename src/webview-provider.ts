import * as vscode from 'vscode';
import type { AppService } from './app-service';
import { notifyCatalogChanges } from './catalog-notifications';
import type { ChatBindingService, ChatSettingSelections } from './chat-settings';
import type { ChatSettingKey } from './types';

interface WebviewMessage {
  type: string;
  payload?: any;
}

export class DashboardWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly changeSubscription: vscode.Disposable;
  private messageQueue: Promise<void> = Promise.resolve();
  private stateRevision = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly app: AppService,
    private readonly chatBindings: ChatBindingService,
  ) {
    this.changeSubscription = app.onDidChange(() => void this.sendState());
  }

  dispose(): void {
    this.changeSubscription.dispose();
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      this.messageQueue = this.messageQueue.then(() => this.handleMessage(message));
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.sendState();
          return;
        case 'saveChannel':
          await this.app.saveChannel(message.payload);
          break;
        case 'toggleChannel':
          await this.app.toggleChannel(String(message.payload?.channelId ?? ''));
          break;
        case 'deleteChannel':
          if (await vscode.window.showWarningMessage('确定删除该渠道及其模型缓存吗？', { modal: true }, '删除') !== '删除') return;
          await this.app.deleteChannel(String(message.payload?.channelId ?? ''));
          break;
        case 'refreshChannel': {
          const change = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在刷新模型目录…' },
            () => this.app.refreshChannel(String(message.payload?.channelId ?? '')));
          await notifyCatalogChanges([change]);
          break;
        }
        case 'testChannel': {
          const change = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在测试渠道连接…' },
            () => this.app.refreshChannel(String(message.payload?.channelId ?? '')));
          await notifyCatalogChanges([change]);
          void vscode.window.showInformationMessage('渠道连接成功，模型目录已更新。');
          break;
        }
        case 'saveModel':
          await this.app.saveModel(message.payload);
          break;
        case 'enableSync':
          await this.app.enableSync(String(message.payload?.password ?? ''), String(message.payload?.confirmation ?? ''));
          break;
        case 'unlockSync': {
          const summary = await this.app.unlockSync(String(message.payload?.password ?? ''));
          await notifyCatalogChanges(summary.changes);
          break;
        }
        case 'changeSyncPassword':
          await this.app.changeSyncPassword(String(message.payload?.password ?? ''), String(message.payload?.confirmation ?? ''));
          break;
        case 'resetSync':
          if (await vscode.window.showWarningMessage(
            '重置将清除同步保险库、本机解密密钥和所有本机 API Key。此操作无法撤销，是否继续？',
            { modal: true },
            '重置同步',
          ) !== '重置同步') {
            await this.postOperationResult('operationCancelled', message.type);
            return;
          }
          await this.app.resetSync();
          break;
        case 'applyChatSettings':
          await this.chatBindings.apply(message.payload as ChatSettingSelections);
          await this.postOperationResult('operationSucceeded', message.type);
          await this.sendState();
          return;
        case 'restoreChatSetting':
          await this.chatBindings.restore(String(message.payload?.setting ?? '') as ChatSettingKey);
          await this.postOperationResult('operationSucceeded', message.type);
          await this.sendState();
          return;
        case 'showError':
          void vscode.window.showErrorMessage(String(message.payload?.message ?? '操作失败'));
          return;
        default:
          return;
      }
      await this.postOperationResult('operationSucceeded', message.type);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : '操作失败';
      void vscode.window.showErrorMessage(messageText);
      await this.postOperationResult('operationFailed', message.type, messageText);
      await this.sendState();
    }
  }

  private async sendState(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const revision = ++this.stateRevision;
    await view.webview.postMessage({ type: 'state', revision, payload: await this.app.getDashboardState() });
  }

  private async postOperationResult(type: 'operationSucceeded' | 'operationFailed' | 'operationCancelled', operation: string, message?: string): Promise<void> {
    await this.view?.webview.postMessage({ type, operation, message });
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'));
    const nonce = getNonce();
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${style}">
  <title>AI Manager</title>
</head>
<body>
  <nav class="tabs" aria-label="AI Manager 页面">
    <button type="button" class="tab active" data-tab="channels">渠道与模型</button>
    <button type="button" class="tab" data-tab="chat">Chat 绑定</button>
    <button type="button" class="tab" data-tab="sync">同步</button>
  </nav>
  <main>
    <section id="channels" class="page active" aria-labelledby="channels-heading">
      <div class="heading-row"><h1 id="channels-heading">渠道</h1><button id="new-channel" type="button">新增</button></div>
      <div class="model-toolbar">
        <label>搜索模型<input id="model-search" type="search" placeholder="模型名或别名"></label>
        <label>筛选<select id="model-filter"><option value="all">全部模型</option><option value="enabled">已启用</option><option value="disabled">未启用</option><option value="available">目录中可用</option><option value="unavailable">目录中已消失</option><option value="openai">OpenAI 协议</option><option value="unsupported">不支持的协议</option></select></label>
      </div>
      <div id="channel-list"></div>
      <dialog id="channel-dialog" class="channel-dialog" aria-labelledby="channel-form-title">
        <form id="channel-form" class="form-card">
          <div class="dialog-header"><h2 id="channel-form-title">新增渠道</h2><button id="cancel-channel" type="button" aria-label="关闭">关闭</button></div>
          <input id="channel-id" type="hidden">
          <label>预设<select id="channel-preset"><option value="custom">通用 OpenAI-compatible</option><option value="opencode-go">OpenCode Go</option><option value="opencode-console">OpenCode Console</option></select></label>
          <label>名称<input id="channel-name" required maxlength="80"></label>
          <label>Base URL<input id="channel-base-url" required type="url"></label>
          <label>模型路径<input id="channel-models-path" required></label>
          <label>Chat 路径<input id="channel-chat-path" required></label>
          <label>API Key<input id="channel-api-key" type="password" autocomplete="off" placeholder="留空表示不修改"></label>
          <label id="channel-clear-api-key-label" class="checkbox" hidden><input id="channel-clear-api-key" type="checkbox">清除已保存的 API Key</label>
          <div class="grid"><label>超时（毫秒）<input id="channel-timeout" type="number" min="1000" max="120000"></label><label>刷新周期（分钟）<input id="channel-refresh" type="number" min="5" max="10080"></label></div>
          <div class="grid"><label>默认输入上限<input id="channel-max-input" type="number" min="1024"></label><label>默认输出上限<input id="channel-max-output" type="number" min="256"></label></div>
          <label class="checkbox"><input id="channel-enabled" type="checkbox" checked>启用渠道</label>
          <div class="actions"><button id="save-channel" type="submit" class="primary">保存</button><button id="cancel-channel-bottom" type="button">取消</button></div>
        </form>
      </dialog>
      <div id="model-editor"></div>
    </section>
    <section id="chat" class="page" aria-labelledby="chat-heading">
      <h1 id="chat-heading">Chat 绑定</h1>
      <form id="chat-form" class="card form-card">
        ${chatBindingRow('chat-default', 'Chat 默认模型', '用于新建主 Chat 和 Agent 会话；当前会话中手动选择的模型不会被覆盖。')}
        ${chatBindingRow('inline-chat', 'Inline Chat 默认模型', '用于在编辑器中通过 Ctrl+I 打开的就地聊天。')}
        ${chatBindingRow('plan-agent', 'Plan Agent 默认模型', '用于 Plan Agent 制定和调整实施计划时的默认模型。')}
        ${chatBindingRow('implement-agent', 'Plan 实现阶段模型（实验性）', '用于 Plan 完成后进入实现阶段时的模型；是否可用取决于当前 VS Code 版本。')}
        ${chatBindingRow('utility', 'Chat: Utility Model', '用于 Chat 的通用辅助任务，例如整理上下文和生成辅助内容。')}
        ${chatBindingRow('utility-small', 'Chat: Utility Small Model', '用于更轻量、强调响应速度的 Chat 辅助任务。')}
        <p class="muted">保持原设置的项目不会被修改。所选模型失效时会恢复首次绑定前的用户级设置。</p>
        <button type="submit" class="primary">应用设置</button>
      </form>
    </section>
    <section id="sync" class="page" aria-labelledby="sync-heading">
      <h1 id="sync-heading">跨设备同步</h1>
      <div class="card form-card">
        <p id="sync-status" class="status sync-status unsynced" role="status" aria-live="polite">未同步</p>
        <p class="muted">渠道、模型偏好和加密后的 API Key 将通过 VS Code Settings Sync 同步。主密码和派生密钥不会进入同步数据。</p>
        <form id="sync-enable-form">
          <label>创建同步主密码<input id="sync-enable-password" type="password" autocomplete="new-password" required></label>
          <label>确认同步主密码<input id="sync-enable-confirmation" type="password" autocomplete="new-password" required></label>
          <button type="submit" class="primary">启用同步</button>
        </form>
        <form id="sync-unlock-form" hidden>
          <label>同步主密码<input id="sync-unlock-password" type="password" autocomplete="current-password" required></label>
          <button type="submit" class="primary">解锁</button>
        </form>
        <form id="sync-change-form" hidden>
          <h2>更改同步主密码</h2>
          <label>新同步主密码<input id="sync-change-password" type="password" autocomplete="new-password" required></label>
          <label>确认新同步主密码<input id="sync-change-confirmation" type="password" autocomplete="new-password" required></label>
          <button type="submit">更改主密码</button>
        </form>
        <div class="actions"><button id="sync-reset" type="button" class="danger" hidden>重置同步</button></div>
      </div>
    </section>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function chatBindingRow(id: string, label: string, description: string): string {
  return `<fieldset class="chat-binding-row"><legend>${label}</legend><p class="chat-binding-description">${description}</p><label>渠道<select id="${id}-channel"><option value="">保持原设置</option></select></label><label>模型<select id="${id}-model" disabled><option value="">请先选择渠道</option></select></label><button id="${id}-restore" type="button" class="restore-binding" hidden>恢复绑定前设置</button></fieldset>`;
}

function getNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
}
