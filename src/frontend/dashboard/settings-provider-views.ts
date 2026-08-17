/// <reference path="../dashboard.d.ts" />

type ProviderCustomTemplate = 'openai' | 'anthropic' | 'other';

const PROVIDER_CUSTOM_TEMPLATES: ReadonlyArray<{ id: ProviderCustomTemplate; label: string }> = [
  { id: 'openai', label: 'OpenAI 兼容' },
  { id: 'anthropic', label: 'Anthropic 兼容' },
  { id: 'other', label: '其他协议' },
];

function providerViewElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function providerViewButton(className: string, text: string): HTMLButtonElement {
  const button = providerViewElement('button', className, text);
  button.type = 'button';
  return button;
}

export class ProviderIdentityView {
  static create(providerId: string, name: string, custom: boolean): HTMLElement {
    const descriptor = ProviderSettingsUtils.identity(providerId, name, custom);
    const identity = providerViewElement('span', 'provider-identity');

    if (descriptor.iconPath) {
      const icon = providerViewElement('img', 'provider-identity-icon');
      icon.src = descriptor.iconPath;
      icon.alt = '';
      identity.append(icon);
    } else {
      const fallback = providerViewElement('span', 'provider-identity-fallback', descriptor.initials);
      fallback.setAttribute('aria-hidden', 'true');
      identity.append(fallback);
    }

    identity.append(providerViewElement('span', 'provider-identity-name', descriptor.label));
    return identity;
  }
}

export class ProviderCardListView {
  constructor(private readonly callbacks: ProviderCardListCallbacks) {}

  render(container: HTMLElement, state: ProviderCardListState): void {
    const root = providerViewElement('section', 'provider-card-list');

    if (state.providers.length === 0) {
      const empty = providerViewElement('div', 'provider-empty');
      empty.append(providerViewElement('p', 'provider-empty-message', '尚未添加厂商'));
      empty.append(this.createAddButton());
      root.append(empty);
      container.replaceChildren(root);
      return;
    }

    const cards = providerViewElement('div', 'provider-cards');
    for (const provider of state.providers) cards.append(this.createCard(provider, state.current));

    const actions = providerViewElement('div', 'provider-list-actions');
    actions.append(this.createAddButton());
    root.append(cards, actions);
    container.replaceChildren(root);
  }

  private createCard(
    provider: ProviderCardItem,
    current: ProviderCardListState['current'],
  ): HTMLElement {
    const card = providerViewElement('article', 'provider-card');
    card.dataset.providerId = provider.id;
    const isCurrent = current?.providerId === provider.id;
    if (isCurrent) {
      card.classList.add('current');
      card.setAttribute('aria-current', 'true');
    }

    const header = providerViewElement('header', 'provider-card-header');
    header.append(ProviderIdentityView.create(provider.id, provider.name, provider.custom));
    const edit = providerViewButton('provider-card-edit', '···');
    edit.dataset.providerAction = 'edit';
    edit.setAttribute('aria-label', '编辑厂商');
    edit.title = '编辑厂商';
    edit.addEventListener('click', () => this.callbacks.onEdit(provider.id));
    header.append(edit);

    const metadata = providerViewElement('div', 'provider-card-meta');
    metadata.append(providerViewElement('span', 'provider-card-protocol', provider.protocolLabel));
    const host = ProviderSettingsUtils.providerHost(provider.baseUrl);
    metadata.append(providerViewElement('span', 'provider-card-host', host || '未设置地址'));
    metadata.append(providerViewElement(
      'span',
      `provider-card-status${provider.configured ? ' on' : ''}`,
      provider.configured ? '已配置' : '未配置',
    ));
    if (isCurrent) {
      const activeModel = provider.models.find(model => model.id === current.modelId);
      metadata.append(providerViewElement(
        'span',
        'provider-card-current',
        `当前：${activeModel?.name || current.modelId}`,
      ));
    }

    const modelRow = providerViewElement('div', 'provider-card-model-row');
    const select = providerViewElement('select', 'provider-card-model-select');
    select.setAttribute('aria-label', `${provider.name} 模型`);
    select.disabled = provider.models.length === 0;
    for (const model of provider.models) {
      const option = providerViewElement('option', undefined, model.name);
      option.value = model.id;
      select.append(option);
    }
    if (current?.providerId === provider.id && provider.models.some(model => model.id === current.modelId)) {
      select.value = current.modelId;
    }

    const use = providerViewButton('provider-card-use', '使用');
    use.dataset.providerAction = 'use';
    use.disabled = provider.models.length === 0;
    use.addEventListener('click', () => {
      if (select.value) this.callbacks.onUse(provider.id, select.value);
    });
    modelRow.append(select, use);
    card.append(header, metadata, modelRow);
    return card;
  }

  private createAddButton(): HTMLButtonElement {
    const add = providerViewButton('list-add-action provider-add-action', '添加厂商');
    add.dataset.providerAction = 'add';
    add.addEventListener('click', () => this.callbacks.onAdd());
    return add;
  }
}

export class ProviderPickerView {
  constructor(private readonly callbacks: ProviderPickerCallbacks) {}

