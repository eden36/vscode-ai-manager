import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { StorageService, LegacyAlias } from './storage';
import type { ChatSettingKey } from './types';

const CHAT_KEYS: ChatSettingKey[] = ['chat.utilityModel', 'chat.utilitySmallModel', 'chat.planAgent.defaultModel'];

export async function migrateModelSchema(storage: StorageService): Promise<LegacyAlias[]> {
  if (storage.getSchemaVersion() >= 2) return [];
  const legacyAliases = storage.getLegacyAliases();
  const orderByChannel = new Map<string, number>();
  const models = storage.getModels().map((model) => {
    const catalogOrder = orderByChannel.get(model.channelId) ?? 0;
    orderByChannel.set(model.channelId, catalogOrder + 1);
    return {
      ...model,
      providerId: model.providerId || randomUUID(),
      customAlias: undefined,
      enabled: false,
      catalogOrder,
    };
  });
  await storage.completeModelSchemaMigration(models);
  return legacyAliases;
}

export async function offerLegacyChatSettingsCleanup(legacyAliases: readonly LegacyAlias[]): Promise<void> {
  if (legacyAliases.length === 0) return;
  const configuration = vscode.workspace.getConfiguration();
  const legacyIds = new Set(legacyAliases.map((alias) => `ai-manager/${alias.id}`));
  const legacyPlanNames = new Set(legacyAliases.map((alias) => `${alias.name} (ai-manager)`));
  const staleKeys = CHAT_KEYS.filter((key) => {
    const value = configuration.inspect(key)?.globalValue;
    return typeof value === 'string' && (legacyIds.has(value) || legacyPlanNames.has(value));
  });
  if (staleKeys.length === 0) return;
  const choice = await vscode.window.showWarningMessage(
    `检测到 ${staleKeys.length} 项旧版 AI Manager Chat 绑定。旧别名已清除，是否同时恢复这些设置的 VS Code 默认值？`,
    { modal: true },
    '清理旧绑定',
  );
  if (choice !== '清理旧绑定') return;
  await Promise.all(staleKeys.map((key) => configuration.update(key, undefined, vscode.ConfigurationTarget.Global)));
}
