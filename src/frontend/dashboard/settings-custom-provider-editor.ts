/// <reference path="../dashboard.d.ts" />

interface SettingsCustomProviderEditorDependencies {
  notify: typeof toast;
  listAddAction: typeof ListAddAction;
  onSaved(snapshot: RedactedCustomProviderSnapshot, selectedId: string, activateSaved: boolean): void;
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
type CustomProviderEditorAction = 'save' | 'test' | 'discover' | 'delete' | 'reveal';
type CustomProviderMutationAction = 'save' | 'delete';
type CustomProviderQueryAction = Exclude<CustomProviderEditorAction, CustomProviderMutationAction>;

interface CustomProviderEditorOperation {
  action: CustomProviderEditorAction;
  controller: AbortController;
  generation: number;
  root: HTMLElement;
  providerId: string | null;
  revision: number;
  newProvider: boolean;
  draft: CustomProviderDraft | null;
  secrets: string[];
}

interface CustomProviderRequestResult {
  ok: boolean;
  body: unknown;
  aborted: boolean;
}

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
const CUSTOM_ADVANCED_JSON_MAX_BYTES = 16 * 1024;
const CUSTOM_NETWORK_ACTIONS = ['save', 'delete', 'test', 'discover', 'reveal-api-key'] as const;

function cpeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (className?.split(/\s+/).includes('cpe-field-error')) element.setAttribute('role', 'alert');
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

function isFiniteJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isFiniteJsonValue);
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value as Record<string, unknown>).every(isFiniteJsonValue);
}

