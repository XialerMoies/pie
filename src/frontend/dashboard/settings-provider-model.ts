/// <reference path="../dashboard.d.ts" />

interface SettingsProviderModelDependencies {
  preferences: AppPreferences;
  chatState: AppChatState;
  refreshDashboard: () => void;
  notify: typeof toast;
  listAddAction: typeof ListAddAction;
  customEditorType: SettingsCustomProviderEditorConstructor;
}

interface OfficialProviderListItem {
  id: string;
  name: string;
  configured: boolean;
}

function providerElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

class SettingsProviderModelController implements SettingsProviderModelApi {
  private selectedProvider: string | null = null;
  private providerKeys: Record<string, ProviderKeyInfo> = {};
  private officialProviders: OfficialProviderListItem[] = [];
  private customProviders: RedactedCustomProvider[] = [];
  private revision = 0;
  private revealRequestId = 0;
  private dragIndex = -1;
  customEditor: SettingsCustomProviderEditor;

  constructor(private readonly dependencies: SettingsProviderModelDependencies) {
    this.customEditor = new dependencies.customEditorType({
      notify: dependencies.notify,
      listAddAction: dependencies.listAddAction,
      onSaved: (snapshot, selectedId) => this.applyCustomSnapshot(snapshot, selectedId),
      onDeleted: snapshot => this.applyCustomSnapshot(snapshot, null),
    });
  }

  renderTab(container: HTMLElement): void {
    container.innerHTML = `
      <div class="model-split">
        <div class="ms-left">
          <div class="msl-title">厂商</div>
          <div class="msl-list" id="msl-list"><div class="sp" style="margin:20px auto"></div></div>
          <div class="list-add-action-mount" id="msl-add-action"></div>
        </div>
        <div class="ms-right">
          <div id="ms-right-content"><div class="sp" style="margin:40px auto"></div></div>
        </div>
      </div>
    `;
    const addMount = $('msl-add-action');
    addMount?.append(this.dependencies.listAddAction.create({
      label: '添加自定义厂商',
      onActivate: () => {
        this.selectedProvider = null;
        this.markSelected(null);
        const content = $('ms-right-content');
        if (content) this.customEditor.startNew(content, this.revision);
      },
    }));

    Promise.all([
      fetch('/api/auth').then(response => response.json()),
      fetch('/api/custom-providers').then(response => response.json()),
      fetch('/api/custom-providers/capabilities').then(response => response.json()),
    ]).then(([authData, providerData]) => {
      const auth = authData as { providers?: Array<{ provider: string; hasKey: boolean; canReveal?: boolean; keyPreview: string }> };
      const snapshot = providerData as CustomProviderListResponse;
      this.providerKeys = {};
      for (const provider of auth.providers ?? []) {
        this.providerKeys[provider.provider] = {
          hasKey: provider.hasKey,
          canReveal: provider.canReveal ?? Boolean(provider.keyPreview),
          keyPreview: provider.keyPreview || '',
        };
      }
      const officialById = new Map<string, OfficialProviderListItem>();
      if (Array.isArray(snapshot.official)) {
        for (const provider of snapshot.official) officialById.set(provider.id, provider);
      } else {
        for (const provider of auth.providers ?? []) {
          officialById.set(provider.provider, { id: provider.provider, name: provider.provider, configured: provider.hasKey });
        }
      }
      this.officialProviders = [...officialById.values()];
      this.customProviders = Array.isArray(snapshot.custom) ? snapshot.custom : [];
      this.revision = Number.isInteger(snapshot.revision) ? snapshot.revision : 0;
      this.reconcileOrder();
      this.renderProviderList();
      const first = window._provOrder?.[0];
      if (first) this.selectProvider(first);
      else {
        const content = $('ms-right-content');
        if (content) this.customEditor.startNew(content, this.revision);
      }
    }).catch(() => {
      const list = $('msl-list');
      if (list) list.replaceChildren(providerElement('p', 'msl-error', '加载失败'));
      this.dependencies.notify('加载厂商列表失败', 'error');
    });
  }

  selectProvider(provider: string): void {
    const custom = this.customProviders.find(candidate => candidate.id === provider);
    this.selectedProvider = provider;
    this.markSelected(provider);
    const content = $('ms-right-content');
    if (!content) return;
    if (custom) {
      this.revealRequestId += 1;
      this.customEditor.mount(content, custom, this.revision);
      return;
    }
    this.renderOfficialProvider(content, provider);
  }

  toggleKeyVisibility(provider: string): void {
    const input = $('key-input') as HTMLInputElement | null;
    if (!input || input.dataset.provider !== provider) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  }

