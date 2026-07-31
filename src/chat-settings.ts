import * as vscode from 'vscode';
import { getModelDisplayName, isModelUsable } from './models';
import type { StorageService } from './storage';
import type { SharedChatSetting } from './shared-state';
import type { CatalogModel, ChannelConfig, ChatBindingRecord, ChatModelTarget, ChatSettingKey } from './types';

export interface ChatSettingSelections {
  chatDefault?: ChatModelTarget;
  inlineChat?: ChatModelTarget;
  implementAgent?: ChatModelTarget;
  utility?: ChatModelTarget;
  utilitySmall?: ChatModelTarget;
  planAgent?: ChatModelTarget;
}

const SETTING_ENTRIES: Array<{ field: keyof ChatSettingSelections; key: ChatSettingKey; label: string }> = [
  { field: 'chatDefault', key: 'chat.defaultModel', label: 'Chat 默认模型' },
  { field: 'inlineChat', key: 'inlineChat.defaultModel', label: 'Inline Chat 默认模型' },
  { field: 'planAgent', key: 'chat.planAgent.defaultModel', label: 'Plan Agent 默认模型' },
  { field: 'implementAgent', key: 'github.copilot.chat.implementAgent.model', label: 'Plan 实现阶段模型' },
  { field: 'utility', key: 'chat.utilityModel', label: 'Chat: Utility Model' },
  { field: 'utilitySmall', key: 'chat.utilitySmallModel', label: 'Chat: Utility Small Model' },
];

const QUALIFIED_MODEL_SETTINGS = new Set<ChatSettingKey>([
  'chat.defaultModel',
  'inlineChat.defaultModel',
  'chat.planAgent.defaultModel',
  'github.copilot.chat.implementAgent.model',
]);

export class ChatBindingService implements vscode.Disposable {
  private operationQueue: Promise<void> = Promise.resolve();
  private readonly selfWrites = new Map<ChatSettingKey, unknown>();
  private readonly configurationSubscription: vscode.Disposable | undefined;

  constructor(private readonly storage: StorageService) {
    this.configurationSubscription = vscode.workspace.onDidChangeConfiguration?.((event) => {
      if (!SETTING_ENTRIES.some((entry) => event.affectsConfiguration(entry.key))) return;
      void this.enqueue(() => this.captureManualChanges(event)).catch((error: unknown) => {
        void vscode.window.showWarningMessage(error instanceof Error ? error.message : 'Chat 设置同步失败');
      });
    });
  }

  dispose(): void {
    this.configurationSubscription?.dispose();
  }

  async initialize(): Promise<void> {
    await this.enqueue(async () => {
      if (this.storage.getSharedChatSettings().length === 0) {
        const configuration = vscode.workspace.getConfiguration();
        await this.storage.upsertSharedChatSettings(SETTING_ENTRIES.map((entry) => {
          const value = configuration.inspect(entry.key)?.globalValue;
          return { setting: entry.key, hadValue: value !== undefined, ...(value === undefined ? {} : { value }) };
        }));
      } else {
        await this.applySharedSettingsInternal();
      }
      await this.reconcileInternal();
    });
  }

  async applySharedSettings(): Promise<void> {
    return this.enqueue(() => this.applySharedSettingsInternal());
  }

  getSelections(): Partial<Record<ChatSettingKey, ChatModelTarget>> {
    const models = this.storage.getModels();
    return Object.fromEntries(this.storage.getChatBindings().flatMap((binding) => {
      const model = models.find((item) => item.providerId === binding.providerId);
      return model ? [[binding.setting, { channelId: model.channelId, modelId: model.id }]] : [];
    }));
  }

  async apply(selections: ChatSettingSelections): Promise<void> {
    return this.enqueue(() => this.applyInternal(selections));
  }

  async restore(setting: ChatSettingKey): Promise<void> {
    return this.enqueue(() => this.restoreInternal(setting));
  }

  async reconcile(): Promise<ChatSettingKey[]> {
    return this.enqueue(() => this.reconcileInternal());
  }

