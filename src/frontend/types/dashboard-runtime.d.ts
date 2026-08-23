interface AppUiComponents {
  ListAddAction: {
    create(options: ListAddActionOptions): HTMLButtonElement;
  };
}
interface AppChat {
  msgs(): string;
  appendDelta(text: string): void;
  updateLastBlock(block: Record<string, unknown>): boolean;
  updateSubagentEvent(event: FrontendSubagentEvent): boolean;
  finalizeLastMessage(): boolean;
  bind(): void;
  updateUI(): void;
  updateModelName(): void;
  showModelPicker(e: MouseEvent): void;
  mountThinkingControl(root: HTMLElement): void;
  syncThinkingLevel(): Promise<void>;
  refreshModeButton(): void;
  addAttachment(att: Omit<ChatAttachment, 'id'>): void;
  removeAttachment(id: string): void;
  clearAttachments(): void;
  getPendingAttachments(): ChatAttachment[];
  showDropZone(show: boolean): void;
  buildInstruction(message: string): string;
  retryLastTurn(): void;
  copyLastError(): Promise<void>;
  refreshWorkspaceState(): void;
  scheduleMessagesRender(scroll?: boolean): void;
  resetMsgKeys(): void;
  scrollToLatest(options?: { force?: boolean; smooth?: boolean }): boolean;
  refreshReadingSettings(): void;
  resizeComposerInput(input: HTMLTextAreaElement): void;
  isBusy(): boolean;
  reconnect?(): void;
}
interface AppChatState {
  getMessages(): Message[];
  replaceMessages(messages: Message[]): void;
  appendMessage(message: Message): void;
  clearMessages(): void;
  isBusy(): boolean;
  setBusy(busy: boolean): void;
  getDashboard(): DashboardData | null;
  setDashboard(data: DashboardData | null): void;
  reset(): void;
}
interface AppChatTimeline {
  bind(): void;
  sync(): void;
  refreshSettings(): void;
  handleMessagesScroll(): void;
  reset(): void;
}
interface ChatStreamHandlers {
  onMessage?: (event: MessageEvent) => void;
  onError?: (event: Event) => void;
  onOpen?: (event: Event) => void;
}
interface AppChatStream {
  open(handlers?: ChatStreamHandlers, options?: { freshTurn?: boolean }): number;
  waitUntilOpen(generation: number, timeoutMs?: number): Promise<boolean>;
  setHandlers(generation: number, handlers: ChatStreamHandlers): boolean;
  close(): void;
  isCurrent(generation: number): boolean;
  isOpen(): boolean;
}
type AppEventType = 'dashboard.changed' | 'usage.changed' | 'mcp.changed' | 'explorer.changed' | 'permission.confirm';
interface AppEvent<T = unknown> {
  type: AppEventType | 'resync';
  revision: number;
  payload?: T;
}
type AppEventHandler = (event: AppEvent) => void;
interface AppEvents {
  start(): Promise<void>;
  stop(): void;
  subscribe(type: AppEventType | 'resync', handler: AppEventHandler): () => void;
  resync(): void;
}
interface AppFile {
  toggleFileMenu(ev: MouseEvent, trigger?: HTMLElement): void;
  closeFM(): void;
  fileAction(action: string): void;
  launchCli(): void;
  openSearchResult(filePath: string, line?: number): Promise<void>;
}
interface AppSession {
  loadSessions(): Promise<void>;
  bumpSessionListSeq(): number;
  isCurrentSessionListSeq(seq: number): boolean;
  newSession(): void;
  renameSession(el: HTMLElement, id: string): void;
  deleteSession(id: string): Promise<void>;
  pinSession(id: string, pinned: boolean): void;
  branchSession(id: string): void;
  toggleOtherSessions(header: HTMLElement): void;
  commitSessionTab(oldId: string, newId: string): void;
  maybeAutoTitleSession(id: string, assistantText?: string): Promise<string | null>;
  getTabLabel(id: string): string;
  getActiveSessionTabId(): string | null;
  setActiveSessionTabId(id: string | null): void;
  ensureDraftSessionTab(): string;
  whenReady(): Promise<void>;
  renderSessionTabs(activeId?: string): void;
  restoreSessionTabs(): Promise<void>;
  saveUiState(): void;
  migrateSessionTabLabels(): void;
}
interface SessionListPanelCallbacks {
  isConversationSearchActive(): boolean;
  getActiveSessionTabId(): string | null;
  getOpenSessionIds(): Set<string>;
  indexSessionTabs(sessions: SessionInfo[], others: { project?: string; path?: string; sessions: SessionInfo[] }[]): void;
  renderSessionTabs(activeId?: string): void;
  setupListHandler(): void;
}
interface AppSessionListPanel {
  fetchIndex(): Promise<void>;
  load(): Promise<void>;
  render(): void;
  invalidate(): void;
  getSession(id: string): SessionInfo | undefined;
}
interface AppSessionViews {
  createSessionListPanel(callbacks: SessionListPanelCallbacks): AppSessionListPanel;
}
interface SessionRestoreOptions {
  onActiveSession(sessionId: string): Promise<void> | void;
  prefetchSessionIndex(): Promise<void> | void;
}
interface AppSessionTabs {
  isDraftSessionId(id: string | null | undefined): boolean;
  readSessionTabIds(): string[];
  writeSessionTabIds(ids: string[]): void;
  setActiveSessionTabId(id: string | null): void;
  renderSessionTabs(activeId?: string): void;
  saveUiState(): void;
}
interface AppSessionRestore {
  init(options: SessionRestoreOptions): void;
  restoreSessionTabs(): Promise<void>;
  whenReady(): Promise<void>;
  markUserInteraction(): void;
  hasUserInteracted(): boolean;
}
interface SessionActivationCallbacks {
  rememberSessionTab(id: string, workspace?: string): void;
  loadSessions(): Promise<void> | void;
  setupDraftSession(id: string): void;
}
interface AppSessionActivation {
  init(options: SessionActivationCallbacks): void;
  activate(tab: AppTab, options?: SessionActivationOptions): Promise<void>;
  activateById(id: string, options?: SessionActivationOptions): Promise<void>;
  switchSession(id: string, options?: SessionActivationOptions): void;
  onceActivated(cb: SessionActivatedCallback): CancelSessionActivationSubscription;
  onceActivated(sessionId: string, cb: SessionActivatedCallback): CancelSessionActivationSubscription;
  emitActivated(sessionId: string): void;
  invalidate(): void;
}
interface AppPermissions {
  mount(container: HTMLElement): void;
  refresh(forceToast?: boolean): Promise<void>;
  unmount(): void;
  getMode(): 'plan' | 'standard' | 'dontAsk' | 'yes';
  setMode(mode: 'plan' | 'standard' | 'dontAsk' | 'yes'): void;
  refreshMode(): Promise<'plan' | 'standard' | 'dontAsk' | 'yes'>;
}
interface PermissionPanelViewState {
  tab: 'audit' | 'rules';
  mode: PermissionMode;
  audit: PermissionAuditEntry[];
  rules: PermissionRulesSnapshot | null;
}
interface AppPermissionViews {
  renderPanel(state: PermissionPanelViewState): string;
  renderContent(state: PermissionPanelViewState): string;
  renderError(message: string): string;
  scopeLabel(scope: PermissionRuleScope): string;
}
interface AppSettings {
  openSettingsModal(): void;
  closeSettingsModal(): void;
  switchSettingsModal(tab: string): void;
  changeFontSize(delta: number): void;
  applyGeneralSetting(key: string, val: boolean): void;
  toggleAutoSaveSetting(): void;
  setSearchType(type: 'filename' | 'text'): void;
  toggleCaseSensitive(): void;
}
interface SettingsGeneralApi {
  renderGeneralTab(container: HTMLElement): void;
  renderSubagentLimits(container: HTMLElement): void;
  toggleAutoSave(): void;
  changeFontSize(delta: number): void;
  applyGeneral(): void;
  applyReading(target: HTMLElement): void;
  applySubagent(target: HTMLInputElement): void;
  changeSubagent(inputId: string, delta: number): void;
}
interface SettingsProviderModelApi {
  customEditor: SettingsCustomProviderEditor;
  renderTab(container: HTMLElement): void;
  unmount(): void;
}
interface SettingsCustomSubagentApi {
  mount(container: HTMLElement): void;
  startNew(): void;
  select(id: string): void;
  save(): Promise<void>;
  delete(id: string): Promise<void>;
}
interface SettingsStorageApi {
  mount(container: HTMLElement): void;
  previewMigration(root?: ParentNode): Promise<void>;
  confirmMigration(): Promise<void>;
  chooseDataRoot(): Promise<void>;
}
interface SkillSettingsSummary {
  id: string;
  name: string;
  description: string;
  source: 'user' | 'workspace';
  path: string;
  trust: 'trusted' | 'untrusted';
  enabled: boolean;
  parse: 'valid' | 'invalid';
  declaredTools: string[];
  diagnostic?: { code: string; message: string };
}
interface SettingsSkillsApi {
  mount(container: HTMLElement): void;
  unmount(): void;
}
interface AppSettingsComponents {
  general: SettingsGeneralApi;
  providers: SettingsProviderModelApi;
  subagents: SettingsCustomSubagentApi;
  storage: SettingsStorageApi;
  skills: SettingsSkillsApi;
}
// ─── TabBehavior / TabStoreAPI ──────────────────────
/** Options 透传至 _applySessionMessages，控制会话激活后的副作用 */
interface SessionActivationOptions {
  workspace?: string;
  scroll?: 'bottom' | 'none';
  refreshSessions?: boolean;
  silent?: boolean;
  skipTabState?: boolean;
}

