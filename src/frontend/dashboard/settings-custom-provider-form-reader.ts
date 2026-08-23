/// <reference path="../dashboard.d.ts" />

type CustomProviderFormModel = CustomProviderDraft['models'][number];

const CUSTOM_PROVIDER_FORM_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CUSTOM_PROVIDER_FORM_FORBIDDEN_HEADERS = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailer', 'upgrade',
]);
const CUSTOM_PROVIDER_FORM_ADVANCED_JSON_MAX_BYTES = 16 * 1024;
const CUSTOM_PROVIDER_FORM_READER_TOKENS_PER_CONTEXT_K = 1000;
const CUSTOM_PROVIDER_FORM_MODEL_DISCOVERY_SENTINEL: CustomProviderFormModel = {
  id: '__model_discovery__',
  name: 'Model discovery placeholder',
  contextWindow: 1,
  maxTokens: 1,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function customProviderContextWindowTokenValue(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * CUSTOM_PROVIDER_FORM_READER_TOKENS_PER_CONTEXT_K) : Number.NaN;
}

function isEmptyCustomProviderModelPlaceholder(modelRow: HTMLElement): boolean {
  return !modelRow.querySelector<HTMLInputElement>('.cpe-model-id')?.value.trim()
    && !modelRow.querySelector<HTMLInputElement>('.cpe-model-name')?.value.trim()
    && customProviderContextWindowTokenValue(modelRow.querySelector<HTMLInputElement>('.cpe-model-context')?.value ?? '') === 128000
    && Number(modelRow.querySelector<HTMLInputElement>('.cpe-model-max')?.value ?? '') === 8192;
}

function isFiniteCustomProviderJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isFiniteCustomProviderJsonValue);
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value as Record<string, unknown>).every(isFiniteCustomProviderJsonValue);
}

