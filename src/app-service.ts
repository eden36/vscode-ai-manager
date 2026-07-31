import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { joinEndpoint, CatalogService } from './catalog';
import type { ChatBindingService } from './chat-settings';
import { createChannelDefaults, isChannelPreset } from './presets';
import { createModelProviderId, getProtocolPath } from './models';
import { StorageService } from './storage';
import type { SyncService } from './sync';
import type { CatalogChange, CatalogModel, CatalogRefreshSummary, ChannelAuthMode, ChannelConfig, ChannelPreset, DashboardState, ModelProtocol } from './types';

interface SaveChannelInput extends Partial<ChannelConfig> {
  apiKey?: string;
  clearApiKey?: boolean;
}

interface SaveModelInput {
  channelId: string;
  id: string;
  customAlias?: string;
  enabled?: boolean;
  protocol?: ModelProtocol;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  toolCalling?: boolean;
}

export class AppService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    readonly storage: StorageService,
    readonly catalog: CatalogService,
    readonly chatBindings: ChatBindingService,
    readonly sync: SyncService,
  ) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  notifyExternalChange(): void {
    this.changeEmitter.fire();
  }

  async getDashboardState(): Promise<DashboardState> {
    return {
      channels: await Promise.all(this.storage.getChannels().map(async (channel) => ({ ...channel, hasCredential: await this.storage.hasApiKey(channel.id) }))),
      models: this.storage.getModels(),
      chatBindings: this.chatBindings.getSelections(),
      chatErrors: this.storage.getChatApplicationErrors(),
      sync: this.sync.getStatus(),
    };
  }

  async saveChannel(input: SaveChannelInput): Promise<ChannelConfig> {
    if (input.clearApiKey && input.apiKey?.trim()) throw new Error('不能同时填写并清除 API Key');
    if (input.clearApiKey || input.apiKey?.trim()) this.sync.assertUnlocked();
    const previousChannels = this.storage.getChannels();
    const existing = input.id ? previousChannels.find((item) => item.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('渠道不存在');
    const channelId = existing?.id ?? randomUUID();
    const previousApiKey = await this.storage.getApiKey(channelId);
    const previousProfile = this.storage.getSyncProfile();
    const previousVault = this.storage.getSyncVault();
    let channel: ChannelConfig | undefined;
    try {
      await this.storage.updateChannels((channels) => {
        const preset = this.parsePreset(input.preset);
        const defaults = createChannelDefaults(preset);
        channel = {
          ...defaults,
          ...existing,
          id: channelId,
          name: this.requiredText(input.name ?? existing?.name, '渠道名称'),
          preset,
          baseUrl: this.requiredText(input.baseUrl ?? existing?.baseUrl ?? defaults.baseUrl, 'Base URL').replace(/\/+$/, ''),
          modelsPath: this.normalizedPath(input.modelsPath ?? existing?.modelsPath ?? defaults.modelsPath),
          chatPath: this.normalizedPath(input.chatPath ?? existing?.chatPath ?? defaults.chatPath),
          anthropicPath: this.optionalPath(input.anthropicPath ?? existing?.anthropicPath ?? defaults.anthropicPath),
          geminiPath: this.optionalPath(input.geminiPath ?? existing?.geminiPath ?? defaults.geminiPath),
          defaultProtocol: this.parseDefaultProtocol(input.defaultProtocol ?? existing?.defaultProtocol ?? defaults.defaultProtocol),
          authMode: this.parseAuthMode(input.authMode ?? existing?.authMode ?? defaults.authMode),
          enabled: input.enabled ?? existing?.enabled ?? true,
          timeoutMs: this.boundedInteger(input.timeoutMs ?? existing?.timeoutMs ?? defaults.timeoutMs, 1_000, 120_000, '超时时间'),
          refreshIntervalMinutes: this.boundedInteger(input.refreshIntervalMinutes ?? existing?.refreshIntervalMinutes ?? defaults.refreshIntervalMinutes, 5, 10_080, '刷新周期'),
          defaultMaxInputTokens: this.boundedInteger(input.defaultMaxInputTokens ?? existing?.defaultMaxInputTokens ?? defaults.defaultMaxInputTokens, 1_024, 10_000_000, '默认输入上限'),
          defaultMaxOutputTokens: this.boundedInteger(input.defaultMaxOutputTokens ?? existing?.defaultMaxOutputTokens ?? defaults.defaultMaxOutputTokens, 256, 1_000_000, '默认输出上限'),
        };
        joinEndpoint(channel.baseUrl, channel.modelsPath);
        joinEndpoint(channel.baseUrl, channel.chatPath);
        if (channel.anthropicPath) joinEndpoint(channel.baseUrl, channel.anthropicPath);
        if (channel.geminiPath) {
          if (!channel.geminiPath.includes('{model}')) throw new Error('Gemini 路径必须包含 {model} 占位符');
          joinEndpoint(channel.baseUrl, channel.geminiPath.replace('{model}', 'test-model'));
        }
        return existing ? channels.map((item) => item.id === channelId ? channel! : item) : [...channels, channel];
      });
      if (!channel) throw new Error('渠道保存失败');
      if (input.clearApiKey) await this.sync.saveCredential(channel.id, undefined);
      else if (typeof input.apiKey === 'string' && input.apiKey.trim()) await this.sync.saveCredential(channel.id, input.apiKey);
      await this.sync.saveProfileFromLocal();
      await this.chatBindings.reconcile();
    } catch (error) {
      const rollback = await Promise.allSettled([
        this.storage.updateChannels((channels) => existing
          ? channels.map((item) => item.id === channelId ? existing : item)
          : channels.filter((item) => item.id !== channelId)),
        previousApiKey === undefined ? this.storage.deleteApiKey(channelId) : this.storage.saveApiKey(channelId, previousApiKey),
        this.storage.saveSyncProfile(previousProfile),
        this.storage.saveSyncVault(previousVault),
      ]);
      if (rollback.some((result) => result.status === 'rejected')) {
        throw new Error('渠道保存失败，且无法完整恢复原配置', { cause: error });
      }
      throw error;
    }
    if (!channel) throw new Error('渠道保存失败');
    this.changeEmitter.fire();
    return channel;
  }

  async toggleChannel(channelId: string): Promise<void> {
    await this.storage.updateChannels((channels) => {
      if (!channels.some((item) => item.id === channelId)) throw new Error('渠道不存在');
      return channels.map((item) => item.id === channelId ? { ...item, enabled: !item.enabled } : item);
    });
    await this.sync.saveProfileFromLocal();
    await this.chatBindings.reconcile();
    this.changeEmitter.fire();
  }

  async deleteChannel(channelId: string): Promise<void> {
    this.sync.assertUnlocked();
    await this.storage.updateChannels((channels) => channels.filter((channel) => channel.id !== channelId));
    await this.storage.updateModels((models) => models.filter((model) => model.channelId !== channelId));
    await this.sync.saveCredential(channelId, undefined);
    await this.sync.saveProfileFromLocal();
    await this.chatBindings.reconcile();
    this.changeEmitter.fire();
  }

  async refreshChannel(channelId: string): Promise<CatalogChange> {
    await this.sync.reconcile();
    this.sync.assertUnlocked();
    const result = await this.catalog.refreshChannel(channelId);
    await this.chatBindings.reconcile();
    this.changeEmitter.fire();
    return result.change;
  }

  async refreshAll(dueOnly = false, skipWhenLocked = false): Promise<CatalogRefreshSummary> {
    await this.sync.reconcile();
    if (this.sync.getStatus().locked) {
      if (!skipWhenLocked) throw new Error('请先解锁 API Key 同步');
      this.changeEmitter.fire();
      return { changes: [], failures: [] };
    }
    const summary = await this.catalog.refreshAll(dueOnly);
    await this.chatBindings.reconcile();
    this.changeEmitter.fire();
    return summary;
  }

  async saveModel(input: SaveModelInput): Promise<void> {
    await this.storage.updateModels((models) => {
      const model = models.find((item) => item.channelId === input.channelId && item.id === input.id);
      if (!model) throw new Error('模型不存在');
      const channel = this.storage.getChannels().find((item) => item.id === model.channelId);
      const protocol = input.protocol ?? model.protocol;
      let enabled = input.enabled ?? model.enabled;
      if (enabled && (!channel?.enabled || !model.available || !getProtocolPath(channel, protocol))) throw new Error('当前模型缺少可用的协议端点，无法启用');
      if (!channel || !getProtocolPath(channel, protocol)) enabled = false;
      const customAlias = input.customAlias === undefined ? model.customAlias : input.customAlias.trim() || undefined;
      if (customAlias && customAlias.length > 80) throw new Error('模型别名不能超过 80 个字符');
      const metadataChanged = input.protocol !== undefined || input.maxInputTokens !== undefined || input.maxOutputTokens !== undefined || input.toolCalling !== undefined;
      const updated: CatalogModel = {
        ...model,
        customAlias,
        enabled,
        protocol,
        providerId: channel ? createModelProviderId(channel, model.id, protocol) : model.providerId,
        maxInputTokens: input.maxInputTokens === undefined ? model.maxInputTokens : this.boundedInteger(input.maxInputTokens, 1_024, 10_000_000, '输入上限'),
        maxOutputTokens: input.maxOutputTokens === undefined ? model.maxOutputTokens : this.boundedInteger(input.maxOutputTokens, 256, 1_000_000, '输出上限'),
        toolCalling: input.toolCalling ?? model.toolCalling,
        metadataOverridden: metadataChanged ? true : model.metadataOverridden,
      };
      return models.map((item) => item.channelId === updated.channelId && item.id === updated.id ? updated : item);
    });
    await this.sync.saveProfileFromLocal();
    await this.chatBindings.reconcile();
    this.changeEmitter.fire();
  }

  async enableSync(password: string, confirmation: string): Promise<void> {
    this.assertMatchingPasswords(password, confirmation);
    await this.sync.enable(password);
    this.changeEmitter.fire();
  }

  async unlockSync(password: string): Promise<CatalogRefreshSummary> {
    await this.sync.unlock(password);
    this.changeEmitter.fire();
    return this.refreshAll(false, true);
  }

  async changeSyncPassword(password: string, confirmation: string): Promise<void> {
    this.assertMatchingPasswords(password, confirmation);
    await this.sync.changePassword(password);
    this.changeEmitter.fire();
  }

  async resetSync(): Promise<void> {
    await this.sync.reset();
    this.changeEmitter.fire();
  }

  private parsePreset(value: unknown): ChannelPreset {
    return isChannelPreset(value) ? value : 'custom';
  }

  private requiredText(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`);
    return value.trim();
  }

  private normalizedPath(value: unknown): string {
    const path = this.requiredText(value, '接口路径');
    return `/${path.replace(/^\/+/, '')}`;
  }

  private boundedInteger(value: unknown, min: number, max: number, label: string): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}必须是 ${min} 到 ${max} 之间的整数`);
    return number;
  }

  private optionalPath(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return this.normalizedPath(value);
  }

  private parseDefaultProtocol(value: unknown): ChannelConfig['defaultProtocol'] {
    return value === 'anthropic' || value === 'gemini' ? value : 'openai';
  }

  private parseAuthMode(value: unknown): ChannelAuthMode {
    return value === 'anthropic-api-key' || value === 'google-api-key' ? value : 'bearer';
  }

  private assertMatchingPasswords(password: string, confirmation: string): void {
    if (password !== confirmation) throw new Error('两次输入的同步主密码不一致');
  }
}
