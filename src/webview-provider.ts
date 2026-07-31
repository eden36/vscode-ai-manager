import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AppService } from './app-service';
import { notifyCatalogChanges } from './catalog-notifications';
import { CHANNEL_PRESETS } from './presets';
import type { StorageService } from './storage';
import type { ChatBindingService, ChatSettingSelections } from './chat-settings';
import type { CatalogChange, ChatSettingKey, ModelProtocol } from './types';

interface WebviewMessage {
  type: string;
  payload?: unknown;
}

interface SaveChannelPayload {
  id?: string;
  preset?: string;
  name?: string;
  baseUrl?: string;
  modelsPath?: string;
  chatPath?: string;
  anthropicPath?: string;
  geminiPath?: string;
  defaultProtocol?: string;
  authMode?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
  refreshIntervalMinutes?: number;
  defaultMaxInputTokens?: number;
  defaultMaxOutputTokens?: number;
  enabled?: boolean;
}

interface SaveModelPayload {
  channelId?: string;
  id?: string;
  customAlias?: string;
  enabled?: boolean;
  protocol?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

const SYNC_CREDENTIAL_NOTICE = 'API Key 将存入本机加密保险库。若你已启用 VS Code Settings Sync，凭据会随同步数据传播到同一账号的其他设备与 Profile。安全边界依赖 VS Code 账号与 Settings Sync 加密，而非用户主密码。是否继续保存？';

export class DashboardWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private readonly changeSubscription: vscode.Disposable;
  private messageQueue: Promise<void> = Promise.resolve();
  private stateRevision = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly app: AppService,
    private readonly chatBindings: ChatBindingService,
    private readonly storage: StorageService,
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
      this.messageQueue = this.messageQueue
        .then(() => this.handleMessage(message))
        .catch((error: unknown) => {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'AI Manager 面板操作失败');
        });
    });
    void this.sendState();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.sendState();
          return;
        case 'saveChannel': {
          const payload = this.parseSaveChannelPayload(message.payload);
          if (!payload) {
            void vscode.window.showErrorMessage('渠道数据无效');
            await this.postOperationResult('operationFailed', message.type, '渠道数据无效');
            return;
          }
          if (payload.apiKey?.trim() && !this.storage.getSyncAcknowledged()) {
            const confirmed = await vscode.window.showWarningMessage(
              SYNC_CREDENTIAL_NOTICE,
              { modal: true },
              '继续保存',
            );
            if (confirmed !== '继续保存') {
              await this.postOperationResult('operationCancelled', message.type);
              return;
            }
            await this.storage.saveSyncAcknowledged(true);
          }
          const saved = await this.app.saveChannel(payload as Parameters<AppService['saveChannel']>[0]);
          await this.postOperationResult('operationSucceeded', message.type);
          if (saved.enabled) {
            try {
              await this.refreshChannelWithProgress(saved.id);
            } catch (error) {
              const refreshError = error instanceof Error ? error.message : '模型目录刷新失败';
              void vscode.window.showErrorMessage(refreshError);
              await this.sendState();
            }
          }
          return;
        }
        case 'toggleChannel': {
          const channelId = this.parseChannelId(message.payload);
          if (!channelId) {
            void vscode.window.showErrorMessage('渠道 ID 无效');
            return;
          }
          await this.app.toggleChannel(channelId);
          break;
        }
        case 'deleteChannel': {
          const channelId = this.parseChannelId(message.payload);
          if (!channelId) {
            void vscode.window.showErrorMessage('渠道 ID 无效');
            return;
          }
          if (await vscode.window.showWarningMessage('确定删除该渠道及其模型缓存吗？', { modal: true }, '删除') !== '删除') return;
          await this.app.deleteChannel(channelId);
          break;
        }
        case 'refreshChannel': {
          const channelId = this.parseChannelId(message.payload);
          if (!channelId) {
            void vscode.window.showErrorMessage('渠道 ID 无效');
            return;
          }
          await this.refreshChannelWithProgress(channelId);
          break;
        }
        case 'testChannel': {
          const channelId = this.parseChannelId(message.payload);
          if (!channelId) {
            void vscode.window.showErrorMessage('渠道 ID 无效');
            return;
          }
          const change = await this.refreshChannelWithProgress(channelId, '正在测试渠道连接…');
          void vscode.window.showInformationMessage(this.testChannelMessage(change));
          break;
        }
        case 'saveModel': {
          const payload = this.parseSaveModelPayload(message.payload);
          if (!payload) {
            void vscode.window.showErrorMessage('模型数据无效');
            await this.postOperationResult('operationFailed', message.type, '模型数据无效');
            return;
          }
          await this.app.saveModel({
            channelId: payload.channelId!,
            id: payload.id!,
            ...(payload.customAlias !== undefined ? { customAlias: payload.customAlias } : {}),
            ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
            ...(payload.protocol !== undefined ? { protocol: payload.protocol as ModelProtocol } : {}),
            ...(payload.maxInputTokens !== undefined ? { maxInputTokens: payload.maxInputTokens } : {}),
            ...(payload.maxOutputTokens !== undefined ? { maxOutputTokens: payload.maxOutputTokens } : {}),
          });
          break;
        }
        case 'applyChatSettings':
          await this.chatBindings.apply(message.payload as ChatSettingSelections);
          await this.postOperationResult('operationSucceeded', message.type);
          await this.sendState();
          return;
        case 'restoreChatSetting':
          await this.chatBindings.restore(String((message.payload as { setting?: unknown })?.setting ?? '') as ChatSettingKey);
          await this.postOperationResult('operationSucceeded', message.type);
          await this.sendState();
          return;
        case 'showError':
          void vscode.window.showErrorMessage(String((message.payload as { message?: unknown })?.message ?? '操作失败'));
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

  private async refreshChannelWithProgress(channelId: string, title = '正在刷新模型目录…'): Promise<CatalogChange> {
    const change = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title },
      () => this.app.refreshChannel(channelId),
    );
    await notifyCatalogChanges([change]);
    return change;
  }

  private testChannelMessage(change: CatalogChange): string {
    const totalModels = this.app.storage.getModels().filter((model) => model.channelId === change.channelId && model.available).length;
    if (totalModels > 0) return `渠道连接成功，已发现 ${totalModels} 个模型。`;
    return '渠道连接成功，但模型目录为空。';
  }

  private parseChannelId(payload: unknown): string | undefined {
    const channelId = typeof (payload as { channelId?: unknown })?.channelId === 'string'
      ? (payload as { channelId: string }).channelId.trim()
      : '';
    return channelId || undefined;
  }

  private parseSaveChannelPayload(payload: unknown): SaveChannelPayload | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = payload as SaveChannelPayload;
    if (typeof value.name !== 'string' || !value.name.trim()) return undefined;
    if (typeof value.baseUrl !== 'string' || !value.baseUrl.trim()) return undefined;
    return value;
  }

  private parseSaveModelPayload(payload: unknown): SaveModelPayload | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = payload as SaveModelPayload;
    if (typeof value.channelId !== 'string' || !value.channelId.trim()) return undefined;
    if (typeof value.id !== 'string' || !value.id.trim()) return undefined;
    return value;
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
      <div id="chat-form" class="card form-card">
        ${chatBindingPicker()}
        ${chatBindingRow('chat-default', '用于新建主 Chat 和 Agent 会话；当前会话中手动选择的模型不会被覆盖。')}
        ${chatBindingRow('inline-chat', '用于在编辑器中通过 Ctrl+I 打开的就地聊天。')}
        ${chatBindingRow('plan-agent', '用于 Plan Agent 制定和调整实施计划时的默认模型。')}
        ${chatBindingRow('implement-agent', '用于 Plan 完成后进入实现阶段时的模型；是否可用取决于当前 VS Code 版本。')}
        ${chatBindingRow('utility', '用于 Chat 的通用辅助任务，例如整理上下文和生成辅助内容。')}
        ${chatBindingRow('utility-small', '用于更轻量、强调响应速度的 Chat 辅助任务。')}
        <p class="muted">保持原设置的项目不会被修改。所选模型失效时会恢复首次绑定前的用户级设置。</p>
      </div>
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
  const bytes = randomBytes(32);
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(bytes, (byte) => characters.charAt(byte % characters.length)).join('');
}