  private async applyInternal(selections: ChatSettingSelections): Promise<void> {
    const selected = SETTING_ENTRIES.flatMap((entry) => selections[entry.field] ? [{ ...entry, target: selections[entry.field]! }] : []);
    if (selected.length === 0) return;
    const channels = this.storage.getChannels();
    const models = this.storage.getModels();
    const resolved = selected.map((entry) => {
      const channel = channels.find((item) => item.id === entry.target.channelId);
      const model = models.find((item) => item.channelId === entry.target.channelId && item.id === entry.target.modelId);
      if (!channel || !model || !isModelUsable(model, channel)) throw new Error(`${entry.label} 选择的模型当前不可用`);
      return { ...entry, channel, model };
    });
    const confirmation = await vscode.window.showWarningMessage(
      `将修改 ${resolved.map((entry) => entry.label).join('、')}，是否继续？`,
      { modal: true },
      '应用',
    );
    if (confirmation !== '应用') return;

    const configuration = vscode.workspace.getConfiguration();
    const originalBindings = this.storage.getChatBindings();
    const applied: ChatBindingRecord[] = [];
    const snapshots: Array<{ key: ChatSettingKey; hadValue: boolean; value: unknown }> = [];
    try {
      for (const entry of resolved) {
        const existing = originalBindings.find((binding) => binding.setting === entry.key);
        const currentGlobalValue = configuration.inspect(entry.key)?.globalValue;
        snapshots.push({ key: entry.key, hadValue: currentGlobalValue !== undefined, value: currentGlobalValue });
        const preservePrevious = existing && Object.is(currentGlobalValue, existing.appliedValue);
        const appliedValue = this.settingValue(entry.key, entry.channel, entry.model);
        await this.updateSetting(configuration, entry.key, appliedValue);
        const binding: ChatBindingRecord = {
          setting: entry.key,
          providerId: entry.model.providerId,
          appliedValue,
          previousHadGlobalValue: preservePrevious ? existing.previousHadGlobalValue : currentGlobalValue !== undefined,
          ...(preservePrevious
            ? existing.previousHadGlobalValue ? { previousGlobalValue: existing.previousGlobalValue } : {}
            : currentGlobalValue !== undefined ? { previousGlobalValue: currentGlobalValue } : {}),
        };
        applied.push(binding);
      }
      await this.storage.upsertChatBindings(applied);
      await this.saveSharedValues(resolved.map((entry) => ({
        setting: entry.key,
        hadValue: true,
        value: this.settingValue(entry.key, entry.channel, entry.model),
      })));
      for (const entry of resolved) await this.storage.saveChatApplicationError(entry.key, undefined);
    } catch (error) {
      const failed = snapshots.at(-1);
      if (failed) await this.storage.saveChatApplicationError(
        failed.key,
        error instanceof Error ? error.message : 'Chat 设置应用失败',
      );
      await this.rollbackSettings(configuration, snapshots);
      await this.restoreBindings(resolved.map((entry) => entry.key), originalBindings);
      throw error;
    }
    void vscode.window.showInformationMessage(`已应用 ${resolved.length} 项 Chat 设置。`);
  }

  private async restoreInternal(setting: ChatSettingKey): Promise<void> {
    const bindings = this.storage.getChatBindings();
    const binding = bindings.find((item) => item.setting === setting);
    if (!binding) throw new Error('该设置当前没有 AI Manager 绑定');
    const entry = SETTING_ENTRIES.find((item) => item.key === setting)!;
    const confirmation = await vscode.window.showWarningMessage(
      `将恢复 ${entry.label} 的绑定前设置，是否继续？`,
      { modal: true },
      '恢复',
    );
    if (confirmation !== '恢复') return;
    const configuration = vscode.workspace.getConfiguration();
    const currentGlobalValue = configuration.inspect(setting)?.globalValue;
    let changed = false;
    try {
      if (Object.is(currentGlobalValue, binding.appliedValue)) {
        await this.updateSetting(configuration, setting, binding.previousHadGlobalValue ? binding.previousGlobalValue : undefined);
        changed = true;
      }
      await this.storage.deleteChatBindings([setting]);
      await this.saveSharedValues([{
        setting,
        hadValue: binding.previousHadGlobalValue,
        ...(binding.previousHadGlobalValue ? { value: binding.previousGlobalValue } : {}),
      }]);
      await this.storage.saveChatApplicationError(setting, undefined);
    } catch (error) {
      await this.storage.saveChatApplicationError(setting, error instanceof Error ? error.message : 'Chat 设置恢复失败');
      if (changed) await this.updateSetting(configuration, setting, currentGlobalValue, false).catch(() => undefined);
      await this.storage.upsertChatBindings([binding]);
      throw error;
    }
    void vscode.window.showInformationMessage(`${entry.label} 已恢复绑定前设置。`);
  }