interface TabBehavior {
  activate(tab: AppTab, options?: SessionActivationOptions): void;
  close(tab: AppTab): void;
  contextMenu?(e: MouseEvent, tab: AppTab): void;
}

interface TabStoreAPI {
  getState(): TabsState;
  getTabs(): AppTab[];
  getActiveTab(): AppTab | null;
  getTab(id: string): AppTab | undefined;
  restoreTabs(items: AppTab[], activeId: string | null): void;
  openTab(tab: Omit<AppTab, 'order'>): AppTab;
  activateTab(id: string | null): void;
  closeTab(id: string): AppTab | undefined;
  replaceTab(id: string, updates: Partial<AppTab>): AppTab | undefined;
  moveTab(from: number, to: number): void;
  getSessionTabIds(): string[];
  getFileTabIds(): string[];
  getActiveSessionTabId(): string | null;
  getActiveFileTabId(): string | null;
  reset(): void;
  registerTabBehavior(kind: TabKind, behavior: TabBehavior): void;
  getTabBehavior(kind: TabKind): TabBehavior | undefined;
}

interface AppTabs extends TabStoreAPI {
  _attachStore(store: TabStoreAPI): void;
  clearActiveTab(): void;
  activate(id: string, options?: SessionActivationOptions): void;
  close(id: string): void;
  contextMenu(e: MouseEvent, id: string): void;
}
