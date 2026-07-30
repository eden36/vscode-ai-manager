import * as vscode from 'vscode';
import type { EncryptedVault, SyncProfile } from './sync';
import type { CatalogModel, ChannelConfig, ChatBindingRecord } from './types';

const CHANNELS_KEY = 'aiManager.channels';
const MODELS_KEY = 'aiManager.models';
const BINDINGS_KEY = 'aiManager.chatBindings';
const SYNC_PROFILE_KEY = 'aiManager.sync.profile.v1';
const SYNC_VAULT_KEY = 'aiManager.sync.vault.v1';
const SYNC_LOCAL_KEY = 'aiManager.sync.localKey.v1';

export class StorageService {
  private stateWriteQueue: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  registerSyncKeys(): void {
    this.context.globalState.setKeysForSync([SYNC_PROFILE_KEY, SYNC_VAULT_KEY]);
  }

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

  getSyncProfile(): SyncProfile | undefined {
    return this.context.globalState.get<SyncProfile>(SYNC_PROFILE_KEY);
  }

  async saveSyncProfile(profile: SyncProfile | undefined): Promise<void> {
    await this.enqueueStateWrite(() => this.context.globalState.update(SYNC_PROFILE_KEY, profile));
  }

  getSyncVault(): EncryptedVault | undefined {
    return this.context.globalState.get<EncryptedVault>(SYNC_VAULT_KEY);
  }

  async saveSyncVault(vault: EncryptedVault | undefined): Promise<void> {
    await this.enqueueStateWrite(() => this.context.globalState.update(SYNC_VAULT_KEY, vault));
  }

  async getSyncLocalKey(): Promise<string | undefined> {
    return this.context.secrets.get(SYNC_LOCAL_KEY);
  }

  async saveSyncLocalKey(key: string): Promise<void> {
    await this.context.secrets.store(SYNC_LOCAL_KEY, key);
  }

  async deleteSyncLocalKey(): Promise<void> {
    await this.context.secrets.delete(SYNC_LOCAL_KEY);
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
