// 共享类型声明 — 被所有 dashboard-*.ts 引用
interface AppPreferences {
  get(key: string, fallback?: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
  getBoolean(key: string, fallback?: boolean): boolean;
  setBoolean(key: string, value: boolean): void;
  getNumber(key: string, fallback: number, min?: number, max?: number): number;
  getJson<T>(key: string, fallback: T): T;
  setJson<T>(key: string, value: T): void;
  hydrate(): Promise<void>;
  onHydrated(listener: () => void): () => void;
  isHydrated(): boolean;
  flush(): Promise<boolean>;
}

interface DashboardData {
  modelProvider: string;
  modelId: string;
  modelContextWindow: number | string;
  modelMaxTokens: number | string;
  thinkingLevel: string;
  runtime: number;
  messagesCount: number;
  isIdle: boolean;
  tools: string[];
  activeTools: string[];
  dataDir: string;
}

interface Message {
  role: 'user' | 'assistant';
  turnId?: string;
  content: string;
  thinking?: string;
  streaming?: boolean;
  error?: ChatErrorState;
  blocks?: AssistantBlock[];
  subagentEvents?: FrontendSubagentEvent[];
  subagentBatches?: FrontendSubagentBatch[];
  _compacted?: boolean;        // 服务端标记：来自 session JSONL 的 compaction 摘要
}

interface AssistantBlock {
  type: 'thinking' | 'text' | 'tool' | 'tool_use' | 'tool_result' | 'step' | 'user_note';
  text?: string;
  status?: 'streaming' | 'done' | 'running' | 'success' | 'error' | 'info' | 'queued' | 'delivered' | 'failed';
  name?: string;
  input?: unknown;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  isError?: boolean;
  toolCallId?: string;
  toolUseId?: string;
  turnId?: string;
  noteId?: string;
  mode?: 'steer' | 'followUp';
  blockId: string;
  seq: number;
}

interface ChatErrorState {
  title: string;
  message: string;
  reason?: string;
  nextSteps?: string[];
  raw?: string;
}

interface ProviderKeyInfo {
  hasKey: boolean;
  keyPreview: string;
}

interface WorkspaceOpenResult {
  ok: boolean;
  action: 'unchanged' | 'focused-existing' | 'binding' | 'switching';
  workspace?: string;
}

interface ElectronAPI {
  onWorkspaceStatus(listener: (status: WorkspaceStatus) => void): () => void;
  getDesktopSessionToken(): Promise<string>;
  minimize(): void;
  maximize(): void;
  close(): void;
  newWindow(): Promise<{ ok: boolean; workspace?: string; instanceId?: string } | null>;
  openWorkspaceFolder(): Promise<WorkspaceOpenResult | null>;
  selectFile(): Promise<string | null>;
  selectFolder(): Promise<string | null>;
  showItemInFolder(path: string): Promise<void>;
  trashItem(path: string): Promise<boolean>;
  spawnTerminal(): Promise<boolean>;
}

type WorkspaceStatus =
  | { state: 'idle' }
  | { state: 'starting'; workspace: string }
  | { state: 'failed'; workspace: string; message: string };

interface StorageLocationInfo {
  dataRoot: string;
  activeDataRoot: string;
  restartRequired: boolean;
  workspace?: string;
  instanceId?: string;
  workspaceLock?: {
    status: 'locked' | 'unlocked';
    owner?: { workspace?: string; instanceId?: string; pid?: number; port?: number; startedAt?: number };
  };
}

// ─── Unified Tab System types ─────────────────────────
type TabKind = 'chat' | 'session' | 'file';

interface AppTab {
  workspace?: string;
  id: string;                    // file path / session id / chat:<ts>-<rand>
  kind: TabKind;
  title: string;
  order: number;                 // 数组索引即顺序
  status?: 'idle' | 'running' | 'error' | 'restoring';
  dirty?: boolean;               // 仅 file 使用
  // kind 专属数据
  path?: string;                 // file 专用：文件路径
  content?: string;              // file 专用：编辑器内容缓存
  lang?: string;                 // file 专用：语法高亮语言
  renderer?: 'text' | 'image' | 'video'; // file 专用：渲染器类型
  sessionId?: string;            // session 专用
  draftId?: string;              // chat 专用
}

interface TabsState {
  items: AppTab[];
  activeId: string | null;
}

// ─── App 命名空间 ─────────────────────────────────────────────
// 收敛所有全局函数，逐步替代 window.xxx 模式
interface AppUI {
  $(id: string): HTMLElement | null;
  S(name: string, size?: number): string;
  E(s: unknown): string;
  F(s: number): string;
  sb(id: string): void;
  winCtrl(action: string): void;
  toast(msg: string, type?: 'info' | 'error' | 'success'): void;
  bootstrapApi(): Promise<void>;
  getD(): Promise<void>;
  refresh(): Promise<void>;
  layout(): void;
  togglePanel(name: string): void;
  renderPanel(name: string, pc?: HTMLElement | null): void;
  restorePanel(name: string): void;
  renderTabs(): void;
  renderSessionTabs(activeId?: string): void;
  closeChatTab(): void;
  openFileTab(id: string, content: string, lang?: string, renderer?: 'text' | 'image' | 'video', options?: { activate?: boolean }): void;
  saveCurrentFile(): Promise<void>;
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
  open(handlers?: ChatStreamHandlers): number;
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
interface AppSettings {
  openSettingsModal(): void;
  closeSettingsModal(): void;
  switchSettingsModal(tab: string): void;
  selectProvider(prov: string): void;
  toggleKeyVis(prov: string): void;
  saveApiKey(provider: string): void;
  loadProviderModels(prov: string): void;
  selectModel(provider: string, modelId: string): void;
  provDragStart(ev: DragEvent, idx: number): void;
  provDragOver(ev: DragEvent, idx: number): void;
  provDrop(ev: DragEvent, idx: number): void;
  changeFontSize(delta: number): void;
  applyGeneralSetting(key: string, val: boolean): void;
  toggleAutoSaveSetting(): void;
  setSearchType(type: 'filename' | 'text'): void;
  toggleCaseSensitive(): void;
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
type McpConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';
interface AppMcpState {
  normalize(value: unknown): McpConnectionState;
  label(value: unknown): string;
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
  Chat: AppChat;
  ChatState: AppChatState;
  ChatTimeline: AppChatTimeline;
  ChatStream: AppChatStream;
  Events: AppEvents;
  File: AppFile;
  Session: AppSession;
  SessionActivation: AppSessionActivation;
  SessionTabs: AppSessionTabs;
  SessionRestore: AppSessionRestore;
  Permissions: AppPermissions;
  Settings: AppSettings;
  Git: AppGit;
  FileDiff: AppFileDiff;
  McpState: AppMcpState;
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

interface Window {
  electronAPI?: ElectronAPI;
  _provOrder?: string[];
  App: AppNamespace;
  __monaco: MonacoAPI;
  __problemsStore: ProblemsStoreAPI;
  ExplorerService: typeof ExplorerService;
  isConversationSearchActive?: () => boolean;
  onceSessionActivated?: OnceSessionActivated;
  emitSessionActivated?: SessionActivatedCallback;
  refreshPermissionsPanel?: (forceToast?: boolean) => Promise<void>;
}

// 公共函数声明（在 HTML onclick 中用）
declare function $(id: string): HTMLElement | null;
declare function S(name: string, size?: number): string;
declare function E(s: unknown): string;
declare function confirmAsync(msg: string): Promise<boolean>;
declare function confirmCommandAsync(input: {
  command: string;
  reason: string;
  permissionSuggestions?: any[];
}): Promise<'once' | 'session' | 'workspace' | 'deny'>;
declare function confirmPermissionAsync(input: {
  source?: string;
  operation?: string;
  toolName?: string;
  toolOperations?: string[];
  riskLevel?: string;
  workspaceBounded?: boolean;
  permissionRequired?: boolean;
  root?: string;
  path?: string;
  relativePath?: string;
  reason?: string;
  permissionSuggestions?: any[];
}): Promise<'once' | 'session' | 'workspace' | 'deny'>;
declare function F(s: number): string;
declare function sb(id: string): void;
declare function toast(msg: string, type?: 'info' | 'error' | 'success'): void;
declare function bootstrapApi(): Promise<void>;
declare function applyExplorerPreferences(): void;
declare function getD(): Promise<void>;
declare function refresh(): Promise<void>;
declare function winCtrl(action: string): void;
declare function layout(): void;
declare function togglePanel(name: string): void;
declare function renderPanel(name: string, pc?: HTMLElement | null): void;
declare function closeChatTab(): void;
declare function msgs(): string;
declare function appendDelta(text: string): void;
declare function bind(): void;
declare function updateUI(): void;
declare function showModelPicker(e: MouseEvent): void;
declare function retryLastTurn(): void;
declare function copyLastError(): Promise<void>;
declare function refreshWorkspaceState(): void;
declare function toggleFileMenu(ev: MouseEvent, trigger?: HTMLElement): void;
declare function closeFM(): void;
declare function fileAction(action: string): void;
declare function launchCli(): void;
declare function openSettingsModal(): void;
declare function closeSettingsModal(): void;
declare function switchSettingsModal(tab: string): void;
declare function selectProvider(prov: string): void;
declare function toggleKeyVis(prov: string): void;
declare function saveApiKey(provider: string): void;
declare function loadProviderModels(prov: string): void;
declare function selectModel(provider: string, modelId: string): void;
declare function provDragStart(ev: DragEvent, idx: number): void;
declare function provDragOver(ev: DragEvent, idx: number): void;
declare function provDrop(ev: DragEvent, idx: number): void;
declare function isConversationSearchActive(): boolean;
declare function loadMonaco(): Promise<void>;
declare function openFileTab(id: string, content: string, lang?: string, renderer?: 'text' | 'image' | 'video', options?: { activate?: boolean }): void;
declare function renderTabs(): void;
declare function registerPane(name: string, render: (container: HTMLElement) => void): void;
declare function saveCurrentFile(): Promise<void>;
declare function tabContextMenu(e: MouseEvent, id: string): void;
declare function tabMoreMenu(e: MouseEvent): void;
declare function toggleExplorerFilter(): void;
declare function refreshTokenUsage(): Promise<void>;
declare function startTokenUpdates(): void;
declare function stopTokenUpdates(): void;

// Tree widget
interface TreeNode { id: string; label: string; icon: string; isDir: boolean; children?: TreeNode[]; }
declare class Tree {
  constructor(container: HTMLElement, opts?: { indent?: number });
  setData(data: TreeNode[]): void;
  setChildren(parentId: string, children: TreeNode[]): void;
  removeNode(id: string): boolean;
  onSelect: ((node: TreeNode) => void) | null;
  onExpand: ((node: TreeNode, cb: (children?: TreeNode[]) => void) => void) | null;
  contextMenu: { label: string; action: (node: TreeNode, tree: Tree) => void; disabled?: (node: TreeNode) => boolean }[];
  blankContextMenu: { label: string; action: () => void }[];
  inlineRename(id: string, cb: (newName: string) => void, onCancel?: () => void): void;
  inlineCreate(parentId: string, isDir: boolean, onCreate: (name: string) => void): void;
  onDragMove: ((srcId: string, dstId: string) => void) | null;
  clearChildCache(): void;
  refreshExpandedChildren(): Promise<void>;
}

// ─── Token / Session Stats (from API /api/token-usage) ────────
interface TokenUsage {
  tokens: number;
  contextWindow: number;
  percent: number;
}

interface SessionStats {
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  cost?: number;
  totalTokens?: number;
  toolCalls?: number;
  turns?: number;
}

// ─── Explorer API item ──────────────────────────────────────────
interface ExplorerItem {
  name: string;
  path: string;
  isDir: boolean;
}

// ─── ProblemsStore Types ──────────────────────────────────────────
interface ProblemItem {
  filePath: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code?: string | number;
  fixCount?: number;
  source: string;      // "typescript" | "eslint" | ...
}

interface ProblemsStoreAPI {
  getProblems(): ProblemItem[];
  getProblemsForFile(filePath: string): ProblemItem[];
  setProblems(filePath: string, items: ProblemItem[]): void;
  clearFile(filePath: string): void;
  clear(): void;
  subscribe(fn: () => void): () => void;
  getErrorCount(): number;
  getWarningCount(): number;
  getInfoCount(): number;
  getFileCount(): number;
  getAllFiles(): string[];
}

// ─── Chat Attachment Types ──────────────────────────────────────
type AttachmentKind = "file" | "folder" | "clip";

interface ChatAttachment {
  id: string;
  kind: AttachmentKind;
  path: string;      // relative to workspace root
  name: string;      // display name
  // clip only
  startLine?: number;
  endLine?: number;
  // folder only
  fileCount?: number;
  totalBytes?: number;
  truncated?: boolean;
}

// ExplorerService
declare class ExplorerService {
  static fetchDir(root: string, path: string): Promise<{ items: ExplorerItem[]; rootDir: string; relativePath: string }>;
  static getWorkspacePath(): string;
  static setWorkspacePath(p: string): void;
  static selectWorkspace(): Promise<string | null>;
  static applyWorkspace(): Promise<void>;
  static iconFor(name: string, dir: boolean): string;
  static toTreeNodes(items: ExplorerItem[]): TreeNode[];
  static _makeRefreshKey(items: TreeNode[], workspacePath?: string): string;
  static markDeleted(path: string): void;
  static clearDeletedMark(path: string): void;
  static reconcilePendingDeletes(parentPath: string, nodes: TreeNode[]): TreeNode[];
  static filterPendingDeletedNodes(nodes: TreeNode[]): TreeNode[];
  static fileOp(op: 'new' | 'rename' | 'delete' | 'move', root: string, path: string, newPath?: string): Promise<void>;
  static _setTree(t: Tree | null): void;
  static _getTree(): Tree | null;
  static refreshTree(): Promise<void>;
}