function readJsonObject(input: HTMLTextAreaElement | null, field: string): Record<string, unknown> | undefined {
  const value = input?.value.trim() ?? '';
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${field} 必须是 JSON 对象`);
  if (!isFiniteJsonValue(parsed)) throw new Error(`${field} 必须只包含有限 JSON 值`);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > CUSTOM_ADVANCED_JSON_MAX_BYTES) {
    throw new Error(`${field} 不能超过 16 KiB`);
  }
  return parsed as Record<string, unknown>;
}

function percentEncodedSecretPattern(secret: string): RegExp | null {
  try {
    const encoded = encodeURIComponent(secret);
    let pattern = '';
    for (let index = 0; index < encoded.length; index += 1) {
      if (encoded[index] === '%' && /^[0-9A-F]{2}$/.test(encoded.slice(index + 1, index + 3))) {
        const byte = encoded.slice(index + 1, index + 3);
        if (byte === '20') pattern += '(?:%20|\\+)';
        else {
          pattern += '%';
          for (const nibble of byte) {
            pattern += /[A-F]/.test(nibble) ? `[${nibble}${nibble.toLowerCase()}]` : nibble;
          }
        }
        index += 2;
      } else pattern += encoded[index].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(pattern, 'g');
  } catch {
    return null;
  }
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isCustomProviderSnapshot(value: unknown): value is RedactedCustomProviderSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as { revision?: unknown; providers?: unknown };
  return Number.isInteger(snapshot.revision)
    && (snapshot.revision as number) >= 0
    && Array.isArray(snapshot.providers);
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
  private generation = 0;
  private mutationOperation: CustomProviderEditorOperation | null = null;
  private queryOperation: CustomProviderEditorOperation | null = null;

  constructor(private readonly dependencies: SettingsCustomProviderEditorDependencies) {}

  setProtocols(protocols: readonly CustomProviderProtocol[]): void {
    this.protocols = [...new Set(protocols)];
  }

  mount(container: HTMLElement, provider: RedactedCustomProvider | null, revision: number): void {
    if (!provider) {
      this.startNew(container, revision);
      return;
    }
    this.invalidateQuery();
    this.detachMutation();
    this.container = container;
    this.provider = provider;
    this.revision = revision;
    this.newProvider = false;
    this.apiKeyCleared = false;
    this.deleteArmed = false;
    this.render(provider);
  }

  startNew(container: HTMLElement, revision: number): void {
    this.invalidateQuery();
    this.detachMutation();
    this.container = container;
    this.provider = null;
    this.revision = revision;
    this.newProvider = true;
    this.apiKeyCleared = false;
    this.deleteArmed = false;
    this.render(null);
  }

  unmount(): void {
    this.invalidateQuery();
    this.detachMutation();
    this.container = null;
    this.root = null;
    this.provider = null;
    this.deleteArmed = false;
  }

  async save(): Promise<void> {
    if (this.mutationOperation) return;
    this.clearFeedback();
    const draft = this.readDraft(true);
    if (!draft) return;
    const operation = this.beginMutation('save', draft);
    if (!operation) return;
    try {
      const url = operation.newProvider
        ? '/api/custom-providers'
        : `/api/custom-providers/${encodeURIComponent(operation.providerId || draft.id)}`;
      const response = await this.request(operation, url, {
        method: operation.newProvider ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: operation.revision, provider: draft }),
      });
      if (response.aborted) return;
      if (!response.ok) {
        if (this.isCurrentMount(operation)) await this.handleMutationError(operation, response.body);
        return;
      }
      if (!isCustomProviderSnapshot(response.body)) {
        if (this.isCurrentMount(operation)) this.showResult('保存响应无效', true, operation.root, operation.secrets);
        return;
      }
      const snapshot = response.body;
      const saved = snapshot.providers.find((candidate) => (
        candidate && typeof candidate === 'object' && (candidate as RedactedCustomProvider).id === draft.id
      )) as RedactedCustomProvider | undefined;
      if (!saved) {
        if (this.isCurrentMount(operation)) this.showResult('保存响应无效', true, operation.root, operation.secrets);
        return;
      }
      const currentMount = this.isCurrentMount(operation);
      const accepted = this.consumeSnapshot(snapshot);
      if (currentMount && accepted) {
        this.provider = saved;
        this.newProvider = false;
        this.apiKeyCleared = false;
        this.render(saved);
      }
      this.dependencies.onSaved(snapshot, saved.id, currentMount && operation.newProvider && accepted);
      if (currentMount && accepted) this.dependencies.notify('已保存', 'success');
    } finally {
      this.finishMutation(operation);
    }
  }

  async test(): Promise<void> {
    if (this.mutationOperation || this.queryOperation?.action === 'test') return;
    this.clearFeedback();
    const draft = this.readDraft(false);
    if (!draft) return;
    const operation = this.beginQuery('test', draft);
    if (!operation) return;
    try {
      const response = await this.request(operation, '/api/custom-providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: draft }),
      });
      if (!this.isCurrentQuery(operation) || response.aborted) return;
      const body = response.body as Record<string, unknown>;
      if (!response.ok || body.ok === false) {
        const code = typeof body.code === 'string' ? body.code : 'failed';
        const message = typeof body.message === 'string'
          ? body.message
          : typeof body.error === 'string' ? body.error : '连接测试失败';
        this.showResult(`${code}: ${message}`, true, operation.root, operation.secrets);
        return;
      }
      const modelId = typeof body.modelId === 'string' ? body.modelId : '';
      const latency = typeof body.latencyMs === 'number' ? ` · ${body.latencyMs} ms` : '';
      this.showResult(`连接成功${modelId ? ` · ${modelId}` : ''}${latency}`, false, operation.root, operation.secrets);
    } finally {
      this.finishQuery(operation);
    }
  }

  async discoverModels(): Promise<void> {
    if (this.mutationOperation || this.queryOperation?.action === 'discover') return;
    this.clearFeedback();
    const draft = this.readDraft(false);
    if (!draft) return;
    const operation = this.beginQuery('discover', draft);
    if (!operation) return;
    try {
      const response = await this.request(operation, '/api/custom-providers/discover-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: draft }),
      });
      if (!this.isCurrentQuery(operation) || response.aborted) return;
      if (!response.ok) {
        this.showResult(this.errorText(response.body, '模型发现失败', operation.secrets), true, operation.root, operation.secrets);
        return;
      }
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const value of safeArray((response.body as { ids?: unknown }).ids)) {
        if (typeof value !== 'string') continue;
        const id = value.trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
      const existing = new Set(
        [...operation.root.querySelectorAll<HTMLInputElement>('.cpe-model-id')].map(input => input.value.trim()),
      );
      const imported = ids.filter(id => !existing.has(id));
      if (imported.length === 0) {
        this.showResult('未发现新的模型 ID', false, operation.root, operation.secrets);
        return;
      }
      if (!window.confirm(`导入 ${imported.length} 个模型 ID？\n${imported.join('\n')}`)) {
        if (this.isCurrentQuery(operation)) this.showResult('已取消导入', false, operation.root, operation.secrets);
        return;
      }
      if (!this.isCurrentQuery(operation)) return;
      const rows = operation.root.querySelector<HTMLElement>('.cpe-model-rows');
      if (!rows) return;
      for (const id of imported) rows.append(this.createModelRow(emptyModel(id)));
      this.refreshDynamicMetadata(operation.root);
      this.showResult(`已导入 ${imported.length} 个模型 ID，保存后生效`, false, operation.root, operation.secrets);
    } finally {
      this.finishQuery(operation);
    }
  }

  async delete(): Promise<void> {
    if (!this.provider || this.newProvider) return;
    if (this.mutationOperation) return;
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
    const operation = this.beginMutation('delete', null);
    if (!operation) return;
    try {
      if (!operation.providerId) return;
      const response = await this.request(operation, `/api/custom-providers/${encodeURIComponent(operation.providerId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: operation.revision }),
      });
      if (response.aborted) return;
      if (!response.ok) {
        if (this.isCurrentMount(operation)) await this.handleMutationError(operation, response.body);
        return;
      }
      if (!isCustomProviderSnapshot(response.body)) {
        if (this.isCurrentMount(operation)) this.showResult('删除响应无效', true, operation.root, operation.secrets);
        return;
      }
      const snapshot = response.body;
      const currentMount = this.isCurrentMount(operation);
      const accepted = this.consumeSnapshot(snapshot);
      this.dependencies.onDeleted(snapshot);
      if (currentMount && accepted) this.dependencies.notify('已删除', 'success');
    } finally {
      this.finishMutation(operation);
    }
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
    conflict.setAttribute('role', 'alert');
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
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
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
    this.refreshDynamicMetadata(root);
    this.container.replaceChildren(root);
    if (this.mutationOperation) this.setMutationBusy(root, this.mutationOperation.action, true);
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
    input.setAttribute('aria-label', 'API Key');
    input.placeholder = provider?.apiKeyConfigured ? '留空保留已保存值' : '输入 API Key';
    row.append(input);
    if (provider?.apiKeyConfigured) {
      const reveal = cpeButton('reveal-api-key', '👁', 'rp-key-toggle');
      reveal.title = '显示 API Key';
      reveal.setAttribute('aria-label', '显示 API Key');
      row.append(reveal);
    }
    row.append(cpeButton('clear-api-key', '清除', 'cpe-button subtle'));
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
      onActivate: () => {
        rows.append(this.createHeaderRow('', false));
        if (this.root) this.refreshDynamicMetadata(this.root);
      },
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
    const remove = cpeButton('remove-header', '删除', 'cpe-icon-button');
    remove.title = '删除 Header';
    remove.setAttribute('aria-label', '删除 Header');
    row.append(remove);
    const nameError = cpeElement('span', 'cpe-field-error cpe-header-error cpe-header-name-error');
    const valueError = cpeElement('span', 'cpe-field-error cpe-header-error cpe-header-value-error');
    nameError.hidden = true;
    valueError.hidden = true;
    row.append(nameError, valueError);
    return row;
  }

  private modelsField(models: DraftModel[]): HTMLElement {
    const section = cpeElement('section', 'cpe-section');
    section.append(cpeElement('div', 'cpe-section-title', '模型'));
    const rows = cpeElement('div', 'cpe-model-rows');
    for (const model of models) rows.append(this.createModelRow(model));
    section.append(rows);
    const error = cpeElement('span', 'cpe-field-error cpe-models-error');
    error.dataset.fieldError = 'models';
    section.append(error);
    const add = this.dependencies.listAddAction.create({
      label: '添加模型',
      onActivate: () => {
        rows.append(this.createModelRow(emptyModel()));
        if (this.root) this.refreshDynamicMetadata(this.root);
      },
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
    const remove = cpeButton('remove-model', '删除', 'cpe-icon-button');
    remove.title = '删除模型';
    remove.setAttribute('aria-label', '删除模型');
    main.append(id, name, remove);
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
    row.append(cpeElement('span', 'cpe-field-error cpe-model-error'));
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
    else if (action === 'reveal-api-key') void this.revealApiKey();
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
      if (this.root) this.refreshDynamicMetadata(this.root);
    } else if (action === 'remove-model') {
      target.closest('.cpe-model-row')?.remove();
      if (this.root) this.refreshDynamicMetadata(this.root);
    }
  }

  private invalidateQuery(): void {
    this.generation += 1;
    const operation = this.queryOperation;
    if (!operation) return;
    operation.controller.abort();
    this.setQueryBusy(operation, false);
    this.queryOperation = null;
  }

  private createOperation(
    action: CustomProviderEditorAction,
    draft: CustomProviderDraft | null,
  ): CustomProviderEditorOperation | null {
    if (!this.root) return null;
    return {
      action,
      controller: new AbortController(),
      generation: this.generation,
      root: this.root,
      providerId: this.provider?.id ?? null,
      revision: this.revision,
      newProvider: this.newProvider,
      draft,
      secrets: this.captureSecrets(this.root),
    };
  }

  private beginQuery(action: CustomProviderQueryAction, draft: CustomProviderDraft | null): CustomProviderEditorOperation | null {
    if (this.mutationOperation) return null;
    if (this.queryOperation) {
      this.queryOperation.controller.abort();
      this.setQueryBusy(this.queryOperation, false);
      this.queryOperation = null;
    }
    const operation = this.createOperation(action, draft);
    if (!operation) return null;
    this.queryOperation = operation;
    this.setQueryBusy(operation, true);
    return operation;
  }

  private beginMutation(action: CustomProviderMutationAction, draft: CustomProviderDraft | null): CustomProviderEditorOperation | null {
    if (this.mutationOperation) return null;
    if (this.queryOperation) {
      this.queryOperation.controller.abort();
      this.setQueryBusy(this.queryOperation, false);
      this.queryOperation = null;
    }
    const operation = this.createOperation(action, draft);
    if (!operation) return null;
    this.mutationOperation = operation;
    this.setMutationBusy(operation.root, action, true);
    return operation;
  }

  private isCurrentMount(operation: CustomProviderEditorOperation): boolean {
    return operation.generation === this.generation
      && operation.root === this.root
      && Boolean(this.container?.contains(operation.root));
  }

  private isCurrentQuery(operation: CustomProviderEditorOperation): boolean {
    return this.queryOperation === operation && this.isCurrentMount(operation);
  }

  private finishQuery(operation: CustomProviderEditorOperation): void {
    if (this.queryOperation !== operation) return;
    this.setQueryBusy(operation, false);
    this.queryOperation = null;
  }

  private finishMutation(operation: CustomProviderEditorOperation): void {
    if (this.mutationOperation !== operation) return;
    this.setMutationBusy(operation.root, operation.action as CustomProviderMutationAction, false);
    if (this.root !== operation.root && this.root) {
      this.setMutationBusy(this.root, operation.action as CustomProviderMutationAction, false);
    }
    this.mutationOperation = null;
  }

  private detachMutation(): void {
    const operation = this.mutationOperation;
    if (!operation) return;
    this.setMutationBusy(operation.root, operation.action as CustomProviderMutationAction, false);
    this.mutationOperation = null;
  }

  private setQueryBusy(operation: CustomProviderEditorOperation, busy: boolean): void {
    const action = operation.action === 'discover' ? 'discover'
      : operation.action === 'reveal' ? 'reveal-api-key'
        : operation.action;
    const button = operation.root.querySelector<HTMLButtonElement>(`[data-cpe-action="${action}"]`);
    if (!button) return;
    button.disabled = busy;
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  private setMutationBusy(root: HTMLElement, action: CustomProviderMutationAction, busy: boolean): void {
    for (const buttonAction of CUSTOM_NETWORK_ACTIONS) {
      const button = root.querySelector<HTMLButtonElement>(`[data-cpe-action="${buttonAction}"]`);
      if (button) button.disabled = busy;
    }
    const active = root.querySelector<HTMLButtonElement>(`[data-cpe-action="${action}"]`);
    if (!active) return;
    if (busy) active.setAttribute('aria-busy', 'true');
    else active.removeAttribute('aria-busy');
  }

  private consumeSnapshot(snapshot: RedactedCustomProviderSnapshot): boolean {
    if (snapshot.revision <= this.revision) return false;
    this.revision = snapshot.revision;
    const mountedId = this.provider?.id;
    if (!mountedId) return true;
    const current = snapshot.providers.find(provider => provider.id === mountedId);
    if (current) this.provider = current;
    return true;
  }

  private captureSecrets(root: HTMLElement): string[] {
    return [
      root.querySelector<HTMLInputElement>('#cpe-api-key')?.value,
      ...[...root.querySelectorAll<HTMLInputElement>('.cpe-header-value')].map(input => input.value),
    ].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  }

  private async revealApiKey(): Promise<void> {
    if (!this.provider?.apiKeyConfigured || this.mutationOperation || this.queryOperation?.action === 'reveal') return;
    this.clearFeedback();
    const operation = this.beginQuery('reveal', null);
    if (!operation) return;
    try {
      if (!operation.providerId) return;
      const response = await this.request(operation, '/api/custom-providers/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: operation.providerId }),
      });
      if (!this.isCurrentQuery(operation) || response.aborted) return;
      if (!response.ok) {
        this.showResult(this.errorText(response.body, 'API Key 显示失败', operation.secrets), true, operation.root, operation.secrets);
        return;
      }
      const apiKey = response.body && typeof response.body === 'object'
        ? (response.body as { apiKey?: unknown }).apiKey
        : undefined;
      if (typeof apiKey !== 'string') {
        this.showResult('API Key 显示响应无效', true, operation.root, operation.secrets);
        return;
      }
      const input = operation.root.querySelector<HTMLInputElement>('#cpe-api-key');
      if (input) input.value = apiKey;
    } finally {
      this.finishQuery(operation);
    }
  }

  private refreshDynamicMetadata(root: HTMLElement): void {
    const headerRows = [...root.querySelectorAll<HTMLElement>('.cpe-header-row')];
    headerRows.forEach((row, index) => {
      const number = index + 1;
      const name = row.querySelector<HTMLInputElement>('.cpe-header-name');
      const value = row.querySelector<HTMLInputElement>('.cpe-header-value');
      if (name) {
        name.dataset.fieldPath = `headers[${index}].name`;
        if (!name.getAttribute('aria-label')) name.setAttribute('aria-label', `Header ${number} 名称`);
      }
      if (value) {
        value.dataset.fieldPath = `headers[${index}].value`;
        value.setAttribute('aria-label', `Header ${number} 值`);
      }
      const nameError = row.querySelector<HTMLElement>('.cpe-header-name-error');
      if (nameError) nameError.dataset.fieldError = `headers[${index}].name`;
      const valueError = row.querySelector<HTMLElement>('.cpe-header-value-error');
      if (valueError) valueError.dataset.fieldError = `headers[${index}].value`;
      const remove = row.querySelector<HTMLButtonElement>('[data-cpe-action="remove-header"]');
      if (remove) {
        remove.title = `删除 Header ${number}`;
        remove.setAttribute('aria-label', `删除 Header ${number}`);
      }
    });

    const modelFields: Array<[string, string]> = [
      ['.cpe-model-id', 'id'],
      ['.cpe-model-name', 'name'],
      ['.cpe-model-context', 'contextWindow'],
      ['.cpe-model-max', 'maxTokens'],
      ['.cpe-model-reasoning', 'reasoning'],
      ['.cpe-model-image', 'input'],
      ['.cpe-cost-input', 'cost.input'],
      ['.cpe-cost-output', 'cost.output'],
      ['.cpe-cost-cache-read', 'cost.cacheRead'],
      ['.cpe-cost-cache-write', 'cost.cacheWrite'],
      ['.cpe-model-sampling', 'samplingParams'],
      ['.cpe-model-compatibility', 'compatibility'],
    ];
    [...root.querySelectorAll<HTMLElement>('.cpe-model-row')].forEach((row, index) => {
      const number = index + 1;
      for (const [selector, field] of modelFields) {
        const control = row.querySelector<HTMLElement>(selector);
        if (!control) continue;
        control.dataset.fieldPath = `models[${index}].${field}`;
        control.setAttribute('aria-label', `模型 ${number} ${field}`);
      }
      const remove = row.querySelector<HTMLButtonElement>('[data-cpe-action="remove-model"]');
      if (remove) {
        remove.title = `删除模型 ${number}`;
        remove.setAttribute('aria-label', `删除模型 ${number}`);
      }
    });
  }

  private readDraft(showErrors: boolean): CustomProviderDraft | null {
    if (!this.root) return null;
    this.refreshDynamicMetadata(this.root);
    const value = (selector: string) => this.root?.querySelector<HTMLInputElement>(selector)?.value.trim() ?? '';
    const id = value('#cpe-id');
    const name = value('#cpe-name');
    const baseUrl = value('#cpe-base-url');
    const modelDiscovery = value('#cpe-model-discovery');
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
    if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      valid = false;
      if (showErrors) this.setFieldError('id', 'Provider ID 只能使用小写字母、数字和连字符');
    }
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error();
      } catch {
        valid = false;
        if (showErrors) this.setFieldError('baseUrl', '请输入有效的 HTTP(S) URL');
      }
    }
    if (baseUrl && modelDiscovery) {
      try {
        const base = new URL(baseUrl);
        const parsed = new URL(modelDiscovery, base);
        if (
          !['http:', 'https:'].includes(parsed.protocol)
          || !parsed.hostname
          || parsed.username
          || parsed.password
          || parsed.origin !== base.origin
        ) throw new Error();
      } catch {
        valid = false;
        if (showErrors) this.setFieldError('modelDiscovery', '请输入同源 HTTP(S) URL 或安全相对路径');
      }
    }
    if (!valid) return null;

    const headers: CustomProviderDraft['headers'] = [];
    const headerNames = new Set<string>();
    const headerRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-header-row')];
    for (let index = 0; index < headerRows.length; index += 1) {
      const row = headerRows[index];
      const originalName = row.dataset.originalName ?? '';
      if (row.dataset.removed === 'true') {
        if (originalName) headers.push({ name: originalName, remove: true });
        continue;
      }
      const configured = row.dataset.configured === 'true';
      const headerName = configured
        ? originalName
        : row.querySelector<HTMLInputElement>('.cpe-header-name')?.value.trim() ?? '';
      const normalizedName = headerName.toLowerCase();
      let message = '';
      if (!headerName) message = '请输入 Header name';
      else if (!CUSTOM_HEADER_NAME_PATTERN.test(headerName) || CUSTOM_FORBIDDEN_HEADERS.has(normalizedName)) {
        message = 'Header name 无效';
      } else if (headerNames.has(normalizedName)) message = 'Header name 重复';
      if (message) {
        valid = false;
        if (showErrors) this.setFieldError(`headers[${index}].name`, message);
      } else headerNames.add(normalizedName);
      const headerValue = row.querySelector<HTMLInputElement>('.cpe-header-value')?.value ?? '';
      const hasHeaderValue = headerValue.trim().length > 0;
      if (!configured && !hasHeaderValue) {
        valid = false;
        if (showErrors) this.setFieldError(`headers[${index}].value`, '请输入 Header value');
      }
      if (!message && (configured || hasHeaderValue)) {
        headers.push({ name: headerName, ...(hasHeaderValue ? { value: headerValue } : {}) });
      }
    }
    if (!valid) return null;

    const modelRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-model-row')];
    if (modelRows.length === 0) {
      if (showErrors) this.setFieldError('models', '至少添加一个模型');
      return null;
    }
    const modelIds = new Set<string>();
    const modelNames = new Set<string>();
    const models: DraftModel[] = [];
    for (let index = 0; index < modelRows.length; index += 1) {
      const row = modelRows[index];
      const field = (name: string) => `models[${index}].${name}`;
      const modelId = row.querySelector<HTMLInputElement>('.cpe-model-id')?.value.trim() ?? '';
      const modelName = row.querySelector<HTMLInputElement>('.cpe-model-name')?.value.trim() ?? '';
      const contextWindow = Number(row.querySelector<HTMLInputElement>('.cpe-model-context')?.value ?? '');
      const maxTokens = Number(row.querySelector<HTMLInputElement>('.cpe-model-max')?.value ?? '');
      const failModel = (path: string, message: string) => {
        valid = false;
        if (showErrors) this.setFieldError(path, message);
      };
      if (!modelId) failModel(field('id'), '请输入 Model ID');
      else if (modelIds.has(modelId)) failModel(field('id'), 'Model ID 重复');
      else modelIds.add(modelId);
      const normalizedName = modelName.toLowerCase();
      if (!modelName) failModel(field('name'), '请输入模型名称');
      else if (modelNames.has(normalizedName)) failModel(field('name'), '模型名称重复');
      else modelNames.add(normalizedName);
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        failModel(field('contextWindow'), 'Context 必须是正整数');
      }
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
        failModel(field('maxTokens'), 'Max tokens 必须是正整数');
      } else if (Number.isInteger(contextWindow) && contextWindow > 0 && maxTokens > contextWindow) {
        failModel(field('maxTokens'), 'Max tokens 不能超过 Context');
      }

      const costFields = [
        ['input', '.cpe-cost-input'],
        ['output', '.cpe-cost-output'],
        ['cacheRead', '.cpe-cost-cache-read'],
        ['cacheWrite', '.cpe-cost-cache-write'],
      ] as const;
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const [costField, selector] of costFields) {
        const amount = Number(row.querySelector<HTMLInputElement>(selector)?.value ?? '');
        if (!Number.isFinite(amount) || amount < 0) failModel(field(`cost.${costField}`), '费用必须是非负数');
        else cost[costField] = amount;
      }

      let samplingParams: Record<string, unknown> | undefined;
      let compatibility: Record<string, unknown> | undefined;
      for (const [advancedField, selector, label] of [
        ['samplingParams', '.cpe-model-sampling', 'Sampling JSON'],
        ['compatibility', '.cpe-model-compatibility', 'Compatibility JSON'],
      ] as const) {
        try {
          const parsed = readJsonObject(row.querySelector(selector), label);
          if (advancedField === 'samplingParams') samplingParams = parsed;
          else compatibility = parsed;
        } catch (error) {
          failModel(field(advancedField), error instanceof Error ? error.message : `${label} 必须是 JSON 对象`);
        }
      }
      models.push({
        id: modelId,
        name: modelName,
        contextWindow,
        maxTokens,
        reasoning: row.querySelector<HTMLInputElement>('.cpe-model-reasoning')?.checked ?? false,
        input: row.querySelector<HTMLInputElement>('.cpe-model-image')?.checked ? ['text', 'image'] : ['text'],
        cost,
        ...(samplingParams ? { samplingParams } : {}),
        ...(compatibility ? { compatibility } : {}),
      });
    }
    if (!valid) return null;

    const apiKeyValue = value('#cpe-api-key');
    if (authMode === 'apiKey' && !apiKeyValue && !this.apiKeyCleared && !this.provider?.apiKeyConfigured) {
      if (showErrors) this.setFieldError('apiKey', '请输入 API Key');
      return null;
    }
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
  }

  private async request(
    operation: CustomProviderEditorOperation,
    url: string,
    init: RequestInit,
  ): Promise<CustomProviderRequestResult> {
    try {
      const response = await fetch(url, { ...init, signal: operation.controller.signal });
      let body: unknown = {};
      try { body = await response.json(); } catch {}
      return { ok: response.ok, body, aborted: operation.controller.signal.aborted };
    } catch (error) {
      if (operation.controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return { ok: false, body: {}, aborted: true };
      }
      return {
        ok: false,
        body: { error: error instanceof Error ? error.message : '网络请求失败', code: 'network_error' },
        aborted: false,
      };
    }
  }

  private async handleMutationError(operation: CustomProviderEditorOperation, value: unknown): Promise<void> {
    if (!this.isCurrentMount(operation)) return;
    const body = value && typeof value === 'object' ? value as CustomProviderErrorResponse : {};
    if (body.code === 'provider_id_conflict' || body.code === 'immutable_provider_id') {
      this.setFieldError('id', body.code === 'provider_id_conflict' ? 'Provider ID 已被占用' : 'Provider ID 创建后不可修改');
      return;
    }
    if (body.code === 'revision_conflict') {
      let latestRevision = this.revision;
      if (Number.isInteger(body.currentRevision) && (body.currentRevision as number) >= 0) {
        latestRevision = Math.max(latestRevision, body.currentRevision as number);
      }
      const latest = await this.request(operation, '/api/custom-providers', { method: 'GET' });
      if (!this.isCurrentMount(operation) || latest.aborted) return;
      if (latest.ok && latest.body && typeof latest.body === 'object') {
        const received = (latest.body as { revision?: unknown }).revision;
        if (Number.isInteger(received) && (received as number) >= 0) {
          latestRevision = Math.max(latestRevision, received as number);
        }
      }
      this.revision = latestRevision;
      const banner = operation.root.querySelector<HTMLElement>('.cpe-conflict-banner');
      if (banner) {
        banner.hidden = false;
        banner.textContent = `版本冲突：已加载最新 revision ${latestRevision}。未保存的表单值已保留，请检查后再次保存。`;
      }
      return;
    }
    if (body.code === 'provider_in_use') {
      this.showReferences(body.references, operation.root, operation.secrets);
      return;
    }
    if (body.code === 'invalid_request' && typeof body.fieldPath === 'string') {
      const field = body.fieldPath.replace(/^provider\./, '');
      this.setFieldError(field, '字段值无效');
      return;
    }
    this.showResult(this.errorText(body, '保存失败', operation.secrets), true, operation.root, operation.secrets);
  }

  private showReferences(value: unknown, root: HTMLElement, secrets: readonly string[]): void {
    const banner = root.querySelector<HTMLElement>('.cpe-conflict-banner');
    if (!banner) return;
    banner.replaceChildren(cpeElement('strong', undefined, '当前配置仍被占用'));
    const list = cpeElement('ul', 'cpe-occupancy-list');
    for (const entry of safeArray(value)) {
      if (!entry || typeof entry !== 'object') continue;
      const reference = entry as Record<string, unknown>;
      const model = typeof reference.modelId === 'string' ? this.redact(reference.modelId, secrets) : '未知模型';
      const source = reference.kind === 'currentModel'
        ? '当前模型'
        : reference.kind === 'defaultModel'
          ? '默认模型'
          : typeof reference.agentName === 'string' ? this.redact(reference.agentName, secrets) : '自定义 Agent';
      list.append(cpeElement('li', undefined, `${source}: ${model}`));
    }
    banner.append(list);
    banner.hidden = false;
  }

  private clearFeedback(): void {
    this.root?.querySelectorAll<HTMLElement>('.cpe-field-error').forEach(error => {
      error.textContent = '';
      if (error.classList.contains('cpe-header-error')) error.hidden = true;
    });
    this.root?.querySelectorAll<HTMLElement>('[aria-invalid="true"]').forEach(control => control.removeAttribute('aria-invalid'));
    const result = this.root?.querySelector<HTMLElement>('.cpe-result');
    if (result) {
      result.hidden = true;
      result.textContent = '';
      result.classList.remove('error');
      result.setAttribute('role', 'status');
    }
    const banner = this.root?.querySelector<HTMLElement>('.cpe-conflict-banner');
    if (banner) {
      banner.hidden = true;
      banner.replaceChildren();
    }
  }

  private setFieldError(field: string, message: string): void {
    const normalized = field.replace(/^provider\./, '');
    const controls = [...(this.root?.querySelectorAll<HTMLElement>('[data-field-path]') ?? [])];
    const control = controls.find(candidate => candidate.dataset.fieldPath === normalized);
    if (control) {
      control.setAttribute('aria-invalid', 'true');
    }
    const target = [...(this.root?.querySelectorAll<HTMLElement>('[data-field-error]') ?? [])]
      .find(candidate => candidate.dataset.fieldError === normalized);
    if (target) {
      target.hidden = false;
      target.textContent = message;
      return;
    }
    const row = control?.closest<HTMLElement>('.cpe-header-row, .cpe-model-row');
    const rowError = row?.querySelector<HTMLElement>('.cpe-header-error, .cpe-model-error');
    if (rowError) {
      rowError.dataset.fieldError = normalized;
      rowError.hidden = false;
      rowError.textContent = message;
      return;
    }
    this.showResult(message, true);
  }

  private showResult(
    message: string,
    error: boolean,
    root = this.root,
    secrets?: readonly string[],
  ): void {
    const result = root?.querySelector<HTMLElement>('.cpe-result');
    if (!result) return;
    result.hidden = false;
    result.classList.toggle('error', error);
    result.setAttribute('role', error ? 'alert' : 'status');
    result.textContent = this.redact(message, secrets);
  }

  private errorText(value: unknown, fallback: string, secrets?: readonly string[]): string {
    if (!value || typeof value !== 'object') return fallback;
    const body = value as Record<string, unknown>;
    const message = typeof body.error === 'string' ? body.error : fallback;
    const code = typeof body.code === 'string' ? `${body.code}: ` : '';
    return this.redact(code + message, secrets);
  }

  private redact(message: string, capturedSecrets?: readonly string[]): string {
    const secrets = capturedSecrets ?? (this.root ? this.captureSecrets(this.root) : []);
    const variants = new Set<string>();
    const encodedPatterns: RegExp[] = [];
    for (const secret of secrets) {
      if (!secret) continue;
      variants.add(secret);
      const json = JSON.stringify(secret);
      if (json.length >= 2) variants.add(json.slice(1, -1));
      const encodedPattern = percentEncodedSecretPattern(secret);
      if (encodedPattern) encodedPatterns.push(encodedPattern);
    }
    let redacted = message;
    for (const secret of [...variants].sort((left, right) => right.length - left.length)) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    for (const pattern of encodedPatterns) redacted = redacted.replace(pattern, '[REDACTED]');
    return redacted
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]');
  }
}

const settingsCustomProviderEditorApp = (window as any).App || ((window as any).App = {});
settingsCustomProviderEditorApp.SettingsCustomProviderEditor = SettingsCustomProviderEditor;
