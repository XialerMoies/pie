/// <reference path="../dashboard.d.ts" />

interface SettingsCustomProviderEditorDependencies {
  notify: typeof toast;
  listAddAction: typeof ListAddAction;
  formType?: SettingsCustomProviderFormViewConstructor;
  onSaved(snapshot: RedactedCustomProviderSnapshot, selectedId: string, activateSaved: boolean, currentMount: boolean): void;
  onDeleted(snapshot: RedactedCustomProviderSnapshot, currentMount: boolean): void;
}

interface CustomProviderErrorResponse {
  error?: unknown;
  code?: unknown;
  fieldPath?: unknown;
  currentRevision?: unknown;
  references?: unknown;
}

type CustomProviderEditorAction = 'save' | 'test' | 'discover' | 'delete' | 'reveal';
type CustomProviderMutationAction = 'save' | 'delete';
type CustomProviderQueryAction = Exclude<CustomProviderEditorAction, CustomProviderMutationAction>;

interface CustomProviderEditorOperation {
  action: CustomProviderEditorAction;
  controller: AbortController;
  generation: number;
  form: SettingsCustomProviderFormView;
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
          for (const nibble of byte) pattern += /[A-F]/.test(nibble) ? `[${nibble}${nibble.toLowerCase()}]` : nibble;
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

export function isCustomProviderRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCustomProviderSnapshot(value: unknown): value is RedactedCustomProviderSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as { revision?: unknown; providers?: unknown };
  return isCustomProviderRevision(snapshot.revision) && Array.isArray(snapshot.providers);
}

