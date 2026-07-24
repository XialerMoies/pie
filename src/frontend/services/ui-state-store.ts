/**
 * UiStateStore — 前端 UI 状态统一门面
 *
 * 以全局 <script> 形式加载，挂载到 window.__uiStateStore。
 * 所有方法通过 window.__uiStateStore.xxx 访问。
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
  activeView: { type: "chat" } | { type: "session"; id: string } | { type: "file"; id: string };
  tabs: {
    // 旧格式（兼容）
    sessions: string[];
    files: FileTabState[];
    chatOpen: boolean;
    labels: Record<string, string>;
    // 新格式（可选，与旧字段共存）
    items?: AppTab[];
    activeId?: string | null;
  };
  panel: { active: string; closed: boolean; width: number };
  recent: { sessions: Record<string, number>; lastSessionId?: string };
}

type Listener = (state: WorkspaceUiState) => void;

function makeDefaultTabs() {
  return { sessions: [], files: [], chatOpen: true, labels: {} };
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

function readLS(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function readLegacyState(): Partial<WorkspaceUiState> {
  const partial: Partial<WorkspaceUiState> = {};
  partial.tabs = { sessions: [], files: [], chatOpen: readLS(OLD.CHAT_TAB) !== "0", labels: {} };

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
  partial.workspacePath = readLS(OLD.WS_KEY) || "";

  return partial;
}

// ─── 服务端读写 ────────────────────────────────────────

async function fetchServerState(): Promise<WorkspaceUiState | null> {
  try {
    const ws = readLS(OLD.WS_KEY) || "";
    const url = ws ? `/api/ui-state?workspace=${encodeURIComponent(ws)}` : "/api/ui-state";
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    // 服务端返回了完整新结构（含 schemaVersion/tabs）→ 直接使用
    if (data && data.schemaVersion === 2) return data as WorkspaceUiState;
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
function getState(): WorkspaceUiState { return _state; }

/** 启动时调用：优先从服务端读取新结构数据，否则从旧 localStorage 迁移 */
async function hydrate(): Promise<WorkspaceUiState> {
  let state = await fetchServerState();

  if (state && state.schemaVersion === 2) {
    _state = { ...DEFAULT_STATE, ...state };
    ensureTabsFormat(_state);
    _hydrated = true;
    saveNow();
    return _state;
  }

  // 降级：从旧 localStorage 迁移到新结构
  const legacy = readLegacyState();
  _state = { ...DEFAULT_STATE, ...legacy };
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
      items: tabs.items.map(tab => ({ ...tab })),
      activeId: tabs.activeId ?? null,
    } as any,
  };
}

/** 立即保存到服务端 */
async function saveNow(): Promise<boolean> {
  _saveTimer = null;
  if (!_hydrated) return false;
  if (!_state.workspacePath) {
    try { _state.workspacePath = localStorage.getItem(OLD.WS_KEY) || ""; } catch {}
  }
  try {
    const payload = serializeStateForSave(_state);
    const r = await fetch("/api/ui-state", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return r.ok;
  } catch { return false; }
}

function _notify(): void {
  for (const fn of _listeners) fn(_state);
}

// ─── 挂载到 window ────────────────────────────────────

(window as any).__uiStateStore = {
  hydrate, getState, patchState, subscribe, saveNow,
  isHydrated,
  /** 直接引用 _state 供已有代码同步（迁移期过渡用） */
  get _state() { return _state; },
  get _hydrated() { return _hydrated; },
};
