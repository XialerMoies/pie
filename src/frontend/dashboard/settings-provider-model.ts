/// <reference path="../dashboard.d.ts" />

interface SettingsProviderModelDependencies {
  preferences: AppPreferences;
  chatState: AppChatState;
  refreshDashboard: () => void;
  notify: typeof toast;
}

class SettingsProviderModelController implements SettingsProviderModelApi {
  private selectedProvider: string | null = null;
  private providerKeys: Record<string, ProviderKeyInfo> = {};
  private revealRequestId = 0;
  private dragIndex = -1;

  constructor(private readonly dependencies: SettingsProviderModelDependencies) {}

  renderTab(container: HTMLElement): void {
    container.innerHTML = `
      <div class="model-split">
        <div class="ms-left">
          <div class="msl-title">厂商</div>
          <div class="msl-list" id="msl-list"><div class="sp" style="margin:20px auto"></div></div>
        </div>
        <div class="ms-right">
          <div id="ms-right-content"><div class="sp" style="margin:40px auto"></div></div>
        </div>
      </div>
    `;
    fetch('/api/auth').then(r => r.json()).then((data: { providers: Array<{ provider: string; hasKey: boolean; canReveal?: boolean; keyPreview: string }> }) => {
      const list = $('msl-list');
      if (!list) return;
      const configuredKeys: Record<string, ProviderKeyInfo> = {};
      data.providers?.forEach(provider => {
        configuredKeys[provider.provider] = {
          hasKey: provider.hasKey,
          canReveal: provider.canReveal ?? Boolean(provider.keyPreview),
          keyPreview: provider.keyPreview || '',
        };
        this.providerKeys[provider.provider] = configuredKeys[provider.provider];
      });
      const allProviders = ['anthropic', 'deepseek', 'openai', 'openrouter', 'google'];
      const configured = allProviders.filter(provider => configuredKeys[provider]?.hasKey);
      const unconfigured = allProviders.filter(provider => !configured.includes(provider));
      const savedOrder = this.dependencies.preferences.get('providers_order');
      let order: string[] = configured.concat(unconfigured);
      if (savedOrder) {
        try {
          const parsed = JSON.parse(savedOrder);
          if (Array.isArray(parsed)) order = parsed.filter((provider): provider is string => typeof provider === 'string');
        } catch {}
      }
      allProviders.forEach(provider => { if (!order.includes(provider)) order.push(provider); });
      window._provOrder = order;
      list.innerHTML = this.renderProviderList(order);
      if (order.length > 0) this.selectProvider(order[0]);
    }).catch(() => {
      const list = $('msl-list');
      if (list) list.innerHTML = '<p style="color:var(--rs);font-size:.72rem">加载失败</p>';
      this.dependencies.notify('加载厂商列表失败', 'error');
    });
  }

  selectProvider(provider: string): void {
    this.selectedProvider = provider;
    document.querySelectorAll('.msl-item').forEach(element => {
      const item = element as HTMLElement;
      item.classList.toggle('on', item.dataset.prov === provider);
    });
    const content = $('ms-right-content');
    if (!content) return;
    const info = this.providerKeys[provider] || { hasKey: false, canReveal: false, keyPreview: '' };
    const placeholder = info.canReveal
      ? `已保存: ${info.keyPreview || '********'}，输入新 Key 覆盖`
      : info.hasKey
        ? '已通过其他方式认证，输入 API Key 覆盖'
      : '输入 API Key...';
    let html = `
      <div class="rp-header">
        <div class="rp-prov-name">${E(provider)}</div>
        <span class="rp-status${info.hasKey ? ' on' : ''}">${info.hasKey ? '已配置' : '未配置'}</span>
      </div>
    `;
    if (info.hasKey) html += `<div class="rp-models" id="rp-models" data-provider="${E(provider)}">加载中...</div>`;
    html += `
      <div class="rp-key-section">
        <div class="rp-key-label">API Key</div>
        <div class="rp-key-row">
          <input class="rp-key-input" type="${info.canReveal ? 'text' : 'password'}" id="key-input" data-provider="${E(provider)}" placeholder="${E(placeholder)}" value="${E(info.keyPreview || '')}"/>
          <button type="button" class="rp-key-toggle" data-settings-action="toggle-key" data-provider="${E(provider)}" aria-label="显示或隐藏 API Key">👁</button>
          <button type="button" class="rp-save-btn" data-settings-action="save-key" data-provider="${E(provider)}">保存</button>
        </div>
      </div>
    `;
    content.innerHTML = html;
    if (info.canReveal) void this.revealProviderKey(provider);
    if (info.hasKey) this.loadProviderModels(provider);
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
    }).catch(() => this.dependencies.notify('保存失败'));
  }

  loadProviderModels(provider: string): void {
    const container = $('rp-models') as HTMLElement | null;
    if (!container || container.dataset.provider !== provider) return;
    fetch('/api/models').then(response => response.json()).then((data: { models?: Array<{ provider: string; id: string }> }) => {
      if (this.selectedProvider !== provider || $('rp-models') !== container) return;
      const models = (data.models || []).filter(model => model.provider === provider);
      if (models.length === 0) {
        container.innerHTML = '<p style="color:var(--tm);font-size:.72rem">无可用模型</p>';
        return;
      }
      const dashboard = this.dependencies.chatState.getDashboard?.() || null;
      container.innerHTML = '<div class="rp-models-title">可用模型</div>' + models.map(model => {
        const active = model.provider === dashboard?.modelProvider && model.id === dashboard?.modelId;
        return `<div class="rp-model-item${active ? ' on' : ''}" data-model-provider="${E(model.provider)}" data-model-id="${E(model.id)}">${E(model.id)}</div>`;
      }).join('');
    }).catch(() => {
      container.innerHTML = '<p style="color:var(--rs);font-size:.72rem">加载失败</p>';
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
    order.splice(index, 0, item);
    window._provOrder = order;
    this.dependencies.preferences.setJson('providers_order', order);
    const list = $('msl-list');
    if (list) list.innerHTML = this.renderProviderList(order);
    this.dragIndex = -1;
  }

  private renderProviderList(order: string[]): string {
    return order.map((provider, index) => {
      const selected = provider === this.selectedProvider || (!this.selectedProvider && index === 0) ? ' on' : '';
      const configured = this.providerKeys[provider]?.hasKey;
      return `<div class="msl-item${selected}" draggable="true" data-prov="${E(provider)}" data-index="${index}">
        <span class="msl-name">${E(provider)}</span><span class="msl-drag">⠿</span><span class="msl-status${configured ? ' on' : ''}"></span>
      </div>`;
    }).join('');
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
});
settingsProviderApp.SettingsComponents = {
  ...(settingsProviderApp.SettingsComponents || {}),
  providers: settingsProviderController,
};
