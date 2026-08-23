/// <reference path="../dashboard.d.ts" />

type CustomProviderElementsModel = CustomProviderDraft['models'][number];
const CUSTOM_PROVIDER_CONTEXT_K = 1000;

function customProviderElement<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (className?.split(/\s+/).includes('cpe-field-error')) element.setAttribute('role', 'alert');
  if (text !== undefined) element.textContent = text;
  return element;
}

function customProviderInput(id: string, className: string, value: string, type = 'text'): HTMLInputElement {
  const input = customProviderElement('input', className);
  input.id = id;
  input.type = type;
  input.value = value;
  return input;
}

function customProviderButton(action: string, label: string, className = 'cpe-button'): HTMLButtonElement {
  const button = customProviderElement('button', className, label);
  button.type = 'button';
  button.dataset.cpeAction = action;
  return button;
}

export class CustomProviderFormElements {
  private modelSequence = 0;

  constructor(
    private readonly options: CustomProviderFormOptions,
    private readonly listAddAction: typeof ListAddAction,
    private readonly metadataChanged: () => void,
  ) {}

  field(labelText: string, control: HTMLElement, errorField?: string): HTMLElement {
    const field = customProviderElement('label', 'cpe-field');
    const fieldPath = errorField ?? this.fieldNameForControl(control.id);
    control.dataset.fieldPath = fieldPath;
    field.append(customProviderElement('span', 'cpe-label', labelText), control);
    const error = customProviderElement('span', 'cpe-field-error');
    error.dataset.fieldError = fieldPath;
    field.append(error);
    return field;
  }

  protocolField(selected: string): HTMLElement {
    const select = customProviderElement('select', 'cpe-input');
    select.id = 'cpe-protocol';
    const prompt = customProviderElement('option', undefined, '选择协议');
    prompt.value = '';
    select.append(prompt);
    for (const protocol of [...new Set(this.options.protocols)]) {
      const option = customProviderElement('option', undefined, protocol);
      option.value = protocol;
      option.selected = protocol === selected;
      select.append(option);
    }
    select.value = this.options.protocols.includes(selected as CustomProviderProtocol) ? selected : '';
    return this.field('协议', select, 'protocol');
  }

  authField(provider: RedactedCustomProvider | null): HTMLElement {
    const group = customProviderElement('div', 'cpe-field cpe-auth-field');
    group.append(customProviderElement('span', 'cpe-label', '认证'));
    const segmented = customProviderElement('div', 'cpe-segmented');
    const defaultMode = provider?.authMode ?? (this.options.template === 'openai' || this.options.template === 'anthropic' ? 'apiKey' : '');
    for (const mode of ['none', 'apiKey'] as const) {
      const label = customProviderElement('label', 'cpe-segment');
      const radio = customProviderElement('input');
      radio.id = mode;
      radio.type = 'radio';
      radio.name = 'cpe-auth-mode';
      radio.value = mode;
      radio.dataset.fieldPath = 'authMode';
      radio.checked = defaultMode === mode;
      label.append(radio, customProviderElement('span', undefined, mode === 'none' ? 'None' : 'API Key'));
      segmented.append(label);
    }
    group.append(segmented);
    const error = customProviderElement('span', 'cpe-field-error');
    error.dataset.fieldError = 'authMode';
    group.append(error);
    return group;
  }

  apiKeyField(provider: RedactedCustomProvider | null): HTMLElement {
    const section = customProviderElement('div', 'cpe-secret-section');
    const line = customProviderElement('div', 'cpe-secret-heading');
    line.append(customProviderElement('span', 'cpe-label', 'API Key'));
    if (provider?.apiKeyConfigured) line.append(customProviderElement('span', 'cpe-secret-status', '已保存'));
    section.append(line);
    const row = customProviderElement('div', 'cpe-inline-row');
    const input = customProviderInput('cpe-api-key', 'cpe-input', '', 'password');
    input.dataset.fieldPath = 'apiKey';
    input.setAttribute('aria-label', 'API Key');
    input.placeholder = provider?.apiKeyConfigured ? '留空保留已保存值' : '输入 API Key';
    row.append(input);
    if (provider?.apiKeyConfigured) {
      const reveal = customProviderButton('reveal-api-key', '👁', 'rp-key-toggle');
      reveal.title = '显示 API Key';
      reveal.setAttribute('aria-label', '显示 API Key');
      row.append(reveal);
    }
    row.append(customProviderButton('clear-api-key', '清除', 'cpe-button subtle'));
    section.append(row);
    const error = customProviderElement('span', 'cpe-field-error');
    error.dataset.fieldError = 'apiKey';
    section.append(error);
    return section;
  }

