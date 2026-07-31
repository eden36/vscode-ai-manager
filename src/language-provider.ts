import * as vscode from 'vscode';
import { OpenAIClient } from './openai-client';
import { AnthropicClient } from './anthropic-client';
import { GeminiClient } from './gemini-client';
import { estimateTokens, getExposedModels, getModelDisplayName, isModelUsable, modelReportsToolCalling } from './models';
import { safeErrorMessage, shouldNotifyLanguageModelFailure } from './errors';
import type { AppService } from './app-service';

export class AiManagerLanguageProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelChangeEmitter.event;
  private readonly clients = { openai: new OpenAIClient(), anthropic: new AnthropicClient(), gemini: new GeminiClient() };
  private readonly changeSubscription: vscode.Disposable;

  constructor(
    private readonly app: AppService,
    private readonly output: vscode.OutputChannel,
  ) {
    this.changeSubscription = app.onDidChange(() => this.modelChangeEmitter.fire());
  }

  dispose(): void {
    this.changeSubscription.dispose();
    this.modelChangeEmitter.dispose();
  }

  provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    if (token.isCancellationRequested) return [];
    const channels = this.app.storage.getChannels();
    const models = getExposedModels(channels, this.app.storage.getModels()).flatMap((model) => {
      const channel = channels.find((item) => item.id === model.channelId);
      if (!channel) return [];
      return [{
        id: model.providerId,
        name: getModelDisplayName(model, channel),
        family: model.id,
        version: '1',
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        tooltip: `${channel.name} / ${model.name}`,
        detail: 'AI Manager 模型',
        capabilities: { imageInput: false, toolCalling: modelReportsToolCalling(model) },
      }];
    });
    if (!options.silent) {
      this.output.appendLine(`[${new Date().toISOString()}] 已注册 ${models.length} 个可用模型`);
    }
    return models;
  }

  async provideLanguageModelChatResponse(
    information: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const model = this.app.storage.getModels().find((item) => item.providerId === information.id);
    const channel = model ? this.app.storage.getChannels().find((item) => item.id === model.channelId) : undefined;
    if (!model || !channel || !isModelUsable(model, channel)) throw new Error('模型已停用或不可用');
    const startedAt = Date.now();
    try {
      const apiKey = await this.app.storage.getApiKey(channel.id);
      if (!apiKey?.trim()) throw new Error(`${channel.name} 未配置 API Key，请在 AI Manager 中编辑渠道并保存密钥`);
      if (model.protocol === 'unknown') throw new Error('模型协议不受支持');
      const result = await this.clients[model.protocol].streamChat({ channel, model }, apiKey, messages, options, progress, token);
      if (!result.streamed) {
        const message = `${getModelDisplayName(model, channel)} 未返回有效内容，请检查模型或渠道配置`;
        this.log(getModelDisplayName(model, channel), channel.name, model.id, Date.now() - startedAt, 'empty-response', undefined, message);
        if (shouldNotifyLanguageModelFailure(options, new Error(message))) void vscode.window.showErrorMessage(message);
        throw new Error(message);
      }
      this.log(getModelDisplayName(model, channel), channel.name, model.id, Date.now() - startedAt, 'success');
    } catch (error) {
      const message = safeErrorMessage(error);
      const category = error instanceof Error && 'category' in error ? String(error.category) : 'unknown';
      const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
      this.log(getModelDisplayName(model, channel), channel.name, model.id, Date.now() - startedAt, category, status, message);
      if (shouldNotifyLanguageModelFailure(options, error)) void vscode.window.showErrorMessage(message);
      throw error;
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    value: string | vscode.LanguageModelChatRequestMessage,
  ): Promise<number> {
    if (typeof value === 'string') return estimateTokens(value);
    return estimateTokens(value.content.map((part) => {
      const candidate = part as { value?: unknown; input?: unknown; content?: unknown };
      return typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.input ?? candidate.content ?? part);
    }).join(''));
  }

  private log(alias: string, channel: string, model: string, durationMs: number, category: string, status?: number, detail?: string): void {
    const suffix = detail ? ` 详情=${detail}` : '';
    this.output.appendLine(`[${new Date().toISOString()}] 渠道=${channel} 别名=${alias} 模型=${model} 耗时=${durationMs}ms${status ? ` 状态=${status}` : ''} 类别=${category}${suffix}`);
  }
}
