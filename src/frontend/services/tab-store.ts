/**
 * TabStore — 统一标签数据层
 *
 * 将 chat/session/file 三种标签合并为 tabs.items[] + tabs.activeId 单模型。
 * 挂载到 window.__tabs 和 window.__state.tabs。
 *
 * Layer 1 只做数据统一，不碰 DOM 渲染。
 */

// ─── 类型 ───────────────────────────────────────────────

export type TabKind = 'chat' | 'session' | 'file';

export interface AppTab {
  id: string;                    // file path / session id / chat:<ts>-<rand>
  kind: TabKind;
  title: string;
  order: number;                 // 数组索引即顺序（持久化时写入）
  status?: 'idle' | 'running' | 'error' | 'restoring';
  dirty?: boolean;               // 仅 file 使用
  // kind 专属数据
  path?: string;                 // file 专用：文件路径
  content?: string;              // file 专用：编辑器内容缓存
  lang?: string;                 // file 专用：语法高亮语言
  renderer?: 'text' | 'image' | 'video'; // file 专用：渲染器类型
  sessionId?: string;            // session 专用：真实 session id
  draftId?: string;              // chat 专用：草稿前缀 draft:<ts>-<rand>
}

export interface TabsState {
  items: AppTab[];
  activeId: string | null;       // null = 空主区
}

// ─── 内部状态 ──────────────────────────────────────────

let _items: AppTab[] = [];
let _activeId: string | null = null;
let _initialized = false;

// ─── 初始化 ──────────────────────────────────────────

/** 从 __state 构建初始 tab 列表（合并新旧格式） */
function _init(): void {
  if (_initialized) return;
  _initialized = true;

  const st = (window as any).__state;

  // 优先从新格式 __state.tabs 恢复
  if (st?.tabs?.items && Array.isArray(st.tabs.items)) {
    _items = st.tabs.items.map((t: any, i: number) => ({ ...t, order: i }));
    _activeId = st.tabs.activeId ?? null;
    return;
  }

  // 降级：从旧字段构建
  const items: AppTab[] = [];
  const fileTabs: Array<{ id: string; label: string }> = st?._fileTabs ?? [];
  for (const ft of fileTabs) {
    items.push({ id: ft.id, kind: 'file', title: ft.label, order: items.length, path: ft.id });
  }
  const sessionTabs: string[] = st?._sessionTabs ?? [];
  const labels: Record<string, string> = st?._sessionTabLabels ?? {};
  for (const sid of sessionTabs) {
    const isDraft = sid.startsWith('draft:');
    items.push({
      id: sid,
      kind: isDraft ? 'chat' : 'session',
      title: labels[sid] || (isDraft ? '新会话' : '新会话'),
      order: items.length,
      ...(isDraft ? { draftId: sid } : { sessionId: sid }),
    });
  }

  _items = items;

  // activeId 优先从新格式读，其次 _activeSessionTabId
  // _activeFileTab 已改为 TabStore getter，初始化时序下返回 null，不再作为降级源
  if (st?.tabs?.activeId) {
    _activeId = st.tabs.activeId;
  } else if (st?._activeSessionTabId) {
    _activeId = st._activeSessionTabId;
  }
}

function _ensureInit(): void {
  if (!_initialized) _init();
}

// ─── 辅助 ─────────────────────────────────────────────

function _syncToState(): void {
  const st = (window as any).__state;
  if (!st) return;
  st.tabs = { items: _items, activeId: _activeId };
  // 同步到 UiStateStore 并触发保存
  // NOTE: 不能用 st._uiStateStore（那是 hydrate 设的原始 WorkspaceUiState 对象，没有 _state getter）
  // 必须用 __uiStateStore 包装器访问模块内部的 _state
  const uisWrapper = (window as any).__uiStateStore;
  if (uisWrapper && uisWrapper._state) {
    const state = uisWrapper._state;
    state.tabs = state.tabs || {};
    state.tabs.items = _items.map(t => ({ ...t }));
    state.tabs.activeId = _activeId;
    // 同步旧格式字段保持兼容
    state.tabs.sessions = _items.filter(t => t.kind === 'session' || t.kind === 'chat').map(t => t.id);
    const activeFile = _items.find(t => t.id === _activeId && t.kind === 'file');
    const activeSession = _items.find(t => t.id === _activeId && (t.kind === 'session' || t.kind === 'chat'));
    if (activeFile) state.activeView = { type: 'file', id: activeFile.id };
    else if (activeSession) state.activeView = { type: 'session', id: activeSession.id };
    else state.activeView = { type: 'chat' };
    if (typeof uisWrapper.saveNow === 'function') uisWrapper.saveNow();
  }
}

// ─── 公开 API ─────────────────────────────────────────

export function getState(): TabsState {
  _ensureInit();
  return { items: [..._items], activeId: _activeId };
}

