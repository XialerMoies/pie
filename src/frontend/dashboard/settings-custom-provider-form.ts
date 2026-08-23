/// <reference path="../dashboard.d.ts" />

type CustomProviderFormModel = CustomProviderDraft['models'][number];
type CustomProviderFormMutationAction = 'save' | 'delete';

const CUSTOM_PROVIDER_FORM_TOKENS_PER_CONTEXT_K = 1000;
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

function contextWindowDisplayValue(value: number): string {
  return String(value / CUSTOM_PROVIDER_FORM_TOKENS_PER_CONTEXT_K);
}

function contextWindowTokenValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * CUSTOM_PROVIDER_FORM_TOKENS_PER_CONTEXT_K) : Number.NaN;
}

function isEmptyModelPlaceholder(modelRow: HTMLElement): boolean {
  return !modelRow.querySelector<HTMLInputElement>('.cpe-model-id')?.value.trim()
    && !modelRow.querySelector<HTMLInputElement>('.cpe-model-name')?.value.trim()
    && contextWindowTokenValue(modelRow.querySelector<HTMLInputElement>('.cpe-model-context')?.value ?? '') === 128000
    && Number(modelRow.querySelector<HTMLInputElement>('.cpe-model-max')?.value ?? '') === 8192;
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
  private readonly elements: CustomProviderFormElements;
  private mutationControlStates: Map<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement, boolean> | null = null;

  constructor(
    private readonly options: CustomProviderFormOptions,
    listAddAction: typeof ListAddAction,
  ) {
    const Elements = (window as any).CustomProviderFormElements as typeof CustomProviderFormElements;
    this.elements = new Elements(options, listAddAction, () => this.refreshDynamicMetadata());
  }

  mount(container: HTMLElement, revision: number): HTMLElement {
    const provider = this.options.provider;
    const root = formElement('div', 'cpe-editor');
    this.root = root;
    this.apiKeyCleared = false;
    this.generatedId = !provider;
    this.mutationControlStates = null;

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
      this.elements.field('名称', formInput('cpe-name', 'cpe-input', provider?.name ?? '')),
      this.elements.field('Base URL', formInput('cpe-base-url', 'cpe-input', provider?.baseUrl ?? '', 'url')),
      this.elements.authField(provider),
      this.elements.apiKeyField(provider),
    );
    const modelRows = formElement('div', 'cpe-model-rows');
    for (const model of provider?.models ?? [emptyCustomProviderModel()]) {
      this.elements.appendModelRow(modelRows, model);
    }
    common.append(this.elements.modelsField(modelRows));

    const advanced = formElement('details', 'cpe-advanced');
    advanced.open = false;
    advanced.append(formElement('summary', undefined, '高级设置'));
    const advancedBody = formElement('div', 'cpe-advanced-body');
    advancedBody.append(
      this.elements.field('Provider ID', formInput('cpe-id', 'cpe-input', provider?.id ?? '')),
      this.elements.protocolField(provider?.protocol ?? templateProtocol(this.options.template)),
      this.elements.field('模型发现路径', formInput('cpe-model-discovery', 'cpe-input', provider?.modelDiscovery ?? '')),
      this.elements.headersField(provider?.headers ?? []),
    );
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
    const Reader = (window as any).CustomProviderFormReader as typeof CustomProviderFormReader;
    return new Reader(
      this.root,
      this.options,
      this.apiKeyCleared,
      (field, message, focus) => this.setFieldError(field, message, focus),
    ).read(options);
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

  appendDiscoveredModels(discoveredModels: readonly CustomProviderDiscoveredModel[]): void {
    if (!this.root) return;
    const rows = this.root.querySelector<HTMLElement>('.cpe-model-rows');
    if (!rows) return;
    const currentRows = [...rows.querySelectorAll<HTMLElement>('.cpe-model-row')];
    if (currentRows.length === 1 && isEmptyModelPlaceholder(currentRows[0])) {
      currentRows[0].remove();
    }
    for (const discovered of discoveredModels) {
      const existing = [...rows.querySelectorAll<HTMLElement>('.cpe-model-row')].find(row => (
        row.querySelector<HTMLInputElement>('.cpe-model-id')?.value.trim() === discovered.id
      ));
      if (existing) {
        this.applyDiscoveredModel(existing, discovered);
        continue;
      }
      const contextWindow = discovered.contextWindow ?? 128000;
      const maxTokens = Math.min(discovered.maxTokens ?? 8192, contextWindow);
      this.elements.appendModelRow(rows, {
        id: discovered.id,
        name: discovered.name ?? discovered.id,
        contextWindow,
        maxTokens,
        reasoning: discovered.reasoning ?? false,
        input: discovered.input?.includes('image') ? ['text', 'image'] : ['text'],
        cost: {
          input: discovered.cost?.input ?? 0,
          output: discovered.cost?.output ?? 0,
          cacheRead: discovered.cost?.cacheRead ?? 0,
          cacheWrite: discovered.cost?.cacheWrite ?? 0,
        },
      }, discovered.source);
    }
    this.refreshDynamicMetadata();
  }

  private applyDiscoveredModel(row: HTMLElement, discovered: CustomProviderDiscoveredModel): void {
    const name = row.querySelector<HTMLInputElement>('.cpe-model-name');
    if (discovered.name && name && (!name.value.trim() || name.value.trim() === discovered.id)) {
      name.value = discovered.name;
    }
    const context = row.querySelector<HTMLInputElement>('.cpe-model-context');
    const max = row.querySelector<HTMLInputElement>('.cpe-model-max');
    if (context && discovered.contextWindow !== undefined) context.value = contextWindowDisplayValue(discovered.contextWindow);
    if (max && discovered.maxTokens !== undefined) max.value = String(discovered.maxTokens);
    if (context && max) {
      const contextValue = contextWindowTokenValue(context.value);
      const maxValue = Number(max.value);
      if (Number.isSafeInteger(contextValue) && contextValue > 0 && maxValue > contextValue) {
        max.value = String(contextValue);
      }
    }
    const reasoning = row.querySelector<HTMLInputElement>('.cpe-model-reasoning');
    if (reasoning && discovered.reasoning !== undefined) reasoning.checked = discovered.reasoning;
    const image = row.querySelector<HTMLInputElement>('.cpe-model-image');
    if (image && discovered.input !== undefined) image.checked = discovered.input.includes('image');
    for (const [field, selector] of [
      ['input', '.cpe-cost-input'],
      ['output', '.cpe-cost-output'],
      ['cacheRead', '.cpe-cost-cache-read'],
      ['cacheWrite', '.cpe-cost-cache-write'],
    ] as const) {
      const value = discovered.cost?.[field];
      const control = row.querySelector<HTMLInputElement>(selector);
      if (control && value !== undefined) control.value = String(value);
    }
    if (discovered.source) {
      const source = row.querySelector<HTMLElement>('.cpe-model-source') ?? formElement('div', 'cpe-model-source');
      source.textContent = discovered.source === 'provider'
        ? '能力与费用已从模型接口自动识别'
        : discovered.source === 'provider+catalog'
          ? '能力由模型接口与目录共同补全'
          : '能力已从模型目录自动补全';
      if (!source.isConnected) row.querySelector('.cpe-model-main-error')?.after(source);
    }
  }

  setApiKey(value: string): void {
    const input = this.root?.querySelector<HTMLInputElement>('#cpe-api-key');
    if (!input) return;
    input.value = value;
    input.type = 'text';
    this.apiKeyCleared = false;
    this.syncApiKeyToggle(true);
  }

  setModelDiscovery(value: string): void {
    const input = this.root?.querySelector<HTMLInputElement>('#cpe-model-discovery');
    if (input) input.value = value;
  }

  toggleApiKeyVisibility(): boolean {
    const input = this.root?.querySelector<HTMLInputElement>('#cpe-api-key');
    if (!input?.value) return false;
    const visible = input.type !== 'text';
    input.type = visible ? 'text' : 'password';
    this.syncApiKeyToggle(visible);
    return true;
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
    if (busy) {
      if (!this.mutationControlStates) {
        const controls = this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
          'input, select, textarea, button',
        );
        this.mutationControlStates = new Map([...controls].map(control => [control, control.disabled]));
      }
      for (const control of this.mutationControlStates.keys()) control.disabled = true;
    } else if (this.mutationControlStates) {
      for (const [control, disabled] of this.mutationControlStates) control.disabled = disabled;
      this.mutationControlStates = null;
    }
    const active = this.root.querySelector<HTMLButtonElement>(`[data-cpe-action="${action}"]`);
    if (active) {
      if (busy) active.setAttribute('aria-busy', 'true');
      else active.removeAttribute('aria-busy');
    }
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
      const advanced = control.closest<HTMLDetailsElement>('details.cpe-advanced, details.cpe-model-advanced');
      if (advanced) advanced.open = true;
    }
    const target = [...(this.root?.querySelectorAll<HTMLElement>('[data-field-error]') ?? [])]
      .find(candidate => candidate.dataset.fieldError === normalized);
    if (target) {
      target.hidden = false;
      target.textContent = message;
    } else {
      const row = control?.closest<HTMLElement>('.cpe-header-row, .cpe-model-row');
      const rowError = row?.classList.contains('cpe-model-row')
        ? control?.closest('.cpe-model-main')
          ? row.querySelector<HTMLElement>('.cpe-model-main-error')
          : control?.closest('.cpe-model-advanced')
            ? row.querySelector<HTMLElement>('.cpe-model-advanced-error')
            : row.querySelector<HTMLElement>('.cpe-model-capability-error')
        : row?.querySelector<HTMLElement>('.cpe-header-error');
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

  private handleFormClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-cpe-action]')?.dataset.cpeAction;
    if (action === 'clear-api-key') {
      this.apiKeyCleared = true;
      const input = this.root?.querySelector<HTMLInputElement>('#cpe-api-key');
      if (input) {
        input.value = '';
        input.type = 'password';
        input.placeholder = '保存后清除';
        this.syncApiKeyToggle(false);
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
      row?.remove();
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
    const headerFieldIndexes = this.headerFieldIndexes(headerRows);
    headerRows.forEach((row, index) => {
      const number = index + 1;
      const fieldIndex = headerFieldIndexes.get(row);
      const name = row.querySelector<HTMLInputElement>('.cpe-header-name');
      const value = row.querySelector<HTMLInputElement>('.cpe-header-value');
      if (name) {
        if (fieldIndex === undefined) delete name.dataset.fieldPath;
        else name.dataset.fieldPath = `headers[${fieldIndex}].name`;
        if (!name.getAttribute('aria-label')) name.setAttribute('aria-label', `Header ${number} 名称`);
      }
      if (value) {
        if (fieldIndex === undefined) delete value.dataset.fieldPath;
        else value.dataset.fieldPath = `headers[${fieldIndex}].value`;
        value.setAttribute('aria-label', `Header ${number} 值`);
      }
      const nameError = row.querySelector<HTMLElement>('.cpe-header-name-error');
      if (nameError) {
        if (fieldIndex === undefined) delete nameError.dataset.fieldError;
        else nameError.dataset.fieldError = `headers[${fieldIndex}].name`;
      }
      const valueError = row.querySelector<HTMLElement>('.cpe-header-value-error');
      if (valueError) {
        if (fieldIndex === undefined) delete valueError.dataset.fieldError;
        else valueError.dataset.fieldError = `headers[${fieldIndex}].value`;
      }
      const remove = row.querySelector<HTMLButtonElement>('[data-cpe-action="remove-header"]');
      if (remove) {
        remove.title = `删除 Header ${number}`;
        remove.setAttribute('aria-label', `删除 Header ${number}`);
      }
    });

    const modelRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-model-row')];
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
    modelRows.forEach((row, index) => {
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
      row.querySelectorAll<HTMLElement>('.cpe-model-error').forEach(error => this.reindexModelError(error, index));
      const remove = row.querySelector<HTMLButtonElement>('[data-cpe-action="remove-model"]');
      if (remove) {
        remove.title = `删除模型 ${number}`;
        remove.setAttribute('aria-label', `删除模型 ${number}`);
      }
      for (const [selector, field] of detailFields) {
        const control = row.querySelector<HTMLElement>(selector);
        if (!control) continue;
        control.dataset.fieldPath = `models[${index}].${field}`;
        control.setAttribute('aria-label', `模型 ${number} ${field}`);
      }
    });
  }

  private headerFieldIndexes(rows: readonly HTMLElement[]): Map<HTMLElement, number> {
    const activeNames = new Set<string>();
    for (const row of rows) {
      if (row.dataset.removed === 'true') continue;
      const name = row.dataset.configured === 'true'
        ? row.dataset.originalName ?? ''
        : row.querySelector<HTMLInputElement>('.cpe-header-name')?.value.trim() ?? '';
      if (name) activeNames.add(name.toLowerCase());
    }

    const indexes = new Map<HTMLElement, number>();
    let fieldIndex = 0;
    for (const row of rows) {
      const originalName = row.dataset.originalName ?? '';
      if (row.dataset.removed === 'true' && (!originalName || activeNames.has(originalName.toLowerCase()))) continue;
      indexes.set(row, fieldIndex);
      fieldIndex += 1;
    }
    return indexes;
  }

  private syncApiKeyToggle(visible: boolean): void {
    const toggle = this.root?.querySelector<HTMLButtonElement>('[data-cpe-action="reveal-api-key"]');
    if (!toggle) return;
    const label = visible ? '隐藏 API Key' : '显示 API Key';
    toggle.title = label;
    toggle.setAttribute('aria-label', label);
  }

  private reindexModelError(error: HTMLElement | null, index: number): void {
    const path = error?.dataset.fieldError;
    const suffix = path?.match(/^models\[\d+\](\..+)$/)?.[1];
    if (error && suffix) error.dataset.fieldError = `models[${index}]${suffix}`;
  }
}

(window as any).CustomProviderFormView = CustomProviderFormView;