  headersField(headers: RedactedCustomProvider['headers']): HTMLElement {
    const section = customProviderElement('section', 'cpe-section');
    section.append(customProviderElement('div', 'cpe-section-title', 'Headers'));
    const rows = customProviderElement('div', 'cpe-header-rows');
    for (const header of headers) rows.append(this.createHeaderRow(header.name, header.configured));
    section.append(rows);
    const add = this.listAddAction.create({
      label: '添加 Header',
      onActivate: () => {
        rows.append(this.createHeaderRow('', false));
        this.metadataChanged();
      },
    });
    add.dataset.cpeAction = 'add-header';
    section.append(add);
    return section;
  }

  modelsField(rows: HTMLElement): HTMLElement {
    const section = customProviderElement('section', 'cpe-section cpe-model-common-section');
    section.append(customProviderElement('div', 'cpe-section-title', '模型'), rows);
    const error = customProviderElement('span', 'cpe-field-error cpe-models-error');
    error.dataset.fieldError = 'models';
    section.append(error);
    const add = this.listAddAction.create({
      label: '添加模型',
      onActivate: () => {
        this.appendModelRow(rows, this.emptyModel());
        this.metadataChanged();
      },
    });
    add.dataset.cpeAction = 'add-model';
    section.append(add);
    return section;
  }

  appendModelRow(rows: HTMLElement, model: CustomProviderElementsModel, source?: CustomProviderDiscoveredModel['source']): void {
    const row = customProviderElement('div', 'cpe-model-row');
    row.dataset.modelKey = String(this.modelSequence++);
    const main = customProviderElement('div', 'cpe-model-main');
    const id = customProviderInput('', 'cpe-input cpe-model-id', model.id);
    id.placeholder = 'Model ID';
    const name = customProviderInput('', 'cpe-input cpe-model-name', model.name);
    name.placeholder = '显示名称';
    const remove = customProviderButton('remove-model', '删除', 'cpe-icon-button');
    remove.title = '删除模型';
    remove.setAttribute('aria-label', '删除模型');
    main.append(id, name, remove);
    row.append(main, customProviderElement('span', 'cpe-field-error cpe-model-error cpe-model-main-error'));
    if (source) row.append(customProviderElement('div', 'cpe-model-source', this.sourceLabel(source)));
    const limits = customProviderElement('div', 'cpe-model-grid');
    limits.append(
      this.miniField('上下文窗口 (k)', 'cpe-model-context', String(model.contextWindow / CUSTOM_PROVIDER_CONTEXT_K), 'number'),
      this.miniField('最大输出 tokens', 'cpe-model-max', String(model.maxTokens), 'number'),
      this.checkboxField('推理', 'cpe-model-reasoning', model.reasoning),
      this.checkboxField('图片输入', 'cpe-model-image', model.input.includes('image')),
    );
    const advanced = customProviderElement('details', 'cpe-model-advanced');
    advanced.append(customProviderElement('summary', undefined, '费用与高级参数'));
    const advancedGrid = customProviderElement('div', 'cpe-advanced-grid');
    advancedGrid.append(
      this.miniField('输入 USD / 1M', 'cpe-cost-input', String(model.cost.input), 'number'),
      this.miniField('输出 USD / 1M', 'cpe-cost-output', String(model.cost.output), 'number'),
      this.miniField('缓存读取 USD / 1M', 'cpe-cost-cache-read', String(model.cost.cacheRead), 'number'),
      this.miniField('缓存写入 USD / 1M', 'cpe-cost-cache-write', String(model.cost.cacheWrite), 'number'),
      this.jsonField('Sampling JSON', 'cpe-model-sampling', model.samplingParams),
      this.jsonField('Compatibility JSON', 'cpe-model-compatibility', model.compatibility),
    );
    advanced.append(advancedGrid, customProviderElement('span', 'cpe-field-error cpe-model-error cpe-model-advanced-error'));
    row.append(limits, customProviderElement('span', 'cpe-field-error cpe-model-error cpe-model-capability-error'), advanced);
    rows.append(row);
  }

