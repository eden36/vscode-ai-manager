import type { CatalogModel, ChannelConfig, ChatModelTarget, ChatSettingKey, DashboardState } from '../types';
import type { ChatSettingSelections } from '../chat-settings';
import { createChannelDefaults, isChannelPreset, PRESET_VALUES } from '../presets';
import { catalogMetadataBaseline } from '../catalog-metadata';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
let state: DashboardState = {
  channels: [],
  models: [],
  chatBindings: {},
  chatErrors: {},
  sync: { enabled: false, locked: false, hasVault: false, localShared: true, cloudState: 'waiting' },
};
const selectedModelIds = new Map<string, string>();
const modelSearchTerms = new Map<string, string>();
let activeModelPickerChannelId: string | null = null;
let modelPickerOverlay: HTMLElement | null = null;
let modelPickerOptions: HTMLElement | null = null;
let modelPickerListenersBound = false;
let chatBindingsRendered = false;
let lastStateRevision = -1;

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
  } else if (message.type === 'operationFailed' && message.operation === 'saveChannel') {
    byId<HTMLButtonElement>('save-channel').disabled = false;
  }
});

function send(type: string, payload?: unknown): void {
  vscode.postMessage({ type, payload });
}

function render(): void {
  renderSyncBanner();
  renderChannels();
  renderChatBindings();
  if (activeModelPickerChannelId) {
    refreshModelPickerOverlay();
    syncModelPickerOverlay();
  }
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
    card.dataset.channelId = channel.id;
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

function channelModels(channelId: string): CatalogModel[] {
  return state.models
    .filter((model) => model.channelId === channelId)
    .sort((left, right) => left.catalogOrder - right.catalogOrder || left.name.localeCompare(right.name));
}

function sortModelsForPicker(models: CatalogModel[]): CatalogModel[] {
  return [...models].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return left.catalogOrder - right.catalogOrder || left.name.localeCompare(right.name);
  });
}

function currentChannel(channelId: string, fallback?: ChannelConfig): ChannelConfig {
  return state.channels.find((item) => item.id === channelId) ?? fallback ?? { id: channelId, name: '', ...createChannelDefaults('custom') };
}

function modelPickerTitleText(channelId: string): string {
  const allModels = channelModels(channelId);
  const query = (modelSearchTerms.get(channelId) ?? '').trim().toLocaleLowerCase();
  const models = allModels.filter((model) => !query || `${model.name} ${model.customAlias ?? ''}`.toLocaleLowerCase().includes(query));
  const enabledCount = allModels.filter((model) => model.enabled).length;
  return query
    ? `模型（显示 ${models.length}/${allModels.length}，${enabledCount} 个已启用）`
    : `模型（${enabledCount} 个已启用）`;
}

