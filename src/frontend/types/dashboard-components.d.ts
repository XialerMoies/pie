interface AppGit {
  refreshGit(): Promise<void>;
  openGitFile(filePath: string): Promise<void>;
  commit(): Promise<void>;
  push(): Promise<void>;
  pull(): Promise<void>;
}
interface FileDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}
interface FileDiffMetadata {
  filePath: string;
  type: 'update' | 'create' | 'delete' | 'rename';
  linesAdded?: number;
  linesRemoved?: number;
  structuredPatch?: FileDiffHunk[];
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  omittedLines?: number;
  message?: string;
}
interface FileDiffRenderOptions {
  pathAction?: string;
  collapsible?: boolean;
  expanded?: boolean;
  toggleAction?: string;
}
interface AppFileDiff {
  countContentLines(content: string): number;
  render(diff: FileDiffMetadata, options?: FileDiffRenderOptions): string;
}
interface ChatComponentView<T> {
  mount(container: HTMLElement): HTMLElement;
  update(data: T): void;
  dispose(): void;
}
interface SubagentDelegationData {
  input: unknown;
  output?: unknown;
  error?: unknown;
  status?: string;
  toolCallId?: string;
  batches?: readonly FrontendSubagentBatch[];
}
interface AppChatViews {
  configure(dependencies: { renderMarkdown?: (text: string) => string }): void;
  createComposer(callbacks: ChatComposerCallbacks): AppChatComposer;
  resizeComposerInput(input: HTMLTextAreaElement): void;
  openModelPicker(event: MouseEvent): void;
  createAttachmentInput(): AppChatAttachmentInput;
  createReadingControls(callbacks?: ChatReadingControlsCallbacks): AppChatReadingControls;
  createSseController(callbacks: ChatSseControllerCallbacks): AppChatSseController;
  FileDiffView: new (diff: FileDiffMetadata, options?: FileDiffRenderOptions) => ChatComponentView<FileDiffMetadata>;
  EditSummaryView: new (blocks: any[], expanded?: boolean) => ChatComponentView<any[]>;
  SubagentTaskView: new (task: FrontendSubagentTask, index?: number) => ChatComponentView<FrontendSubagentTask>;
  SubagentBatchView: new (batch: FrontendSubagentBatch) => ChatComponentView<FrontendSubagentBatch>;
  renderEditSummary(blocks: any[], expanded?: boolean): string;
  refreshEditSummary(flow: HTMLElement, blocks: any[]): void;
  renderSubagentBatches(batches: readonly FrontendSubagentBatch[] | undefined, toolCallId?: string): string;
  refreshSubagentBatches(root: HTMLElement, batches: readonly FrontendSubagentBatch[] | undefined, toolCallId?: string): boolean;
  renderSubagentDelegation(data: SubagentDelegationData): string;
  refreshSubagentDelegation(root: HTMLElement, data: SubagentDelegationData): boolean;
  permissionFailureToChatError?(failure: PermissionFailurePayload): ChatErrorState;
  ChatEventNodeView: AppChatEventNodeView;
}
interface AppChatEventNodeView {
  configure(dependencies: { renderMarkdown?: (text: string) => string }): void;
  renderEventBlock(block: any, blocks: any[], defaultOpen?: boolean, batches?: readonly FrontendSubagentBatch[]): string;
  renderBlocks(blocks: any[], batches?: readonly FrontendSubagentBatch[]): string;
  renderBlockNode(block: any, blocks: any[]): HTMLElement | null;
  replaceBlockContents(target: HTMLElement, html: string): void;
  insertBlockNode(flow: HTMLElement, block: any, blocks: any[]): boolean;
  refreshEditSummary(flow: HTMLElement, blocks: any[]): void;
  subagentDelegationData(block: any, blocks: any[], batches?: readonly FrontendSubagentBatch[]): SubagentDelegationData;
  blockId(block: any): string;
}
interface ChatComposerCallbacks {
  isBusy: () => boolean;
  getInputHistory?: () => string[];
  onInput: (input: HTMLTextAreaElement) => void;
  onSubmit: (text: string) => void;
  onSubmitNote: (text: string, mode: 'steer' | 'followUp') => void;
  onAbort: () => void;
}
interface AppChatComposer {
  bind(): void;
  refresh(): void;
  dispose(): void;
}
interface AppChatAttachmentInput {
  bind(): void;
  dispose(): void;
}
interface ChatSseControllerCallbacks {
  scheduleMessagesRender(scroll?: boolean): void;
  updateUI(): void;
  markLastMessageRendered(): void;
  renderMessages(): void;
  refreshComposer(): void;
  setAssistantError(title: string, message: string, reason?: string, nextSteps?: string[], raw?: string, actions?: ChatErrorAction[]): void;
  completeSend(sessionId: string, assistantText: string): void;
  failSend(): void;
}
interface AppChatSseController {
  bind(generation: number): boolean;
  handleMessage(generation: number, event: MessageEvent): void;
  handleError(generation: number, event: Event): void;
  handleOpen(generation: number, event: Event): void;
}
interface ChatReadingControlsCallbacks {
  onScroll?: () => void;
}
interface AppChatReadingControls {
  bind(): void;
  refreshSettings(): void;
  scrollToLatest(options?: { force?: boolean; smooth?: boolean }): boolean;
  reset(): void;
  dispose(): void;
}
type McpConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';
interface McpServerStatus {
  name: string;
  state: unknown;
  tools: string[];
  error?: string;
  config?: { command?: string; args?: string[]; url?: string; transport?: string; enabled?: boolean };
  canDelete?: boolean;
}
interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  command: string;
  args: string[];
  envHints?: string[];
  postInstallHint?: string;
}
interface AppMcpState {
  normalize(value: unknown): McpConnectionState;
  label(value: unknown): string;
}
interface AppMcpViews {
  renderPanel(): string;
  renderServers(servers: McpServerStatus[]): string;
  renderCatalog(catalog: CatalogEntry[]): string;
}
interface AppExplorerViews {
  renderEmpty(): string;
  renderPanel(): string;
  showFilterMenu(anchor: HTMLElement, enabled: boolean, onChange: (enabled: boolean) => void): void;
  dispose(): void;
}
interface AppConstants {
  WS_KEY: string;
}
interface WorkspaceUiSnapshot {
  schemaVersion: 2;
  workspacePath: string;
  activeView: { type: 'chat' } | { type: 'session'; id: string } | { type: 'file'; id: string };
  tabs: {
    sessions: string[];
    files: Array<{ id: string; label: string; content?: string; lang?: string }>;
    chatOpen: boolean;
    labels: Record<string, string>;
    titleSources?: Record<string, 'auto' | 'manual'>;
    items?: AppTab[];
    activeId?: string | null;
  };
  panel: { active: string; closed: boolean; width: number };
  recent: { sessions: Record<string, number>; lastSessionId?: string };
}
interface AppStateFacade {
  hydrate(): Promise<WorkspaceUiSnapshot>;
  saveNow(): Promise<boolean>;
  getSnapshot(): WorkspaceUiSnapshot;
  getWorkspacePath(): string;
  setWorkspacePath(workspacePath: string): void;
  resetWorkspace(workspacePath: string): void;
  syncTabs(items: AppTab[], activeId: string | null): void;
  updateSessionMetadata(labels: Record<string, string>, titleSources: Record<string, 'auto' | 'manual'>): void;
  updatePanel(panel: Partial<WorkspaceUiSnapshot['panel']>): void;
  setChatOpen(chatOpen: boolean): void;
  touchSession(sessionId: string, timestamp?: number): void;
}