  private async reconcileInternal(): Promise<ChatSettingKey[]> {
    const channels = this.storage.getChannels();
    const models = this.storage.getModels();
    const configuration = vscode.workspace.getConfiguration();
    const retained: ChatBindingRecord[] = [];
    const restored: ChatSettingKey[] = [];
    const originalBindings = this.storage.getChatBindings();
    const snapshots: Array<{ key: ChatSettingKey; hadValue: boolean; value: unknown }> = [];
    try {
      for (const binding of originalBindings) {
        const model = models.find((item) => item.providerId === binding.providerId);
        const channel = model ? channels.find((item) => item.id === model.channelId) : undefined;
        const currentGlobalValue = configuration.inspect(binding.setting)?.globalValue;
        if (!model || !channel || !isModelUsable(model, channel)) {
          if (Object.is(currentGlobalValue, binding.appliedValue)) {
            snapshots.push({ key: binding.setting, hadValue: currentGlobalValue !== undefined, value: currentGlobalValue });
            await this.updateSetting(configuration, binding.setting, binding.previousHadGlobalValue ? binding.previousGlobalValue : undefined);
            restored.push(binding.setting);
          }
          continue;
        }
        const expectedValue = this.settingValue(binding.setting, channel, model);
        if (expectedValue !== binding.appliedValue) {
          if (!Object.is(currentGlobalValue, binding.appliedValue)) continue;
          snapshots.push({ key: binding.setting, hadValue: currentGlobalValue !== undefined, value: currentGlobalValue });
          await this.updateSetting(configuration, binding.setting, expectedValue);
          retained.push({ ...binding, appliedValue: expectedValue });
        } else if (Object.is(currentGlobalValue, binding.appliedValue)) {
          retained.push(binding);
        }
      }
      const retainedKeys = new Set(retained.map((binding) => binding.setting));
      await this.storage.upsertChatBindings(retained);
      await this.storage.deleteChatBindings(
        originalBindings.flatMap((binding) => retainedKeys.has(binding.setting) ? [] : [binding.setting]),
      );
      await this.saveSharedValues([
        ...retained.map((binding) => ({ setting: binding.setting, hadValue: true, value: binding.appliedValue })),
        ...restored.map((setting) => {
          const binding = originalBindings.find((item) => item.setting === setting)!;
          return {
            setting,
            hadValue: binding.previousHadGlobalValue,
            ...(binding.previousHadGlobalValue ? { value: binding.previousGlobalValue } : {}),
          };
        }),
      ]);
      for (const snapshot of snapshots) await this.storage.saveChatApplicationError(snapshot.key, undefined);
    } catch (error) {
      const failed = snapshots.at(-1);
      if (failed) await this.storage.saveChatApplicationError(
        failed.key,
        error instanceof Error ? error.message : 'Chat 设置协调失败',
      );
      await this.rollbackSettings(configuration, snapshots);
      await this.restoreBindings(originalBindings.map((binding) => binding.setting), originalBindings);
      throw error;
    }
    if (restored.length > 0) {
      void vscode.window.showInformationMessage(`所绑定模型已不可用，已恢复 ${restored.length} 项 Chat 原设置。`);
    }
    return restored;
  }

  private settingValue(setting: ChatSettingKey, channel: ChannelConfig, model: CatalogModel): string {
    return QUALIFIED_MODEL_SETTINGS.has(setting)
      ? `${getModelDisplayName(model, channel)} (ai-manager)`
      : `ai-manager/${model.providerId}`;
  }

