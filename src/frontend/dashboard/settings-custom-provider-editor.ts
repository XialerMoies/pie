/// <reference path="../dashboard.d.ts" />

interface SettingsCustomProviderEditorDependencies {
  notify: typeof toast;
  listAddAction: typeof ListAddAction;
  onSaved(snapshot: RedactedCustomProviderSnapshot, selectedId: string): void;
  onDeleted(snapshot: RedactedCustomProviderSnapshot): void;
}

interface CustomProviderErrorResponse {
  error?: unknown;
  code?: unknown;
  fieldPath?: unknown;
  currentRevision?: unknown;
  references?: unknown;
}

type DraftModel = CustomProviderDraft['models'][number];

const CUSTOM_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CUSTOM_FORBIDDEN_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'upgrade',
]);

function cpeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function cpeInput(
  id: string,
  className: string,
  value: string,
  type = 'text',
): HTMLInputElement {
  const input = cpeElement('input', className);
  input.id = id;
  input.type = type;
  input.value = value;
  return input;
}

function cpeButton(action: string, label: string, className = 'cpe-button'): HTMLButtonElement {
  const button = cpeElement('button', className, label);
  button.type = 'button';
  button.dataset.cpeAction = action;
  return button;
}

function emptyModel(id = ''): DraftModel {
  return {
    id,
    name: id,
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

function finiteNumber(input: HTMLInputElement | null, fallback = 0): number {
  const parsed = Number(input?.value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJsonObject(input: HTMLTextAreaElement | null, field: string): Record<string, unknown> | undefined {
  const value = input?.value.trim() ?? '';
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${field} 必须是 JSON 对象`);
  return parsed as Record<string, unknown>;
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class SettingsCustomProviderEditor {
  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private provider: RedactedCustomProvider | null = null;
  private revision = 0;
  private newProvider = false;
  private apiKeyCleared = false;
  private deleteArmed = false;
  private protocols: CustomProviderProtocol[] = [];

  constructor(private readonly dependencies: SettingsCustomProviderEditorDependencies) {}

  setProtocols(protocols: readonly CustomProviderProtocol[]): void {
    this.protocols = [...new Set(protocols)];
  }

  mount(container: HTMLElement, provider: RedactedCustomProvider | null, revision: number): void {
    if (!provider) {
      this.startNew(container, revision);
      return;
    }
    this.container = container;
    this.provider = provider;
    this.revision = revision;
    this.newProvider = false;
    this.apiKeyCleared = false;
    this.deleteArmed = false;
    this.render(provider);
  }

  startNew(container: HTMLElement, revision: number): void {
    this.container = container;
    this.provider = null;
    this.revision = revision;
    this.newProvider = true;
    this.apiKeyCleared = false;
    this.deleteArmed = false;
    this.render(null);
  }

  async save(): Promise<void> {
    this.clearFeedback();
    const draft = this.readDraft(true);
    if (!draft) return;
    const currentId = this.provider?.id;
    const url = this.newProvider
      ? '/api/custom-providers'
      : `/api/custom-providers/${encodeURIComponent(currentId || draft.id)}`;
    const response = await this.request(url, {
      method: this.newProvider ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: this.revision, provider: draft }),
    });
    if (!response.ok) {
      await this.handleMutationError(response.body);
      return;
    }
    const snapshot = response.body as RedactedCustomProviderSnapshot;
    const saved = safeArray(snapshot.providers).find((candidate) => (
      candidate && typeof candidate === 'object' && (candidate as RedactedCustomProvider).id === draft.id
    )) as RedactedCustomProvider | undefined;
    if (!saved || typeof snapshot.revision !== 'number') {
      this.showResult('保存响应无效', true);
      return;
    }
    this.revision = snapshot.revision;
    this.provider = saved;
    this.newProvider = false;
    this.apiKeyCleared = false;
    this.render(saved);
    this.dependencies.onSaved(snapshot, saved.id);
    this.dependencies.notify('已保存', 'success');
  }

  async test(): Promise<void> {
    this.clearFeedback();
    const draft = this.readDraft(false);
    if (!draft) return;
    const response = await this.request('/api/custom-providers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: draft }),
    });
    const body = response.body as Record<string, unknown>;
    if (!response.ok || body.ok === false) {
      const code = typeof body.code === 'string' ? body.code : 'failed';
      const message = typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string' ? body.error : '连接测试失败';
      this.showResult(`${code}: ${this.redact(message)}`, true);
      return;
    }
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const latency = typeof body.latencyMs === 'number' ? ` · ${body.latencyMs} ms` : '';
    this.showResult(`连接成功${modelId ? ` · ${modelId}` : ''}${latency}`, false);
  }

  async discoverModels(): Promise<void> {
    this.clearFeedback();
    const draft = this.readDraft(false);
    if (!draft) return;
    const response = await this.request('/api/custom-providers/discover-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: draft }),
    });
    if (!response.ok) {
      this.showResult(this.errorText(response.body, '模型发现失败'), true);
      return;
    }
    const ids = safeArray((response.body as { ids?: unknown }).ids)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const existing = new Set(
      [...(this.root?.querySelectorAll<HTMLInputElement>('.cpe-model-id') ?? [])].map(input => input.value),
    );
    const imported = ids.filter(id => !existing.has(id));
    if (imported.length === 0) {
      this.showResult('未发现新的模型 ID', false);
      return;
    }
    if (!window.confirm(`导入 ${imported.length} 个模型 ID？\n${imported.join('\n')}`)) {
      this.showResult('已取消导入', false);
      return;
    }
    const rows = this.root?.querySelector<HTMLElement>('.cpe-model-rows');
    if (!rows) return;
    for (const id of imported) rows.append(this.createModelRow(emptyModel(id)));
    this.showResult(`已导入 ${imported.length} 个模型 ID，保存后生效`, false);
  }

  async delete(): Promise<void> {
    if (!this.provider || this.newProvider) return;
    const button = this.root?.querySelector<HTMLButtonElement>('[data-cpe-action="delete"]');
    if (!this.deleteArmed) {
      this.deleteArmed = true;
      if (button) {
        button.classList.add('armed');
        button.textContent = '再次点击删除';
      }
      return;
    }
    this.clearFeedback();
    const response = await this.request(`/api/custom-providers/${encodeURIComponent(this.provider.id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: this.revision }),
    });
    if (!response.ok) {
      await this.handleMutationError(response.body);
      return;
    }
    const snapshot = response.body as RedactedCustomProviderSnapshot;
    if (typeof snapshot.revision !== 'number' || !Array.isArray(snapshot.providers)) {
      this.showResult('删除响应无效', true);
      return;
    }
    this.dependencies.onDeleted(snapshot);
    this.dependencies.notify('已删除', 'success');
  }

  private render(provider: RedactedCustomProvider | null): void {
    if (!this.container) return;
    const root = cpeElement('div', 'cpe-editor');
    this.root = root;

    const heading = cpeElement('div', 'cpe-heading');
    heading.append(
      cpeElement('div', 'cpe-title', provider ? provider.name : '添加自定义厂商'),
      cpeElement('span', 'cpe-revision', `Revision ${this.revision}`),
    );
    root.append(heading);

    const conflict = cpeElement('div', 'cpe-conflict-banner');
    conflict.hidden = true;
    root.append(conflict);

    const form = cpeElement('div', 'cpe-form');
    form.append(
      this.field('名称', cpeInput('cpe-name', 'cpe-input', provider?.name ?? '')),
      this.field('Provider ID', cpeInput('cpe-id', 'cpe-input', provider?.id ?? '')),
      this.protocolField(provider?.protocol ?? ''),
      this.field('Base URL', cpeInput('cpe-base-url', 'cpe-input', provider?.baseUrl ?? '', 'url')),
      this.field('模型发现路径', cpeInput('cpe-model-discovery', 'cpe-input', provider?.modelDiscovery ?? '')),
      this.authField(provider),
      this.apiKeyField(provider),
      this.headersField(provider?.headers ?? []),
      this.modelsField(provider?.models ?? [emptyModel()]),
    );
    const idInput = form.querySelector<HTMLInputElement>('#cpe-id');
    if (idInput) idInput.readOnly = Boolean(provider);
    root.append(form);

    const result = cpeElement('div', 'cpe-result');
    result.hidden = true;
    root.append(result);

    const actions = cpeElement('div', 'cpe-actions');
    actions.append(
      cpeButton('test', '测试连接'),
      cpeButton('discover', '发现模型'),
      cpeButton('save', '保存', 'cpe-button primary'),
    );
    if (provider) actions.prepend(cpeButton('delete', '删除', 'cpe-button danger'));
    root.append(actions);

    root.addEventListener('click', event => this.handleClick(event));
    root.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      if (input.id !== 'cpe-api-key' || input.value.length === 0) return;
      this.apiKeyCleared = false;
      input.placeholder = this.provider?.apiKeyConfigured ? '留空保留已保存值' : '输入 API Key';
    });
    this.container.replaceChildren(root);
  }

  private field(labelText: string, control: HTMLElement, errorField?: string): HTMLElement {
    const field = cpeElement('label', 'cpe-field');
    field.append(cpeElement('span', 'cpe-label', labelText), control);
    const error = cpeElement('span', 'cpe-field-error');
    error.dataset.fieldError = errorField ?? this.fieldNameForControl(control.id);
    field.append(error);
    return field;
  }

  private fieldNameForControl(id: string): string {
    if (id === 'cpe-name') return 'name';
    if (id === 'cpe-id') return 'id';
    if (id === 'cpe-base-url') return 'baseUrl';
    if (id === 'cpe-model-discovery') return 'modelDiscovery';
    if (id === 'cpe-protocol') return 'protocol';
    return id;
  }

  private protocolField(selected: string): HTMLElement {
    const select = cpeElement('select', 'cpe-input');
    select.id = 'cpe-protocol';
    const prompt = cpeElement('option', undefined, '选择协议');
    prompt.value = '';
    select.append(prompt);
    for (const protocol of this.protocols) {
      const option = cpeElement('option', undefined, protocol);
      option.value = protocol;
      option.selected = protocol === selected;
      select.append(option);
    }
    return this.field('协议', select, 'protocol');
  }

  private authField(provider: RedactedCustomProvider | null): HTMLElement {
    const group = cpeElement('div', 'cpe-field cpe-auth-field');
    group.append(cpeElement('span', 'cpe-label', '认证'));
    const segmented = cpeElement('div', 'cpe-segmented');
    for (const mode of ['none', 'apiKey'] as const) {
      const label = cpeElement('label', 'cpe-segment');
      const radio = cpeElement('input');
      radio.type = 'radio';
      radio.name = 'cpe-auth-mode';
      radio.value = mode;
      radio.checked = provider?.authMode === mode;
      label.append(radio, cpeElement('span', undefined, mode === 'none' ? 'None' : 'API Key'));
      segmented.append(label);
    }
    group.append(segmented);
    const error = cpeElement('span', 'cpe-field-error');
    error.dataset.fieldError = 'authMode';
    group.append(error);
    return group;
  }

  private apiKeyField(provider: RedactedCustomProvider | null): HTMLElement {
    const section = cpeElement('div', 'cpe-secret-section');
    const line = cpeElement('div', 'cpe-secret-heading');
    line.append(cpeElement('span', 'cpe-label', 'API Key'));
    if (provider?.apiKeyConfigured) line.append(cpeElement('span', 'cpe-secret-status', '已保存'));
    section.append(line);
    const row = cpeElement('div', 'cpe-inline-row');
    const input = cpeInput('cpe-api-key', 'cpe-input', '', 'password');
    input.placeholder = provider?.apiKeyConfigured ? '留空保留已保存值' : '输入 API Key';
    row.append(input, cpeButton('clear-api-key', '清除', 'cpe-button subtle'));
    section.append(row);
    const error = cpeElement('span', 'cpe-field-error');
    error.dataset.fieldError = 'apiKey';
    section.append(error);
    return section;
  }

  private headersField(headers: RedactedCustomProvider['headers']): HTMLElement {
    const section = cpeElement('section', 'cpe-section');
    section.append(cpeElement('div', 'cpe-section-title', 'Headers'));
    const rows = cpeElement('div', 'cpe-header-rows');
    for (const header of headers) rows.append(this.createHeaderRow(header.name, header.configured));
    section.append(rows);
    const add = this.dependencies.listAddAction.create({
      label: '添加 Header',
      onActivate: () => rows.append(this.createHeaderRow('', false)),
    });
    add.dataset.cpeAction = 'add-header';
    section.append(add);
    return section;
  }

  private createHeaderRow(name: string, configured: boolean): HTMLElement {
    const row = cpeElement('div', 'cpe-header-row');
    row.dataset.originalName = name;
    row.dataset.configured = String(configured);
    const nameInput = cpeInput('', 'cpe-input cpe-header-name', name);
    nameInput.placeholder = 'Header name';
    if (configured) {
      nameInput.readOnly = true;
      nameInput.title = '如需修改名称，请删除此 Header 后新增';
      nameInput.setAttribute('aria-label', '已配置 Header 名称，只读');
    }
    const valueInput = cpeInput('', 'cpe-input cpe-header-value', '', 'password');
    valueInput.placeholder = configured ? '留空保留已保存值' : 'Header value';
    row.append(nameInput, valueInput);
    if (configured) row.append(cpeElement('span', 'cpe-header-status', '已保存'));
    row.append(cpeButton('remove-header', '删除', 'cpe-icon-button'));
    row.append(cpeElement('span', 'cpe-field-error cpe-header-error'));
    return row;
  }

  private modelsField(models: DraftModel[]): HTMLElement {
    const section = cpeElement('section', 'cpe-section');
    section.append(cpeElement('div', 'cpe-section-title', '模型'));
    const rows = cpeElement('div', 'cpe-model-rows');
    for (const model of models) rows.append(this.createModelRow(model));
    section.append(rows);
    const add = this.dependencies.listAddAction.create({
      label: '添加模型',
      onActivate: () => rows.append(this.createModelRow(emptyModel())),
    });
    add.dataset.cpeAction = 'add-model';
    section.append(add);
    return section;
  }

  private createModelRow(model: DraftModel): HTMLElement {
    const row = cpeElement('div', 'cpe-model-row');
    const main = cpeElement('div', 'cpe-model-main');
    const id = cpeInput('', 'cpe-input cpe-model-id', model.id);
    id.placeholder = 'Model ID';
    const name = cpeInput('', 'cpe-input cpe-model-name', model.name);
    name.placeholder = '显示名称';
    main.append(id, name, cpeButton('remove-model', '删除', 'cpe-icon-button'));
    row.append(main);

    const limits = cpeElement('div', 'cpe-model-grid');
    limits.append(
      this.miniField('Context', 'cpe-model-context', String(model.contextWindow), 'number'),
      this.miniField('Max tokens', 'cpe-model-max', String(model.maxTokens), 'number'),
      this.checkboxField('Reasoning', 'cpe-model-reasoning', model.reasoning),
      this.checkboxField('Image input', 'cpe-model-image', model.input.includes('image')),
    );
    row.append(limits);

    const details = cpeElement('details', 'cpe-advanced');
    details.open = false;
    details.append(cpeElement('summary', undefined, '高级设置'));
    const advanced = cpeElement('div', 'cpe-advanced-grid');
    advanced.append(
      this.miniField('Input USD / 1M', 'cpe-cost-input', String(model.cost.input), 'number'),
      this.miniField('Output USD / 1M', 'cpe-cost-output', String(model.cost.output), 'number'),
      this.miniField('Cache read USD / 1M', 'cpe-cost-cache-read', String(model.cost.cacheRead), 'number'),
      this.miniField('Cache write USD / 1M', 'cpe-cost-cache-write', String(model.cost.cacheWrite), 'number'),
      this.jsonField('Sampling JSON', 'cpe-model-sampling', model.samplingParams),
      this.jsonField('Compatibility JSON', 'cpe-model-compatibility', model.compatibility),
    );
    details.append(advanced);
    row.append(details);
    return row;
  }

  private miniField(labelText: string, className: string, value: string, type: string): HTMLElement {
    const label = cpeElement('label', 'cpe-mini-field');
    const input = cpeInput('', `cpe-input ${className}`, value, type);
    if (type === 'number') {
      input.min = '0';
      input.step = 'any';
    }
    label.append(cpeElement('span', undefined, labelText), input);
    return label;
  }

  private checkboxField(labelText: string, className: string, checked: boolean): HTMLElement {
    const label = cpeElement('label', 'cpe-check-field');
    const input = cpeElement('input');
    input.type = 'checkbox';
    input.className = className;
    input.checked = checked;
    label.append(input, cpeElement('span', undefined, labelText));
    return label;
  }

  private jsonField(labelText: string, className: string, value: Record<string, unknown> | undefined): HTMLElement {
    const label = cpeElement('label', 'cpe-mini-field cpe-json-field');
    const textarea = cpeElement('textarea', `cpe-input ${className}`);
    textarea.rows = 3;
    textarea.value = value ? JSON.stringify(value, null, 2) : '';
    label.append(cpeElement('span', undefined, labelText), textarea);
    return label;
  }

  private handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-cpe-action]')?.dataset.cpeAction;
    if (!action) return;
    if (action === 'save') void this.save();
    else if (action === 'test') void this.test();
    else if (action === 'discover') void this.discoverModels();
    else if (action === 'delete') void this.delete();
    else if (action === 'clear-api-key') {
      this.apiKeyCleared = true;
      const input = this.root?.querySelector<HTMLInputElement>('#cpe-api-key');
      if (input) {
        input.value = '';
        input.placeholder = '保存后清除';
      }
    } else if (action === 'remove-header') {
      const row = target.closest<HTMLElement>('.cpe-header-row');
      if (!row) return;
      if (row.dataset.configured === 'true') {
        row.dataset.removed = 'true';
        row.hidden = true;
      } else row.remove();
    } else if (action === 'remove-model') {
      target.closest('.cpe-model-row')?.remove();
    }
  }

  private readDraft(showErrors: boolean): CustomProviderDraft | null {
    if (!this.root) return null;
    const value = (selector: string) => this.root?.querySelector<HTMLInputElement>(selector)?.value.trim() ?? '';
    const id = value('#cpe-id');
    const name = value('#cpe-name');
    const baseUrl = value('#cpe-base-url');
    const protocol = this.root.querySelector<HTMLSelectElement>('#cpe-protocol')?.value ?? '';
    const authMode = this.root.querySelector<HTMLInputElement>('input[name="cpe-auth-mode"]:checked')?.value ?? '';
    let valid = true;
    const requireField = (field: string, fieldValue: string, message: string) => {
      if (fieldValue) return;
      valid = false;
      if (showErrors) this.setFieldError(field, message);
    };
    requireField('name', name, '请输入名称');
    requireField('id', id, '请输入 Provider ID');
    requireField('protocol', protocol, '请选择协议');
    requireField('baseUrl', baseUrl, '请输入 Base URL');
    requireField('authMode', authMode, '请选择认证方式');
    if (!valid) return null;

    const headers: CustomProviderDraft['headers'] = [];
    const headerNames = new Set<string>();
    for (const row of this.root.querySelectorAll<HTMLElement>('.cpe-header-row')) {
      const originalName = row.dataset.originalName ?? '';
      if (row.dataset.removed === 'true') {
        if (originalName) headers.push({ name: originalName, remove: true });
        continue;
      }
      const configured = row.dataset.configured === 'true';
      const headerName = configured
        ? originalName
        : row.querySelector<HTMLInputElement>('.cpe-header-name')?.value.trim() ?? '';
      const error = row.querySelector<HTMLElement>('.cpe-header-error');
      const normalizedName = headerName.toLowerCase();
      let message = '';
      if (!headerName) message = '请输入 Header name';
      else if (!CUSTOM_HEADER_NAME_PATTERN.test(headerName) || CUSTOM_FORBIDDEN_HEADERS.has(normalizedName)) {
        message = 'Header name 无效';
      } else if (headerNames.has(normalizedName)) message = 'Header name 重复';
      if (message) {
        valid = false;
        if (showErrors && error) error.textContent = message;
        continue;
      }
      headerNames.add(normalizedName);
      const headerValue = row.querySelector<HTMLInputElement>('.cpe-header-value')?.value ?? '';
      headers.push({ name: headerName, ...(headerValue ? { value: headerValue } : {}) });
    }
    if (!valid) return null;
    try {
      const models = [...this.root.querySelectorAll<HTMLElement>('.cpe-model-row')].map(row => {
        const samplingParams = readJsonObject(row.querySelector('.cpe-model-sampling'), 'Sampling JSON');
        const compatibility = readJsonObject(row.querySelector('.cpe-model-compatibility'), 'Compatibility JSON');
        const modelId = row.querySelector<HTMLInputElement>('.cpe-model-id')?.value.trim() ?? '';
        const modelName = row.querySelector<HTMLInputElement>('.cpe-model-name')?.value.trim() ?? '';
        return {
          id: modelId,
          name: modelName || modelId,
          contextWindow: finiteNumber(row.querySelector('.cpe-model-context')),
          maxTokens: finiteNumber(row.querySelector('.cpe-model-max')),
          reasoning: row.querySelector<HTMLInputElement>('.cpe-model-reasoning')?.checked ?? false,
          input: row.querySelector<HTMLInputElement>('.cpe-model-image')?.checked ? ['text', 'image'] : ['text'],
          cost: {
            input: finiteNumber(row.querySelector('.cpe-cost-input')),
            output: finiteNumber(row.querySelector('.cpe-cost-output')),
            cacheRead: finiteNumber(row.querySelector('.cpe-cost-cache-read')),
            cacheWrite: finiteNumber(row.querySelector('.cpe-cost-cache-write')),
          },
          ...(samplingParams ? { samplingParams } : {}),
          ...(compatibility ? { compatibility } : {}),
        } as DraftModel;
      });
      const apiKeyValue = value('#cpe-api-key');
      if (authMode === 'apiKey' && !apiKeyValue && !this.apiKeyCleared && !this.provider?.apiKeyConfigured) {
        if (showErrors) this.setFieldError('apiKey', '请输入 API Key');
        return null;
      }
      const modelDiscovery = value('#cpe-model-discovery');
      return {
        id,
        name,
        protocol: protocol as CustomProviderDraft['protocol'],
        baseUrl,
        authMode: authMode as CustomProviderDraft['authMode'],
        ...(this.apiKeyCleared ? { apiKey: null } : authMode === 'apiKey' && apiKeyValue ? { apiKey: apiKeyValue } : {}),
        headers,
        models,
        ...(modelDiscovery ? { modelDiscovery } : {}),
      };
    } catch (error) {
      this.showResult(error instanceof Error ? error.message : '高级设置格式无效', true);
      return null;
    }
  }

  private async request(url: string, init: RequestInit): Promise<{ ok: boolean; body: unknown }> {
    try {
      const response = await fetch(url, init);
      let body: unknown = {};
      try { body = await response.json(); } catch {}
      return { ok: response.ok, body };
    } catch (error) {
      return { ok: false, body: { error: error instanceof Error ? error.message : '网络请求失败', code: 'network_error' } };
    }
  }

  private async handleMutationError(value: unknown): Promise<void> {
    const body = value && typeof value === 'object' ? value as CustomProviderErrorResponse : {};
    if (body.code === 'provider_id_conflict' || body.code === 'immutable_provider_id') {
      this.setFieldError('id', body.code === 'provider_id_conflict' ? 'Provider ID 已被占用' : 'Provider ID 创建后不可修改');
      return;
    }
    if (body.code === 'revision_conflict') {
      let latestRevision = typeof body.currentRevision === 'number' ? body.currentRevision : this.revision;
      const latest = await this.request('/api/custom-providers', { method: 'GET' });
      if (latest.ok && latest.body && typeof latest.body === 'object') {
        const received = (latest.body as { revision?: unknown }).revision;
        if (typeof received === 'number') latestRevision = received;
      }
      this.revision = latestRevision;
      const banner = this.root?.querySelector<HTMLElement>('.cpe-conflict-banner');
      if (banner) {
        banner.hidden = false;
        banner.textContent = `版本冲突：已加载最新 revision ${latestRevision}。未保存的表单值已保留，请检查后再次保存。`;
      }
      return;
    }
    if (body.code === 'provider_in_use') {
      this.showReferences(body.references);
      return;
    }
    if (body.code === 'invalid_request' && typeof body.fieldPath === 'string') {
      const pathParts = body.fieldPath.split('.');
      const field = pathParts[pathParts.length - 1]?.replace(/\[\d+\]$/, '') ?? '';
      this.setFieldError(field, '字段值无效');
      return;
    }
    this.showResult(this.errorText(body, '保存失败'), true);
  }

  private showReferences(value: unknown): void {
    if (!this.root) return;
    const banner = this.root.querySelector<HTMLElement>('.cpe-conflict-banner');
    if (!banner) return;
    banner.replaceChildren(cpeElement('strong', undefined, '当前配置仍被占用'));
    const list = cpeElement('ul', 'cpe-occupancy-list');
    for (const entry of safeArray(value)) {
      if (!entry || typeof entry !== 'object') continue;
      const reference = entry as Record<string, unknown>;
      const model = typeof reference.modelId === 'string' ? this.redact(reference.modelId) : '未知模型';
      const source = reference.kind === 'currentModel'
        ? '当前模型'
        : reference.kind === 'defaultModel'
          ? '默认模型'
          : typeof reference.agentName === 'string' ? this.redact(reference.agentName) : '自定义 Agent';
      list.append(cpeElement('li', undefined, `${source}: ${model}`));
    }
    banner.append(list);
    banner.hidden = false;
  }

  private clearFeedback(): void {
    this.root?.querySelectorAll<HTMLElement>('.cpe-field-error').forEach(error => { error.textContent = ''; });
    const result = this.root?.querySelector<HTMLElement>('.cpe-result');
    if (result) {
      result.hidden = true;
      result.textContent = '';
      result.classList.remove('error');
    }
    const banner = this.root?.querySelector<HTMLElement>('.cpe-conflict-banner');
    if (banner) {
      banner.hidden = true;
      banner.replaceChildren();
    }
  }

  private setFieldError(field: string, message: string): void {
    const target = [...(this.root?.querySelectorAll<HTMLElement>('[data-field-error]') ?? [])]
      .find(candidate => candidate.dataset.fieldError === field);
    if (target) target.textContent = message;
    else this.showResult(message, true);
  }

  private showResult(message: string, error: boolean): void {
    const result = this.root?.querySelector<HTMLElement>('.cpe-result');
    if (!result) return;
    result.hidden = false;
    result.classList.toggle('error', error);
    result.textContent = this.redact(message);
  }

  private errorText(value: unknown, fallback: string): string {
    if (!value || typeof value !== 'object') return fallback;
    const body = value as Record<string, unknown>;
    const message = typeof body.error === 'string' ? body.error : fallback;
    const code = typeof body.code === 'string' ? `${body.code}: ` : '';
    return this.redact(code + message);
  }

  private redact(message: string): string {
    const secrets = [
      this.root?.querySelector<HTMLInputElement>('#cpe-api-key')?.value,
      ...[...(this.root?.querySelectorAll<HTMLInputElement>('.cpe-header-value') ?? [])].map(input => input.value),
    ]
      .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
      .sort((left, right) => right.length - left.length);
    let redacted = message;
    for (const secret of secrets) redacted = redacted.split(secret).join('[REDACTED]');
    return redacted
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]');
  }
}

const settingsCustomProviderEditorApp = (window as any).App || ((window as any).App = {});
settingsCustomProviderEditorApp.SettingsCustomProviderEditor = SettingsCustomProviderEditor;