interface AppNamespace {
  Preferences: AppPreferences;
  Constants: AppConstants;
  State: AppStateFacade;
  UI: AppUI;
  Ui: AppUiComponents;
  Chat: AppChat;
  ChatState: AppChatState;
  ChatTimeline: AppChatTimeline;
  ChatStream: AppChatStream;
  Events: AppEvents;
  File: AppFile;
  Session: AppSession;
  SessionViews: AppSessionViews;
  PermissionViews: AppPermissionViews;
  SessionActivation: AppSessionActivation;
  SessionTabs: AppSessionTabs;
  SessionRestore: AppSessionRestore;
  Permissions: AppPermissions;
  Settings: AppSettings;
  SettingsComponents: AppSettingsComponents;
  SettingsCustomProviderEditor: SettingsCustomProviderEditorConstructor;
  isCustomProviderRevision(value: unknown): value is number;
  Git: AppGit;
  FileDiff: AppFileDiff;
  ChatViews: AppChatViews;
  McpState: AppMcpState;
  McpViews: AppMcpViews;
  ExplorerViews: AppExplorerViews;
  Tabs: AppTabs;
}

interface MonacoAPI {
  create(container: HTMLElement): void;
  setValue(val: string): void;
  getValue(): string;
  setLang(id: string): void;
  dispose(): void;
  tsOpenFile(filePath: string, content: string): void;
  tsChangeFile(filePath: string, content: string): void;
  tsCloseFile(filePath: string): void;
  updateSettings(): void;
  blur(): void;
  pauseDiags(): void;
  resumeDiags(): void;
  refreshDiagnosticsForFile(filePath: string): Promise<void>;
  revealPosition(line: number, col: number): void;
  getCurrentFile(): string;
  isReady(): boolean;
}

type SessionActivatedCallback = (sessionId: string) => void;
type CancelSessionActivationSubscription = () => void;
interface OnceSessionActivated {
  (cb: SessionActivatedCallback): CancelSessionActivationSubscription;
  (sessionId: string, cb: SessionActivatedCallback): CancelSessionActivationSubscription;
}
