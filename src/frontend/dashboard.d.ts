// 共享类型声明 — 被所有 dashboard-*.ts 引用

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
  _compacted?: boolean;        // 服务端标记：来自 session JSONL 的 compaction 摘要
}

interface AssistantBlock {
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'step';
  text?: string;
  status?: 'streaming' | 'done' | 'running' | 'success' | 'error' | 'info';
  name?: string;
  input?: unknown;
  output?: string;
  error?: string;
  isError?: boolean;
  toolCallId?: string;
  toolUseId?: string;
  turnId?: string;
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
  keyFull: string;
}

interface ElectronAPI {
  minimize(): void;
  maximize(): void;
  close(): void;
  newWindow(): void;
  openFile(): Promise<string | null>;
  openFolder(): Promise<string | null>;
  showItemInFolder(path: string): void;
  trashItem(path: string): Promise<void>;
  spawnTerminal(): void;
}

// ─── Unified Tab System types ─────────────────────────
type TabKind = 'chat' | 'session' | 'file';

interface AppTab {
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

interface AppState {
  D: DashboardData | null;
  M: Message[];
  IL: boolean;
  CS: EventSource | null;
  CT: string;
  _activePanel: string;
  _fileTabs: FileTab[];
  _activeFileTab: string | null;
  _sessionTabs: string[];
  _sessionTabLabels?: Record<string, string>;
  _activeSessionTabId?: string | null;
  tabs?: TabsState;
  _uiStateStore?: any;
}

interface FileTab {
  id: string;      // file path
  label: string;   // file name
  content: string;
  lang: string;
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
  getD(): Promise<void>;
  refresh(): Promise<void>;
  layout(): void;
  togglePanel(name: string): void;
  renderPanel(name: string, pc?: HTMLElement | null): void;
  sinfoHTML(): string;
  refreshSinfo(): void;
  renderTabs(): void;
  renderSessionTabs(activeId?: string): void;
  closeChatTab(): void;
  openFileTab(id: string, content: string, lang?: string, renderer?: 'text' | 'image' | 'video'): void;
  saveCurrentFile(): Promise<void>;
}
interface AppChat {
  msgs(): string;
  appendDelta(text: string): void;
  updateLastBlock(block: Record<string, unknown>): boolean;
  bind(): void;
  updateUI(): void;
  updateModelName(): void;
  showModelPicker(e: MouseEvent): void;
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
}
interface AppFile {
  toggleFileMenu(ev: MouseEvent): void;
  closeFM(): void;
  fileAction(action: string): void;
  launchCli(): void;
  openSearchResult(filePath: string, line?: number): Promise<void>;
}
interface AppSession {
  loadSessions(): void;
  newSession(): void;
  renameSession(el: HTMLElement, id: string): void;
  deleteSession(id: string): Promise<void>;
  pinSession(id: string, pinned: boolean): void;
  branchSession(id: string): void;
  commitSessionTab(oldId: string, newId: string): void;
  getActiveSessionTabId(): string | null;
  setActiveSessionTabId(id: string | null): void;
  renderSessionTabs(activeId?: string): void;
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
interface TabBehavior {
  activate(tab: AppTab): void;
  close(tab: AppTab): void;
  contextMenu?(e: MouseEvent, tab: AppTab): void;
}

interface TabStoreAPI {
  getState(): TabsState;
  getTabs(): AppTab[];
  getActiveTab(): AppTab | null;
  getTab(id: string): AppTab | undefined;
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

interface AppTabs {
  activate(id: string): void;
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
interface AppConstants {
  WS_KEY: string;
}

interface AppNamespace {
  Constants: AppConstants;
  UI: AppUI;
  Chat: AppChat;
  File: AppFile;
  Session: AppSession;
  Settings: AppSettings;
  Git: AppGit;
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
}

interface Window {
  electronAPI?: ElectronAPI;
  _provOrder?: string[];
  __state: AppState;
  App: AppNamespace;
  __monaco: MonacoAPI;
  ExplorerService: typeof ExplorerService;
}

// 公共函数声明（在 HTML onclick 中用）
declare function $(id: string): HTMLElement | null;
declare function S(name: string, size?: number): string;
declare function E(s: unknown): string;
declare function F(s: number): string;
declare function sb(id: string): void;
declare function toast(msg: string, type?: 'info' | 'error' | 'success'): void;
declare function getD(): Promise<void>;
declare function refresh(): Promise<void>;
declare function winCtrl(action: string): void;
declare function layout(): void;
declare function togglePanel(name: string): void;
declare function renderPanel(name: string, pc?: HTMLElement | null): void;
declare function sinfoHTML(): string;
declare function refreshSinfo(): void;
declare function renderSessionTabs(activeId?: string): void;
declare function closeChatTab(): void;
declare function msgs(): string;
declare function appendDelta(text: string): void;
declare function bind(): void;
declare function updateUI(): void;
declare function showModelPicker(e: MouseEvent): void;
declare function retryLastTurn(): void;
declare function copyLastError(): Promise<void>;
declare function refreshWorkspaceState(): void;
declare function toggleFileMenu(ev: MouseEvent): void;
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
declare function loadSessions(): void;
declare function newSession(): void;
declare function renameSession(el: HTMLElement, id: string): void;
declare function deleteSession(id: string): Promise<void>;
declare function pinSession(id: string, pinned: boolean): void;
declare function branchSession(id: string): void;
declare function commitSessionTab(oldId: string, newId: string): void;
declare function getActiveSessionTabId(): string | null;
declare function setActiveSessionTabId(id: string | null): void;
declare function openFileTab(id: string, content: string, lang?: string, renderer?: 'text' | 'image' | 'video'): void;
declare function renderTabs(): void;
declare function registerPane(name: string, render: (container: HTMLElement) => void): void;
declare function saveCurrentFile(): Promise<void>;
declare function tabContextMenu(e: MouseEvent, id: string): void;
declare function tabMoreMenu(e: MouseEvent): void;
declare function toggleExplorerFilter(): void;

// Tree widget
interface TreeNode { id: string; label: string; icon: string; isDir: boolean; children?: TreeNode[]; }
declare class Tree {
  constructor(container: HTMLElement, opts?: { indent?: number });
  setData(data: TreeNode[]): void;
  setChildren(parentId: string, children: TreeNode[]): void;
  onSelect: ((node: TreeNode) => void) | null;
  onExpand: ((node: TreeNode, cb: (children?: TreeNode[]) => void) => void) | null;
  contextMenu: { label: string; action: (node: TreeNode, tree: Tree) => void; disabled?: (node: TreeNode) => boolean }[];
  blankContextMenu: { label: string; action: () => void }[];
  inlineRename(id: string, cb: (newName: string) => void, onCancel?: () => void): void;
  inlineCreate(parentId: string, isDir: boolean, onCreate: (name: string) => void): void;
  onDragMove: ((srcId: string, dstId: string) => void) | null;
  clearChildCache(): void;
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
  static fileOp(op: 'new' | 'rename' | 'delete' | 'move', root: string, path: string, newPath?: string): Promise<void>;
  static _setTree(t: Tree | null): void;
  static _getTree(): Tree | null;
  static refreshTree(): Promise<void>;
}
