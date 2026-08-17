/// <reference path="../dashboard.d.ts" />

type CustomProviderFormModel = CustomProviderDraft['models'][number];
type CustomProviderFormAction = 'save' | 'test' | 'discover' | 'delete' | 'reveal-api-key';
type CustomProviderFormMutationAction = 'save' | 'delete';

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
const CUSTOM_NETWORK_ACTIONS: readonly CustomProviderFormAction[] = [
  'save',
  'delete',
  'test',
  'discover',
  'reveal-api-key',
];

function formElement<K extends keyof HTMLElementTagNameMap>(
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

function formInput(id: string, className: string, value: string, type = 'text'): HTMLInputElement {
  const input = formElement('input', className);
  input.id = id;
  input.type = type;
  input.value = value;
  return input;
}

function formButton(action: string, label: string, className = 'cpe-button'): HTMLButtonElement {
  const button = formElement('button', className, label);
  button.type = 'button';
  button.dataset.cpeAction = action;
  return button;
}

function emptyCustomProviderModel(id = ''): CustomProviderFormModel {
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

function templateProtocol(template: CustomProviderTemplate | undefined): CustomProviderProtocol | '' {
  if (template === 'openai') return 'openai-completions';
  if (template === 'anthropic') return 'anthropic-messages';
  return '';
}

export class CustomProviderFormView implements SettingsCustomProviderFormView {
  private root: HTMLElement | null = null;
  private apiKeyCleared = false;
  private generatedId = true;
  private modelSequence = 0;

  constructor(
    private readonly options: CustomProviderFormOptions,
    private readonly listAddAction: typeof ListAddAction,
  ) {}

  mount(container: HTMLElement, revision: number): HTMLElement {
    const provider = this.options.provider;
    const root = formElement('div', 'cpe-editor');
    this.root = root;
    this.apiKeyCleared = false;
    this.generatedId = !provider;

    const heading = formElement('div', 'cpe-heading');
    heading.append(
      formElement('div', 'cpe-title', provider ? provider.name : '添加自定义厂商'),
      formElement('span', 'cpe-revision', `Revision ${revision}`),
    );
    root.append(heading);

    const conflict = formElement('div', 'cpe-conflict-banner');
    conflict.hidden = true;
    conflict.setAttribute('role', 'alert');
    root.append(conflict);

    const form = formElement('div', 'cpe-form');
    const common = formElement('div', 'cpe-common');
    common.append(
      this.field('名称', formInput('cpe-name', 'cpe-input', provider?.name ?? '')),
      this.field('Base URL', formInput('cpe-base-url', 'cpe-input', provider?.baseUrl ?? '', 'url')),
      this.authField(provider),
      this.apiKeyField(provider),
    );
    const modelRows = formElement('div', 'cpe-model-rows');
    const modelDetails = formElement('div', 'cpe-model-detail-rows');
    for (const model of provider?.models ?? [emptyCustomProviderModel()]) {
      this.appendModelPair(modelRows, modelDetails, model);
    }
    common.append(this.modelsField(modelRows));

    const advanced = formElement('details', 'cpe-advanced');
    advanced.open = false;
    advanced.append(formElement('summary', undefined, '高级设置'));
    const advancedBody = formElement('div', 'cpe-advanced-body');
    advancedBody.append(
      this.field('Provider ID', formInput('cpe-id', 'cpe-input', provider?.id ?? '')),
      this.protocolField(provider?.protocol ?? templateProtocol(this.options.template)),
      this.field('模型发现路径', formInput('cpe-model-discovery', 'cpe-input', provider?.modelDiscovery ?? '')),
      this.headersField(provider?.headers ?? []),
    );
    const modelAdvanced = formElement('section', 'cpe-section cpe-model-advanced-section');
    modelAdvanced.append(formElement('div', 'cpe-section-title', '模型能力与费用'), modelDetails);
    advancedBody.append(modelAdvanced);
    advanced.append(advancedBody);
    form.append(common, advanced);
    root.append(form);

    const idInput = root.querySelector<HTMLInputElement>('#cpe-id');
    if (idInput) idInput.readOnly = Boolean(provider);

    const result = formElement('div', 'cpe-result');
    result.hidden = true;
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
    root.append(result);

    const actions = formElement('div', 'cpe-actions');
    actions.append(
      formButton('test', '测试连接'),
      formButton('discover', '发现模型'),
      formButton('save', '保存', 'cpe-button primary'),
    );
    if (provider) actions.prepend(formButton('delete', '删除', 'cpe-button danger'));
    root.append(actions);

    root.addEventListener('click', event => this.handleFormClick(event));
    root.addEventListener('input', event => this.handleFormInput(event));
    this.refreshDynamicMetadata();
    container.replaceChildren(root);
    return root;
  }

  read(options: CustomProviderFormReadOptions): CustomProviderDraft | null {
    if (!this.root) return null;
    this.refreshDynamicMetadata();
    const showErrors = options.showErrors;
    const value = (selector: string) => this.root?.querySelector<HTMLInputElement>(selector)?.value.trim() ?? '';
    const id = value('#cpe-id');
    const name = value('#cpe-name');
    const baseUrl = value('#cpe-base-url');
    const modelDiscovery = value('#cpe-model-discovery');
    const protocol = this.root.querySelector<HTMLSelectElement>('#cpe-protocol')?.value ?? '';
    const authMode = this.root.querySelector<HTMLInputElement>('input[name="cpe-auth-mode"]:checked')?.value ?? '';
    let valid = true;
    const fail = (field: string, message: string) => {
      valid = false;
      if (showErrors) this.setFieldError(field, message, false);
    };
    if (!name) fail('name', '请输入名称');
    if (!id) fail('id', '请输入 Provider ID');
    if (!protocol) fail('protocol', '请选择协议');
    if (!baseUrl) fail('baseUrl', '请输入 Base URL');
    if (!authMode) fail('authMode', '请选择认证方式');
    if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      fail('id', 'Provider ID 只能使用小写字母、数字和连字符');
    }
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error();
      } catch {
        fail('baseUrl', '请输入有效的 HTTP(S) URL');
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
        fail('modelDiscovery', '请输入同源 HTTP(S) URL 或安全相对路径');
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
      if (message) fail(`headers[${index}].name`, message);
      else headerNames.add(normalizedName);
      const headerValue = row.querySelector<HTMLInputElement>('.cpe-header-value')?.value ?? '';
      const hasHeaderValue = headerValue.trim().length > 0;
      if (!configured && !hasHeaderValue) fail(`headers[${index}].value`, '请输入 Header value');
      if (!message && (configured || hasHeaderValue)) {
        headers.push({ name: headerName, ...(hasHeaderValue ? { value: headerValue } : {}) });
      }
    }
    if (!valid) return null;

    const commonRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-model-row')];
    const detailRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-model-detail-row')];
    if (commonRows.length === 0 || commonRows.length !== detailRows.length) {
      if (showErrors) this.setFieldError('models', '至少添加一个模型', false);
      return null;
    }
    const modelIds = new Set<string>();
    const modelNames = new Set<string>();
    const models: CustomProviderFormModel[] = [];
    for (let index = 0; index < commonRows.length; index += 1) {
      const commonRow = commonRows[index];
      const detailRow = detailRows[index];
      const field = (name: string) => `models[${index}].${name}`;
      const modelId = commonRow.querySelector<HTMLInputElement>('.cpe-model-id')?.value.trim() ?? '';
      const modelName = commonRow.querySelector<HTMLInputElement>('.cpe-model-name')?.value.trim() ?? '';
      const contextWindow = Number(detailRow.querySelector<HTMLInputElement>('.cpe-model-context')?.value ?? '');
      const maxTokens = Number(detailRow.querySelector<HTMLInputElement>('.cpe-model-max')?.value ?? '');
      if (!modelId) fail(field('id'), '请输入 Model ID');
      else if (modelIds.has(modelId)) fail(field('id'), 'Model ID 重复');
      else modelIds.add(modelId);
      const normalizedName = modelName.toLowerCase();
      if (!modelName) fail(field('name'), '请输入模型名称');
      else if (modelNames.has(normalizedName)) fail(field('name'), '模型名称重复');
      else modelNames.add(normalizedName);
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) fail(field('contextWindow'), 'Context 必须是正整数');
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) fail(field('maxTokens'), 'Max tokens 必须是正整数');
      else if (Number.isInteger(contextWindow) && contextWindow > 0 && maxTokens > contextWindow) {
        fail(field('maxTokens'), 'Max tokens 不能超过 Context');
      }

      const costFields = [
        ['input', '.cpe-cost-input'],
        ['output', '.cpe-cost-output'],
        ['cacheRead', '.cpe-cost-cache-read'],
        ['cacheWrite', '.cpe-cost-cache-write'],
      ] as const;
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const [costField, selector] of costFields) {
        const amount = Number(detailRow.querySelector<HTMLInputElement>(selector)?.value ?? '');
        if (!Number.isFinite(amount) || amount < 0) fail(field(`cost.${costField}`), '费用必须是非负数');
        else cost[costField] = amount;
      }

      let samplingParams: Record<string, unknown> | undefined;
      let compatibility: Record<string, unknown> | undefined;
      for (const [advancedField, selector, label] of [
        ['samplingParams', '.cpe-model-sampling', 'Sampling JSON'],
        ['compatibility', '.cpe-model-compatibility', 'Compatibility JSON'],
      ] as const) {
        try {
          const parsed = readJsonObject(detailRow.querySelector(selector), label);
          if (advancedField === 'samplingParams') samplingParams = parsed;
          else compatibility = parsed;
        } catch (error) {
          fail(field(advancedField), error instanceof Error ? error.message : `${label} 必须是 JSON 对象`);
        }
      }
      models.push({
        id: modelId,
        name: modelName,
        contextWindow,
        maxTokens,
        reasoning: detailRow.querySelector<HTMLInputElement>('.cpe-model-reasoning')?.checked ?? false,
        input: detailRow.querySelector<HTMLInputElement>('.cpe-model-image')?.checked ? ['text', 'image'] : ['text'],
        cost,
        ...(samplingParams ? { samplingParams } : {}),
        ...(compatibility ? { compatibility } : {}),
      });
    }
    if (!valid) return null;

    const apiKeyValue = value('#cpe-api-key');
    if (authMode === 'apiKey' && !apiKeyValue && !this.apiKeyCleared && !this.options.provider?.apiKeyConfigured) {
      if (showErrors) this.setFieldError('apiKey', '请输入 API Key', false);
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

  getRoot(): HTMLElement | null {
    return this.root;
  }

  captureSecrets(): string[] {
    if (!this.root) return [];
    return [
      this.root.querySelector<HTMLInputElement>('#cpe-api-key')?.value,
      ...[...this.root.querySelectorAll<HTMLInputElement>('.cpe-header-value')].map(input => input.value),
    ].filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
  }

  appendDiscoveredModels(ids: readonly string[]): void {
    if (!this.root) return;
    const commonRows = this.root.querySelector<HTMLElement>('.cpe-model-rows');
    const detailRows = this.root.querySelector<HTMLElement>('.cpe-model-detail-rows');
    if (!commonRows || !detailRows) return;
    for (const id of ids) this.appendModelPair(commonRows, detailRows, emptyCustomProviderModel(id));
    this.refreshDynamicMetadata();
  }

  setApiKey(value: string): void {
    const input = this.root?.querySelector<HTMLInputElement>('#cpe-api-key');
    if (!input) return;
    input.value = value;
    this.apiKeyCleared = false;
  }

  setDeleteArmed(armed: boolean): void {
    const button = this.root?.querySelector<HTMLButtonElement>('[data-cpe-action="delete"]');
    if (!button) return;
    button.classList.toggle('armed', armed);
    button.textContent = armed ? '再次点击删除' : '删除';
  }

  setQueryBusy(action: 'test' | 'discover' | 'reveal', busy: boolean): void {
    const buttonAction = action === 'reveal' ? 'reveal-api-key' : action;
    const button = this.root?.querySelector<HTMLButtonElement>(`[data-cpe-action="${buttonAction}"]`);
    if (!button) return;
    button.disabled = busy;
    if (busy) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }

  setMutationBusy(action: CustomProviderFormMutationAction, busy: boolean): void {
    if (!this.root) return;
    for (const buttonAction of CUSTOM_NETWORK_ACTIONS) {
      const button = this.root.querySelector<HTMLButtonElement>(`[data-cpe-action="${buttonAction}"]`);
      if (button) button.disabled = busy;
    }
    const active = this.root.querySelector<HTMLButtonElement>(`[data-cpe-action="${action}"]`);
    if (!active) return;
    if (busy) active.setAttribute('aria-busy', 'true');
    else active.removeAttribute('aria-busy');
  }

  clearFeedback(): void {
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

  setFieldError(field: string, message: string, focus = true): void {
    const normalized = field.replace(/^provider\./, '');
    const controls = [...(this.root?.querySelectorAll<HTMLElement>('[data-field-path]') ?? [])];
    const control = controls.find(candidate => candidate.dataset.fieldPath === normalized);
    if (control) {
      control.setAttribute('aria-invalid', 'true');
      const advanced = control.closest<HTMLDetailsElement>('details.cpe-advanced');
      if (advanced) advanced.open = true;
    }
    const target = [...(this.root?.querySelectorAll<HTMLElement>('[data-field-error]') ?? [])]
      .find(candidate => candidate.dataset.fieldError === normalized);
    if (target) {
      target.hidden = false;
      target.textContent = message;
    } else {
      const row = control?.closest<HTMLElement>('.cpe-header-row, .cpe-model-row, .cpe-model-detail-row');
      const rowError = row?.querySelector<HTMLElement>('.cpe-header-error, .cpe-model-error');
      if (rowError) {
        rowError.dataset.fieldError = normalized;
        rowError.hidden = false;
        rowError.textContent = message;
      } else this.showResult(message, true);
    }
    if (focus && control) control.focus();
  }

  showResult(message: string, error: boolean): void {
    const result = this.root?.querySelector<HTMLElement>('.cpe-result');
    if (!result) return;
    result.hidden = false;
    result.classList.toggle('error', error);
    result.setAttribute('role', error ? 'alert' : 'status');
    result.textContent = message;
  }

  showConflict(revision: number): void {
    const banner = this.root?.querySelector<HTMLElement>('.cpe-conflict-banner');
    if (!banner) return;
    banner.hidden = false;
    banner.textContent = `版本冲突：已加载最新 revision ${revision}。未保存的表单值已保留，请检查后再次保存。`;
  }

  showReferences(references: readonly string[]): void {
    const banner = this.root?.querySelector<HTMLElement>('.cpe-conflict-banner');
    if (!banner) return;
    banner.replaceChildren(formElement('strong', undefined, '当前配置仍被占用'));
    const list = formElement('ul', 'cpe-occupancy-list');
    for (const reference of references) list.append(formElement('li', undefined, reference));
    banner.append(list);
    banner.hidden = false;
  }

  private field(labelText: string, control: HTMLElement, errorField?: string): HTMLElement {
    const field = formElement('label', 'cpe-field');
    const fieldPath = errorField ?? this.fieldNameForControl(control.id);
    control.dataset.fieldPath = fieldPath;
    field.append(formElement('span', 'cpe-label', labelText), control);
    const error = formElement('span', 'cpe-field-error');
    error.dataset.fieldError = fieldPath;
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
    const select = formElement('select', 'cpe-input');
    select.id = 'cpe-protocol';
    const prompt = formElement('option', undefined, '选择协议');
    prompt.value = '';
    select.append(prompt);
    for (const protocol of [...new Set(this.options.protocols)]) {
      const option = formElement('option', undefined, protocol);
      option.value = protocol;
      option.selected = protocol === selected;
      select.append(option);
    }
    select.value = this.options.protocols.includes(selected as CustomProviderProtocol) ? selected : '';
    return this.field('协议', select, 'protocol');
  }

  private authField(provider: RedactedCustomProvider | null): HTMLElement {
    const group = formElement('div', 'cpe-field cpe-auth-field');
    group.append(formElement('span', 'cpe-label', '认证'));
    const segmented = formElement('div', 'cpe-segmented');
    const defaultMode = provider?.authMode ?? (this.options.template === 'openai' || this.options.template === 'anthropic' ? 'apiKey' : '');
    for (const mode of ['none', 'apiKey'] as const) {
      const label = formElement('label', 'cpe-segment');
      const radio = formElement('input');
      radio.id = mode;
      radio.type = 'radio';
      radio.name = 'cpe-auth-mode';
      radio.value = mode;
      radio.dataset.fieldPath = 'authMode';
      radio.checked = defaultMode === mode;
      label.append(radio, formElement('span', undefined, mode === 'none' ? 'None' : 'API Key'));
      segmented.append(label);
    }
    group.append(segmented);
    const error = formElement('span', 'cpe-field-error');
    error.dataset.fieldError = 'authMode';
    group.append(error);
    return group;
  }

  private apiKeyField(provider: RedactedCustomProvider | null): HTMLElement {
    const section = formElement('div', 'cpe-secret-section');
    const line = formElement('div', 'cpe-secret-heading');
    line.append(formElement('span', 'cpe-label', 'API Key'));
    if (provider?.apiKeyConfigured) line.append(formElement('span', 'cpe-secret-status', '已保存'));
    section.append(line);
    const row = formElement('div', 'cpe-inline-row');
    const input = formInput('cpe-api-key', 'cpe-input', '', 'password');
    input.dataset.fieldPath = 'apiKey';
    input.setAttribute('aria-label', 'API Key');
    input.placeholder = provider?.apiKeyConfigured ? '留空保留已保存值' : '输入 API Key';
    row.append(input);
    if (provider?.apiKeyConfigured) {
      const reveal = formButton('reveal-api-key', '👁', 'rp-key-toggle');
      reveal.title = '显示 API Key';
      reveal.setAttribute('aria-label', '显示 API Key');
      row.append(reveal);
    }
    row.append(formButton('clear-api-key', '清除', 'cpe-button subtle'));
    section.append(row);
    const error = formElement('span', 'cpe-field-error');
    error.dataset.fieldError = 'apiKey';
    section.append(error);
    return section;
  }

  private headersField(headers: RedactedCustomProvider['headers']): HTMLElement {
    const section = formElement('section', 'cpe-section');
    section.append(formElement('div', 'cpe-section-title', 'Headers'));
    const rows = formElement('div', 'cpe-header-rows');
    for (const header of headers) rows.append(this.createHeaderRow(header.name, header.configured));
    section.append(rows);
    const add = this.listAddAction.create({
      label: '添加 Header',
      onActivate: () => {
        rows.append(this.createHeaderRow('', false));
        this.refreshDynamicMetadata();
      },
    });
    add.dataset.cpeAction = 'add-header';
    section.append(add);
    return section;
  }

  private createHeaderRow(name: string, configured: boolean): HTMLElement {
    const row = formElement('div', 'cpe-header-row');
    row.dataset.originalName = name;
    row.dataset.configured = String(configured);
    const nameInput = formInput('', 'cpe-input cpe-header-name', name);
    nameInput.placeholder = 'Header name';
    if (configured) {
      nameInput.readOnly = true;
      nameInput.title = '如需修改名称，请删除此 Header 后新增';
      nameInput.setAttribute('aria-label', '已配置 Header 名称，只读');
    }
    const valueInput = formInput('', 'cpe-input cpe-header-value', '', 'password');
    valueInput.placeholder = configured ? '留空保留已保存值' : 'Header value';
    row.append(nameInput, valueInput);
    if (configured) row.append(formElement('span', 'cpe-header-status', '已保存'));
    const remove = formButton('remove-header', '删除', 'cpe-icon-button');
    remove.title = '删除 Header';
    remove.setAttribute('aria-label', '删除 Header');
    row.append(remove);
    const nameError = formElement('span', 'cpe-field-error cpe-header-error cpe-header-name-error');
    const valueError = formElement('span', 'cpe-field-error cpe-header-error cpe-header-value-error');
    nameError.hidden = true;
    valueError.hidden = true;
    row.append(nameError, valueError);
    return row;
  }

  private modelsField(rows: HTMLElement): HTMLElement {
    const section = formElement('section', 'cpe-section cpe-model-common-section');
    section.append(formElement('div', 'cpe-section-title', '模型'), rows);
    const error = formElement('span', 'cpe-field-error cpe-models-error');
    error.dataset.fieldError = 'models';
    section.append(error);
    const add = this.listAddAction.create({
      label: '添加模型',
      onActivate: () => {
        const details = this.root?.querySelector<HTMLElement>('.cpe-model-detail-rows');
        if (!details) return;
        this.appendModelPair(rows, details, emptyCustomProviderModel());
        this.refreshDynamicMetadata();
      },
    });
    add.dataset.cpeAction = 'add-model';
    section.append(add);
    return section;
  }

  private appendModelPair(commonRows: HTMLElement, detailRows: HTMLElement, model: CustomProviderFormModel): void {
    const key = String(this.modelSequence++);
    const row = formElement('div', 'cpe-model-row');
    row.dataset.modelKey = key;
    const main = formElement('div', 'cpe-model-main');
    const id = formInput('', 'cpe-input cpe-model-id', model.id);
    id.placeholder = 'Model ID';
    const name = formInput('', 'cpe-input cpe-model-name', model.name);
    name.placeholder = '显示名称';
    const remove = formButton('remove-model', '删除', 'cpe-icon-button');
    remove.title = '删除模型';
    remove.setAttribute('aria-label', '删除模型');
    main.append(id, name, remove);
    row.append(main, formElement('span', 'cpe-field-error cpe-model-error'));
    commonRows.append(row);

    const detail = formElement('div', 'cpe-model-detail-row');
    detail.dataset.modelKey = key;
    const limits = formElement('div', 'cpe-model-grid');
    limits.append(
      this.miniField('Context', 'cpe-model-context', String(model.contextWindow), 'number'),
      this.miniField('Max tokens', 'cpe-model-max', String(model.maxTokens), 'number'),
      this.checkboxField('Reasoning', 'cpe-model-reasoning', model.reasoning),
      this.checkboxField('Image input', 'cpe-model-image', model.input.includes('image')),
    );
    const advanced = formElement('div', 'cpe-advanced-grid');
    advanced.append(
      this.miniField('Input USD / 1M', 'cpe-cost-input', String(model.cost.input), 'number'),
      this.miniField('Output USD / 1M', 'cpe-cost-output', String(model.cost.output), 'number'),
      this.miniField('Cache read USD / 1M', 'cpe-cost-cache-read', String(model.cost.cacheRead), 'number'),
      this.miniField('Cache write USD / 1M', 'cpe-cost-cache-write', String(model.cost.cacheWrite), 'number'),
      this.jsonField('Sampling JSON', 'cpe-model-sampling', model.samplingParams),
      this.jsonField('Compatibility JSON', 'cpe-model-compatibility', model.compatibility),
    );
    detail.append(limits, advanced, formElement('span', 'cpe-field-error cpe-model-error'));
    detailRows.append(detail);
  }

  private miniField(labelText: string, className: string, value: string, type: string): HTMLElement {
    const label = formElement('label', 'cpe-mini-field');
    const input = formInput('', `cpe-input ${className}`, value, type);
    if (type === 'number') {
      input.min = '0';
      input.step = 'any';
    }
    label.append(formElement('span', undefined, labelText), input);
    return label;
  }

  private checkboxField(labelText: string, className: string, checked: boolean): HTMLElement {
    const label = formElement('label', 'cpe-check-field');
    const input = formElement('input');
    input.type = 'checkbox';
    input.className = className;
    input.checked = checked;
    label.append(input, formElement('span', undefined, labelText));
    return label;
  }

  private jsonField(labelText: string, className: string, value: Record<string, unknown> | undefined): HTMLElement {
    const label = formElement('label', 'cpe-mini-field cpe-json-field');
    const textarea = formElement('textarea', `cpe-input ${className}`);
    textarea.rows = 3;
    textarea.value = value ? JSON.stringify(value, null, 2) : '';
    label.append(formElement('span', undefined, labelText), textarea);
    return label;
  }

  private handleFormClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-cpe-action]')?.dataset.cpeAction;
    if (action === 'clear-api-key') {
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
      this.refreshDynamicMetadata();
    } else if (action === 'remove-model') {
      const row = target.closest<HTMLElement>('.cpe-model-row');
      const key = row?.dataset.modelKey;
      row?.remove();
      if (key) this.root?.querySelector<HTMLElement>(`.cpe-model-detail-row[data-model-key="${key}"]`)?.remove();
      this.refreshDynamicMetadata();
    }
  }

  private handleFormInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.id === 'cpe-name' && this.generatedId && !this.options.provider) {
      const id = this.root?.querySelector<HTMLInputElement>('#cpe-id');
      if (id) id.value = this.availableProviderId(this.slugifyProviderId(input.value));
      return;
    }
    if (input.id === 'cpe-id' && !this.options.provider) {
      this.generatedId = false;
      return;
    }
    if (input.id === 'cpe-api-key' && input.value.length > 0) {
      this.apiKeyCleared = false;
      input.placeholder = this.options.provider?.apiKeyConfigured ? '留空保留已保存值' : '输入 API Key';
    }
  }

  private slugifyProviderId(name: string): string {
    const slug = name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug || 'custom-provider';
  }

  private availableProviderId(base: string): string {
    if (!this.options.occupiedProviderIds.has(base)) return base;
    let suffix = 2;
    while (this.options.occupiedProviderIds.has(`${base}-${suffix}`)) suffix += 1;
    return `${base}-${suffix}`;
  }

  private refreshDynamicMetadata(): void {
    if (!this.root) return;
    const headerRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-header-row')];
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

    const commonRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-model-row')];
    const detailRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-model-detail-row')];
    const detailFields: Array<[string, string]> = [
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
    commonRows.forEach((row, index) => {
      const number = index + 1;
      const id = row.querySelector<HTMLElement>('.cpe-model-id');
      const name = row.querySelector<HTMLElement>('.cpe-model-name');
      if (id) {
        id.dataset.fieldPath = `models[${index}].id`;
        id.setAttribute('aria-label', `模型 ${number} id`);
      }
      if (name) {
        name.dataset.fieldPath = `models[${index}].name`;
        name.setAttribute('aria-label', `模型 ${number} name`);
      }
      const remove = row.querySelector<HTMLButtonElement>('[data-cpe-action="remove-model"]');
      if (remove) {
        remove.title = `删除模型 ${number}`;
        remove.setAttribute('aria-label', `删除模型 ${number}`);
      }
      const detail = detailRows[index];
      if (!detail) return;
      for (const [selector, field] of detailFields) {
        const control = detail.querySelector<HTMLElement>(selector);
        if (!control) continue;
        control.dataset.fieldPath = `models[${index}].${field}`;
        control.setAttribute('aria-label', `模型 ${number} ${field}`);
      }
    });
  }
}

(window as any).CustomProviderFormView = CustomProviderFormView;
