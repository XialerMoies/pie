/// <reference path="../dashboard.d.ts" />

/**
 * TabStore — 统一标签数据层
 *
 * 将 chat/session/file 三种标签合并为 tabs.items[] + tabs.activeId 单模型。
 * 通过 App.Tabs facade 暴露，持久化由 App.State 负责。
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
const tabStoreApp = (window as any).App || ((window as any).App = {});

function _ensureInit(): void {
  // State restoration is explicit through restoreTabs().
}

// ─── 辅助 ─────────────────────────────────────────────

function _syncToState(): void {
  tabStoreApp.State.syncTabs(_items, _activeId);
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

/** 用持久化快照原子恢复标签状态，不触发重复持久化。 */
export function restoreTabs(items: AppTab[], activeId: string | null): void {
  _items = items.map((tab, index) => ({ ...tab, order: index }));
  _activeId = activeId && _items.some(tab => tab.id === activeId) ? activeId : null;
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

/** 清空标签状态（不涉及行为注册）。 */
export function reset(): void {
  _items = [];
  _activeId = null;
  // 注意：不能清空 _behaviors —— 行为注册是模块级装配（file/session/chat 各自注册一次）。
  // workspace 切换等场景调用 reset() 时若清空，App.Tabs.activate/close 将找不到 handler，
  // 导致标签无法切换/关闭（回归 bug1/bug2）。
}

/** 关闭后自动选下一个 active：优先右侧相邻；若关闭的是最后一个则选左侧相邻 */
function _getNextActiveId(closedIdx: number): string | null {
  if (_items.length === 0) return null;
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
  activate(tab: AppTab, options?: SessionActivationOptions): void;
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
  restoreTabs, openTab, activateTab, closeTab, replaceTab, moveTab,
  getSessionTabIds, getFileTabIds,
  getActiveSessionTabId, getActiveFileTabId,
  reset,
  registerTabBehavior, getTabBehavior,
};

if (tabStoreApp.Tabs?._attachStore) tabStoreApp.Tabs._attachStore(_public);
else tabStoreApp.Tabs = _public;
