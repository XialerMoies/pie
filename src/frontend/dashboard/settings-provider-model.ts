/// <reference path="../dashboard.d.ts" />

interface SettingsProviderModelDependencies {
  preferences: AppPreferences;
  chatState: AppChatState;
  refreshDashboard: () => void | Promise<void>;
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

type ProviderSettingsView =
  | { kind: 'list' }
  | { kind: 'picker' }
  | { kind: 'official'; providerId: string }
  | { kind: 'custom'; providerId: string }
  | { kind: 'new-custom'; template: 'openai' | 'anthropic' | 'other' };

type ProviderLoadState = 'loading' | 'ready' | 'error';

interface OfficialApiKeyDraft {
  value: string;
  revealed: boolean;
  saving: boolean;
}

interface ProviderModelSwitchOperation {
  requestId: number;
  providerId: string;
  modelId: string;
}

const SETTINGS_CUSTOM_PROVIDER_PROTOCOLS = new Set<string>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'mistral-conversations',
  'azure-openai-responses',
  'pi-messages',
]);

const SETTINGS_PROTOCOL_LABELS: Record<CustomProviderProtocol, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'mistral-conversations': 'Mistral Conversations',
  'azure-openai-responses': 'Azure OpenAI Responses',
  'pi-messages': 'PI Messages',
};

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

function providerElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

class SettingsProviderModelController implements SettingsProviderModelApi {
  private content: HTMLElement | null = null;
  private view: ProviderSettingsView = { kind: 'list' };
  private lifecycleGeneration = 0;
  private viewGeneration = 0;
  private revealRequestId = 0;
  private officialAuthRequestId = 0;
  private officialModelsRequestId = 0;
  private modelSwitchRequestId = 0;
  private providerKeys: Record<string, ProviderKeyInfo> = {};
  private officialProviders: OfficialProviderListItem[] = [];
  private authOfficialProviders: OfficialProviderListItem[] = [];
  private customProviders: RedactedCustomProvider[] = [];
  private revision = 0;
  private hasCustomAuthority = false;
  private customSnapshotState: ProviderLoadState = 'loading';
  private capabilitiesState: ProviderLoadState = 'loading';
  private customProtocols: CustomProviderProtocol[] = [];
  private officialModelsState: OfficialProviderModelsStatus = 'loading';
  private officialModels = new Map<string, ProviderCardModel[]>();
  private currentModel: ProviderCardListState['current'] = null;
  private officialDrafts = new Map<string, OfficialApiKeyDraft>();
  private optimisticOfficialKeys = new Set<string>();
  private pendingModelSwitch: ProviderModelSwitchOperation | null = null;
  customEditor: SettingsCustomProviderEditor;

  constructor(private readonly dependencies: SettingsProviderModelDependencies) {
    this.customEditor = new dependencies.customEditorType({
      notify: dependencies.notify,
      listAddAction: dependencies.listAddAction,
      onSaved: (snapshot, selectedId, activateSaved, currentMount) => {
        this.applyCustomSnapshot(snapshot, { kind: 'save', selectedId, activateSaved, currentMount });
      },
      onDeleted: (snapshot, currentMount) => this.applyCustomSnapshot(snapshot, { kind: 'delete', currentMount }),
    });
  }

  renderTab(container: HTMLElement): void {
    this.customEditor.unmount();
    const generation = ++this.lifecycleGeneration;
    this.viewGeneration += 1;
    this.revealRequestId += 1;
    this.view = { kind: 'list' };
    this.providerKeys = {};
    this.officialProviders = [];
    this.authOfficialProviders = [];
    this.customProviders = [];
    this.revision = 0;
    this.hasCustomAuthority = false;
    this.customSnapshotState = 'loading';
    this.capabilitiesState = 'loading';
    this.customProtocols = [];
    this.officialModelsState = 'loading';
    this.officialModels = new Map();
    this.currentModel = this.readCurrentModel();
    this.officialDrafts.clear();
    this.optimisticOfficialKeys.clear();
    this.customEditor.setProtocols([]);

    const shell = providerElement('section', 'provider-settings-shell');
    const content = providerElement('div', 'provider-settings-content');
    shell.append(content);
    container.replaceChildren(shell);
    this.content = content;
    this.renderCurrentView();

    void this.loadOfficialAuth(generation);
    void this.loadCustomSnapshot(generation);
    void this.loadCapabilities(generation);
    void this.loadOfficialModels(generation);
  }