export class SettingsCustomProviderEditor {
  private container: HTMLElement | null = null;
  private root: HTMLElement | null = null;
  private form: SettingsCustomProviderFormView | null = null;
  private provider: RedactedCustomProvider | null = null;
  private revision = 0;
  private newProvider = false;
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
      this.startNew(container, revision, { template: 'other', occupiedProviderIds: new Set() });
      return;
    }
    this.invalidateQuery();
    this.detachMutation();
    this.container = container;
    this.provider = provider;
    this.revision = revision;
    this.newProvider = false;
    this.deleteArmed = false;
    this.render({ provider, occupiedProviderIds: new Set([provider.id]) });
  }

  startNew(
    container: HTMLElement,
    revision: number,
    options: { template: CustomProviderTemplate; occupiedProviderIds: ReadonlySet<string> },
  ): void {
    this.invalidateQuery();
    this.detachMutation();
    this.container = container;
    this.provider = null;
    this.revision = revision;
    this.newProvider = true;
    this.deleteArmed = false;
    this.render({ provider: null, ...options });
  }

  unmount(): void {
    this.invalidateQuery();
    this.detachMutation();
    this.container = null;
    this.root = null;
    this.form = null;
    this.provider = null;
    this.deleteArmed = false;
  }

  async save(): Promise<void> {
    if (this.mutationOperation) return;
    this.form?.clearFeedback();
    const draft = this.form?.read({ showErrors: true, purpose: 'save' }) ?? null;
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
        if (this.isCurrentMount(operation)) this.showResult(operation, '保存响应无效', true);
        return;
      }
      const snapshot = response.body;
      const saved = snapshot.providers.find((candidate) => (
        candidate && typeof candidate === 'object' && (candidate as RedactedCustomProvider).id === draft.id
      )) as RedactedCustomProvider | undefined;
      if (!saved) {
        if (this.isCurrentMount(operation)) this.showResult(operation, '保存响应无效', true);
        return;
      }
      const currentMount = this.isCurrentMount(operation);
      const accepted = this.consumeSnapshot(snapshot);
      if (currentMount && accepted) {
        this.provider = saved;
        this.newProvider = false;
        this.deleteArmed = false;
        this.render({ provider: saved, occupiedProviderIds: new Set([saved.id]) });
      }
      this.dependencies.onSaved(snapshot, saved.id, currentMount && operation.newProvider && accepted, currentMount);
      if (currentMount && accepted) this.dependencies.notify('已保存', 'success');
    } finally {
      this.finishMutation(operation);
    }
  }

  async test(): Promise<void> {
    if (this.mutationOperation || this.queryOperation?.action === 'test') return;
    this.form?.clearFeedback();
    const draft = this.form?.read({ showErrors: false, purpose: 'test' }) ?? null;
    if (!draft) return;
    const operation = this.beginQuery('test', draft);
    if (!operation) return;
    try {
      const response = await this.request(operation, '/api/custom-providers/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: draft }),
      });
      if (!this.isCurrentQuery(operation) || response.aborted) return;
      const body = response.body as Record<string, unknown>;
      if (!response.ok || body.ok === false) {
        const code = typeof body.code === 'string' ? body.code : 'failed';
        const message = typeof body.message === 'string'
          ? body.message
          : typeof body.error === 'string' ? body.error : '连接测试失败';
        this.showResult(operation, `${code}: ${message}`, true);
        return;
      }
      const modelId = typeof body.modelId === 'string' ? body.modelId : '';
      const latency = typeof body.latencyMs === 'number' ? ` · ${body.latencyMs} ms` : '';
      this.showResult(operation, `连接成功${modelId ? ` · ${modelId}` : ''}${latency}`, false);
    } finally {
      this.finishQuery(operation);
    }
  }

  async discoverModels(): Promise<void> {
    if (this.mutationOperation || this.queryOperation?.action === 'discover') return;
    this.form?.clearFeedback();
    const draft = this.form?.read({ showErrors: false, purpose: 'discover' }) ?? null;
    if (!draft) return;
    const operation = this.beginQuery('discover', draft);
    if (!operation) return;
    try {
      const response = await this.request(operation, '/api/custom-providers/discover-models', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: draft }),
      });
      if (!this.isCurrentQuery(operation) || response.aborted) return;
      if (!response.ok) {
        this.showResult(operation, this.errorText(response.body, '模型发现失败', operation.secrets), true);
        return;
      }
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const value of safeArray((response.body as { ids?: unknown }).ids)) {
        if (typeof value !== 'string') continue;
        const id = value.trim();
        if (!id || seen.has(id) || this.redact(id, operation.secrets) !== id) continue;
        seen.add(id);
        ids.push(id);
      }
      const existing = new Set(
        [...operation.root.querySelectorAll<HTMLInputElement>('.cpe-model-id')].map(input => input.value.trim()),
      );
      const imported = ids.filter(id => !existing.has(id));
      if (imported.length === 0) {
        this.showResult(operation, '未发现新的模型 ID', false);
        return;
      }
      if (!window.confirm(`导入 ${imported.length} 个模型 ID？\n${imported.join('\n')}`)) {
        if (this.isCurrentQuery(operation)) this.showResult(operation, '已取消导入', false);
        return;
      }
      if (!this.isCurrentQuery(operation)) return;
      if (typeof operation.draft?.modelDiscovery === 'string') {
        operation.form.setModelDiscovery(operation.draft.modelDiscovery);
      }
      operation.form.appendDiscoveredModels(imported);
      this.showResult(operation, `已导入 ${imported.length} 个模型 ID，保存后生效`, false);
    } finally {
      this.finishQuery(operation);
    }
  }

  async delete(): Promise<void> {
    if (!this.provider || this.newProvider || this.mutationOperation) return;
    if (!this.deleteArmed) {
      this.deleteArmed = true;
      this.form?.setDeleteArmed(true);
      return;
    }
    this.form?.clearFeedback();
    const operation = this.beginMutation('delete', null);
    if (!operation) return;
    try {
      if (!operation.providerId) return;
      const response = await this.request(operation, `/api/custom-providers/${encodeURIComponent(operation.providerId)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: operation.revision }),
      });
      if (response.aborted) return;
      if (!response.ok) {
        if (this.isCurrentMount(operation)) await this.handleMutationError(operation, response.body);
        return;
      }
      if (!isCustomProviderSnapshot(response.body)) {
        if (this.isCurrentMount(operation)) this.showResult(operation, '删除响应无效', true);
        return;
      }
      const snapshot = response.body;
      const currentMount = this.isCurrentMount(operation);
      const accepted = this.consumeSnapshot(snapshot);
      this.dependencies.onDeleted(snapshot, currentMount);
      if (currentMount && accepted) this.dependencies.notify('已删除', 'success');
    } finally {
      this.finishMutation(operation);
    }
  }

  private render(options: Omit<CustomProviderFormOptions, 'protocols'>): void {
    if (!this.container) return;
    const FormType = this.dependencies.formType
      ?? (window as any).CustomProviderFormView as SettingsCustomProviderFormViewConstructor;
    const form = new FormType({ ...options, protocols: this.protocols }, this.dependencies.listAddAction);
    const root = form.mount(this.container, this.revision);
    this.form = form;
    this.root = root;
    root.addEventListener('click', event => this.handleClick(event));
    if (this.mutationOperation) form.setMutationBusy(this.mutationOperation.action as CustomProviderMutationAction, true);
  }

  private handleClick(event: MouseEvent): void {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-cpe-action]')?.dataset.cpeAction;
    if (action === 'save') void this.save();
    else if (action === 'test') void this.test();
    else if (action === 'discover') void this.discoverModels();
    else if (action === 'delete') void this.delete();
    else if (action === 'reveal-api-key' && !this.form?.toggleApiKeyVisibility()) void this.revealApiKey();
  }

  private invalidateQuery(): void {
    this.generation += 1;
    const operation = this.queryOperation;
    if (!operation) return;
    operation.controller.abort();
    operation.form.setQueryBusy(operation.action as CustomProviderQueryAction, false);
    this.queryOperation = null;
  }

  private createOperation(action: CustomProviderEditorAction, draft: CustomProviderDraft | null): CustomProviderEditorOperation | null {
    if (!this.root || !this.form) return null;
    return {
      action,
      controller: new AbortController(),
      generation: this.generation,
      form: this.form,
      root: this.root,
      providerId: this.provider?.id ?? null,
      revision: this.revision,
      newProvider: this.newProvider,
      draft,
      secrets: this.form.captureSecrets(),
    };
  }

  private beginQuery(action: CustomProviderQueryAction, draft: CustomProviderDraft | null): CustomProviderEditorOperation | null {
    if (this.mutationOperation) return null;
    if (this.queryOperation) {
      this.queryOperation.controller.abort();
      this.queryOperation.form.setQueryBusy(this.queryOperation.action as CustomProviderQueryAction, false);
      this.queryOperation = null;
    }
    const operation = this.createOperation(action, draft);
    if (!operation) return null;
    this.queryOperation = operation;
    operation.form.setQueryBusy(action, true);
    return operation;
  }

  private beginMutation(action: CustomProviderMutationAction, draft: CustomProviderDraft | null): CustomProviderEditorOperation | null {
    if (this.mutationOperation) return null;
    if (this.queryOperation) {
      this.queryOperation.controller.abort();
      this.queryOperation.form.setQueryBusy(this.queryOperation.action as CustomProviderQueryAction, false);
      this.queryOperation = null;
    }
    const operation = this.createOperation(action, draft);
    if (!operation) return null;
    this.mutationOperation = operation;
    operation.form.setMutationBusy(action, true);
    return operation;
  }

  private isCurrentMount(operation: CustomProviderEditorOperation): boolean {
    return operation.generation === this.generation
      && operation.form === this.form
      && operation.root === this.root
      && Boolean(this.container?.contains(operation.root));
  }

  private isCurrentQuery(operation: CustomProviderEditorOperation): boolean {
    return this.queryOperation === operation && this.isCurrentMount(operation);
  }

  private finishQuery(operation: CustomProviderEditorOperation): void {
    if (this.queryOperation !== operation) return;
    operation.form.setQueryBusy(operation.action as CustomProviderQueryAction, false);
    this.queryOperation = null;
  }

  private finishMutation(operation: CustomProviderEditorOperation): void {
    if (this.mutationOperation !== operation) return;
    operation.form.setMutationBusy(operation.action as CustomProviderMutationAction, false);
    if (this.form !== operation.form) this.form?.setMutationBusy(operation.action as CustomProviderMutationAction, false);
    this.mutationOperation = null;
  }

  private detachMutation(): void {
    const operation = this.mutationOperation;
    if (!operation) return;
    operation.form.setMutationBusy(operation.action as CustomProviderMutationAction, false);
    this.mutationOperation = null;
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

  private async revealApiKey(): Promise<void> {
    if (!this.provider?.apiKeyConfigured || this.mutationOperation || this.queryOperation?.action === 'reveal') return;
    this.form?.clearFeedback();
    const operation = this.beginQuery('reveal', null);
    if (!operation) return;
    try {
      if (!operation.providerId) return;
      const response = await this.request(operation, '/api/custom-providers/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: operation.providerId }),
      });
      if (!this.isCurrentQuery(operation) || response.aborted) return;
      if (!response.ok) {
        this.showResult(operation, this.errorText(response.body, 'API Key 显示失败', operation.secrets), true);
        return;
      }
      const apiKey = response.body && typeof response.body === 'object'
        ? (response.body as { apiKey?: unknown }).apiKey
        : undefined;
      if (typeof apiKey !== 'string') {
        this.showResult(operation, 'API Key 显示响应无效', true);
        return;
      }
      operation.form.setApiKey(apiKey);
    } finally {
      this.finishQuery(operation);
    }
  }

  private async request(operation: CustomProviderEditorOperation, url: string, init: RequestInit): Promise<CustomProviderRequestResult> {
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
      this.finishMutation(operation);
      operation.form.setFieldError(
        'id',
        body.code === 'provider_id_conflict' ? 'Provider ID 已被占用' : 'Provider ID 创建后不可修改',
      );
      return;
    }
    if (body.code === 'revision_conflict') {
      let latestRevision = this.revision;
      if (isCustomProviderRevision(body.currentRevision)) latestRevision = Math.max(latestRevision, body.currentRevision);
      const latest = await this.request(operation, '/api/custom-providers', { method: 'GET' });
      if (!this.isCurrentMount(operation) || latest.aborted) return;
      if (latest.ok && latest.body && typeof latest.body === 'object') {
        const received = (latest.body as { revision?: unknown }).revision;
        if (isCustomProviderRevision(received)) latestRevision = Math.max(latestRevision, received);
      }
      this.revision = latestRevision;
      operation.form.showConflict(latestRevision);
      return;
    }
    if (body.code === 'provider_in_use') {
      this.showReferences(operation, body.references);
      return;
    }
    if (body.code === 'invalid_request' && typeof body.fieldPath === 'string') {
      this.finishMutation(operation);
      operation.form.setFieldError(body.fieldPath.replace(/^provider\./, ''), '字段值无效');
      return;
    }
    this.showResult(operation, this.errorText(body, '保存失败', operation.secrets), true);
  }

  private showReferences(operation: CustomProviderEditorOperation, value: unknown): void {
    const references: string[] = [];
    for (const entry of safeArray(value)) {
      if (!entry || typeof entry !== 'object') continue;
      const reference = entry as Record<string, unknown>;
      const model = typeof reference.modelId === 'string' ? this.redact(reference.modelId, operation.secrets) : '未知模型';
      const source = reference.kind === 'currentModel'
        ? '当前模型'
        : reference.kind === 'defaultModel'
          ? '默认模型'
          : typeof reference.agentName === 'string' ? this.redact(reference.agentName, operation.secrets) : '自定义 Agent';
      references.push(`${source}: ${model}`);
    }
    operation.form.showReferences(references);
  }

  private showResult(operation: CustomProviderEditorOperation, message: string, error: boolean): void {
    operation.form.showResult(this.redact(message, operation.secrets), error);
  }

  private errorText(value: unknown, fallback: string, secrets?: readonly string[]): string {
    if (!value || typeof value !== 'object') return fallback;
    const body = value as Record<string, unknown>;
    const message = typeof body.error === 'string' ? body.error : fallback;
    const code = typeof body.code === 'string' ? `${body.code}: ` : '';
    return this.redact(code + message, secrets);
  }

  private redact(message: string, capturedSecrets?: readonly string[]): string {
    const secrets = capturedSecrets ?? this.form?.captureSecrets() ?? [];
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
settingsCustomProviderEditorApp.isCustomProviderRevision = isCustomProviderRevision;
