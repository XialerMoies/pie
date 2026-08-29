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
  streaming?: boolean;
  error?: ChatErrorState;
  blocks?: AssistantBlock[];
  subagentEvents?: FrontendSubagentEvent[];
  subagentBatches?: FrontendSubagentBatch[];
  _compacted?: boolean;        // 服务端标记：来自 session JSONL 的 compaction 摘要
  /** Legacy runtime fields retained while the global-script chat renderer migrates. */
  thinking?: boolean;
  _rv?: unknown;
}

type CommandConfirmChoice = 'once' | 'session' | 'workspace' | 'deny';
type FrontendSubagentStatus = 'queued' | 'running' | 'success' | 'error' | 'interrupted';
interface FrontendSubagentEvent { id: string; batchId: string; taskId: string; status: FrontendSubagentStatus; toolCallId?: string; }
interface FrontendSubagentTask { taskId: string; status: FrontendSubagentStatus; events: FrontendSubagentEvent[]; }
interface FrontendSubagentBatch { batchId: string; status: FrontendSubagentStatus; events: FrontendSubagentEvent[]; tasks: FrontendSubagentTask[]; }

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
  actions?: ChatErrorAction[];
}
type ChatErrorAction = 'retry' | 'copy' | 'refresh' | 'settings' | 'reconnect' | 'permissions';
interface PermissionFailurePayload {
  code: string;
  category: 'permission' | 'confirmation' | 'safety' | 'path' | string;
  decision: 'deny' | 'ask' | 'block' | string;
  message: string;
  reason: string;
  operation?: string;
  target?: string;
  recoverable: boolean;
  suggestions: Array<{ action: 'retry' | 'reconnect' | 'open_permissions' | string; label: string }>;
}

interface ProviderKeyInfo {
  hasKey: boolean;
  canReveal: boolean;
  keyPreview: string;
}

interface ProviderCardModel {
  id: string;
  name: string;
}

interface ProviderCardItem {
  id: string;
  name: string;
  custom: boolean;
  configured: boolean;
  baseUrl: string;
  protocolLabel: string;
  models: ProviderCardModel[];
}

interface ProviderCardListState {
  current: { providerId: string; modelId: string } | null;
  pendingSwitch: { providerId: string; modelId: string } | null;
  providers: ProviderCardItem[];
}

interface ProviderPickerState {
  official: Array<{ id: string; name: string; configured: boolean }>;
  customAvailable: boolean;
}

interface ProviderCardListCallbacks {
  onUse(providerId: string, modelId: string): void;
  onEdit(providerId: string): void;
  onAdd(): void;
}

interface ProviderPickerCallbacks {
  onBack(): void;
  onOfficial(providerId: string): void;
  onCustom(template: 'openai' | 'anthropic' | 'other'): void;
}

type OfficialProviderModelsStatus = 'idle' | 'loading' | 'ready' | 'error';

interface OfficialProviderEditorState {
  provider: { id: string; name: string; configured: boolean };
  apiKey: {
    value: string;
    placeholder: string;
    revealed: boolean;
    canReveal: boolean;
    saving: boolean;
  };
  models: {
    status: OfficialProviderModelsStatus;
    items: ProviderCardModel[];
    activeModelId: string | null;
    switchPending: boolean;
    pendingModelId: string | null;
    error: string;
  };
}

interface OfficialProviderEditorCallbacks {
  onBack(): void;
  onReveal(providerId: string): void;
  onApiKeyChange(providerId: string, value: string): void;
  onKeyVisibilityChange(providerId: string, revealed: boolean): void;
  onSave(providerId: string, apiKey: string): void;
  onUse(providerId: string, modelId: string): void;
}

declare const ProviderSettingsUtils: {
  providerHost(baseUrl: string): string;
  identity(providerId: string, name: string, isCustom: boolean): {
    iconPath?: string;
    initials: string;
    label: string;
  };
};

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
type TabKind = 'chat' | 'session' | 'file' | 'component' | 'mcp-management';

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
  componentId?: string;
  componentManifest?: {
    id: string;
    version?: string;
    kind?: 'required' | 'optional';
    capability?: string;
    source?: string;
    productClass?: string;
    hostSurface?: string;
    displayName?: string;
    publisher?: string;
    icon?: string;
    agentConfig?: { timeoutMs?: number; maxConcurrent?: number };
    description?: string;
    dependencies?: Array<string | { id: string; version?: string; optional?: boolean; capability?: string }>;
    children?: Array<{ id: string; displayName?: string; publisher?: string; description?: string; icon?: string; agentConfig?: { timeoutMs?: number; maxConcurrent?: number }; enabled?: boolean; status?: 'active' | 'disabled' | 'untrusted' | 'unhealthy'; health?: string }>;
  };
  componentEnabled?: boolean;
  componentStatus?: 'active' | 'disabled' | 'untrusted' | 'unhealthy';
  componentInstalled?: boolean;
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
  mark(name: string): void;
  logTiming(): void;
  applyExplorerPreferences(): void;
  placeContextMenu(menu: HTMLElement, x: number, y: number, opts?: { margin?: number; maxHeight?: number }): void;
  layout(): void;
  togglePanel(name: string): void;
  renderPanel(name: string, pc?: HTMLElement | null): void;
  restorePanel(name: string): void;
  disposeMountedPane(): void;
  reconcileContributions(): void;
  syncComponents(): Promise<void>;
  setProblemsComponentActive(active: boolean): void;
  renderTabs(): void;
  renderSessionTabs(activeId?: string): void;
  closeChatTab(): void;
  restoreFileTabs(): void;
  quickOpenFile(): void;
  openFileTab(id: string, content: string, lang?: string, renderer?: 'text' | 'image' | 'video', options?: { activate?: boolean }): void;
  openComponentTab(component: { id: string; version?: string; kind?: 'required' | 'optional'; capability?: string; source?: string; productClass?: string; hostSurface?: string; displayName?: string; publisher?: string; icon?: string; agentConfig?: { timeoutMs?: number; maxConcurrent?: number }; description?: string; dependencies?: Array<string | { id: string; version?: string; optional?: boolean; capability?: string }>; children?: Array<{ id: string; displayName?: string; publisher?: string; description?: string; icon?: string; agentConfig?: { timeoutMs?: number; maxConcurrent?: number }; enabled?: boolean; status?: 'active' | 'disabled' | 'untrusted' | 'unhealthy'; health?: string }>; enabled?: boolean; status?: 'active' | 'disabled' | 'untrusted' | 'unhealthy'; installed?: boolean }): void;
  /** Opens the MCP Server discovery/install workspace, not a component detail. */
  openMcpManagementTab(): void;
  saveCurrentFile(): Promise<void>;
}