  unmount(): void {
    this.lifecycleGeneration += 1;
    this.viewGeneration += 1;
    this.revealRequestId += 1;
    this.customEditor.unmount();
    this.content = null;
    this.view = { kind: 'list' };
    this.officialDrafts.clear();
  }

  private showPicker(): void {
    this.customEditor.unmount();
    this.revealRequestId += 1;
    this.view = { kind: 'picker' };
    this.viewGeneration += 1;
    this.renderCurrentView();
  }

  private showOfficial(providerId: string): void {
    this.customEditor.unmount();
    this.revealRequestId += 1;
    this.view = { kind: 'official', providerId };
    this.viewGeneration += 1;
    this.officialDrafts.set(providerId, { value: '', revealed: false, saving: false });
    this.renderCurrentView();
  }

  private showCustom(providerId: string): void {
    this.customEditor.unmount();
    this.revealRequestId += 1;
    this.view = { kind: 'custom', providerId };
    this.viewGeneration += 1;
    this.renderCurrentView();
  }

  private startCustom(template: 'openai' | 'anthropic' | 'other'): void {
    if (!this.customEditingAvailable()) return;
    this.customEditor.unmount();
    this.revealRequestId += 1;
    this.view = { kind: 'new-custom', template };
    this.viewGeneration += 1;
    this.renderCurrentView();
  }

  private showList(): void {
    this.customEditor.unmount();
    this.revealRequestId += 1;
    this.view = { kind: 'list' };
    this.viewGeneration += 1;
    this.officialDrafts.clear();
    this.renderCurrentView();
  }

  private renderCurrentView(): void {
    if (!this.content) return;
    if (this.view.kind === 'list') this.renderList();
    else if (this.view.kind === 'picker') this.renderPicker();
    else if (this.view.kind === 'official') this.renderOfficial(this.view.providerId);
    else this.renderCustomEditor();
  }

  private renderAfterDataChange(): void {
    if (this.view.kind === 'custom' || this.view.kind === 'new-custom') {
      if (!this.content?.querySelector('.cpe-editor')) this.renderCustomEditor();
      return;
    }
    this.renderCurrentView();
  }

  private renderList(): void {
    if (!this.content) return;
    const view = new ProviderCardListView({
      onUse: (providerId, modelId) => { void this.switchModel(providerId, modelId); },
      onEdit: providerId => {
        if (this.customProviders.some(provider => provider.id === providerId)) this.showCustom(providerId);
        else this.showOfficial(providerId);
      },
      onAdd: () => this.showPicker(),
    });
    view.render(this.content, {
      current: this.currentModel,
      pendingSwitch: this.pendingModelSwitch
        ? { providerId: this.pendingModelSwitch.providerId, modelId: this.pendingModelSwitch.modelId }
        : null,
      providers: this.visibleCards(),
    });
    this.appendCustomStatus(this.content.querySelector('.provider-card-list'));
  }

  private renderPicker(): void {
    if (!this.content) return;
    const view = new ProviderPickerView({
      onBack: () => this.showList(),
      onOfficial: providerId => this.showOfficial(providerId),
      onCustom: template => this.startCustom(template),
    });
    view.render(this.content, {
      official: this.allOfficialProviders(),
      customAvailable: this.customEditingAvailable(),
    });
    this.appendCustomStatus(this.content.querySelector('.provider-picker'));
  }