function modelPickerAnchor(channelId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-channel-id="${channelId}"] .model-combobox`);
}

function ensureModelPickerOverlay(): { overlay: HTMLElement; options: HTMLElement } {
  if (!modelPickerOverlay || !modelPickerOptions) {
    modelPickerOverlay = document.createElement('div');
    modelPickerOverlay.id = 'model-picker-overlay';
    modelPickerOverlay.className = 'model-picker-overlay';
    modelPickerOverlay.hidden = true;
    modelPickerOptions = document.createElement('div');
    modelPickerOptions.className = 'model-options';
    modelPickerOptions.setAttribute('role', 'listbox');
    modelPickerOverlay.append(modelPickerOptions);
    document.body.append(modelPickerOverlay);
  }
  if (!modelPickerListenersBound) {
    modelPickerListenersBound = true;
    document.addEventListener('mousedown', handleModelPickerOutsidePointer);
    window.addEventListener('resize', syncModelPickerOverlay);
    document.addEventListener('scroll', syncModelPickerOverlay, true);
    modelPickerOverlay.addEventListener('mousedown', (event) => event.preventDefault());
  }
  return { overlay: modelPickerOverlay, options: modelPickerOptions };
}

function isModelPickerOpen(channelId: string): boolean {
  return activeModelPickerChannelId === channelId && !!modelPickerOverlay && !modelPickerOverlay.hidden;
}

function setModelPickerExpanded(channelId: string, expanded: boolean): void {
  const combobox = modelPickerAnchor(channelId);
  const search = document.querySelector<HTMLInputElement>(`[data-channel-id="${channelId}"] .model-picker-search`);
  search?.setAttribute('aria-expanded', String(expanded));
  combobox?.classList.toggle('is-open', expanded);
  combobox?.querySelector('.model-combobox-toggle')?.setAttribute('aria-expanded', String(expanded));
}

function openModelPicker(channelId: string): void {
  if (!modelPickerAnchor(channelId)) return;
  const opening = !isModelPickerOpen(channelId);
  activeModelPickerChannelId = channelId;
  const { overlay } = ensureModelPickerOverlay();
  overlay.hidden = false;
  setModelPickerExpanded(channelId, true);
  refreshModelPickerOverlay(opening);
  syncModelPickerOverlay();
}

function closeModelPicker(): void {
  if (activeModelPickerChannelId) setModelPickerExpanded(activeModelPickerChannelId, false);
  activeModelPickerChannelId = null;
  if (modelPickerOverlay) modelPickerOverlay.hidden = true;
}

function syncModelPickerOverlay(): void {
  if (!activeModelPickerChannelId || !modelPickerOverlay || modelPickerOverlay.hidden) return;
  const anchor = modelPickerAnchor(activeModelPickerChannelId);
  if (!anchor) {
    closeModelPicker();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  modelPickerOverlay.style.top = `${rect.bottom + 1}px`;
  modelPickerOverlay.style.left = `${rect.left}px`;
  modelPickerOverlay.style.width = `${rect.width}px`;
}

function handleModelPickerOutsidePointer(event: MouseEvent): void {
  if (!activeModelPickerChannelId || !modelPickerOverlay || modelPickerOverlay.hidden) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (modelPickerOverlay.contains(target)) return;
  const anchor = modelPickerAnchor(activeModelPickerChannelId);
  if (anchor?.contains(target)) return;
  closeModelPicker();
}

function modelPickerDisplayName(model: CatalogModel): string {
  return model.name;
}

function refreshModelPickerOverlay(resetScroll = false): void {
  if (!activeModelPickerChannelId) return;
  const channelId = activeModelPickerChannelId;
  const { options } = ensureModelPickerOverlay();
  const channel = currentChannel(channelId);
  const allModels = channelModels(channelId);
  const scrollTop = resetScroll ? 0 : options.scrollTop;
  const query = (modelSearchTerms.get(channelId) ?? '').trim().toLocaleLowerCase();
  const models = sortModelsForPicker(allModels.filter((model) => !query || `${model.name} ${model.customAlias ?? ''}`.toLocaleLowerCase().includes(query)));
  const selectedId = selectedModelIds.get(channelId) ?? allModels[0]?.id;
  const title = document.querySelector(`[data-channel-id="${channelId}"] .model-picker-title`);
  if (title) title.textContent = modelPickerTitleText(channelId);
  options.replaceChildren();
  if (models.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = allModels.length === 0 ? '刷新后显示模型。' : '没有符合搜索条件的模型。';
    options.append(empty);
    options.scrollTop = scrollTop;
    return;
  }
  for (const model of models) {
    const item = document.createElement('div');
    item.className = 'model-option';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(model.id === selectedId));
    const label = modelPickerDisplayName(model);
    const select = button(label, () => selectModelFromPicker(channelId, model), 'model-option-select');
    const toggleModel = button(model.enabled ? '停用' : '启用', () => {
      send('saveModel', { channelId: model.channelId, id: model.id, enabled: !model.enabled });
    }, 'model-option-toggle');
    toggleModel.disabled = !channel.enabled || !model.available || !protocolConfigured(channel, model.protocol);
    item.append(select, toggleModel);
    const enabledCheck = document.createElement('span');
    enabledCheck.className = 'model-enabled-check';
    if (model.enabled) {
      enabledCheck.textContent = '✓';
      enabledCheck.setAttribute('aria-label', '已启用');
    } else {
      enabledCheck.setAttribute('aria-hidden', 'true');
    }
    item.append(enabledCheck);
    options.append(item);
  }
  options.scrollTop = scrollTop;
}

function selectModelFromPicker(channelId: string, model: CatalogModel): void {
  selectedModelIds.set(channelId, model.id);
  modelSearchTerms.delete(channelId);
  const channel = currentChannel(channelId);
  const label = modelPickerDisplayName(model);
  const search = document.querySelector<HTMLInputElement>(`[data-channel-id="${channelId}"] .model-picker-search`);
  if (search) search.value = label;
  const selectedModelContainer = document.querySelector(`[data-channel-id="${channelId}"] .selected-model-container`);
  selectedModelContainer?.replaceChildren(renderModelRow(channel, model));
  closeModelPicker();
}

function renderChannelModels(channel: ChannelConfig): HTMLElement {
  const wrapper = document.createElement('section');
  wrapper.className = 'models';
  wrapper.dataset.channelId = channel.id;
  const channelId = channel.id;
  const pickerLabel = document.createElement('label');
  pickerLabel.className = 'model-picker';
  const pickerTitle = document.createElement('span');
  pickerTitle.className = 'model-picker-title';
  pickerTitle.textContent = modelPickerTitleText(channelId);
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'model-picker-search';
  search.placeholder = '搜索或选择模型';
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list');
  search.setAttribute('aria-controls', 'model-picker-overlay');
  search.setAttribute('aria-expanded', String(isModelPickerOpen(channelId)));
  const combobox = document.createElement('div');
  combobox.className = 'model-combobox';
  const toggle = button('', () => undefined, 'model-combobox-toggle');
  toggle.setAttribute('aria-label', '显示模型列表');
  toggle.setAttribute('aria-expanded', String(isModelPickerOpen(channelId)));
  combobox.append(search, toggle);
  pickerLabel.append(pickerTitle, combobox);
  const selectedModelContainer = document.createElement('div');
  selectedModelContainer.className = 'selected-model-container';
  const allModels = channelModels(channelId);
  const selectedModel = (): CatalogModel | undefined => allModels.find((model) => model.id === selectedModelIds.get(channelId)) ?? allModels[0];
  const initialModel = selectedModel();
  if (initialModel) {
    search.value = modelPickerDisplayName(initialModel);
    selectedModelContainer.replaceChildren(renderModelRow(channel, initialModel));
  } else {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '刷新后显示模型。';
    selectedModelContainer.append(empty);
    search.disabled = true;
    toggle.disabled = true;
  }
  search.addEventListener('input', () => {
    modelSearchTerms.set(channelId, search.value);
    openModelPicker(channelId);
  });
  search.addEventListener('focus', () => {
    openModelPicker(channelId);
    search.select();
  });
  search.addEventListener('click', () => openModelPicker(channelId));
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      const current = selectedModel();
      if (current) search.value = modelPickerDisplayName(current);
      modelSearchTerms.delete(channelId);
      closeModelPicker();
      return;
    }
    if (!isModelPickerOpen(channelId)) openModelPicker(channelId);
  });
  toggle.addEventListener('mousedown', (event) => event.preventDefault());
  toggle.addEventListener('click', () => {
    if (isModelPickerOpen(channelId)) {
      closeModelPicker();
      return;
    }
    modelSearchTerms.delete(channelId);
    search.value = '';
    openModelPicker(channelId);
    search.focus();
  });
  wrapper.append(pickerLabel, selectedModelContainer);
  return wrapper;
}

function renderModelRow(channel: ChannelConfig, model: CatalogModel): HTMLElement {
  const row = document.createElement('div');
  row.className = 'model-row';
  const top = document.createElement('div');
  top.className = 'model-config';
  const nameRow = document.createElement('div');
  nameRow.className = 'model-config-row model-name-row';
  const nameText = document.createElement('span');
  nameText.className = 'model-config-label';
  nameText.textContent = '模型名';
  const modelName = document.createElement('strong');
  modelName.className = 'model-original-name';
  modelName.textContent = model.name;
  nameRow.append(nameText, modelName);
  const aliasRow = document.createElement('div');
  aliasRow.className = 'model-config-row model-alias-row';
  const aliasText = document.createElement('span');
  aliasText.className = 'model-config-label';
  aliasText.textContent = '别名';
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
  aliasRow.append(aliasText, alias);
  const enabledRow = document.createElement('label');
  enabledRow.className = 'model-config-row model-enabled-row';
  const enabledText = document.createElement('span');
  enabledText.className = 'model-config-label';
  enabledText.textContent = '启用';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  enabled.checked = model.enabled;
  enabled.disabled = !channel.enabled || !model.available || !protocolConfigured(channel, model.protocol);
  enabled.addEventListener('change', () => send('saveModel', { channelId: model.channelId, id: model.id, enabled: enabled.checked }));
  enabledRow.append(enabledText, enabled);
  top.append(nameRow, aliasRow, enabledRow);
  const metadata = document.createElement('div');
  metadata.className = 'muted';
  metadata.textContent = `${model.protocol} · ${model.available ? '可用' : '目录中已消失'} · ${model.maxInputTokens}/${model.maxOutputTokens} tokens · ${model.toolCalling ? '支持工具' : '未声明工具'}`;
  row.append(top, metadata, button('编辑元数据', () => openModelEditor(model)));
  return row;
}

function openChannelForm(channel?: ChannelConfig & { hasCredential?: boolean }): void {
  const dialog = byId<HTMLDialogElement>('channel-dialog');
  byId('channel-form-title').textContent = channel ? '编辑渠道' : '新增渠道';
  const defaults = channel ?? { id: '', name: '', ...createChannelDefaults('custom') };
  byId<HTMLInputElement>('channel-id').value = defaults.id;
  byId<HTMLSelectElement>('channel-preset').value = defaults.preset;
  byId<HTMLInputElement>('channel-name').value = defaults.name;
  byId<HTMLInputElement>('channel-base-url').value = defaults.baseUrl;
  byId<HTMLInputElement>('channel-models-path').value = defaults.modelsPath;
  byId<HTMLInputElement>('channel-chat-path').value = defaults.chatPath;
  byId<HTMLInputElement>('channel-anthropic-path').value = defaults.anthropicPath ?? '';
  byId<HTMLInputElement>('channel-gemini-path').value = defaults.geminiPath ?? '';
  byId<HTMLSelectElement>('channel-default-protocol').value = defaults.defaultProtocol;
  byId<HTMLSelectElement>('channel-auth-mode').value = defaults.authMode;
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
  const preset = (event.target as HTMLSelectElement).value;
  const selected = PRESET_VALUES[isChannelPreset(preset) ? preset : 'custom'];
  byId<HTMLInputElement>('channel-base-url').value = selected.baseUrl;
  byId<HTMLInputElement>('channel-models-path').value = selected.modelsPath;
  byId<HTMLInputElement>('channel-chat-path').value = selected.chatPath;
  byId<HTMLInputElement>('channel-anthropic-path').value = selected.anthropicPath ?? '';
  byId<HTMLInputElement>('channel-gemini-path').value = selected.geminiPath ?? '';
  byId<HTMLSelectElement>('channel-default-protocol').value = selected.defaultProtocol;
  byId<HTMLSelectElement>('channel-auth-mode').value = selected.authMode;
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
    anthropicPath: value('channel-anthropic-path'),
    geminiPath: value('channel-gemini-path'),
    defaultProtocol: value('channel-default-protocol'),
    authMode: value('channel-auth-mode'),
    apiKey: value('channel-api-key'),
    clearApiKey: checked('channel-clear-api-key'),
    timeoutMs: numberValue('channel-timeout'),
    refreshIntervalMinutes: numberValue('channel-refresh'),
    defaultMaxInputTokens: numberValue('channel-max-input'),
    defaultMaxOutputTokens: numberValue('channel-max-output'),
    enabled: checked('channel-enabled'),
  });
});

function openModelEditor(model: CatalogModel): void {
  const container = byId('model-editor');
  const current = state.models.find((item) => item.channelId === model.channelId && item.id === model.id) ?? model;
  const baseline = catalogMetadataBaseline(current);
  const form = document.createElement('form');
  form.className = 'card form-card';
  const heading = document.createElement('h2');
  heading.textContent = `编辑元数据：${model.name}`;
  const inputLabel = numericLabel('输入上限', current.maxInputTokens, 1024);
  const outputLabel = numericLabel('输出上限', current.maxOutputTokens, 256);
  const protocolLabel = document.createElement('label');
  protocolLabel.textContent = '调用协议';
  const protocol = document.createElement('select');
  for (const item of ['openai', 'anthropic', 'gemini', 'unknown']) {
    const option = document.createElement('option');
    option.value = item;
    option.textContent = item;
    protocol.append(option);
  }
  protocol.value = current.protocol;
  protocolLabel.append(protocol);
  const toolsLabel = document.createElement('label');
  toolsLabel.className = 'checkbox';
  const tools = document.createElement('input');
  tools.type = 'checkbox';
  tools.checked = current.toolCalling;
  toolsLabel.append(tools, document.createTextNode('支持工具调用'));
  const differsFromBaseline = (): boolean => protocol.value !== baseline.protocol
    || Number(inputLabel.input.value) !== baseline.maxInputTokens
    || Number(outputLabel.input.value) !== baseline.maxOutputTokens
    || tools.checked !== baseline.toolCalling;
  const restoreForm = (): void => {
    protocol.value = baseline.protocol;
    inputLabel.input.value = String(baseline.maxInputTokens);
    outputLabel.input.value = String(baseline.maxOutputTokens);
    tools.checked = baseline.toolCalling;
    updateRestoreState();
  };
  const actions = document.createElement('div');
  actions.className = 'actions';
  const restore = button('还原', restoreForm);
  restore.type = 'button';
  restore.disabled = true;
  const updateRestoreState = (): void => {
    restore.disabled = !differsFromBaseline();
  };
  const save = button('保存', () => undefined, 'primary');
  save.type = 'submit';
  actions.append(restore, save, button('取消', () => container.replaceChildren()));
  form.append(heading, protocolLabel, inputLabel.label, outputLabel.label, toolsLabel, actions);
  protocol.addEventListener('change', updateRestoreState);
  inputLabel.input.addEventListener('input', updateRestoreState);
  outputLabel.input.addEventListener('input', updateRestoreState);
  tools.addEventListener('change', updateRestoreState);
  updateRestoreState();
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

const chatRows: Array<{ prefix: string; label: string; key: ChatSettingKey; field: keyof ChatSettingSelections }> = [
  { prefix: 'chat-default', label: 'Chat 默认模型', key: 'chat.defaultModel', field: 'chatDefault' },
  { prefix: 'inline-chat', label: 'Inline Chat 默认模型', key: 'inlineChat.defaultModel', field: 'inlineChat' },
  { prefix: 'plan-agent', label: 'Plan Agent 默认模型', key: 'chat.planAgent.defaultModel', field: 'planAgent' },
  { prefix: 'implement-agent', label: 'Plan 实现阶段模型（实验性）', key: 'github.copilot.chat.implementAgent.model', field: 'implementAgent' },
  { prefix: 'utility', label: 'Chat: Utility Model', key: 'chat.utilityModel', field: 'utility' },
  { prefix: 'utility-small', label: 'Chat: Utility Small Model', key: 'chat.utilitySmallModel', field: 'utilitySmall' },
];
let selectedChatBindingPrefix = 'chat-default';
let chatBindingPickerOpen = false;

function setChatBindingPickerOpen(open: boolean): void {
  chatBindingPickerOpen = open;
  const trigger = byId<HTMLButtonElement>('chat-binding-picker-trigger');
  const options = byId<HTMLDivElement>('chat-binding-picker-options');
  options.hidden = !open;
  trigger.setAttribute('aria-expanded', String(open));
}

function renderChatBindingPicker(): void {
  const trigger = byId<HTMLButtonElement>('chat-binding-picker-trigger');
  const options = byId<HTMLDivElement>('chat-binding-picker-options');
  trigger.textContent = chatRows.find((row) => row.prefix === selectedChatBindingPrefix)?.label ?? selectedChatBindingPrefix;
  options.replaceChildren();
  for (const row of chatRows) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-binding-picker-option';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(row.prefix === selectedChatBindingPrefix));
    const label = document.createElement('span');
    label.className = 'chat-binding-picker-option-label';
    label.textContent = row.label;
    item.append(label);
    if (state.chatBindings[row.key]) {
      const check = document.createElement('span');
      check.className = 'chat-binding-picker-check';
      check.textContent = '✓';
      check.setAttribute('aria-label', '已配置');
      item.append(check);
    }
    item.addEventListener('click', () => {
      selectedChatBindingPrefix = row.prefix;
      setChatBindingPickerOpen(false);
      showChatBinding(row.prefix);
      renderChatBindingPicker();
    });
    options.append(item);
  }
}

byId<HTMLButtonElement>('chat-binding-picker-trigger').addEventListener('click', () => setChatBindingPickerOpen(!chatBindingPickerOpen));
document.addEventListener('mousedown', (event) => {
  if (!chatBindingPickerOpen) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  const trigger = byId<HTMLButtonElement>('chat-binding-picker-trigger');
  const options = byId<HTMLDivElement>('chat-binding-picker-options');
  if (trigger.contains(target) || options.contains(target)) return;
  setChatBindingPickerOpen(false);
});
byId<HTMLDivElement>('chat-binding-picker-options').addEventListener('mousedown', (event) => event.preventDefault());

for (const row of chatRows) {
  byId<HTMLSelectElement>(`${row.prefix}-channel`).addEventListener('change', () => fillModelPicker(row.prefix));
  byId<HTMLButtonElement>(`${row.prefix}-restore`).addEventListener('click', () => send('restoreChatSetting', { setting: row.key }));
}

function renderChatBindings(): void {
  for (const row of chatRows) {
    const target = state.chatBindings[row.key];
    const error = state.chatErrors[row.key];
    const channelPicker = byId<HTMLSelectElement>(`${row.prefix}-channel`);
    const modelPicker = byId<HTMLSelectElement>(`${row.prefix}-model`);
    byId<HTMLButtonElement>(`${row.prefix}-restore`).hidden = !target;
    const errorElement = byId<HTMLElement>(`${row.prefix}-error`);
    errorElement.hidden = !error;
    errorElement.textContent = error ?? '';
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
  renderChatBindingPicker();
  showChatBinding(selectedChatBindingPrefix);
  chatBindingsRendered = true;
}

function showChatBinding(prefix: string): void {
  for (const row of chatRows) {
    byId<HTMLElement>(`${row.prefix}-binding`).hidden = row.prefix !== prefix;
  }
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
    .filter((model) => model.channelId === channelId && model.enabled && model.available && protocolConfigured(state.channels.find((channel) => channel.id === channelId)!, model.protocol))
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
  if (Object.keys(payload).length === 0) {
    const activeRow = chatRows.find((row) => row.prefix === selectedChatBindingPrefix);
    if (activeRow && state.chatBindings[activeRow.key]) {
      send('restoreChatSetting', { setting: activeRow.key });
      return;
    }
    return;
  }
  send('applyChatSettings', payload);
});

function renderSyncBanner(): void {
  const banner = byId('sync-banner');
  const { locked, cloudState, error } = state.sync;
  const visible = cloudState === 'error' || locked;
  banner.hidden = !visible;
  if (!visible) return;
  if (cloudState === 'error') {
    banner.className = 'sync-banner status error';
    banner.textContent = `跨设备同步失败：${error ?? '未知错误'}`;
    banner.title = error ?? '';
    return;
  }
  banner.className = 'sync-banner status';
  banner.textContent = '等待同步密钥：加密密钥尚未从 VS Code Settings Sync 到达，稍后会自动完成。';
  banner.title = '跨设备 API Key 同步会在密钥到达后自动恢复。';
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

function protocolConfigured(channel: ChannelConfig | undefined, protocol: CatalogModel['protocol']): boolean {
  if (!channel) return false;
  if (protocol === 'openai') return Boolean(channel.chatPath);
  if (protocol === 'anthropic') return Boolean(channel.anthropicPath);
  if (protocol === 'gemini') return Boolean(channel.geminiPath?.includes('{model}'));
  return false;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

send('ready');