  private createHeaderRow(name: string, configured: boolean): HTMLElement {
    const row = customProviderElement('div', 'cpe-header-row');
    row.dataset.originalName = name;
    row.dataset.configured = String(configured);
    const nameInput = customProviderInput('', 'cpe-input cpe-header-name', name);
    nameInput.placeholder = 'Header name';
    if (configured) {
      nameInput.readOnly = true;
      nameInput.title = '如需修改名称，请删除此 Header 后新增';
      nameInput.setAttribute('aria-label', '已配置 Header 名称，只读');
    }
    const valueInput = customProviderInput('', 'cpe-input cpe-header-value', '', 'password');
    valueInput.placeholder = configured ? '留空保留已保存值' : 'Header value';
    row.append(nameInput, valueInput);
    if (configured) row.append(customProviderElement('span', 'cpe-header-status', '已保存'));
    const remove = customProviderButton('remove-header', '删除', 'cpe-icon-button');
    remove.title = '删除 Header';
    remove.setAttribute('aria-label', '删除 Header');
    row.append(remove);
    const nameError = customProviderElement('span', 'cpe-field-error cpe-header-error cpe-header-name-error');
    const valueError = customProviderElement('span', 'cpe-field-error cpe-header-error cpe-header-value-error');
    nameError.hidden = true;
    valueError.hidden = true;
    row.append(nameError, valueError);
    return row;
  }

  private fieldNameForControl(id: string): string {
    return ({ 'cpe-name': 'name', 'cpe-id': 'id', 'cpe-base-url': 'baseUrl', 'cpe-model-discovery': 'modelDiscovery', 'cpe-protocol': 'protocol' } as Record<string, string>)[id] ?? id;
  }

  private miniField(labelText: string, className: string, value: string, type: string): HTMLElement {
    const label = customProviderElement('label', 'cpe-mini-field');
    const input = customProviderInput('', `cpe-input ${className}`, value, type);
    if (type === 'number') { input.min = '0'; input.step = 'any'; }
    label.append(customProviderElement('span', undefined, labelText), input);
    return label;
  }

  private checkboxField(labelText: string, className: string, checked: boolean): HTMLElement {
    const label = customProviderElement('label', 'cpe-check-field');
    const input = customProviderElement('input');
    input.type = 'checkbox';
    input.className = className;
    input.checked = checked;
    label.append(input, customProviderElement('span', undefined, labelText));
    return label;
  }

  private jsonField(labelText: string, className: string, value: Record<string, unknown> | undefined): HTMLElement {
    const label = customProviderElement('label', 'cpe-mini-field cpe-json-field');
    const textarea = customProviderElement('textarea', `cpe-input ${className}`);
    textarea.rows = 3;
    textarea.value = value ? JSON.stringify(value, null, 2) : '';
    label.append(customProviderElement('span', undefined, labelText), textarea);
    return label;
  }

  private emptyModel(): CustomProviderElementsModel {
    return { id: '', name: '', contextWindow: 128000, maxTokens: 8192, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }

  private sourceLabel(source: NonNullable<CustomProviderDiscoveredModel['source']>): string {
    return source === 'provider' ? '能力与费用已从模型接口自动识别' : source === 'provider+catalog' ? '能力由模型接口与目录共同补全' : '能力已从模型目录自动补全';
  }
}

(window as any).CustomProviderFormElements = CustomProviderFormElements;
