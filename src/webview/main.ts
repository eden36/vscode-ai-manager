import type { CatalogModel, ChannelConfig, ChatModelTarget, ChatSettingKey, DashboardState } from '../types';
import type { ChatSettingSelections } from '../chat-settings';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
let state: DashboardState = { channels: [], models: [], chatBindings: {}, sync: { enabled: false, locked: false, hasVault: false } };
const openModelChannels = new Set<string>();
let chatBindingsRendered = false;
let lastStateRevision = -1;
let syncOperationPending = false;

const syncOperations = ['enableSync', 'unlockSync', 'changeSyncPassword', 'resetSync'];

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少界面元素：${id}`);
  return element as T;
};
const value = (id: string): string => byId<HTMLInputElement | HTMLSelectElement>(id).value;
const checked = (id: string): boolean => byId<HTMLInputElement>(id).checked;
const numberValue = (id: string): number => Number(value(id));

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === button.dataset.tab));
  });
});

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { type?: string; revision?: number; operation?: string; payload?: any };
  if (message.type === 'state') {
    if (typeof message.revision === 'number' && message.revision <= lastStateRevision) return;
    if (typeof message.revision === 'number') lastStateRevision = message.revision;
    state = message.payload as DashboardState;
    render();
  } else if (message.type === 'operationSucceeded') {
    if (message.operation === 'saveChannel') closeChannelDialog();
    if (message.operation === 'applyChatSettings' || message.operation === 'restoreChatSetting') chatBindingsRendered = false;
    if (syncOperations.includes(message.operation ?? '')) {
      syncOperationPending = false;
      clearSyncPasswords();
      renderSync();
    }
  } else if (message.type === 'operationCancelled' && syncOperations.includes(message.operation ?? '')) {
    syncOperationPending = false;
    renderSync();
  } else if (message.type === 'operationFailed' && message.operation === 'saveChannel') {
    byId<HTMLButtonElement>('save-channel').disabled = false;
  } else if (message.type === 'operationFailed' && syncOperations.includes(message.operation ?? '')) {
    syncOperationPending = false;
    renderSync();
  }
});

function send(type: string, payload?: unknown): void {
  vscode.postMessage({ type, payload });
}

function render(): void {
  renderChannels();
  renderChatBindings();
  renderSync();
}

function button(text: string, onClick: () => void, className = ''): HTMLButtonElement {
  const result = document.createElement('button');
  result.type = 'button';
  result.textContent = text;
  result.className = className;
  result.addEventListener('click', onClick);
  return result;
}

function renderChannels(): void {
  const container = byId('channel-list');
  container.replaceChildren();
  if (state.channels.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '尚未配置渠道。';
    container.append(empty);
    return;
  }
  for (const channel of state.channels) {
    const card = document.createElement('article');
    card.className = 'card';
    const header = document.createElement('div');
    header.className = 'card-header';
    const title = document.createElement('span');
    title.className = 'card-title';
    title.textContent = channel.name;
    const controls = document.createElement('div');
    controls.append(
      button('编辑', () => openChannelForm(channel)),
      button('测试', () => send('testChannel', { channelId: channel.id })),
      button('刷新', () => send('refreshChannel', { channelId: channel.id })),
      button('删除', () => send('deleteChannel', { channelId: channel.id }), 'danger'),
    );
    header.append(title, controls);
    const badges = document.createElement('div');
    const enabledBadge = document.createElement('button');
    enabledBadge.type = 'button';
    enabledBadge.className = `badge channel-state ${channel.enabled ? 'enabled' : 'disabled'}`;
    enabledBadge.textContent = channel.enabled ? '已启用' : '已停用';
    enabledBadge.title = channel.enabled ? '点击停用渠道' : '点击启用渠道';
    enabledBadge.setAttribute('aria-pressed', String(channel.enabled));
    enabledBadge.addEventListener('click', () => {
      enabledBadge.disabled = true;
      send('toggleChannel', { channelId: channel.id });
    });
    const credentialBadge = document.createElement('span');
    credentialBadge.className = 'badge';
    credentialBadge.textContent = channel.hasCredential ? '已保存密钥' : '无密钥';
    badges.append(enabledBadge, credentialBadge);
    const status = document.createElement('p');
    status.className = `status${channel.lastRefreshError ? ' error' : ''}`;
    status.textContent = channel.lastRefreshError
      ? `刷新失败：${channel.lastRefreshError}${channel.lastRefreshAt ? `；缓存于 ${formatTime(channel.lastRefreshAt)}` : ''}`
      : channel.lastRefreshAt ? `最后刷新：${formatTime(channel.lastRefreshAt)}` : '尚未刷新模型目录';
    card.append(header, badges, status, renderChannelModels(channel));
    container.append(card);
  }
}

function renderChannelModels(channel: ChannelConfig): HTMLElement {
  const wrapper = document.createElement('details');
  wrapper.className = 'models';
  wrapper.open = openModelChannels.has(channel.id);
  const allModels = state.models
    .filter((model) => model.channelId === channel.id)
    .sort((left, right) => left.catalogOrder - right.catalogOrder || left.name.localeCompare(right.name));
  const query = value('model-search').trim().toLocaleLowerCase();
  const filter = value('model-filter');
  const models = allModels.filter((model) => {
    const matchesQuery = !query || `${model.name} ${model.customAlias ?? ''}`.toLocaleLowerCase().includes(query);
    const matchesFilter = filter === 'all'
      || filter === 'enabled' && model.enabled
      || filter === 'disabled' && !model.enabled
      || filter === 'available' && model.available
      || filter === 'unavailable' && !model.available
      || filter === 'openai' && model.protocol === 'openai'
      || filter === 'unsupported' && model.protocol !== 'openai';
    return matchesQuery && matchesFilter;
  });
  const summary = document.createElement('summary');
  const filtered = query || filter !== 'all';
  summary.textContent = filtered
    ? `模型（显示 ${models.length}/${allModels.length}，${allModels.filter((model) => model.enabled).length} 个已启用）`
    : `模型（${allModels.filter((model) => model.enabled).length} 个已启用）`;
  wrapper.append(summary);
  let populated = false;
  const populate = (): void => {
    if (populated) return;
    populated = true;
    if (models.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = allModels.length === 0 ? '刷新后显示模型。' : '没有符合筛选条件的模型。';
      wrapper.append(empty);
    }
    for (const model of models) wrapper.append(renderModelRow(channel, model));
  };
  wrapper.addEventListener('toggle', () => {
    if (wrapper.open) {
      openModelChannels.add(channel.id);
      populate();
    } else {
      openModelChannels.delete(channel.id);
    }
  });
  if (wrapper.open) populate();
  return wrapper;
}

function renderModelRow(channel: ChannelConfig, model: CatalogModel): HTMLElement {
  const row = document.createElement('div');
  row.className = `model-row${model.enabled ? ' enabled' : ''}`;
  const top = document.createElement('div');
  top.className = 'model-config';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'checkbox model-enabled';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = model.enabled;
  enabled.disabled = !channel.enabled || !model.available || model.protocol !== 'openai';
  enabled.addEventListener('change', () => send('saveModel', { channelId: model.channelId, id: model.id, enabled: enabled.checked }));
  enabledLabel.append(enabled, document.createTextNode('启用'));
  const alias = document.createElement('input');
  alias.className = 'model-alias';
  alias.setAttribute('aria-label', `${model.name} 的显示别名`);
  const fallbackAlias = defaultAlias(channel, model);
  alias.value = model.customAlias ?? fallbackAlias;
  alias.maxLength = 80;
  const saveAlias = (): void => {
    const normalized = alias.value.trim();
    const customAlias = !normalized || normalized === fallbackAlias ? '' : normalized;
    if (!normalized) alias.value = fallbackAlias;
    if (customAlias !== (model.customAlias ?? '')) send('saveModel', { channelId: model.channelId, id: model.id, customAlias });
  };
  alias.addEventListener('blur', saveAlias);
  alias.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      alias.blur();
    }
  });
  top.append(enabledLabel, alias);
  const name = document.createElement('div');
  name.className = 'muted';
  const nameLabel = document.createElement('span');
  nameLabel.textContent = '原模型： ';
  const modelName = document.createElement('strong');
  modelName.className = 'model-original-name';
  modelName.textContent = model.name;
  name.append(nameLabel, modelName);
  const metadata = document.createElement('div');
  metadata.className = 'muted';
  metadata.textContent = `${model.protocol} · ${model.available ? '可用' : '目录中已消失'} · ${model.maxInputTokens}/${model.maxOutputTokens} tokens · ${model.toolCalling ? '支持工具' : '未声明工具'}`;
  row.append(top, name, metadata, button('编辑元数据', () => openModelEditor(model)));
  return row;
}

function openChannelForm(channel?: ChannelConfig & { hasCredential?: boolean }): void {
  const dialog = byId<HTMLDialogElement>('channel-dialog');
  byId('channel-form-title').textContent = channel ? '编辑渠道' : '新增渠道';
  const defaults = channel ?? {
    id: '', name: '', preset: 'custom', baseUrl: '', modelsPath: '/v1/models', chatPath: '/v1/chat/completions',
    timeoutMs: 15000, refreshIntervalMinutes: 360, defaultMaxInputTokens: 128000, defaultMaxOutputTokens: 8192, enabled: true,
  };
  byId<HTMLInputElement>('channel-id').value = defaults.id;
  byId<HTMLSelectElement>('channel-preset').value = defaults.preset;
  byId<HTMLInputElement>('channel-name').value = defaults.name;
  byId<HTMLInputElement>('channel-base-url').value = defaults.baseUrl;
  byId<HTMLInputElement>('channel-models-path').value = defaults.modelsPath;
  byId<HTMLInputElement>('channel-chat-path').value = defaults.chatPath;
  byId<HTMLInputElement>('channel-api-key').value = '';
  byId<HTMLInputElement>('channel-api-key').disabled = false;
  byId<HTMLInputElement>('channel-api-key').placeholder = channel ? '留空表示不修改' : '可选';
  byId<HTMLInputElement>('channel-clear-api-key').checked = false;
  byId('channel-clear-api-key-label').hidden = !channel?.hasCredential;
  byId<HTMLButtonElement>('save-channel').disabled = false;
  byId<HTMLInputElement>('channel-timeout').value = String(defaults.timeoutMs);
  byId<HTMLInputElement>('channel-refresh').value = String(defaults.refreshIntervalMinutes);
  byId<HTMLInputElement>('channel-max-input').value = String(defaults.defaultMaxInputTokens);
  byId<HTMLInputElement>('channel-max-output').value = String(defaults.defaultMaxOutputTokens);
  byId<HTMLInputElement>('channel-enabled').checked = defaults.enabled;
  if (!dialog.open) dialog.showModal();
}

byId('new-channel').addEventListener('click', () => openChannelForm());
const closeChannelDialog = (): void => {
  byId<HTMLInputElement>('channel-api-key').value = '';
  byId<HTMLButtonElement>('save-channel').disabled = false;
  const dialog = byId<HTMLDialogElement>('channel-dialog');
  if (dialog.open) dialog.close();
};
byId('cancel-channel').addEventListener('click', closeChannelDialog);
byId('cancel-channel-bottom').addEventListener('click', closeChannelDialog);
byId<HTMLInputElement>('channel-clear-api-key').addEventListener('change', (event) => {
  const clear = (event.target as HTMLInputElement).checked;
  const apiKey = byId<HTMLInputElement>('channel-api-key');
  apiKey.disabled = clear;
  if (clear) apiKey.value = '';
});
byId<HTMLSelectElement>('channel-preset').addEventListener('change', (event) => {
  const values: Record<string, [string, string, string]> = {
    custom: ['', '/v1/models', '/v1/chat/completions'],
    'opencode-go': ['https://opencode.ai', '/zen/go/v1/models', '/zen/go/v1/chat/completions'],
    'opencode-console': ['https://console.opencode.ai', '/inference/openai/v1/models', '/inference/openai/v1/chat/completions'],
  };
  const selected = values[(event.target as HTMLSelectElement).value] ?? values.custom!;
  byId<HTMLInputElement>('channel-base-url').value = selected[0];
  byId<HTMLInputElement>('channel-models-path').value = selected[1];
  byId<HTMLInputElement>('channel-chat-path').value = selected[2];
});
byId<HTMLFormElement>('channel-form').addEventListener('submit', (event) => {
  event.preventDefault();
  byId<HTMLButtonElement>('save-channel').disabled = true;
  send('saveChannel', {
    id: value('channel-id') || undefined,
    preset: value('channel-preset'),
    name: value('channel-name'),
    baseUrl: value('channel-base-url'),
    modelsPath: value('channel-models-path'),
    chatPath: value('channel-chat-path'),
    apiKey: value('channel-api-key'),
    clearApiKey: checked('channel-clear-api-key'),
    timeoutMs: numberValue('channel-timeout'),
    refreshIntervalMinutes: numberValue('channel-refresh'),
    defaultMaxInputTokens: numberValue('channel-max-input'),
    defaultMaxOutputTokens: numberValue('channel-max-output'),
    enabled: checked('channel-enabled'),
  });
});

byId<HTMLInputElement>('model-search').addEventListener('input', renderChannels);
byId<HTMLSelectElement>('model-filter').addEventListener('change', renderChannels);

function openModelEditor(model: CatalogModel): void {
  const container = byId('model-editor');
  const form = document.createElement('form');
  form.className = 'card form-card';
  const heading = document.createElement('h2');
  heading.textContent = `编辑元数据：${model.name}`;
  const inputLabel = numericLabel('输入上限', model.maxInputTokens, 1024);
  const outputLabel = numericLabel('输出上限', model.maxOutputTokens, 256);
  const protocolLabel = document.createElement('label');
  protocolLabel.textContent = '调用协议';
  const protocol = document.createElement('select');
  for (const item of ['openai', 'anthropic', 'gemini', 'unknown']) {
    const option = document.createElement('option');
    option.value = item;
    option.textContent = item;
    protocol.append(option);
  }
  protocol.value = model.protocol;
  protocolLabel.append(protocol);
  const toolsLabel = document.createElement('label');
  toolsLabel.className = 'checkbox';
  const tools = document.createElement('input');
  tools.type = 'checkbox';
  tools.checked = model.toolCalling;
  toolsLabel.append(tools, document.createTextNode('支持工具调用'));
  const actions = document.createElement('div');
  actions.className = 'actions';
  const save = button('保存', () => undefined, 'primary');
  save.type = 'submit';
  actions.append(save, button('取消', () => container.replaceChildren()));
  form.append(heading, protocolLabel, inputLabel.label, outputLabel.label, toolsLabel, actions);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    send('saveModel', { channelId: model.channelId, id: model.id, protocol: protocol.value, maxInputTokens: Number(inputLabel.input.value), maxOutputTokens: Number(outputLabel.input.value), toolCalling: tools.checked });
    container.replaceChildren();
  });
  container.replaceChildren(form);
  form.scrollIntoView({ behavior: 'smooth' });
}

function numericLabel(text: string, current: number, min: number): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement('label');
  label.textContent = text;
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.value = String(current);
  label.append(input);
  return { label, input };
}

const chatRows: Array<{ prefix: string; key: ChatSettingKey; field: keyof ChatSettingSelections }> = [
  { prefix: 'chat-default', key: 'chat.defaultModel', field: 'chatDefault' },
  { prefix: 'inline-chat', key: 'inlineChat.defaultModel', field: 'inlineChat' },
  { prefix: 'plan-agent', key: 'chat.planAgent.defaultModel', field: 'planAgent' },
  { prefix: 'implement-agent', key: 'github.copilot.chat.implementAgent.model', field: 'implementAgent' },
  { prefix: 'utility', key: 'chat.utilityModel', field: 'utility' },
  { prefix: 'utility-small', key: 'chat.utilitySmallModel', field: 'utilitySmall' },
];

for (const row of chatRows) {
  byId<HTMLSelectElement>(`${row.prefix}-channel`).addEventListener('change', () => fillModelPicker(row.prefix));
  byId<HTMLButtonElement>(`${row.prefix}-restore`).addEventListener('click', () => send('restoreChatSetting', { setting: row.key }));
}

function renderChatBindings(): void {
  for (const row of chatRows) {
    const target = state.chatBindings[row.key];
    const channelPicker = byId<HTMLSelectElement>(`${row.prefix}-channel`);
    const modelPicker = byId<HTMLSelectElement>(`${row.prefix}-model`);
    byId<HTMLButtonElement>(`${row.prefix}-restore`).hidden = !target;
    const previousChannelId = channelPicker.value;
    const previousModelId = modelPicker.value;
    const eligibleChannels = state.channels.filter((item) => eligibleModels(item.id).length > 0);
    channelPicker.replaceChildren(option('', '保持原设置'));
    for (const channel of eligibleChannels) {
      channelPicker.append(option(channel.id, channel.name));
    }
    const preferredChannelId = chatBindingsRendered ? previousChannelId : target?.channelId ?? '';
    channelPicker.value = eligibleChannels.some((channel) => channel.id === preferredChannelId) ? preferredChannelId : '';
    const preferredModelId = chatBindingsRendered && channelPicker.value === previousChannelId
      ? previousModelId
      : target?.channelId === channelPicker.value ? target.modelId : undefined;
    fillModelPicker(row.prefix, preferredModelId);
  }
  chatBindingsRendered = true;
}

function fillModelPicker(prefix: string, selectedModelId?: string): void {
  const channelId = value(`${prefix}-channel`);
  const picker = byId<HTMLSelectElement>(`${prefix}-model`);
  picker.replaceChildren(option('', channelId ? '请选择模型' : '请先选择渠道'));
  picker.disabled = !channelId;
  for (const model of eligibleModels(channelId)) {
    const channel = state.channels.find((item) => item.id === channelId)!;
    picker.append(option(model.id, model.customAlias?.trim() || defaultAlias(channel, model)));
  }
  picker.value = selectedModelId ?? '';
}

function eligibleModels(channelId: string): CatalogModel[] {
  if (!state.channels.some((channel) => channel.id === channelId && channel.enabled)) return [];
  return state.models
    .filter((model) => model.channelId === channelId && model.enabled && model.available && model.protocol === 'openai')
    .sort((left, right) => left.catalogOrder - right.catalogOrder || left.name.localeCompare(right.name));
}

byId<HTMLFormElement>('chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const payload: Record<string, ChatModelTarget> = {};
  for (const row of chatRows) {
    const channelId = value(`${row.prefix}-channel`);
    const modelId = value(`${row.prefix}-model`);
    if (channelId && !modelId) {
      send('showError', { message: '选择渠道后还需要选择对应模型' });
      return;
    }
    if (channelId && modelId) payload[row.field] = { channelId, modelId };
  }
  send('applyChatSettings', payload);
});

function renderSync(): void {
  const { enabled, locked, hasVault } = state.sync;
  const status = byId('sync-status');
  const statusType = syncOperationPending ? 'syncing' : enabled && !locked ? 'synced' : 'unsynced';
  status.className = `status sync-status ${statusType}`;
  status.textContent = statusType === 'syncing' ? '同步中' : statusType === 'synced' ? '已同步' : '未同步';
  status.title = syncOperationPending
    ? '正在同步配置和加密保险库。'
    : locked
      ? '已收到同步保险库，当前电脑需要输入主密码解锁。'
      : enabled ? '同步已启用，当前电脑已解锁。' : '尚未启用 AI Manager 跨设备同步。';
  byId<HTMLFormElement>('sync-enable-form').hidden = enabled || hasVault;
  byId<HTMLFormElement>('sync-unlock-form').hidden = !locked;
  byId<HTMLFormElement>('sync-change-form').hidden = !enabled || locked;
  byId<HTMLButtonElement>('sync-reset').hidden = !hasVault;
}

byId<HTMLFormElement>('sync-enable-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendSyncOperation('enableSync', { password: value('sync-enable-password'), confirmation: value('sync-enable-confirmation') });
});

byId<HTMLFormElement>('sync-unlock-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendSyncOperation('unlockSync', { password: value('sync-unlock-password') });
});

byId<HTMLFormElement>('sync-change-form').addEventListener('submit', (event) => {
  event.preventDefault();
  sendSyncOperation('changeSyncPassword', { password: value('sync-change-password'), confirmation: value('sync-change-confirmation') });
});

byId<HTMLButtonElement>('sync-reset').addEventListener('click', () => sendSyncOperation('resetSync'));

function sendSyncOperation(type: string, payload?: unknown): void {
  syncOperationPending = true;
  renderSync();
  send(type, payload);
}

function clearSyncPasswords(): void {
  for (const id of ['sync-enable-password', 'sync-enable-confirmation', 'sync-unlock-password', 'sync-change-password', 'sync-change-confirmation']) {
    byId<HTMLInputElement>(id).value = '';
  }
}

function option(value: string, label: string): HTMLOptionElement {
  const result = document.createElement('option');
  result.value = value;
  result.textContent = label;
  return result;
}

function defaultAlias(channel: ChannelConfig, model: CatalogModel): string {
  return `${channel.name}： ${model.name}`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

send('ready');