export function getTabs(): AppTab[] {
  _ensureInit();
  return [..._items];
}

export function getActiveTab(): AppTab | null {
  _ensureInit();
  if (!_activeId) return null;
  return _items.find(t => t.id === _activeId) ?? null;
}

export function getTab(id: string): AppTab | undefined {
  _ensureInit();
  return _items.find(t => t.id === id);
}

/** 追加新标签到末尾 */
export function openTab(tab: Omit<AppTab, 'order'>): AppTab {
  _ensureInit();
  const full: AppTab = { ...tab, order: _items.length };
  _items.push(full);
  _syncToState();
  return full;
}

/** 设置 activeId，null = 空主区 */
export function activateTab(id: string | null): void {
  _ensureInit();
  if (id !== null && !_items.find(t => t.id === id)) return; // id 不在列表中则忽略
  _activeId = id;
  _syncToState();
}

/** 关闭标签：移除并返回，自动切换 activeId */
export function closeTab(id: string): AppTab | undefined {
  _ensureInit();
  const idx = _items.findIndex(t => t.id === id);
  if (idx < 0) return undefined;
  const removed = _items.splice(idx, 1)[0];

  // 如果关闭的是当前 active，自动切换到下一个
  if (_activeId === id) {
    _activeId = _getNextActiveId(idx);
  }

  // 重排 order
  _items.forEach((t, i) => { t.order = i; });

  _syncToState();
  return removed;
}

/** 局部更新标签（chat→session 升级用） */
export function replaceTab(id: string, updates: Partial<AppTab>): AppTab | undefined {
  _ensureInit();
  const idx = _items.findIndex(t => t.id === id);
  if (idx < 0) return undefined;
  _items[idx] = { ..._items[idx], ...updates, order: idx };
  // 如果 id 变了，activeId 也要同步更新
  if (updates.id && _activeId === id) _activeId = updates.id;
  _syncToState();
  return _items[idx];
}

/** 拖拽重排 */
export function moveTab(from: number, to: number): void {
  _ensureInit();
  if (from < 0 || from >= _items.length || to < 0 || to >= _items.length) return;
  const moved = _items.splice(from, 1)[0];
  _items.splice(to, 0, moved);
  _items.forEach((t, i) => { t.order = i; });
  _syncToState();
}

/** 重置（测试用） */
export function reset(): void {
  _items = [];
  _activeId = null;
  _initialized = false;
  _behaviors.clear();
}

/** 关闭后自动选下一个 active */
function _getNextActiveId(closedIdx: number): string | null {
  if (_items.length === 0) return null;
  // 优先选左侧相邻，否则选右侧相邻
  const nextIdx = Math.min(closedIdx, _items.length - 1);
  return _items[nextIdx]?.id ?? null;
}

/** TabStore 在旧 _sessionTabs 中的投影（adapter 用） */
export function getSessionTabIds(): string[] {
  _ensureInit();
  return _items.filter(t => t.kind === 'session' || t.kind === 'chat').map(t => t.id);
}

/** TabStore 在旧 _fileTabs 中的投影（adapter 用） */
export function getFileTabIds(): string[] {
  _ensureInit();
  return _items.filter(t => t.kind === 'file').map(t => t.id);
}

/** TabStore activeId 映射到旧 getActiveSessionTabId 语义 */
export function getActiveSessionTabId(): string | null {
  _ensureInit();
  const tab = _items.find(t => t.id === _activeId);
  if (tab && (tab.kind === 'session' || tab.kind === 'chat')) return tab.id;
  return null;
}

/** TabStore activeId 映射到旧 _activeFileTab 语义 */
export function getActiveFileTabId(): string | null {
  _ensureInit();
  const tab = _items.find(t => t.id === _activeId);
  if (tab && tab.kind === 'file') return tab.id;
  return null;
}

// ─── TabBehaviorRegistry ──────────────────────────────

export interface TabBehavior {
  activate(tab: AppTab): void;
  close(tab: AppTab): void;
  contextMenu?(e: MouseEvent, tab: AppTab): void;
}

const _behaviors = new Map<TabKind, TabBehavior>();

export function registerTabBehavior(kind: TabKind, behavior: TabBehavior): void {
  _behaviors.set(kind, behavior);
}

export function getTabBehavior(kind: TabKind): TabBehavior | undefined {
  return _behaviors.get(kind);
}

// ─── 挂载到 window ────────────────────────────────────

const _public = {
  getState, getTabs, getActiveTab, getTab,
  openTab, activateTab, closeTab, replaceTab, moveTab,
  getSessionTabIds, getFileTabIds,
  getActiveSessionTabId, getActiveFileTabId,
  reset,
  registerTabBehavior, getTabBehavior,
};

(window as any).__tabs = _public;
