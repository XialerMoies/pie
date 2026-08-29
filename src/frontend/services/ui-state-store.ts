/**
 * UiStateStore — 前端 UI 状态统一门面
 *
 * 通过 App.State facade 暴露，避免把可变状态挂到 window 全局。
 *
 * 原则：
 *   服务端 /api/ui-state 为权威持久化源
 *   localStorage 仅作一次性迁移兜底
 *   所有写操作统一通过 patchState()
 */

// ─── 类型 ───────────────────────────────────────────────

export interface FileTabState { id: string; label: string; content?: string; lang?: string }

export interface WorkspaceUiState {
  schemaVersion: 2;
  workspacePath: string;
  activeView: { type: "chat" } | { type: "session"; id: string } | { type: "file"; id: string } | { type: "component"; id: string } | { type: "mcp-management"; id: string };
  tabs: {
    // 旧格式（兼容）
    sessions: string[];
    files: FileTabState[];
    chatOpen: boolean;
    labels: Record<string, string>;
    titleSources?: Record<string, "auto" | "manual">;
    // 新格式（可选，与旧字段共存）
    items?: AppTab[];
    activeId?: string | null;
  };
  panel: { active: string; closed: boolean; width: number };
  recent: { sessions: Record<string, number>; lastSessionId?: string };
}

type Listener = (state: WorkspaceUiState) => void;

function makeDefaultTabs() {
  return { sessions: [], files: [], chatOpen: true, labels: {}, titleSources: {} };
}

const DEFAULT_STATE: WorkspaceUiState = {
  schemaVersion: 2,
  workspacePath: "",
  activeView: { type: "chat" },
  tabs: { ...makeDefaultTabs(), items: [], activeId: null },
  panel: { active: "explorer", closed: false, width: 260 },
  recent: { sessions: {} },
};

let _state: WorkspaceUiState = { ...DEFAULT_STATE };
const _listeners = new Set<Listener>();
let _hydrated = false;
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
let _saveGeneration = 0;
let _savePromise: Promise<boolean> | null = null;
let _workspaceGeneration = 0;

// ─── localStorage 旧 key（迁移用） ──────────────────────

const OLD = {
  SESSION_TABS: "session-tabs",
  ACTIVE_SESSION: "active-session-tab",
  SESSION_LABELS: "session-tab-labels",
  LAST_SESSION: "last-session-id",
  ACTIVE_PANEL: "active-panel",
  PANEL_WIDTH: "panel-width",
  CHAT_TAB: "chat-tab-open",
  WS_KEY: "workspace_path",
};

const WORKSPACE_LEGACY_KEYS = [
  "file-tabs",
  "last-active-tab",
  OLD.SESSION_TABS,
  OLD.ACTIVE_SESSION,
  OLD.SESSION_LABELS,
  OLD.LAST_SESSION,
  OLD.CHAT_TAB,
  OLD.ACTIVE_PANEL,
  OLD.PANEL_WIDTH,
] as const;