  render(container: HTMLElement, state: ProviderPickerState): void {
    const root = providerViewElement('section', 'provider-picker');
    const back = providerViewButton('provider-picker-back', '返回');
    back.dataset.providerAction = 'back';
    back.addEventListener('click', () => this.callbacks.onBack());
    root.append(back);

    const official = providerViewElement('section', 'provider-preset-group provider-preset-official-group');
    official.append(providerViewElement('h3', 'provider-preset-heading', '官方厂商'));
    const officialList = providerViewElement('div', 'provider-preset-list');
    for (const provider of state.official) {
      const tile = providerViewButton('provider-preset provider-preset-official', '');
      tile.dataset.providerId = provider.id;
      tile.append(
        ProviderIdentityView.create(provider.id, provider.name, false),
        providerViewElement(
          'span',
          `provider-preset-status${provider.configured ? ' on' : ''}`,
          provider.configured ? '已配置' : '未配置',
        ),
      );
      tile.addEventListener('click', () => this.callbacks.onOfficial(provider.id));
      officialList.append(tile);
    }
    official.append(officialList);

    const custom = providerViewElement('section', 'provider-preset-group provider-preset-custom-group');
    custom.append(providerViewElement('h3', 'provider-preset-heading', '自定义厂商'));
    const customList = providerViewElement('div', 'provider-preset-list');
    for (const template of PROVIDER_CUSTOM_TEMPLATES) {
      const tile = providerViewButton('provider-preset provider-preset-custom', template.label);
      tile.dataset.customTemplate = template.id;
      tile.disabled = !state.customAvailable;
      tile.addEventListener('click', () => this.callbacks.onCustom(template.id));
      customList.append(tile);
    }
    custom.append(customList);
    root.append(official, custom);
    container.replaceChildren(root);
  }
}

export class OfficialProviderEditorView {
  constructor(private readonly callbacks: OfficialProviderEditorCallbacks) {}

  render(container: HTMLElement, state: OfficialProviderEditorState): void {
    const root = providerViewElement('section', 'rp-official');
    const back = providerViewButton('provider-editor-back', '返回');
    back.dataset.providerAction = 'back';
    back.addEventListener('click', () => this.callbacks.onBack());

    const header = providerViewElement('header', 'rp-header');
    header.append(
      ProviderIdentityView.create(state.provider.id, state.provider.name, false),
      providerViewElement(
        'span',
        `rp-status${state.provider.configured ? ' on' : ''}`,
        state.provider.configured ? '已配置' : '未配置',
      ),
    );

    root.append(back, header, this.createModels(state), this.createKeySection(state));
    container.replaceChildren(root);
  }

  private createModels(state: OfficialProviderEditorState): HTMLElement {
    const models = providerViewElement('div', 'rp-models');
    models.dataset.provider = state.provider.id;

    if (state.models.status === 'loading') {
      models.append(providerViewElement('p', 'rp-empty', '加载中...'));
      return models;
    }
    if (state.models.status === 'error') {
      models.append(providerViewElement('p', 'msl-error', state.models.error || '加载失败'));
      return models;
    }
    if (state.models.status !== 'ready' || state.models.items.length === 0) {
      models.append(providerViewElement('p', 'rp-empty', state.models.status === 'ready' ? '无可用模型' : '尚未加载模型'));
      return models;
    }

    models.append(providerViewElement('div', 'rp-models-title', '可用模型'));
    for (const model of state.models.items) {
      const active = model.id === state.models.activeModelId;
      const item = providerViewButton(`rp-model-item${active ? ' on' : ''}`, model.name);
      item.dataset.modelProvider = state.provider.id;
      item.dataset.modelId = model.id;
      item.setAttribute('aria-pressed', String(active));
      item.addEventListener('click', () => this.callbacks.onUse(state.provider.id, model.id));
      models.append(item);
    }
    return models;
  }

  private createKeySection(state: OfficialProviderEditorState): HTMLElement {
    const section = providerViewElement('section', 'rp-key-section');
    const row = providerViewElement('div', 'rp-key-row');
    const input = providerViewElement('input', 'rp-key-input');
    input.type = state.apiKey.revealed ? 'text' : 'password';
    input.id = 'key-input';
    input.dataset.provider = state.provider.id;
    input.value = state.apiKey.value;
    input.placeholder = state.apiKey.placeholder;
    input.disabled = state.apiKey.saving;
    input.autocomplete = 'off';

    const label = providerViewElement('label', 'rp-key-label', 'API Key');
    label.htmlFor = input.id;

    const reveal = providerViewButton('rp-key-toggle', '');
    reveal.dataset.providerAction = 'reveal-key';
    let localValueAvailable = state.apiKey.revealed;
    let userEdited = false;
    const syncRevealControl = (): void => {
      const action = input.type === 'text' ? '隐藏' : '显示';
      reveal.textContent = action;
      reveal.title = `${action} API Key`;
      reveal.setAttribute('aria-label', `${action} API Key`);
      const canToggleLocally = localValueAvailable || (userEdited && input.value.length > 0);
      reveal.disabled = state.apiKey.saving
        || (input.type === 'password' && !state.apiKey.canReveal && !canToggleLocally);
    };
    input.addEventListener('input', () => {
      userEdited = true;
      localValueAvailable = input.value.length > 0;
      syncRevealControl();
      this.callbacks.onApiKeyChange(state.provider.id, input.value);
    });
    reveal.addEventListener('click', () => {
      if (input.type === 'text') {
        input.type = 'password';
        syncRevealControl();
        this.callbacks.onKeyVisibilityChange(state.provider.id, false);
        return;
      }
      if (localValueAvailable || (userEdited && input.value.length > 0)) {
        input.type = 'text';
        localValueAvailable = true;
        syncRevealControl();
        this.callbacks.onKeyVisibilityChange(state.provider.id, true);
        return;
      }
      if (state.apiKey.canReveal) this.callbacks.onReveal(state.provider.id);
    });
    syncRevealControl();

    const save = providerViewButton('rp-save-btn', state.apiKey.saving ? '保存中...' : '保存');
    save.dataset.providerAction = 'save-key';
    save.disabled = state.apiKey.saving;
    save.addEventListener('click', () => this.callbacks.onSave(state.provider.id, input.value));
    row.append(input, reveal, save);
    section.append(label, row);
    return section;
  }
}