  private async updateSetting(
    configuration: vscode.WorkspaceConfiguration,
    setting: ChatSettingKey,
    value: unknown,
    openSettingOnFailure = true,
  ): Promise<void> {
    // 值已一致时直接返回：VS Code 不会为无变化的写入触发配置事件，
    // 留下的 selfWrites 标记会把用户后续的同值手动修改误判为自写。
    if (Object.is(configuration.inspect(setting)?.globalValue, value)) return;
    try {
      this.selfWrites.set(setting, value);
      await configuration.update(setting, value, vscode.ConfigurationTarget.Global);
      const stored = configuration.inspect(setting)?.globalValue;
      if (!Object.is(stored, value)) throw new Error('设置写入后未生效');
    } catch (error) {
      this.selfWrites.delete(setting);
      if (QUALIFIED_MODEL_SETTINGS.has(setting) && openSettingOnFailure) {
        void vscode.commands.executeCommand('workbench.action.openSettings', `@id:${setting}`);
        const label = SETTING_ENTRIES.find((entry) => entry.key === setting)?.label ?? setting;
        throw new Error(`VS Code 无法应用“${label}”模型值，可能是当前版本不支持或组织策略已锁定；已打开对应设置供你核对`, { cause: error });
      }
      throw error;
    }
  }

  private async applySharedSettingsInternal(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration();
    const snapshots: Array<{ key: ChatSettingKey; hadValue: boolean; value: unknown }> = [];
    try {
      for (const setting of this.storage.getSharedChatSettings()) {
        const current = configuration.inspect(setting.setting)?.globalValue;
        const expected = setting.hadValue ? setting.value : undefined;
        if (Object.is(current, expected)) continue;
        snapshots.push({ key: setting.setting, hadValue: current !== undefined, value: current });
        try {
          await this.updateSetting(configuration, setting.setting, expected);
          await this.storage.saveChatApplicationError(setting.setting, undefined);
        } catch (error) {
          await this.storage.saveChatApplicationError(
            setting.setting,
            error instanceof Error ? error.message : '共享 Chat 设置应用失败',
          );
          throw error;
        }
      }
    } catch (error) {
      await this.rollbackSettings(configuration, snapshots);
      throw error;
    }
  }

  private async captureManualChanges(event: vscode.ConfigurationChangeEvent): Promise<void> {
    const configuration = vscode.workspace.getConfiguration();
    const bindings = this.storage.getChatBindings();
    const changes: SharedChatSetting[] = [];
    const unbound: ChatSettingKey[] = [];
    for (const entry of SETTING_ENTRIES) {
      if (!event.affectsConfiguration(entry.key)) continue;
      const current = configuration.inspect(entry.key)?.globalValue;
      if (this.selfWrites.has(entry.key) && Object.is(this.selfWrites.get(entry.key), current)) {
        this.selfWrites.delete(entry.key);
        continue;
      }
      this.selfWrites.delete(entry.key);
      changes.push({ setting: entry.key, hadValue: current !== undefined, ...(current === undefined ? {} : { value: current }) });
      await this.storage.saveChatApplicationError(entry.key, undefined);
      const binding = bindings.find((item) => item.setting === entry.key);
      if (binding && !Object.is(binding.appliedValue, current)) unbound.push(entry.key);
    }
    await this.storage.deleteChatBindings(unbound);
    await this.saveSharedValues(changes);
  }

  private async saveSharedValues(changes: readonly SharedChatSetting[]): Promise<void> {
    await this.storage.upsertSharedChatSettings(changes);
  }

  /** 定向恢复指定设置的绑定：原来不存在的键改为删除，避免整表覆盖其他 Profile 的记录。 */
  private async restoreBindings(
    settings: readonly ChatSettingKey[],
    originalBindings: readonly ChatBindingRecord[],
  ): Promise<void> {
    const previous = originalBindings.filter((binding) => settings.includes(binding.setting));
    const previousKeys = new Set(previous.map((binding) => binding.setting));
    await this.storage.upsertChatBindings(previous);
    await this.storage.deleteChatBindings(settings.filter((setting) => !previousKeys.has(setting)));
  }

  private async rollbackSettings(
    configuration: vscode.WorkspaceConfiguration,
    snapshots: Array<{ key: ChatSettingKey; hadValue: boolean; value: unknown }>,
  ): Promise<void> {
    for (const snapshot of [...snapshots].reverse()) {
      await this.updateSetting(configuration, snapshot.key, snapshot.hadValue ? snapshot.value : undefined, false).catch(() => undefined);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation);
    this.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}
