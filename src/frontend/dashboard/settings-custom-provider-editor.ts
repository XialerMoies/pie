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
type CustomProviderEditorAction = 'save' | 'test' | 'discover' | 'delete' | 'reveal';

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
  private generation = 0;
  private activeOperation: CustomProviderEditorOperation | null = null;

  constructor(private readonly dependencies: SettingsCustomProviderEditorDependencies) {}

  setProtocols(protocols: readonly CustomProviderProtocol[]): void {
    this.protocols = [...new Set(protocols)];
  }

  mount(container: HTMLElement, provider: RedactedCustomProvider | null, revision: number): void {
    if (!provider) {
      this.startNew(container, revision);
      return;
    }
    this.invalidateOperation();
    this.container = container;
    this.provider = provider;
    this.revision = revision;
    this.newProvider = false;
    this.apiKeyCleared = false;
    this.deleteArmed = false;
    this.render(provider);
  }

  startNew(container: HTMLElement, revision: number): void {
    this.invalidateOperation();
    this.container = container;
    this.provider = null;
    this.revision = revision;
    this.newProvider = true;
    this.apiKeyCleared = false;
    this.deleteArmed = false;
    this.render(null);
  }

  unmount(): void {
    this.invalidateOperation();
    this.container = null;
    this.root = null;
    this.provider = null;
    this.deleteArmed = false;
  }

  async save(): Promise<void> {
    if (this.activeOperation?.action === 'save') return;
    this.clearFeedback();
    const draft = this.readDraft(true);
    if (!draft) return;
    const operation = this.beginOperation('save', draft);
    if (!operation) return;
    const url = operation.newProvider
      ? '/api/custom-providers'
      : `/api/custom-providers/${encodeURIComponent(operation.providerId || draft.id)}`;
    const response = await this.request(operation, url, {
      method: operation.newProvider ? 'POST' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: operation.revision, provider: draft }),
    });
    if (!this.isActive(operation) || response.aborted) return this.finishOperation(operation);
    if (!response.ok) {
      await this.handleMutationError(operation, response.body);
      this.finishOperation(operation);
      return;
    }
    const snapshot = response.body as RedactedCustomProviderSnapshot;
    const saved = safeArray(snapshot.providers).find((candidate) => (
      candidate && typeof candidate === 'object' && (candidate as RedactedCustomProvider).id === draft.id
    )) as RedactedCustomProvider | undefined;
    if (!saved || typeof snapshot.revision !== 'number') {
      this.finishOperation(operation);
      this.showResult('保存响应无效', true, operation.root, operation.secrets);
      return;
    }
    this.finishOperation(operation);
    this.revision = snapshot.revision;
    this.provider = saved;
    this.newProvider = false;
    this.apiKeyCleared = false;
    this.render(saved);
    this.dependencies.onSaved(snapshot, saved.id);
    this.dependencies.notify('已保存', 'success');
  }

  async test(): Promise<void> {
    if (this.activeOperation?.action === 'test') return;
    this.clearFeedback();
    const draft = this.readDraft(false);
    if (!draft) return;
    const operation = this.beginOperation('test', draft);
    if (!operation) return;
    const response = await this.request(operation, '/api/custom-providers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: draft }),
    });
    if (!this.isActive(operation) || response.aborted) return this.finishOperation(operation);
    const body = response.body as Record<string, unknown>;
    if (!response.ok || body.ok === false) {
      const code = typeof body.code === 'string' ? body.code : 'failed';
      const message = typeof body.message === 'string'
        ? body.message
        : typeof body.error === 'string' ? body.error : '连接测试失败';
      this.finishOperation(operation);
      this.showResult(`${code}: ${message}`, true, operation.root, operation.secrets);
      return;
    }
    const modelId = typeof body.modelId === 'string' ? body.modelId : '';
    const latency = typeof body.latencyMs === 'number' ? ` · ${body.latencyMs} ms` : '';
    this.finishOperation(operation);
    this.showResult(`连接成功${modelId ? ` · ${modelId}` : ''}${latency}`, false, operation.root, operation.secrets);
  }

  async discoverModels(): Promise<void> {
    if (this.activeOperation?.action === 'discover') return;
    this.clearFeedback();
    const draft = this.readDraft(false);
    if (!draft) return;
    const operation = this.beginOperation('discover', draft);
    if (!operation) return;
    const response = await this.request(operation, '/api/custom-providers/discover-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: draft }),
    });
    if (!this.isActive(operation) || response.aborted) return this.finishOperation(operation);
    if (!response.ok) {
      this.finishOperation(operation);
      this.showResult(this.errorText(response.body, '模型发现失败', operation.secrets), true, operation.root, operation.secrets);
      return;
    }
    const ids = safeArray((response.body as { ids?: unknown }).ids)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const existing = new Set(
      [...operation.root.querySelectorAll<HTMLInputElement>('.cpe-model-id')].map(input => input.value),
    );
    const imported = ids.filter(id => !existing.has(id));
    if (imported.length === 0) {
      this.finishOperation(operation);
      this.showResult('未发现新的模型 ID', false, operation.root, operation.secrets);
      return;
    }
    if (!window.confirm(`导入 ${imported.length} 个模型 ID？\n${imported.join('\n')}`)) {
      if (!this.isActive(operation)) return this.finishOperation(operation);
      this.finishOperation(operation);
      this.showResult('已取消导入', false, operation.root, operation.secrets);
      return;
    }
    if (!this.isActive(operation)) return this.finishOperation(operation);
    const rows = operation.root.querySelector<HTMLElement>('.cpe-model-rows');
    if (!rows) return this.finishOperation(operation);
    for (const id of imported) rows.append(this.createModelRow(emptyModel(id)));
    this.refreshDynamicMetadata(operation.root);
    this.finishOperation(operation);
    this.showResult(`已导入 ${imported.length} 个模型 ID，保存后生效`, false, operation.root, operation.secrets);
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
    if (this.activeOperation?.action === 'delete') return;
    this.clearFeedback();
    const operation = this.beginOperation('delete', null);
    if (!operation || !operation.providerId) return;
    const response = await this.request(operation, `/api/custom-providers/${encodeURIComponent(operation.providerId)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: operation.revision }),
    });
    if (!this.isActive(operation) || response.aborted) return this.finishOperation(operation);
    if (!response.ok) {
      await this.handleMutationError(operation, response.body);
      this.finishOperation(operation);
      return;
    }
    const snapshot = response.body as RedactedCustomProviderSnapshot;
    if (typeof snapshot.revision !== 'number' || !Array.isArray(snapshot.providers)) {
      this.finishOperation(operation);
      this.showResult('删除响应无效', true, operation.root, operation.secrets);
      return;
    }
    this.finishOperation(operation);
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
    row.append(cpeElement('span', 'cpe-field-error cpe-header-error'));
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

  private invalidateOperation(): void {
    this.generation += 1;
    const operation = this.activeOperation;
    if (!operation) return;
    operation.controller.abort();
    this.setBusy(operation, false);
    this.activeOperation = null;
  }

  private beginOperation(
    action: CustomProviderEditorAction,
    draft: CustomProviderDraft | null,
  ): CustomProviderEditorOperation | null {
    if (!this.root) return null;
    if (this.activeOperation) {
      this.activeOperation.controller.abort();
      this.setBusy(this.activeOperation, false);
      this.activeOperation = null;
    }
    const operation: CustomProviderEditorOperation = {
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
    this.activeOperation = operation;
    this.setBusy(operation, true);
    return operation;
  }

  private isActive(operation: CustomProviderEditorOperation): boolean {
    return this.activeOperation === operation
      && operation.generation === this.generation
      && operation.root === this.root
      && Boolean(this.container?.contains(operation.root));
  }

  private finishOperation(operation: CustomProviderEditorOperation): void {
    if (this.activeOperation !== operation) return;
    this.setBusy(operation, false);
    this.activeOperation = null;
  }

  private setBusy(operation: CustomProviderEditorOperation, busy: boolean): void {
    const action = operation.action === 'discover' ? 'discover'
      : operation.action === 'reveal' ? 'reveal-api-key'
        : operation.action;
    const button = operation.root.querySelector<HTMLButtonElement>(`[data-cpe-action="${action}"]`);
    if (!button) return;
    button.disabled = busy;
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  private captureSecrets(root: HTMLElement): string[] {
    return [
      root.querySelector<HTMLInputElement>('#cpe-api-key')?.value,
      ...[...root.querySelectorAll<HTMLInputElement>('.cpe-header-value')].map(input => input.value),
    ].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  }

  private async revealApiKey(): Promise<void> {
    if (!this.provider?.apiKeyConfigured || this.activeOperation?.action === 'reveal') return;
    this.clearFeedback();
    const operation = this.beginOperation('reveal', null);
    if (!operation?.providerId) return;
    const response = await this.request(operation, '/api/custom-providers/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: operation.providerId }),
    });
    if (!this.isActive(operation) || response.aborted) return this.finishOperation(operation);
    if (!response.ok) {
      this.finishOperation(operation);
      this.showResult(this.errorText(response.body, 'API Key 显示失败', operation.secrets), true, operation.root, operation.secrets);
      return;
    }
    const apiKey = response.body && typeof response.body === 'object'
      ? (response.body as { apiKey?: unknown }).apiKey
      : undefined;
    if (typeof apiKey !== 'string') {
      this.finishOperation(operation);
      this.showResult('API Key 显示响应无效', true, operation.root, operation.secrets);
      return;
    }
    this.finishOperation(operation);
    const input = operation.root.querySelector<HTMLInputElement>('#cpe-api-key');
    if (input) input.value = apiKey;
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
      if (!configured && !headerValue) {
        valid = false;
        if (showErrors) this.setFieldError(`headers[${headers.length}].value`, '请输入 Header value');
        continue;
      }
      headers.push({ name: headerName, ...(headerValue ? { value: headerValue } : {}) });
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
        } catch {
          failModel(field(advancedField), `${label} 必须是 JSON 对象`);
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
    if (!this.isActive(operation)) return;
    const body = value && typeof value === 'object' ? value as CustomProviderErrorResponse : {};
    if (body.code === 'provider_id_conflict' || body.code === 'immutable_provider_id') {
      this.setFieldError('id', body.code === 'provider_id_conflict' ? 'Provider ID 已被占用' : 'Provider ID 创建后不可修改');
      return;
    }
    if (body.code === 'revision_conflict') {
      let latestRevision = typeof body.currentRevision === 'number' ? body.currentRevision : operation.revision;
      const latest = await this.request(operation, '/api/custom-providers', { method: 'GET' });
      if (!this.isActive(operation) || latest.aborted) return;
      if (latest.ok && latest.body && typeof latest.body === 'object') {
        const received = (latest.body as { revision?: unknown }).revision;
        if (typeof received === 'number') latestRevision = received;
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
    this.root?.querySelectorAll<HTMLElement>('.cpe-field-error').forEach(error => { error.textContent = ''; });
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
    const control = this.root?.querySelector<HTMLElement>(`[data-field-path="${normalized}"]`);
    if (control) {
      control.setAttribute('aria-invalid', 'true');
      const row = control.closest<HTMLElement>('.cpe-header-row, .cpe-model-row');
      const rowError = row?.querySelector<HTMLElement>('.cpe-header-error, .cpe-model-error');
      if (rowError) {
        rowError.dataset.fieldError = normalized;
        rowError.textContent = message;
        return;
      }
    }
    const target = [...(this.root?.querySelectorAll<HTMLElement>('[data-field-error]') ?? [])]
      .find(candidate => candidate.dataset.fieldError === normalized);
    if (target) target.textContent = message;
    else this.showResult(message, true);
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
    for (const secret of secrets) {
      if (!secret) continue;
      variants.add(secret);
      const json = JSON.stringify(secret);
      if (json.length >= 2) variants.add(json.slice(1, -1));
      try {
        const encoded = encodeURIComponent(secret);
        variants.add(encoded);
        variants.add(encoded.replace(/%[0-9A-F]{2}/g, part => part.toLowerCase()));
        variants.add(encoded.replace(/%[0-9a-f]{2}/g, part => part.toUpperCase()));
        variants.add(encoded.replace(/%20/gi, '+'));
      } catch {}
    }
    let redacted = message;
    for (const secret of [...variants].sort((left, right) => right.length - left.length)) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED]');
  }
}

const settingsCustomProviderEditorApp = (window as any).App || ((window as any).App = {});
settingsCustomProviderEditorApp.SettingsCustomProviderEditor = SettingsCustomProviderEditor;