function readLS(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function readLegacyState(): Partial<WorkspaceUiState> {
  const partial: Partial<WorkspaceUiState> = {};
  partial.tabs = { sessions: [], files: [], chatOpen: readLS(OLD.CHAT_TAB) !== "0", labels: {}, titleSources: {} };

  const rawTabs = readLS(OLD.SESSION_TABS);
  const sessions: string[] = rawTabs ? JSON.parse(rawTabs).filter((id: unknown) => typeof id === "string") : [];
  if (sessions.length > 0) {
    partial.tabs = { ...partial.tabs, sessions,
      labels: (() => { try { return JSON.parse(readLS(OLD.SESSION_LABELS) || "{}"); } catch { return {}; } })(),
    };
    const activeId = readLS(OLD.ACTIVE_SESSION);
    if (activeId && sessions.includes(activeId)) partial.activeView = { type: "session", id: activeId };
  }

  const panelActive = readLS(OLD.ACTIVE_PANEL) || DEFAULT_STATE.panel.active;
  const panelWidth = parseInt(readLS(OLD.PANEL_WIDTH) || "", 10);
  partial.panel = { active: panelActive, closed: false, width: panelWidth > 50 ? panelWidth : DEFAULT_STATE.panel.width };

  partial.recent = { sessions: {}, lastSessionId: readLS(OLD.LAST_SESSION) || undefined };
  return partial;
}

// ─── 服务端读写 ────────────────────────────────────────

async function fetchServerState(): Promise<Partial<WorkspaceUiState> | null> {
  try {
    const r = await fetch("/api/ui-state");
    if (!r.ok) return null;
    const data = await r.json();
    // 服务端返回了完整新结构（含 schemaVersion/tabs）→ 直接使用
    if (data && data.schemaVersion === 2) return data as WorkspaceUiState;
    if (data && typeof data.workspacePath === "string") return { workspacePath: data.workspacePath };
    // 旧结构（只有 openSessionIds）→ 视为无数据，降级
    return null;
  } catch {
    return null;
  }
}

// ─── 新旧格式转换 ────────────────────────────────────

/** 将旧 tabs 格式转为新 AppTab[] */
function legacyTabsToNew(
  old: { sessions?: string[]; files?: FileTabState[]; labels?: Record<string, string> },
  activeView: WorkspaceUiState['activeView'],
): AppTab[] {
  const items: AppTab[] = [];
  const sessions = old.sessions ?? [];
  for (const sid of sessions) {
    const label = old.labels?.[sid];
    const isDraft = sid.startsWith('draft:');
    items.push({
      id: sid,
      kind: isDraft ? 'chat' : 'session',
      title: label || (isDraft ? '新会话' : '新会话'),
      order: items.length,
      ...(isDraft ? { draftId: sid } : { sessionId: sid }),
    });
  }
  const files = old.files ?? [];
  for (const f of files) {
    items.push({ id: f.id, kind: 'file', title: f.label, order: items.length, path: f.id, content: (f as any).content, lang: (f as any).lang });
  }
  return items;
}

/** 确保 _state.tabs 包含新格式 items/activeId。旧格式不再补充写回 */
function ensureTabsFormat(state: WorkspaceUiState): void {
  const tabs = state.tabs;
  if (!tabs) {
    (state as any).tabs = { ...makeDefaultTabs(), items: [], activeId: null };
    return;
  }
  // 已有新格式 → 直接返回，不再写旧格式
  if (tabs.items) return;
  // 旧格式 → 转为新格式（仅启动时迁移用）
  tabs.items = legacyTabsToNew(
    { sessions: tabs.sessions, files: tabs.files, labels: tabs.labels },
    state.activeView,
  );
  if (state.activeView.type === 'session') tabs.activeId = state.activeView.id;
  else if (state.activeView.type === 'file') tabs.activeId = state.activeView.id;
}

// ─── 公开 API ──────────────────────────────────────────

function isHydrated(): boolean { return _hydrated; }
function getUiState(): WorkspaceUiState { return _state; }
function getSnapshot(): WorkspaceUiState {
  return {
    ..._state,
    activeView: { ..._state.activeView },
    tabs: {
      ..._state.tabs,
      sessions: [...(_state.tabs.sessions || [])],
      files: (_state.tabs.files || []).map(file => ({ ...file })),
      labels: { ...(_state.tabs.labels || {}) },
      titleSources: { ...(_state.tabs.titleSources || {}) },
      items: (_state.tabs.items || []).map(tab => ({ ...tab })),
    },
    panel: { ..._state.panel },
    recent: {
      ..._state.recent,
      sessions: { ...(_state.recent.sessions || {}) },
    },
  };
}

function getWorkspacePath(): string {
  return _state.workspacePath || "";
}

function setWorkspacePath(workspacePath: string): void {
  ++_workspaceGeneration;
  _state.workspacePath = workspacePath;
  try { localStorage.setItem(OLD.WS_KEY, workspacePath); } catch {}
  _notify();
  _scheduleSave();
}

function resetWorkspace(workspacePath: string): void {
  ++_workspaceGeneration;
  _state = {
    schemaVersion: 2,
    workspacePath,
    activeView: { type: "chat" },
    tabs: { ...makeDefaultTabs(), items: [], activeId: null },
    panel: { ...DEFAULT_STATE.panel },
    recent: { sessions: {} },
  };
  try {
    for (const key of WORKSPACE_LEGACY_KEYS) localStorage.removeItem(key);
    localStorage.setItem(OLD.WS_KEY, workspacePath);
  } catch {}
  _notify();
  _scheduleSave();
}

function syncTabs(items: AppTab[], activeId: string | null): void {
  const copiedItems = items.map((tab, index) => ({ ...tab, order: index }));
  const activeTab = copiedItems.find(tab => tab.id === activeId);
  _state.tabs = {
    ..._state.tabs,
    items: copiedItems,
    activeId: activeTab ? activeId : null,
  };
  if (activeTab?.kind === "file") _state.activeView = { type: "file", id: activeTab.id };
  else if (activeTab?.kind === "session" || activeTab?.kind === "chat") _state.activeView = { type: "session", id: activeTab.id };
  else if (activeTab?.kind === "component") _state.activeView = { type: "component", id: activeTab.id };
  else if (activeTab?.kind === "mcp-management") _state.activeView = { type: "mcp-management", id: activeTab.id };
  else _state.activeView = { type: "chat" };
  _notify();
  _scheduleSave();
}

function updateSessionMetadata(
  labels: Record<string, string>,
  titleSources: Record<string, "auto" | "manual">,
): void {
  _state.tabs = {
    ..._state.tabs,
    labels: { ...labels },
    titleSources: { ...titleSources },
  };
  _notify();
  _scheduleSave();
}

function updatePanel(panel: Partial<WorkspaceUiState["panel"]>): void {
  _state.panel = { ..._state.panel, ...panel };
  _notify();
  _scheduleSave();
}

function setChatOpen(chatOpen: boolean): void {
  _state.tabs = { ..._state.tabs, chatOpen };
  _notify();
  _scheduleSave();
}

function touchSession(sessionId: string, timestamp = Date.now()): void {
  if (!sessionId) return;
  _state.recent = {
    ..._state.recent,
    lastSessionId: sessionId,
    sessions: { ..._state.recent.sessions, [sessionId]: timestamp },
  };
  _notify();
  _scheduleSave();
}

/** 启动时调用：优先从服务端读取新结构数据，否则从旧 localStorage 迁移 */
async function hydrateUiState(): Promise<WorkspaceUiState> {
  const workspaceGeneration = _workspaceGeneration;
  let state = await fetchServerState();

  if (workspaceGeneration !== _workspaceGeneration) {
    _hydrated = true;
    saveNow();
    return _state;
  }

  if (state && state.schemaVersion === 2) {
    _state = { ...DEFAULT_STATE, ...state };
    ensureTabsFormat(_state);
    _hydrated = true;
    saveNow();
    return _state;
  }

  // 降级：从旧 localStorage 迁移到新结构
  const legacy = readLegacyState();
  const workspacePath = typeof state?.workspacePath === "string" ? state.workspacePath : _state.workspacePath;
  _state = { ...DEFAULT_STATE, ...legacy, workspacePath };
  ensureTabsFormat(_state);
  _hydrated = true;
  saveNow(); // 异步写回服务端
  return _state;
}

/** 局部更新状态，通知监听器，触发节流保存 */
function patchState(patch: Partial<WorkspaceUiState>): WorkspaceUiState {
  _state = { ..._state, ...patch };
  _notify();
  _scheduleSave();
  return _state;
}

/** 订阅状态变化 */
function subscribe(fn: Listener): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

/** 节流保存到服务端（500ms 去重） */
function _scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { saveNow(); }, 500);
}

