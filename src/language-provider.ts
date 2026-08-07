import * as vscode from 'vscode';
import { OpenAIClient } from './openai-client';
import { AnthropicClient } from './anthropic-client';
import { GeminiClient } from './gemini-client';
import { ResponsesClient } from './responses-client';
import { estimateTokens, getExposedModels, getModelDisplayName, getProtocolPath, isModelUsable, modelReportsToolCalling } from './models';
import { RequestError, safeErrorMessage, shouldNotifyLanguageModelFailure } from './errors';
import type { AppService } from './app-service';
import type { StreamResult } from './openai-client';
import type { ResolvedCandidate } from './types';

type ClientProtocol = 'openai' | 'anthropic' | 'gemini' | 'responses';

const PROTOCOL_FALLBACK_ORDER: readonly ClientProtocol[] = ['openai', 'responses', 'anthropic', 'gemini'];

/** 503 时只在同族方言之间互换：实际遇到的协议错配几乎都是 OpenAI 的两种方言配反。 */
const TRANSIENT_ALTERNATIVE: Record<ClientProtocol, ClientProtocol> = {
  openai: 'responses',
  responses: 'openai',
  anthropic: 'openai',
  gemini: 'openai',
};

/**
 * 404 说明该协议端点确实不存在，可以放心遍历其他协议并记住结果；
 * 503 更多是上游临时不可用，遍历会成倍消耗配额，侥幸成功也不该固化成模型协议。
 */
function protocolMismatchKind(error: unknown): 'structural' | 'transient' | undefined {
  if (!(error instanceof RequestError) || error.responseStarted) return undefined;
  if (error.status === 404) return 'structural';
  if (error.status === 503) return 'transient';
  return undefined;
}

export class AiManagerLanguageProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly modelChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.modelChangeEmitter.event;
  private readonly clients = { openai: new OpenAIClient(), anthropic: new AnthropicClient(), gemini: new GeminiClient(), responses: new ResponsesClient() };
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
      const result = await this.streamWithProtocolFallback({ channel, model }, apiKey, messages, options, progress, token);
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

  /**
   * 渠道对「模型存在但该协议端点没有上游」通常回 404，此时遍历其他已配置协议重试，
   * 成功后把探测结果写回目录，避免每次调用都先失败一轮；503 只保守试一个同族协议且不写回。
   */
  private async streamWithProtocolFallback(
    target: ResolvedCandidate,
    apiKey: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<StreamResult> {
    const { channel, model } = target;
    try {
      return await this.clients[model.protocol as ClientProtocol].streamChat(target, apiKey, messages, options, progress, token);
    } catch (error) {
      const kind = protocolMismatchKind(error);
      if (!kind || model.metadataOverridden) throw error;
      const alternatives = kind === 'structural'
        ? PROTOCOL_FALLBACK_ORDER
        : [TRANSIENT_ALTERNATIVE[model.protocol as ClientProtocol]];
      for (const candidate of alternatives) {
        if (candidate === model.protocol || !getProtocolPath(channel, candidate)) continue;
        try {
          const result = await this.clients[candidate].streamChat(
            { channel, model: { ...model, protocol: candidate } }, apiKey, messages, options, progress, token,
          );
          this.output.appendLine(`[${new Date().toISOString()}] 渠道=${channel.name} 模型=${model.id} 协议自动切换为 ${candidate}`);
          if (kind === 'structural') void this.app.applyDetectedProtocol(channel.id, model.id, candidate);
          return result;
        } catch (retryError) {
          if (!protocolMismatchKind(retryError)) throw retryError;
        }
      }
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