function readCustomProviderJsonObject(input: HTMLTextAreaElement | null, field: string): Record<string, unknown> | undefined {
  const value = input?.value.trim() ?? '';
  if (!value) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${field} 必须是 JSON 对象`);
  if (!isFiniteCustomProviderJsonValue(parsed)) throw new Error(`${field} 必须只包含有限 JSON 值`);
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > CUSTOM_PROVIDER_FORM_ADVANCED_JSON_MAX_BYTES) {
    throw new Error(`${field} 不能超过 16 KiB`);
  }
  return parsed as Record<string, unknown>;
}

export class CustomProviderFormReader {
  constructor(
    private readonly root: HTMLElement,
    private readonly options: CustomProviderFormOptions,
    private readonly apiKeyCleared: boolean,
    private readonly setFieldError: (field: string, message: string, focus?: boolean) => void,
  ) {}

  read(options: CustomProviderFormReadOptions): CustomProviderDraft | null {
    const showErrors = options.showErrors;
    const value = (selector: string) => this.root.querySelector<HTMLInputElement>(selector)?.value.trim() ?? '';
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
    if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('id', 'Provider ID 只能使用小写字母、数字和连字符');
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
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.origin !== base.origin) throw new Error();
      } catch {
        fail('modelDiscovery', '请输入同源 HTTP(S) URL 或安全相对路径');
      }
    }
    if (!valid) return null;

    const headers: CustomProviderDraft['headers'] = [];
    const headerNames = new Set<string>();
    const headerRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-header-row')];
    const headerFieldIndexes = this.headerFieldIndexes(headerRows);
    for (let index = 0; index < headerRows.length; index += 1) {
      const row = headerRows[index];
      const originalName = row.dataset.originalName ?? '';
      if (row.dataset.removed === 'true') {
        if (originalName) headers.push({ name: originalName, remove: true });
        continue;
      }
      const configured = row.dataset.configured === 'true';
      const headerName = configured ? originalName : row.querySelector<HTMLInputElement>('.cpe-header-name')?.value.trim() ?? '';
      const normalizedName = headerName.toLowerCase();
      const fieldIndex = headerFieldIndexes.get(row) ?? index;
      let message = '';
      if (!headerName) message = '请输入 Header name';
      else if (!CUSTOM_PROVIDER_FORM_HEADER_NAME_PATTERN.test(headerName) || CUSTOM_PROVIDER_FORM_FORBIDDEN_HEADERS.has(normalizedName)) message = 'Header name 无效';
      else if (headerNames.has(normalizedName)) message = 'Header name 重复';
      if (message) fail(`headers[${fieldIndex}].name`, message);
      else headerNames.add(normalizedName);
      const headerValue = row.querySelector<HTMLInputElement>('.cpe-header-value')?.value ?? '';
      const hasHeaderValue = headerValue.trim().length > 0;
      if (!configured && !hasHeaderValue) fail(`headers[${fieldIndex}].value`, '请输入 Header value');
      if (!message && (configured || hasHeaderValue)) headers.push({ name: headerName, ...(hasHeaderValue ? { value: headerValue } : {}) });
    }
    if (!valid) return null;
    const activeHeaderNames = new Set(headers.filter(header => header.remove !== true).map(header => header.name.toLowerCase()));
    const finalHeaders = headers.filter(header => header.remove !== true || !activeHeaderNames.has(header.name.toLowerCase()));

    const modelRows = [...this.root.querySelectorAll<HTMLElement>('.cpe-model-row')];
    const hasEmptyModelPlaceholder = modelRows.length === 1 && isEmptyCustomProviderModelPlaceholder(modelRows[0]);
    if (modelRows.length === 0 || ((options.purpose === 'test' || options.purpose === 'discover') && hasEmptyModelPlaceholder)) {
      if (options.purpose === 'test' || options.purpose === 'discover') {
        const apiKeyValue = value('#cpe-api-key');
        return {
          id, name, protocol: protocol as CustomProviderDraft['protocol'], baseUrl,
          authMode: authMode as CustomProviderDraft['authMode'],
          ...(authMode === 'apiKey' && apiKeyValue ? { apiKey: apiKeyValue } : {}),
          headers: finalHeaders,
          models: [CUSTOM_PROVIDER_FORM_MODEL_DISCOVERY_SENTINEL],
          ...(modelDiscovery ? { modelDiscovery } : {}),
        };
      }
      if (showErrors) this.setFieldError('models', '至少添加一个模型', false);
      return null;
    }

    const modelIds = new Set<string>();
    const modelNames = new Set<string>();
    const models: CustomProviderFormModel[] = [];
    for (let index = 0; index < modelRows.length; index += 1) {
      const modelRow = modelRows[index];
      const field = (fieldName: string) => `models[${index}].${fieldName}`;
      const modelId = modelRow.querySelector<HTMLInputElement>('.cpe-model-id')?.value.trim() ?? '';
      const modelName = modelRow.querySelector<HTMLInputElement>('.cpe-model-name')?.value.trim() ?? '';
      const contextWindow = customProviderContextWindowTokenValue(modelRow.querySelector<HTMLInputElement>('.cpe-model-context')?.value ?? '');
      const maxTokens = Number(modelRow.querySelector<HTMLInputElement>('.cpe-model-max')?.value ?? '');
      if (!modelId) fail(field('id'), '请输入 Model ID');
      else if (modelIds.has(modelId)) fail(field('id'), 'Model ID 重复');
      else modelIds.add(modelId);
      const normalizedName = modelName.toLowerCase();
      if (!modelName) fail(field('name'), '请输入模型名称');
      else if (modelNames.has(normalizedName)) fail(field('name'), '模型名称重复');
      else modelNames.add(normalizedName);
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) fail(field('contextWindow'), '上下文窗口必须是正整数');
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) fail(field('maxTokens'), '最大输出 tokens 必须是正整数');
      else if (Number.isInteger(contextWindow) && contextWindow > 0 && maxTokens > contextWindow) fail(field('maxTokens'), '最大输出 tokens 不能超过上下文窗口');
      const costFields = [['input', '.cpe-cost-input'], ['output', '.cpe-cost-output'], ['cacheRead', '.cpe-cost-cache-read'], ['cacheWrite', '.cpe-cost-cache-write']] as const;
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const [costField, selector] of costFields) {
        const amount = Number(modelRow.querySelector<HTMLInputElement>(selector)?.value ?? '');
        if (!Number.isFinite(amount) || amount < 0) fail(field(`cost.${costField}`), '费用必须是非负数');
        else cost[costField] = amount;
      }
      let samplingParams: Record<string, unknown> | undefined;
      let compatibility: Record<string, unknown> | undefined;
      for (const [advancedField, selector, label] of [['samplingParams', '.cpe-model-sampling', 'Sampling JSON'], ['compatibility', '.cpe-model-compatibility', 'Compatibility JSON']] as const) {
        try {
          const parsed = readCustomProviderJsonObject(modelRow.querySelector(selector), label);
          if (advancedField === 'samplingParams') samplingParams = parsed;
          else compatibility = parsed;
        } catch (error) {
          fail(field(advancedField), error instanceof Error ? error.message : `${label} 必须是 JSON 对象`);
        }
      }
      models.push({
        id: modelId, name: modelName, contextWindow, maxTokens,
        reasoning: modelRow.querySelector<HTMLInputElement>('.cpe-model-reasoning')?.checked ?? false,
        input: modelRow.querySelector<HTMLInputElement>('.cpe-model-image')?.checked ? ['text', 'image'] : ['text'],
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
      id, name, protocol: protocol as CustomProviderDraft['protocol'], baseUrl,
      authMode: authMode as CustomProviderDraft['authMode'],
      ...(this.apiKeyCleared ? { apiKey: null } : authMode === 'apiKey' && apiKeyValue ? { apiKey: apiKeyValue } : {}),
      headers: finalHeaders,
      models,
      ...(modelDiscovery ? { modelDiscovery } : {}),
    };
  }

  private headerFieldIndexes(rows: readonly HTMLElement[]): Map<HTMLElement, number> {
    const activeNames = new Set<string>();
    for (const row of rows) {
      if (row.dataset.removed === 'true') continue;
      const name = row.dataset.configured === 'true' ? row.dataset.originalName ?? '' : row.querySelector<HTMLInputElement>('.cpe-header-name')?.value.trim() ?? '';
      if (name) activeNames.add(name.toLowerCase());
    }
    const indexes = new Map<HTMLElement, number>();
    let fieldIndex = 0;
    for (const row of rows) {
      const originalName = row.dataset.originalName ?? '';
      if (row.dataset.removed === 'true' && (!originalName || activeNames.has(originalName.toLowerCase()))) continue;
      indexes.set(row, fieldIndex++);
    }
    return indexes;
  }
}

(window as any).CustomProviderFormReader = CustomProviderFormReader;