  saveApiKey(provider: string): void {
    const input = $('key-input') as HTMLInputElement | null;
    if (!input || input.dataset.provider !== provider || !input.value.trim()) {
      this.dependencies.notify('请输入 API Key');
      return;
    }
    fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, apiKey: input.value.trim() }),
    }).then(response => response.json()).then((result: { ok: boolean }) => {
      if (!result.ok) {
        this.dependencies.notify('保存失败');
        return;
      }
      this.dependencies.notify('已保存');
      this.providerKeys[provider] = { hasKey: true, canReveal: true, keyPreview: input.value.trim().slice(0, 8) + '...' };
      this.selectProvider(provider);
      this.renderProviderList();
    }).catch(() => this.dependencies.notify('保存失败'));
  }

  loadProviderModels(provider: string): void {
    const container = $('rp-models') as HTMLElement | null;
    if (!container || container.dataset.provider !== provider) return;
    fetch('/api/models').then(response => response.json()).then((data: { models?: Array<{ provider: string; id: string }> }) => {
      if (this.selectedProvider !== provider || $('rp-models') !== container) return;
      const models = (data.models || []).filter(model => model.provider === provider);
      if (models.length === 0) {
        container.replaceChildren(providerElement('p', 'rp-empty', '无可用模型'));
        return;
      }
      const dashboard = this.dependencies.chatState.getDashboard?.() || null;
      const title = providerElement('div', 'rp-models-title', '可用模型');
      const rows = models.map(model => {
        const active = model.provider === dashboard?.modelProvider && model.id === dashboard?.modelId;
        const row = providerElement('div', `rp-model-item${active ? ' on' : ''}`, model.id);
        row.dataset.modelProvider = model.provider;
        row.dataset.modelId = model.id;
        return row;
      });
      container.replaceChildren(title, ...rows);
    }).catch(() => {
      container.replaceChildren(providerElement('p', 'msl-error', '加载失败'));
      this.dependencies.notify('加载模型列表失败', 'error');
    });
  }

  selectModel(provider: string, modelId: string): void {
    fetch('/api/model/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, modelId }),
    }).then(response => response.json()).then((result: { ok: boolean; error?: string }) => {
      if (!result.ok) {
        this.dependencies.notify('切换失败: ' + (result.error || ''), 'error');
        return;
      }
      this.dependencies.notify('已切换: ' + modelId, 'success');
      this.dependencies.refreshDashboard();
      document.querySelectorAll('.rp-model-item').forEach(element => {
        const item = element as HTMLElement;
        item.classList.toggle('on', item.dataset.modelProvider === provider && item.dataset.modelId === modelId);
      });
    }).catch(() => this.dependencies.notify('切换失败', 'error'));
  }

  dragStart(event: DragEvent, index: number): void {
    this.dragIndex = index;
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  }

  dragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  drop(event: DragEvent, index: number): void {
    event.preventDefault();
    if (this.dragIndex < 0 || this.dragIndex === index) return;
    const order = window._provOrder || [];
    const item = order.splice(this.dragIndex, 1)[0];
    if (!item) return;
    order.splice(index, 0, item);
    window._provOrder = order;
    this.dependencies.preferences.setJson('providers_order', order);
    this.dragIndex = -1;
    this.renderProviderList();
  }

  private renderOfficialProvider(content: HTMLElement, provider: string): void {
    const info = this.providerKeys[provider] || { hasKey: false, canReveal: false, keyPreview: '' };
    const placeholder = info.canReveal
      ? `已保存: ${info.keyPreview || '********'}，输入新 Key 覆盖`
      : info.hasKey ? '已通过其他方式认证，输入 API Key 覆盖' : '输入 API Key...';
    const root = providerElement('div', 'rp-official');
    const header = providerElement('div', 'rp-header');
    header.append(
      providerElement('div', 'rp-prov-name', provider),
      providerElement('span', `rp-status${info.hasKey ? ' on' : ''}`, info.hasKey ? '已配置' : '未配置'),
    );
    root.append(header);
    if (info.hasKey) {
      const models = providerElement('div', 'rp-models', '加载中...');
      models.id = 'rp-models';
      models.dataset.provider = provider;
      root.append(models);
    }
    const section = providerElement('div', 'rp-key-section');
    section.append(providerElement('div', 'rp-key-label', 'API Key'));
    const row = providerElement('div', 'rp-key-row');
    const input = providerElement('input', 'rp-key-input');
    input.type = info.canReveal ? 'text' : 'password';
    input.id = 'key-input';
    input.dataset.provider = provider;
    input.placeholder = placeholder;
    input.value = info.keyPreview || '';
    const toggle = providerElement('button', 'rp-key-toggle', '👁');
    toggle.type = 'button';
    toggle.dataset.settingsAction = 'toggle-key';
    toggle.dataset.provider = provider;
    toggle.setAttribute('aria-label', '显示或隐藏 API Key');
    const save = providerElement('button', 'rp-save-btn', '保存');
    save.type = 'button';
    save.dataset.settingsAction = 'save-key';
    save.dataset.provider = provider;
    row.append(input, toggle, save);
    section.append(row);
    root.append(section);
    content.replaceChildren(root);
    if (info.canReveal) void this.revealProviderKey(provider);
    if (info.hasKey) this.loadProviderModels(provider);
  }

  private reconcileOrder(): void {
    const allProviderIds = [...this.officialProviders.map(provider => provider.id), ...this.customProviders.map(provider => provider.id)];
    const uniqueIds = [...new Set(allProviderIds)];
    const current = new Set(uniqueIds);
    let saved: string[] = [];
    const savedOrder = this.dependencies.preferences.get('providers_order');
    if (savedOrder) {
      try {
        const parsed = JSON.parse(savedOrder);
        if (Array.isArray(parsed)) saved = parsed.filter((id): id is string => typeof id === 'string' && current.has(id));
      } catch {}
    }
    for (const id of uniqueIds) if (!saved.includes(id)) saved.push(id);
    window._provOrder = saved;
  }

  private renderProviderList(): void {
    const list = $('msl-list');
    if (!list) return;
    const customById = new Map(this.customProviders.map(provider => [provider.id, provider]));
    const officialById = new Map(this.officialProviders.map(provider => [provider.id, provider]));
    const items = (window._provOrder || []).flatMap((id, index) => {
      const custom = customById.get(id);
      const official = officialById.get(id);
      if (!custom && !official) return [];
      const selected = id === this.selectedProvider || (!this.selectedProvider && index === 0);
      const item = providerElement('div', `msl-item${selected ? ' on' : ''}`);
      item.draggable = true;
      item.dataset.prov = id;
      item.dataset.index = String(index);
      item.append(providerElement('span', 'msl-drag', '⠿'));
      item.append(providerElement('span', 'msl-name', custom?.name ?? id));
      if (custom) item.append(providerElement('span', 'msl-kind', '自定义'));
      const configured = custom ? custom.authMode === 'none' || custom.apiKeyConfigured : this.providerKeys[id]?.hasKey ?? official?.configured;
      item.append(providerElement('span', `msl-status${configured ? ' on' : ''}`));
      return [item];
    });
    list.replaceChildren(...items);
  }

  private markSelected(provider: string | null): void {
    document.querySelectorAll('.msl-item').forEach(element => {
      const item = element as HTMLElement;
      item.classList.toggle('on', provider !== null && item.dataset.prov === provider);
    });
  }

  private applyCustomSnapshot(snapshot: RedactedCustomProviderSnapshot, selectedId: string | null): void {
    this.customProviders = snapshot.providers;
    this.revision = snapshot.revision;
    this.reconcileOrder();
    this.renderProviderList();
    const next = selectedId && this.customProviders.some(provider => provider.id === selectedId) ? selectedId : window._provOrder?.[0];
    if (next) this.selectProvider(next);
    else {
      this.selectedProvider = null;
      const content = $('ms-right-content');
      if (content) this.customEditor.startNew(content, this.revision);
    }
  }

  private async revealProviderKey(provider: string): Promise<void> {
    const requestId = ++this.revealRequestId;
    try {
      const response = await fetch('/api/auth/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      if (!response.ok) return;
      const data = await response.json() as { apiKey?: string };
      const input = $('key-input') as HTMLInputElement | null;
      if (requestId === this.revealRequestId && this.selectedProvider === provider && input?.dataset.provider === provider && typeof data.apiKey === 'string') {
        input.value = data.apiKey;
      }
    } catch {}
  }
}

const settingsProviderApp = (window as any).App;
const settingsProviderController = new SettingsProviderModelController({
  preferences: settingsProviderApp.Preferences,
  chatState: settingsProviderApp.ChatState,
  refreshDashboard: getD,
  notify: toast,
  listAddAction: settingsProviderApp.Ui.ListAddAction,
  customEditorType: settingsProviderApp.SettingsCustomProviderEditor,
});
settingsProviderApp.SettingsComponents = {
  ...(settingsProviderApp.SettingsComponents || {}),
  providers: settingsProviderController,
};
