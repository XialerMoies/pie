type CustomProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'mistral-conversations'
  | 'azure-openai-responses'
  | 'pi-messages';
type CustomProviderAuthMode = 'none' | 'apiKey';
type CustomProviderTemplate = 'openai' | 'anthropic' | 'other';
interface CustomProviderModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: Array<'text' | 'image'>;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  samplingParams?: Record<string, unknown>;
  compatibility?: Record<string, unknown>;
}
interface CustomProviderDiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
  cost?: Partial<CustomProviderModel['cost']>;
  source?: 'provider' | 'catalog' | 'provider+catalog';
}
interface RedactedCustomProvider {
  id: string;
  name: string;
  protocol: CustomProviderProtocol;
  baseUrl: string;
  authMode: CustomProviderAuthMode;
  apiKeyConfigured: boolean;
  headers: Array<{ name: string; configured: boolean }>;
  modelDiscovery?: string;
  models: CustomProviderModel[];
}
interface CustomProviderDraft extends Omit<RedactedCustomProvider, 'apiKeyConfigured' | 'headers'> {
  apiKey?: string | null;
  headers: Array<{ name: string; value?: string; remove?: boolean }>;
}
interface CustomProviderFormOptions {
  provider: RedactedCustomProvider | null;
  template?: CustomProviderTemplate;
  protocols: readonly CustomProviderProtocol[];
  occupiedProviderIds: ReadonlySet<string>;
}
interface CustomProviderFormReadOptions {
  showErrors: boolean;
  purpose: 'save' | 'test' | 'discover';
}
declare class CustomProviderFormReader {
  constructor(
    root: HTMLElement,
    options: CustomProviderFormOptions,
    apiKeyCleared: boolean,
    setFieldError: (field: string, message: string, focus?: boolean) => void,
  );
  read(options: CustomProviderFormReadOptions): CustomProviderDraft | null;
}
declare class CustomProviderFormElements {
  constructor(options: CustomProviderFormOptions, listAddAction: typeof ListAddAction, metadataChanged: () => void);
  field(labelText: string, control: HTMLElement, errorField?: string): HTMLElement;
  protocolField(selected: string): HTMLElement;
  authField(provider: RedactedCustomProvider | null): HTMLElement;
  apiKeyField(provider: RedactedCustomProvider | null): HTMLElement;
  headersField(headers: RedactedCustomProvider['headers']): HTMLElement;
  modelsField(rows: HTMLElement): HTMLElement;
  appendModelRow(rows: HTMLElement, model: CustomProviderDraft['models'][number], source?: CustomProviderDiscoveredModel['source']): void;
}
interface SettingsCustomProviderFormView {
  mount(container: HTMLElement, revision: number): HTMLElement;
  read(options: CustomProviderFormReadOptions): CustomProviderDraft | null;
  getRoot(): HTMLElement | null;
  captureSecrets(): string[];
  appendDiscoveredModels(models: readonly CustomProviderDiscoveredModel[]): void;
  setApiKey(value: string): void;
  setModelDiscovery(value: string): void;
  toggleApiKeyVisibility(): boolean;
  setDeleteArmed(armed: boolean): void;
  setQueryBusy(action: 'test' | 'discover' | 'reveal', busy: boolean): void;
  setMutationBusy(action: 'save' | 'delete', busy: boolean): void;
  clearFeedback(): void;
  setFieldError(field: string, message: string, focus?: boolean): void;
  showResult(message: string, error: boolean): void;
  showConflict(revision: number): void;
  showReferences(references: readonly string[]): void;
}
interface SettingsCustomProviderFormViewConstructor {
  new(options: CustomProviderFormOptions, listAddAction: typeof ListAddAction): SettingsCustomProviderFormView;
}
interface RedactedCustomProviderSnapshot {
  schemaVersion: 1;
  revision: number;
  providers: RedactedCustomProvider[];
}
interface CustomProviderListResponse {
  revision: number;
  official: Array<{ id: string; name: string; configured: boolean }>;
  custom: RedactedCustomProvider[];
}
interface CustomProviderCapabilitiesResponse {
  protocols: Array<{
    id: string;
    authModes: CustomProviderAuthMode[];
    supportsCompatibility: boolean;
  }>;
  price: { currency: 'USD'; unit: 'millionTokens' };
}
interface SettingsCustomProviderEditorDependencies {
  notify: typeof toast;
  listAddAction: typeof ListAddAction;
  formType?: SettingsCustomProviderFormViewConstructor;
  onSaved(
    snapshot: RedactedCustomProviderSnapshot,
    selectedId: string,
    activateSaved: boolean,
    currentMount: boolean,
  ): void;
  onDeleted(snapshot: RedactedCustomProviderSnapshot, currentMount: boolean): void;
}
interface SettingsCustomProviderEditor {
  setProtocols(protocols: readonly CustomProviderProtocol[]): void;
  mount(container: HTMLElement, provider: RedactedCustomProvider | null, revision: number): void;
  startNew(
    container: HTMLElement,
    revision: number,
    options: { template: CustomProviderTemplate; occupiedProviderIds: ReadonlySet<string> },
  ): void;
  unmount(): void;
  save(): Promise<void>;
  test(): Promise<void>;
  discoverModels(): Promise<void>;
  delete(): Promise<void>;
}
interface SettingsCustomProviderEditorConstructor {
  new(dependencies: SettingsCustomProviderEditorDependencies): SettingsCustomProviderEditor;
}
interface ListAddActionOptions {
  id?: string;
  label: string;
  disabled?: boolean;
  onActivate: () => void;
}
declare const ListAddAction: {
  create(options: ListAddActionOptions): HTMLButtonElement;
};
