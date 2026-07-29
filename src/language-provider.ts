import * as vscode from 'vscode';
import { OpenAIClient } from './openai-client';
import { estimateTokens, getExposedModels, getModelDisplayName, isModelUsable } from './models';
import type { AppService } from './app-service';

export class AiManagerLanguageProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelChangeEmitter.event;
  private readonly client = new OpenAIClient();
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

  provideLanguageModelChatInformation(): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const channels = this.app.storage.getChannels();
    return getExposedModels(channels, this.app.storage.getModels()).flatMap((model) => {
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
        capabilities: { imageInput: false, toolCalling: model.toolCalling },
      }];
    });
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
      const result = await this.client.streamChat({ channel, model }, apiKey, messages, options, progress, token);
      this.log(getModelDisplayName(model, channel), channel.name, model.id, Date.now() - startedAt, result.streamed ? 'success' : 'empty-response');
    } catch (error) {
      const category = error instanceof Error && 'category' in error ? String(error.category) : 'unknown';
      const status = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
      this.log(getModelDisplayName(model, channel), channel.name, model.id, Date.now() - startedAt, category, status);
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

  private log(alias: string, channel: string, model: string, durationMs: number, category: string, status?: number): void {
    this.output.appendLine(`[${new Date().toISOString()}] 渠道=${channel} 别名=${alias} 模型=${model} 耗时=${durationMs}ms${status ? ` 状态=${status}` : ''} 类别=${category}`);
  }
}
