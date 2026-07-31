import * as vscode from 'vscode';
import type { AppService } from './app-service';
import { notifyCatalogChanges } from './catalog-notifications';
import { CHANNEL_PRESETS } from './presets';
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
    const presetOptions = CHANNEL_PRESETS.map((preset) => `<option value="${preset.id}">${preset.label}</option>`).join('');
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
  </nav>
  <main>
    <section id="channels" class="page active" aria-labelledby="channels-heading">
      <p id="sync-banner" class="sync-banner status" role="status" aria-live="polite" hidden></p>
      <div class="heading-row"><h1 id="channels-heading">渠道</h1><button id="new-channel" type="button">新增</button></div>
      <div id="channel-list"></div>
      <dialog id="channel-dialog" class="channel-dialog" aria-labelledby="channel-form-title">
        <form id="channel-form" class="form-card">
          <div class="dialog-header"><h2 id="channel-form-title">新增渠道</h2><button id="cancel-channel" type="button" aria-label="关闭">关闭</button></div>
          <input id="channel-id" type="hidden">
          <label>预设<select id="channel-preset">${presetOptions}</select></label>
          <label>名称<input id="channel-name" required maxlength="80"></label>
          <label>Base URL<input id="channel-base-url" required type="url"></label>
          <label>模型路径<input id="channel-models-path" required></label>
          <label>OpenAI Chat 路径<input id="channel-chat-path" required></label>
          <label>Anthropic Messages 路径<input id="channel-anthropic-path" placeholder="留空表示不支持"></label>
          <label>Gemini 流式路径<input id="channel-gemini-path" placeholder="必须包含 {model}；留空表示不支持"></label>
          <div class="grid"><label>默认调用协议<select id="channel-default-protocol"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label><label>API Key 认证方式<select id="channel-auth-mode"><option value="bearer">Authorization: Bearer</option><option value="anthropic-api-key">x-api-key</option><option value="google-api-key">x-goog-api-key</option></select></label></div>
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
        ${chatBindingPicker()}
        ${chatBindingRow('chat-default', '用于新建主 Chat 和 Agent 会话；当前会话中手动选择的模型不会被覆盖。')}
        ${chatBindingRow('inline-chat', '用于在编辑器中通过 Ctrl+I 打开的就地聊天。')}
        ${chatBindingRow('plan-agent', '用于 Plan Agent 制定和调整实施计划时的默认模型。')}
        ${chatBindingRow('implement-agent', '用于 Plan 完成后进入实现阶段时的模型；是否可用取决于当前 VS Code 版本。')}
        ${chatBindingRow('utility', '用于 Chat 的通用辅助任务，例如整理上下文和生成辅助内容。')}
        ${chatBindingRow('utility-small', '用于更轻量、强调响应速度的 Chat 辅助任务。')}
        <p class="muted">保持原设置的项目不会被修改。所选模型失效时会恢复首次绑定前的用户级设置。</p>
        <button type="submit" class="primary">应用设置</button>
      </form>
    </section>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function chatBindingRow(id: string, description: string): string {
  return `<fieldset id="${id}-binding" class="chat-binding-row"${id === 'chat-default' ? '' : ' hidden'}><p class="chat-binding-description">${description}</p><p id="${id}-error" class="status error" hidden></p><label>渠道<select id="${id}-channel"><option value="">保持原设置</option></select></label><label>模型<select id="${id}-model" disabled><option value="">请先选择渠道</option></select></label><button id="${id}-restore" type="button" class="restore-binding" hidden>恢复绑定前设置</button></fieldset>`;
}

function chatBindingPicker(): string {
  return `<label class="chat-binding-picker">设置项<div class="chat-binding-combobox"><button type="button" id="chat-binding-picker-trigger" class="chat-binding-picker-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="chat-binding-picker-options">Chat 默认模型</button><div id="chat-binding-picker-options" class="chat-binding-picker-options" role="listbox" hidden></div></div></label>`;
}

function getNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => characters.charAt(Math.floor(Math.random() * characters.length))).join('');
}