  private renderOfficial(providerId: string): void {
    if (!this.content) return;
    const provider = this.officialById(providerId);
    const key = this.providerKeys[providerId] ?? { hasKey: false, canReveal: false, keyPreview: '' };
    const draft = this.officialDraft(providerId);
    const placeholder = key.canReveal
      ? `已保存: ${key.keyPreview || '********'}，输入新 Key 覆盖`
      : key.hasKey ? '已通过其他方式认证，输入 API Key 覆盖' : '输入 API Key...';
    const view = new OfficialProviderEditorView({
      onBack: () => this.showList(),
      onReveal: id => { void this.revealOfficialKey(id); },
      onApiKeyChange: (id, value) => { this.officialDraft(id).value = value; },
      onKeyVisibilityChange: (id, revealed) => { this.officialDraft(id).revealed = revealed; },
      onSave: (id, apiKey) => { void this.saveOfficialKey(id, apiKey); },
      onUse: (id, modelId) => { void this.switchModel(id, modelId); },
    });
    view.render(this.content, {
      provider: {
        id: provider.id,
        name: provider.name,
        configured: provider.configured || key.hasKey,
      },
      apiKey: {
        value: draft.value,
        placeholder,
        revealed: draft.revealed,
        canReveal: key.canReveal,
        saving: draft.saving,
      },
      models: {
        status: this.officialModelsState,
        items: this.modelsForProvider(providerId, false),
        activeModelId: this.currentModel?.providerId === providerId ? this.currentModel.modelId : null,
        switchPending: Boolean(this.pendingModelSwitch),
        pendingModelId: this.pendingModelSwitch?.providerId === providerId
          ? this.pendingModelSwitch.modelId
          : null,
        error: this.officialModelsState === 'error' ? '加载模型列表失败' : '',
      },
    });
  }

  private renderCustomEditor(): void {
    if (!this.content) return;
    const shell = providerElement('section', 'provider-custom-editor-shell');
    const back = providerElement('button', 'provider-editor-back', '返回');
    back.type = 'button';
    back.dataset.providerAction = 'back';
    back.addEventListener('click', () => this.showList());
    const mount = providerElement('div', 'provider-custom-editor-mount');
    shell.append(back, mount);
    this.content.replaceChildren(shell);

    if (!this.customEditingAvailable()) {
      mount.append(providerElement('p', 'provider-custom-status', this.customStatusText()));
      return;
    }
    if (this.view.kind === 'custom') {
      const provider = this.customProviders.find(candidate => candidate.id === this.view.providerId);
      if (provider) this.customEditor.mount(mount, provider, this.revision);
      else this.showList();
      return;
    }
    if (this.view.kind === 'new-custom') {
      this.customEditor.startNew(mount, this.revision, {
        template: this.view.template,
        occupiedProviderIds: this.occupiedProviderIds(),
      });
    }
  }

  private appendCustomStatus(parent: Element | null): void {
    if (!parent) return;
    const status = providerElement('div', 'provider-custom-status');
    status.setAttribute('aria-live', 'polite');
    const ready = this.customEditingAvailable();
    status.hidden = ready;
    status.textContent = ready ? '' : this.customStatusText();
    parent.append(status);
  }

  private customStatusText(): string {
    if (this.customSnapshotState === 'error') return '自定义厂商不可用：配置列表加载失败';
    if (this.capabilitiesState === 'error') return '自定义厂商不可用：协议能力加载失败';
    return '正在加载自定义厂商...';
  }

  private customEditingAvailable(): boolean {
    return this.customSnapshotState === 'ready'
      && this.capabilitiesState === 'ready'
      && this.customProtocols.length > 0;
  }

