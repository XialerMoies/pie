/// <reference path="../dashboard.d.ts" />

interface SettingsProviderModelDependencies {
  preferences: AppPreferences;
  chatState: AppChatState;
  refreshDashboard: () => void;
  notify: typeof toast;
  listAddAction: typeof ListAddAction;
  customEditorType: SettingsCustomProviderEditorConstructor;
  isValidRevision: (value: unknown) => value is number;
}

interface OfficialProviderListItem {
  id: string;
  name: string;
  configured: boolean;
}

type CustomProviderLoadState = 'loading' | 'ready' | 'error';

const SETTINGS_CUSTOM_PROVIDER_PROTOCOLS = new Set<string>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'mistral-conversations',
  'azure-openai-responses',
  'pi-messages',
]);

function providerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function providerJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${url}`);
  return response.json();
}

function capabilityProtocols(value: unknown): CustomProviderProtocol[] {
  if (!providerRecord(value) || !Array.isArray(value.protocols)) throw new Error('Invalid capabilities response');
  const protocols: CustomProviderProtocol[] = [];
  for (const entry of value.protocols) {
    if (!providerRecord(entry) || typeof entry.id !== 'string') continue;
    if (!SETTINGS_CUSTOM_PROVIDER_PROTOCOLS.has(entry.id) || protocols.includes(entry.id as CustomProviderProtocol)) continue;
    protocols.push(entry.id as CustomProviderProtocol);
  }
  if (protocols.length === 0) throw new Error('No supported custom provider protocols');
  return protocols;
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
  private authOfficialProviders: OfficialProviderListItem[] = [];
  private customProviders: RedactedCustomProvider[] = [];
  private revision = 0;
  private hasCustomAuthority = false;
  private newDraftActive = false;
  private revealRequestId = 0;
  private dragIndex = -1;
  private renderGeneration = 0;
  private customSnapshotState: CustomProviderLoadState = 'loading';
  private capabilitiesState: CustomProviderLoadState = 'loading';
  private customProtocols: CustomProviderProtocol[] = [];
  private addCustomButton: HTMLButtonElement | null = null;
  private customStatus: HTMLElement | null = null;
  customEditor: SettingsCustomProviderEditor;

  constructor(private readonly dependencies: SettingsProviderModelDependencies) {
    this.customEditor = new dependencies.customEditorType({
      notify: dependencies.notify,
      listAddAction: dependencies.listAddAction,
      onSaved: (snapshot, selectedId, activateSaved) => this.applyCustomSnapshot(snapshot, selectedId, activateSaved),
      onDeleted: snapshot => this.applyCustomSnapshot(snapshot, null),
    });
  }

  renderTab(container: HTMLElement): void {
    this.customEditor.unmount();
    const generation = ++this.renderGeneration;
    this.selectedProvider = null;
    this.newDraftActive = false;
    this.hasCustomAuthority = false;
    this.providerKeys = {};
    this.officialProviders = [];
    this.authOfficialProviders = [];
    this.customProviders = [];
    this.revision = 0;
    this.customSnapshotState = 'loading';
    this.capabilitiesState = 'loading';
    this.customProtocols = [];
    this.customEditor.setProtocols([]);
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
    this.addCustomButton = this.dependencies.listAddAction.create({
      label: '添加自定义厂商',
      disabled: true,
      onActivate: () => {
        if (!this.customEditingAvailable()) return;
        this.selectedProvider = null;
        this.newDraftActive = true;
        this.markSelected(null);
        const content = $('ms-right-content');
        if (content) this.customEditor.startNew(content, this.revision);
      },
    });
    this.customStatus = providerElement('div', 'msl-custom-status', '正在加载自定义厂商...');
    this.customStatus.setAttribute('aria-live', 'polite');
    addMount?.append(this.addCustomButton, this.customStatus);

    void this.loadOfficialAuth(generation);
    void this.loadCustomSnapshot(generation);
    void this.loadCapabilities(generation);
  }

  unmount(): void {
    this.renderGeneration += 1;
    this.revealRequestId += 1;
    this.customEditor.unmount();
    this.selectedProvider = null;
    this.newDraftActive = false;
    this.addCustomButton = null;
    this.customStatus = null;
  }

  selectProvider(provider: string): void {
    const custom = this.customProviders.find(candidate => candidate.id === provider);
    this.selectedProvider = provider;
    this.newDraftActive = false;
    this.markSelected(provider);
    const content = $('ms-right-content');
    if (!content) return;
    if (custom) {
      this.revealRequestId += 1;
      if (!this.customEditingAvailable()) {
        this.renderCustomUnavailable(content);
        return;
      }
      this.customEditor.mount(content, custom, this.revision);
      return;
    }
    this.customEditor.unmount();
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

  private async loadOfficialAuth(generation: number): Promise<void> {
    try {
      const value = await providerJson('/api/auth');
      if (generation !== this.renderGeneration) return;
      if (!providerRecord(value) || !Array.isArray(value.providers)) throw new Error('Invalid auth response');
      this.providerKeys = {};
      const officialById = new Map<string, OfficialProviderListItem>();
      for (const entry of value.providers) {
        if (!providerRecord(entry) || typeof entry.provider !== 'string') continue;
        const hasKey = entry.hasKey === true;
        const keyPreview = typeof entry.keyPreview === 'string' ? entry.keyPreview : '';
        this.providerKeys[entry.provider] = {
          hasKey,
          canReveal: typeof entry.canReveal === 'boolean' ? entry.canReveal : Boolean(keyPreview),
          keyPreview,
        };
        officialById.set(entry.provider, { id: entry.provider, name: entry.provider, configured: hasKey });
      }
      this.authOfficialProviders = [...officialById.values()];
      if (this.customSnapshotState !== 'ready') this.officialProviders = this.authOfficialProviders;
      const selectedBeforeAuth = this.selectedProvider;
      this.refreshProviderListAndSelection();
      if (
        selectedBeforeAuth
        && this.selectedProvider === selectedBeforeAuth
        && !this.customProviders.some(provider => provider.id === selectedBeforeAuth)
      ) {
        const content = $('ms-right-content');
        if (content) this.renderOfficialProvider(content, selectedBeforeAuth);
      }
    } catch {
      if (generation !== this.renderGeneration) return;
      this.providerKeys = {};
      this.authOfficialProviders = [];
      if (this.customSnapshotState !== 'ready') this.officialProviders = [];
      this.refreshProviderListAndSelection();
      this.dependencies.notify('加载官方厂商认证失败', 'error');
    }
  }

  private async loadCustomSnapshot(generation: number): Promise<void> {
    try {
      const value = await providerJson('/api/custom-providers');
      if (generation !== this.renderGeneration) return;
      if (
        !providerRecord(value)
        || !this.dependencies.isValidRevision(value.revision)
        || !Array.isArray(value.official)
        || !Array.isArray(value.custom)
      ) throw new Error('Invalid custom provider response');
      const snapshot = value as unknown as CustomProviderListResponse;
      if (!this.hasCustomAuthority || snapshot.revision > this.revision) {
        this.hasCustomAuthority = true;
        this.officialProviders = snapshot.official;
        this.customProviders = snapshot.custom;
        this.revision = snapshot.revision;
        this.refreshProviderListAndSelection();
      }
      this.convergeCustomAvailability(false);
    } catch {
      if (generation !== this.renderGeneration) return;
      if (!this.hasCustomAuthority) {
        this.officialProviders = this.authOfficialProviders;
        this.customProviders = [];
        this.revision = 0;
        this.refreshProviderListAndSelection();
      }
      this.convergeCustomAvailability(true);
    }
  }

  private async loadCapabilities(generation: number): Promise<void> {
    try {
      const protocols = capabilityProtocols(await providerJson('/api/custom-providers/capabilities'));
      if (generation !== this.renderGeneration) return;
      this.capabilitiesState = 'ready';
      this.customProtocols = protocols;
      this.customEditor.setProtocols(protocols);
    } catch {
      if (generation !== this.renderGeneration) return;
      this.capabilitiesState = 'error';
      this.customProtocols = [];
      this.customEditor.setProtocols([]);
    }
    this.updateCustomAvailability();
  }

  private customEditingAvailable(): boolean {
    return this.customSnapshotState === 'ready'
      && this.capabilitiesState === 'ready'
      && this.customProtocols.length > 0;
  }

  private convergeCustomAvailability(loadFailed: boolean): void {
    this.customSnapshotState = this.hasCustomAuthority ? 'ready' : loadFailed ? 'error' : 'loading';
    this.updateCustomAvailability();
  }

  private updateCustomAvailability(): void {
    const available = this.customEditingAvailable();
    if (this.addCustomButton) this.addCustomButton.disabled = !available;
    if (this.customStatus) {
      if (available) {
        this.customStatus.hidden = true;
        this.customStatus.textContent = '';
      } else {
        this.customStatus.hidden = false;
        this.customStatus.textContent = this.customSnapshotState === 'error'
          ? '自定义厂商不可用：配置列表加载失败'
          : this.capabilitiesState === 'error'
            ? '自定义厂商不可用：协议能力加载失败'
            : '正在加载自定义厂商...';
      }
    }
    const selectedCustom = this.customProviders.find(provider => provider.id === this.selectedProvider);
    const content = $('ms-right-content');
    if (this.newDraftActive) {
      this.markSelected(null);
      return;
    }
    if (selectedCustom && content) {
      if (available) {
        if (!content.querySelector('.cpe-editor')) this.customEditor.mount(content, selectedCustom, this.revision);
      }
      else this.renderCustomUnavailable(content);
    } else if (!this.selectedProvider && (window._provOrder?.length ?? 0) === 0 && content) {
      if (available) {
        this.newDraftActive = true;
        this.customEditor.startNew(content, this.revision);
      }
      else this.renderCustomUnavailable(content);
    }
  }

  private renderCustomUnavailable(content: HTMLElement): void {
    const message = this.customSnapshotState === 'error'
      ? '自定义厂商暂不可用，配置列表加载失败。'
      : this.capabilitiesState === 'error'
        ? '自定义厂商暂不可用，协议能力加载失败。'
        : '正在加载自定义厂商配置...';
    content.replaceChildren(providerElement('p', 'msl-error', message));
  }

  private refreshProviderListAndSelection(): void {
    this.reconcileOrder();
    this.renderProviderList();
    if (this.newDraftActive) {
      this.markSelected(null);
      return;
    }
    const availableIds = new Set(window._provOrder ?? []);
    if (this.selectedProvider && availableIds.has(this.selectedProvider)) {
      this.markSelected(this.selectedProvider);
      return;
    }
    this.selectedProvider = null;
    const first = window._provOrder?.[0];
    if (first) this.selectProvider(first);
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
      const selected = id === this.selectedProvider;
      const item = providerElement('button', `msl-item${selected ? ' on' : ''}`);
      item.type = 'button';
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

  private applyCustomSnapshot(
    snapshot: RedactedCustomProviderSnapshot,
    selectedId: string | null,
    activateSaved = false,
  ): void {
    if (!this.dependencies.isValidRevision(snapshot.revision) || !Array.isArray(snapshot.providers)) return;
    if (this.hasCustomAuthority && snapshot.revision <= this.revision) {
      this.convergeCustomAvailability(false);
      return;
    }
    const selectedBeforeMutation = this.selectedProvider;
    const newDraftBeforeMutation = this.newDraftActive;
    this.hasCustomAuthority = true;
    this.customProviders = snapshot.providers;
    this.revision = snapshot.revision;
    this.reconcileOrder();
    this.renderProviderList();
    this.convergeCustomAvailability(false);
    if (newDraftBeforeMutation && !activateSaved) {
      this.markSelected(null);
      return;
    }
    if (activateSaved) this.newDraftActive = false;
    const available = new Set([
      ...this.officialProviders.map(provider => provider.id),
      ...this.customProviders.map(provider => provider.id),
    ]);
    if (selectedBeforeMutation && available.has(selectedBeforeMutation)) {
      this.markSelected(selectedBeforeMutation);
      return;
    }
    const next = selectedId && this.customProviders.some(provider => provider.id === selectedId) ? selectedId : window._provOrder?.[0];
    if (next) this.selectProvider(next);
    else {
      this.selectedProvider = null;
      this.newDraftActive = true;
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
  isValidRevision: settingsProviderApp.isCustomProviderRevision,
});
settingsProviderApp.SettingsComponents = {
  ...(settingsProviderApp.SettingsComponents || {}),
  providers: settingsProviderController,
};
