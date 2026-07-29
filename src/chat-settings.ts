import * as vscode from 'vscode';
import { getModelDisplayName, isModelUsable } from './models';
import type { StorageService } from './storage';
import type { CatalogModel, ChannelConfig, ChatBindingRecord, ChatModelTarget, ChatSettingKey } from './types';

export interface ChatSettingSelections {
  utility?: ChatModelTarget;
  utilitySmall?: ChatModelTarget;
  planAgent?: ChatModelTarget;
}

const SETTING_ENTRIES: Array<{ field: keyof ChatSettingSelections; key: ChatSettingKey; label: string }> = [
  { field: 'utility', key: 'chat.utilityModel', label: 'Chat: Utility Model' },
  { field: 'utilitySmall', key: 'chat.utilitySmallModel', label: 'Chat: Utility Small Model' },
  { field: 'planAgent', key: 'chat.planAgent.defaultModel', label: 'Chat: Plan Agent Default Model' },
];

export class ChatBindingService {
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: StorageService) {}

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
    if (selected.length === 0) throw new Error('请至少选择一个要修改的 Chat 模型');
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
    let bindings = originalBindings;
    const snapshots: Array<{ key: ChatSettingKey; hadValue: boolean; value: unknown }> = [];
    try {
      for (const entry of resolved) {
        const existing = bindings.find((binding) => binding.setting === entry.key);
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
        bindings = [...bindings.filter((item) => item.setting !== entry.key), binding];
      }
      await this.storage.saveChatBindings(bindings);
    } catch (error) {
      await this.rollbackSettings(configuration, snapshots);
      await this.storage.saveChatBindings(originalBindings);
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
      await this.storage.saveChatBindings(bindings.filter((item) => item.setting !== setting));
    } catch (error) {
      if (changed) await this.updateSetting(configuration, setting, currentGlobalValue, false).catch(() => undefined);
      await this.storage.saveChatBindings(bindings);
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
      await this.storage.saveChatBindings(retained);
    } catch (error) {
      await this.rollbackSettings(configuration, snapshots);
      await this.storage.saveChatBindings(originalBindings);
      throw error;
    }
    if (restored.length > 0) {
      void vscode.window.showInformationMessage(`所绑定模型已不可用，已恢复 ${restored.length} 项 Chat 原设置。`);
    }
    return restored;
  }

  private settingValue(setting: ChatSettingKey, channel: ChannelConfig, model: CatalogModel): string {
    return setting === 'chat.planAgent.defaultModel'
      ? `${getModelDisplayName(model, channel)} (ai-manager)`
      : `ai-manager/${model.providerId}`;
  }

  private async updateSetting(
    configuration: vscode.WorkspaceConfiguration,
    setting: ChatSettingKey,
    value: unknown,
    openPlanSettingOnFailure = true,
  ): Promise<void> {
    try {
      await configuration.update(setting, value, vscode.ConfigurationTarget.Global);
      const stored = configuration.inspect(setting)?.globalValue;
      if (!Object.is(stored, value)) throw new Error('设置写入后未生效');
    } catch (error) {
      if (setting === 'chat.planAgent.defaultModel' && openPlanSettingOnFailure) {
        void vscode.commands.executeCommand('workbench.action.openSettings', `@id:${setting}`);
        throw new Error('VS Code 未接受 Plan Agent 动态模型值，已打开对应设置供你核对', { cause: error });
      }
      throw error;
    }
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