  private allOfficialProviders(): OfficialProviderListItem[] {
    const result: OfficialProviderListItem[] = [];
    const indexes = new Map<string, number>();
    const merge = (provider: OfficialProviderListItem): void => {
      const configured = provider.configured || Boolean(this.providerKeys[provider.id]?.hasKey);
      const index = indexes.get(provider.id);
      if (index === undefined) {
        indexes.set(provider.id, result.length);
        result.push({ ...provider, configured });
      } else {
        const current = result[index];
        result[index] = {
          id: current.id,
          name: current.name === current.id ? provider.name : current.name,
          configured: current.configured || configured,
        };
      }
    };
    for (const provider of this.officialProviders) merge(provider);
    for (const provider of this.authOfficialProviders) merge(provider);
    const currentId = this.currentModel?.providerId;
    if (currentId && !this.customProviders.some(provider => provider.id === currentId)) {
      merge({ id: currentId, name: currentId, configured: Boolean(this.providerKeys[currentId]?.hasKey) });
    }
    return result;
  }

  private officialById(providerId: string): OfficialProviderListItem {
    return this.allOfficialProviders().find(provider => provider.id === providerId)
      ?? { id: providerId, name: providerId, configured: Boolean(this.providerKeys[providerId]?.hasKey) };
  }

  private occupiedProviderIds(): ReadonlySet<string> {
    return new Set([
      ...this.allOfficialProviders().map(provider => provider.id),
      ...this.customProviders.map(provider => provider.id),
    ]);
  }

  private visibleCards(): ProviderCardItem[] {
    const official = this.allOfficialProviders();
    const customById = new Map(this.customProviders.map(provider => [provider.id, provider]));
    const officialById = new Map(official.map(provider => [provider.id, provider]));
    const visibleIds: string[] = [];
    for (const provider of official) if (provider.configured) visibleIds.push(provider.id);
    for (const provider of this.customProviders) visibleIds.push(provider.id);
    if (this.currentModel?.providerId) visibleIds.push(this.currentModel.providerId);
    const uniqueVisible = [...new Set(visibleIds)];
    const visible = new Set(uniqueVisible);
    const ordered: string[] = [];
    for (const id of this.savedProviderOrder()) if (visible.has(id) && !ordered.includes(id)) ordered.push(id);
    for (const id of uniqueVisible) if (!ordered.includes(id)) ordered.push(id);

    return ordered.flatMap(id => {
      const custom = customById.get(id);
      if (custom) {
        return [{
          id: custom.id,
          name: custom.name,
          custom: true,
          configured: custom.authMode === 'none' || custom.apiKeyConfigured,
          baseUrl: custom.baseUrl,
          protocolLabel: SETTINGS_PROTOCOL_LABELS[custom.protocol],
          models: this.modelsForProvider(custom.id, true),
        }];
      }
      const provider = officialById.get(id) ?? this.officialById(id);
      return [{
        id: provider.id,
        name: provider.name,
        custom: false,
        configured: provider.configured || Boolean(this.providerKeys[id]?.hasKey),
        baseUrl: '',
        protocolLabel: '官方',
        models: this.modelsForProvider(id, false),
      }];
    });
  }