function serializeStateForSave(state: WorkspaceUiState): WorkspaceUiState {
  const tabs = state.tabs;
  if (!tabs || !Array.isArray(tabs.items)) return state;
  return {
    ...state,
    tabs: {
      labels: tabs.labels ?? {},
      titleSources: tabs.titleSources ?? {},
      items: tabs.items.map(tab => ({ ...tab })),
      activeId: tabs.activeId ?? null,
    } as any,
  };
}

/** 立即保存到服务端 */
async function saveNow(): Promise<boolean> {
  _saveTimer = null;
  if (!_hydrated) return false;
  ++_saveGeneration;
  if (_savePromise) return _savePromise;

  let lastWrittenGeneration = 0;
  _savePromise = (async () => {
    let result = true;
    do {
      lastWrittenGeneration = _saveGeneration;
      try {
        const payload = serializeStateForSave(_state);
        const r = await fetch("/api/ui-state", {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        result = r.ok && result;
      } catch { result = false; }
    } while (lastWrittenGeneration !== _saveGeneration);
    return result;
  })().finally(() => {
    _savePromise = null;
    // A state change can land between the final comparison and cleanup.
    if (_saveGeneration > lastWrittenGeneration) void saveNow();
  });
  return _savePromise;
}

function _notify(): void {
  for (const fn of _listeners) fn(_state);
}

const app = (window as any).App || ((window as any).App = {});
app.State = {
  hydrate: hydrateUiState,
  saveNow,
  getSnapshot,
  getWorkspacePath,
  setWorkspacePath,
  resetWorkspace,
  syncTabs,
  updateSessionMetadata,
  updatePanel,
  setChatOpen,
  touchSession,
};
