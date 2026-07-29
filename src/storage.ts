import * as vscode from 'vscode';
import type { CatalogModel, ChannelConfig, ChatBindingRecord } from './types';

const CHANNELS_KEY = 'aiManager.channels';
const MODELS_KEY = 'aiManager.models';
const ALIASES_KEY = 'aiManager.aliases';
const BINDINGS_KEY = 'aiManager.chatBindings';
const SCHEMA_VERSION_KEY = 'aiManager.schemaVersion';

export interface LegacyAlias {
  id: string;
  name: string;
}

export class StorageService {
  private stateWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  getChannels(): ChannelConfig[] {
    return this.context.globalState.get<ChannelConfig[]>(CHANNELS_KEY, []);
  }

  getModels(): CatalogModel[] {
    return this.context.globalState.get<CatalogModel[]>(MODELS_KEY, []);
  }

  async saveChannels(channels: ChannelConfig[]): Promise<void> {
    await this.enqueueStateWrite(() => this.context.globalState.update(CHANNELS_KEY, channels));
  }

  async updateChannels(update: (channels: ChannelConfig[]) => ChannelConfig[]): Promise<ChannelConfig[]> {
    return this.enqueueStateWrite(async () => {
      const channels = update(this.getChannels());
      await this.context.globalState.update(CHANNELS_KEY, channels);
      return channels;
    });
  }

  async saveModels(models: CatalogModel[]): Promise<void> {
    await this.enqueueStateWrite(() => this.context.globalState.update(MODELS_KEY, models));
  }

  async updateModels(update: (models: CatalogModel[]) => CatalogModel[]): Promise<CatalogModel[]> {
    return this.enqueueStateWrite(async () => {
      const models = update(this.getModels());
      await this.context.globalState.update(MODELS_KEY, models);
      return models;
    });
  }

  getChatBindings(): ChatBindingRecord[] {
    return this.context.globalState.get<ChatBindingRecord[]>(BINDINGS_KEY, []);
  }

  async saveChatBindings(bindings: ChatBindingRecord[]): Promise<void> {
    await this.enqueueStateWrite(() => this.context.globalState.update(BINDINGS_KEY, bindings));
  }

  getSchemaVersion(): number {
    return this.context.globalState.get<number>(SCHEMA_VERSION_KEY, 1);
  }

  getLegacyAliases(): LegacyAlias[] {
    return this.context.globalState.get<LegacyAlias[]>(ALIASES_KEY, []);
  }

  async completeModelSchemaMigration(models: CatalogModel[]): Promise<void> {
    await this.saveModels(models);
    await this.context.globalState.update(ALIASES_KEY, undefined);
    await this.context.globalState.update(SCHEMA_VERSION_KEY, 2);
  }

  async getApiKey(channelId: string): Promise<string | undefined> {
    return this.context.secrets.get(this.secretKey(channelId));
  }

  async hasApiKey(channelId: string): Promise<boolean> {
    return Boolean(await this.getApiKey(channelId));
  }

  async saveApiKey(channelId: string, apiKey: string): Promise<void> {
    const value = apiKey.trim();
    if (value) {
      await this.context.secrets.store(this.secretKey(channelId), value);
    }
  }

  async deleteApiKey(channelId: string): Promise<void> {
    await this.context.secrets.delete(this.secretKey(channelId));
  }

  private secretKey(channelId: string): string {
    return `aiManager.channel.${channelId}.apiKey`;
  }

  private enqueueStateWrite<T>(operation: () => PromiseLike<T>): Promise<T> {
    const result = this.stateWriteQueue.then(operation);
    this.stateWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