  private savedProviderOrder(): string[] {
    const raw = this.dependencies.preferences.get('providers_order');
    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private modelsForProvider(providerId: string, custom: boolean): ProviderCardModel[] {
    const models = custom
      ? this.customProviders.find(provider => provider.id === providerId)?.models.map(model => ({ id: model.id, name: model.name })) ?? []
      : this.officialModels.get(providerId) ?? [];
    const seen = new Set<string>();
    return models.filter(model => {
      const key = `${providerId}\u0000${model.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private readCurrentModel(): ProviderCardListState['current'] {
    const dashboard = this.dependencies.chatState.getDashboard();
    if (!dashboard || typeof dashboard.modelProvider !== 'string' || typeof dashboard.modelId !== 'string') return null;
    return { providerId: dashboard.modelProvider, modelId: dashboard.modelId };
  }

  private officialDraft(providerId: string): OfficialApiKeyDraft {
    let draft = this.officialDrafts.get(providerId);
    if (!draft) {
      draft = { value: '', revealed: false, saving: false };
      this.officialDrafts.set(providerId, draft);
    }
    return draft;
  }

  private async loadOfficialAuth(generation: number): Promise<void> {
    const requestId = ++this.officialAuthRequestId;
    try {
      const value = await providerJson('/api/auth');
      if (generation !== this.lifecycleGeneration || requestId !== this.officialAuthRequestId) return;
      if (!providerRecord(value) || !Array.isArray(value.providers)) throw new Error('Invalid auth response');
      const keys: Record<string, ProviderKeyInfo> = {};
      const official: OfficialProviderListItem[] = [];
      const seen = new Set<string>();
      for (const entry of value.providers) {
        if (!providerRecord(entry) || typeof entry.provider !== 'string') continue;
        const confirmedKey = entry.hasKey === true;
        const optimisticKey = this.optimisticOfficialKeys.has(entry.provider);
        const hasKey = confirmedKey || optimisticKey;
        const currentKey = this.providerKeys[entry.provider];
        const keyPreview = optimisticKey && !confirmedKey
          ? currentKey?.keyPreview ?? '********'
          : typeof entry.keyPreview === 'string' ? entry.keyPreview : '';
        keys[entry.provider] = {
          hasKey,
          canReveal: optimisticKey && !confirmedKey
            ? currentKey?.canReveal ?? true
            : typeof entry.canReveal === 'boolean' ? entry.canReveal : Boolean(keyPreview),
          keyPreview,
        };
        if (!seen.has(entry.provider)) {
          seen.add(entry.provider);
          official.push({ id: entry.provider, name: entry.provider, configured: hasKey });
        }
        if (confirmedKey) this.optimisticOfficialKeys.delete(entry.provider);
      }
      for (const providerId of this.optimisticOfficialKeys) {
        if (seen.has(providerId)) continue;
        const currentKey = this.providerKeys[providerId];
        keys[providerId] = currentKey ?? { hasKey: true, canReveal: true, keyPreview: '********' };
        const currentProvider = this.officialById(providerId);
        official.push({ id: providerId, name: currentProvider.name, configured: true });
      }
      this.providerKeys = keys;
      this.authOfficialProviders = official;
      this.renderAfterDataChange();
    } catch {
      if (generation !== this.lifecycleGeneration || requestId !== this.officialAuthRequestId) return;
      this.dependencies.notify('加载官方厂商认证失败', 'error');
      this.renderAfterDataChange();
    }
  }

  private async loadCustomSnapshot(generation: number): Promise<void> {
    try {
      const value = await providerJson('/api/custom-providers');
      if (generation !== this.lifecycleGeneration) return;
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
      } else if (snapshot.revision === this.revision) {
        this.officialProviders = snapshot.official;
      }
      this.customSnapshotState = this.hasCustomAuthority ? 'ready' : 'loading';
      this.renderAfterDataChange();
    } catch {
      if (generation !== this.lifecycleGeneration) return;
      if (!this.hasCustomAuthority) {
        this.customProviders = [];
        this.revision = 0;
        this.customSnapshotState = 'error';
      } else this.customSnapshotState = 'ready';
      this.renderAfterDataChange();
    }
  }

  private async loadCapabilities(generation: number): Promise<void> {
    try {
      const protocols = capabilityProtocols(await providerJson('/api/custom-providers/capabilities'));
      if (generation !== this.lifecycleGeneration) return;
      this.capabilitiesState = 'ready';
      this.customProtocols = protocols;
      this.customEditor.setProtocols(protocols);
    } catch {
      if (generation !== this.lifecycleGeneration) return;
      this.capabilitiesState = 'error';
      this.customProtocols = [];
      this.customEditor.setProtocols([]);
    }
    this.renderAfterDataChange();
  }

  private async loadOfficialModels(generation: number): Promise<void> {
    const requestId = ++this.officialModelsRequestId;
    this.officialModelsState = 'loading';
    this.renderAfterDataChange();
    try {
      const value = await providerJson('/api/models');
      if (generation !== this.lifecycleGeneration || requestId !== this.officialModelsRequestId) return;
      if (!providerRecord(value) || !Array.isArray(value.models)) throw new Error('Invalid models response');
      const models = new Map<string, ProviderCardModel[]>();
      const seen = new Set<string>();
      for (const entry of value.models) {
        if (!providerRecord(entry) || typeof entry.provider !== 'string' || typeof entry.id !== 'string') continue;
        const key = `${entry.provider}\u0000${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const items = models.get(entry.provider) ?? [];
        items.push({ id: entry.id, name: typeof entry.name === 'string' ? entry.name : entry.id });
        models.set(entry.provider, items);
      }
      this.officialModels = models;
      this.officialModelsState = 'ready';
      this.renderAfterDataChange();
    } catch {
      if (generation !== this.lifecycleGeneration || requestId !== this.officialModelsRequestId) return;
      this.officialModels = new Map();
      this.officialModelsState = 'error';
      this.renderAfterDataChange();
      this.dependencies.notify('加载模型列表失败', 'error');
    }
  }

  private applyCustomSnapshot(
    snapshot: RedactedCustomProviderSnapshot,
    source:
      | { kind: 'save'; selectedId: string; activateSaved: boolean; currentMount: boolean }
      | { kind: 'delete'; currentMount: boolean },
  ): void {
    if (!this.dependencies.isValidRevision(snapshot.revision) || !Array.isArray(snapshot.providers)) return;
    const accepted = !this.hasCustomAuthority || snapshot.revision > this.revision;
    if (accepted) {
      this.hasCustomAuthority = true;
      this.customProviders = snapshot.providers;
      this.revision = snapshot.revision;
    }
    this.customSnapshotState = this.hasCustomAuthority ? 'ready' : this.customSnapshotState;
    if (!accepted) {
      this.renderAfterDataChange();
      return;
    }

    const activeView = this.view;
    const shouldReturn = source.currentMount && (source.kind === 'save'
      ? (activeView.kind === 'custom' && activeView.providerId === source.selectedId)
        || (activeView.kind === 'new-custom' && source.activateSaved)
      : activeView.kind === 'custom'
        && !snapshot.providers.some(provider => provider.id === activeView.providerId));
    if (shouldReturn) this.showList();
    else this.renderAfterDataChange();
  }

  private async revealOfficialKey(providerId: string): Promise<void> {
    const lifecycle = this.lifecycleGeneration;
    const view = this.viewGeneration;
    const requestId = ++this.revealRequestId;
    try {
      const response = await fetch('/api/auth/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId }),
      });
      const value = await response.json() as unknown;
      if (!response.ok || !providerRecord(value) || typeof value.apiKey !== 'string') throw new Error('Reveal failed');
      if (
        lifecycle !== this.lifecycleGeneration
        || view !== this.viewGeneration
        || requestId !== this.revealRequestId
        || this.view.kind !== 'official'
        || this.view.providerId !== providerId
      ) return;
      const draft = this.officialDraft(providerId);
      draft.value = value.apiKey;
      draft.revealed = true;
      this.renderOfficial(providerId);
    } catch {
      if (
        lifecycle === this.lifecycleGeneration
        && view === this.viewGeneration
        && requestId === this.revealRequestId
        && this.view.kind === 'official'
        && this.view.providerId === providerId
      ) this.dependencies.notify('显示 API Key 失败', 'error');
    }
  }

  private async saveOfficialKey(providerId: string, value: string): Promise<void> {
    let apiKey = value.trim();
    if (!apiKey) {
      this.dependencies.notify('请输入 API Key');
      return;
    }
    const lifecycle = this.lifecycleGeneration;
    const view = this.viewGeneration;
    const draft = this.officialDraft(providerId);
    draft.value = value;
    draft.saving = true;
    if (this.view.kind === 'official' && this.view.providerId === providerId) this.renderOfficial(providerId);
    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, apiKey }),
      });
      let result: unknown = {};
      try { result = await response.json(); } catch {}
      if (!response.ok || !providerRecord(result) || result.ok !== true) throw new Error('Save failed');
      draft.value = '';
      draft.revealed = false;
      value = '';
      apiKey = '';
      if (lifecycle !== this.lifecycleGeneration) return;
      this.optimisticOfficialKeys.add(providerId);
      this.providerKeys[providerId] = { hasKey: true, canReveal: true, keyPreview: '********' };
      const provider = this.officialById(providerId);
      const existing = this.authOfficialProviders.find(candidate => candidate.id === providerId);
      if (existing) existing.configured = true;
      else this.authOfficialProviders.push({ id: providerId, name: provider.name, configured: true });
      if (
        view === this.viewGeneration
        && this.view.kind === 'official'
        && this.view.providerId === providerId
      ) this.renderOfficial(providerId);
      this.dependencies.notify('已保存', 'success');
      await Promise.all([this.loadOfficialAuth(lifecycle), this.loadOfficialModels(lifecycle)]);
      if (
        lifecycle === this.lifecycleGeneration
        && view === this.viewGeneration
        && this.view.kind === 'official'
        && this.view.providerId === providerId
      ) this.showList();
    } catch {
      draft.saving = false;
      if (
        lifecycle !== this.lifecycleGeneration
        || view !== this.viewGeneration
        || this.view.kind !== 'official'
        || this.view.providerId !== providerId
      ) return;
      this.dependencies.notify('保存失败', 'error');
      this.renderOfficial(providerId);
    }
  }

  private async switchModel(providerId: string, modelId: string): Promise<void> {
    if (this.pendingModelSwitch) return;
    const lifecycle = this.lifecycleGeneration;
    const view = this.viewGeneration;
    const operation: ProviderModelSwitchOperation = {
      requestId: ++this.modelSwitchRequestId,
      providerId,
      modelId,
    };
    this.pendingModelSwitch = operation;
    this.renderAfterDataChange();
    try {
      const response = await fetch('/api/model/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, modelId }),
      });
      let result: unknown = {};
      try { result = await response.json(); } catch {}
      if (!this.isActiveModelSwitch(operation)) return;
      if (!response.ok || !providerRecord(result) || result.ok !== true) {
        const suffix = providerRecord(result) && typeof result.error === 'string' ? `: ${result.error}` : '';
        if (this.isOriginalModelSwitchContext(lifecycle, view, operation)) {
          this.dependencies.notify(`切换失败${suffix}`, 'error');
        }
        return;
      }
      if (this.isOriginalModelSwitchContext(lifecycle, view, operation)) {
        this.dependencies.notify(`已切换: ${modelId}`, 'success');
      }
      await this.dependencies.refreshDashboard();
      if (!this.isActiveModelSwitch(operation)) return;
      this.currentModel = this.readCurrentModel();
    } catch {
      if (this.isOriginalModelSwitchContext(lifecycle, view, operation)) {
        this.dependencies.notify('切换失败', 'error');
      }
    } finally {
      if (this.isActiveModelSwitch(operation)) {
        this.pendingModelSwitch = null;
        this.renderAfterDataChange();
      }
    }
  }

  private isActiveModelSwitch(operation: ProviderModelSwitchOperation): boolean {
    return operation.requestId === this.modelSwitchRequestId
      && this.pendingModelSwitch === operation;
  }

  private isOriginalModelSwitchContext(
    lifecycle: number,
    view: number,
    operation: ProviderModelSwitchOperation,
  ): boolean {
    return this.isActiveModelSwitch(operation)
      && lifecycle === this.lifecycleGeneration
      && view === this.viewGeneration;
  }
}

const settingsProviderApp = (window as any).App;
const settingsProviderController = new SettingsProviderModelController({
  preferences: settingsProviderApp.Preferences,
  chatState: settingsProviderApp.ChatState,
  refreshDashboard: () => settingsProviderApp.UI.getD(),
  notify: toast,
  listAddAction: settingsProviderApp.Ui.ListAddAction,
  customEditorType: settingsProviderApp.SettingsCustomProviderEditor,
  isValidRevision: settingsProviderApp.isCustomProviderRevision,
});
settingsProviderApp.SettingsComponents = {
  ...(settingsProviderApp.SettingsComponents || {}),
  providers: settingsProviderController,
};
