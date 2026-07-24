// ═══════════════════════════════════════════════════════════════════
//  会话管理
// ═══════════════════════════════════════════════════════════════════

interface SessionInfo {
  id: string;
  name: string;
  active: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt?: string;
  file: string;
  workspace?: string;
  pinned?: boolean;
  archived?: boolean;
  hasError?: boolean;
  isRunning?: boolean;
  branchFrom?: { id: string; name?: string };
}

type ThreadStatus = 'running' | 'error' | 'archived' | 'pinned' | 'success' | 'empty';

let _loadRetries = 0;
const MAX_LOAD_RETRIES = 8;
let _lastSessionRenderKey = '';
const SESSION_TABS_KEY = 'session-tabs';
const SESSION_TAB_LABELS_KEY = 'session-tab-labels';
const ACTIVE_SESSION_TAB_KEY = 'active-session-tab';
const DRAFT_SESSION_PREFIX = 'draft:';
let _sessionTabLookup = new Map<string, SessionInfo>();

function isDraftSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DRAFT_SESSION_PREFIX);
}

function createDraftSessionId(): string {
  return DRAFT_SESSION_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function normalizeSessionTabIds(ids: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function readSessionTabIds(): string[] {
  // TabStore 优先
  const tabs = (window as any).__tabs;
  if (tabs) { const ids = tabs.getSessionTabIds(); if (ids.length > 0) return ids; }
  // 降级：store → __state → localStorage
  const store = window.__state?._uiStateStore;
  if (store?.tabs?.sessions && Array.isArray(store.tabs.sessions)) return store.tabs.sessions;
  const stateIds = window.__state._sessionTabs;
  if (Array.isArray(stateIds) && stateIds.length > 0) return stateIds;
  try {
    const raw = localStorage.getItem(SESSION_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) return normalizeSessionTabIds(parsed);
  } catch {}
  window.__state._sessionTabs = [];
  return [];
}

function writeSessionTabIds(ids: string[]): void {
  const next = normalizeSessionTabIds(ids);
  window.__state._sessionTabs = next;
  // 同步到 TabStore（作为 adapter 写入）
  const tabs = (window as any).__tabs;
  if (tabs) {
    const existing = tabs.getSessionTabIds();
    for (const id of next) {
      if (!existing.includes(id)) {
        const isDraft = id.startsWith('draft:');
        tabs.openTab({
          kind: isDraft ? 'chat' : 'session',
          id,
          title: '新会话',
          ...(isDraft ? { draftId: id } : { sessionId: id }),
        });
      }
    }
    for (const id of existing) { if (!next.includes(id)) tabs.closeTab(id); }
  }
  // TabStore._syncToState 已处理 items → UiStateStore.tabs, 仅触发保存
  if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

let _getActiveSessionTabIdDepth = 0;
function getActiveSessionTabId(): string | null {
  // 递归防护（TabStore 初始化时序可能产生循环调用）
  if (_getActiveSessionTabIdDepth > 5) { _getActiveSessionTabIdDepth = 0; return null; }
  _getActiveSessionTabIdDepth++;
  try {
    const tabs = (window as any).__tabs;
    if (tabs) { const id = tabs.getActiveSessionTabId(); if (id) return id; }
    const store = window.__state?._uiStateStore;
    if (store?.activeView?.type === 'session' && store.activeView.id) {
      if (readSessionTabIds().includes(store.activeView.id)) return store.activeView.id;
    }
    const stateId = window.__state._activeSessionTabId;
    if (stateId && readSessionTabIds().includes(stateId)) return stateId;
    try { const id = localStorage.getItem(ACTIVE_SESSION_TAB_KEY); if (id && readSessionTabIds().includes(id)) return id; } catch {}
    return null;
  } finally { _getActiveSessionTabIdDepth--; }
}

function setActiveSessionTabId(id: string | null): void {
  window.__state._activeSessionTabId = id;
  // 同步到 TabStore（_syncToState 已处理 activeView → UiStateStore）
  const tabs = (window as any).__tabs;
  if (tabs) tabs.activateTab(id);
  // TabStore 不可用时回退触发保存
  if (!tabs && typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

function readOpenRealSessionIds(): Set<string> {
  return new Set(readSessionTabIds().filter(id => !isDraftSessionId(id)));
}

function readSessionTabLabels(): Record<string, string> {
  const store = window.__state?._uiStateStore;
  if (store?.tabs?.labels && Object.keys(store.tabs.labels).length > 0) return store.tabs.labels;
  let result: Record<string, string> = {};
  try { const raw = localStorage.getItem(SESSION_TAB_LABELS_KEY); const parsed = raw ? JSON.parse(raw) : {}; if (parsed && typeof parsed === 'object') result = parsed as Record<string, string>; } catch {}
  const stateLabels = (window.__state as any)._sessionTabLabels;
  if (stateLabels && typeof stateLabels === 'object') result = { ...result, ...stateLabels };
  return result;
}

function writeSessionTabLabel(id: string, label: string): void {
  if (!id || !label.trim()) return;
  const labels = { ...readSessionTabLabels(), [id]: label.trim() };
  (window.__state as any)._sessionTabLabels = labels;
  const store = window.__state?._uiStateStore;
  if (store) { store.tabs.labels = labels; if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave(); }
  // 同步到 TabStore 标题
  const tabs = (window as any).__tabs;
  if (tabs) tabs.replaceTab(id, { title: label.trim() });
}

function removeSessionTabLabel(id: string): void {
  const labels = { ...readSessionTabLabels() }; if (!(id in labels)) return; delete labels[id];
  (window.__state as any)._sessionTabLabels = labels;
  const store = window.__state?._uiStateStore;
  if (store) { store.tabs.labels = labels; if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave(); }
}

function commitSessionTab(draftId: string, sessionId: string, label?: string): void {
  if (!sessionId) return;
  // TabStore 原地升级（chat→session）
  const tabs = (window as any).__tabs;
  if (tabs && tabs.getTab(draftId)) {
    tabs.replaceTab(draftId, { kind: 'session', id: sessionId, sessionId, draftId: undefined, status: 'running' });
    tabs.activateTab(sessionId);
  }
  const ids = readSessionTabIds();
  const index = ids.indexOf(draftId);
  const next = index >= 0 ? ids.map(id => id === draftId ? sessionId : id) : [...ids, sessionId];
  writeSessionTabIds(next);

  const labels = readSessionTabLabels();
  const nextLabel = (label || labels[draftId] || '').trim();
  delete labels[draftId];
  if (nextLabel && nextLabel !== '新会话') labels[sessionId] = nextLabel;
  else delete labels[sessionId];
  (window.__state as any)._sessionTabLabels = labels;
  // 同步到 UiStateStore
  const store = window.__state?._uiStateStore;
  if (store) { store.tabs.labels = labels; if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave(); }

  setActiveSessionTabId(sessionId);
  renderSessionTabs(sessionId);
}

function rememberSessionTab(id: string): void {
  if (!id) return;
  const tabs = (window as any).__tabs;
  if (tabs && !tabs.getTab(id)) {
    const isDraft = id.startsWith('draft:');
    tabs.openTab({ kind: isDraft ? 'chat' : 'session', id, title: '新会话', ...(isDraft ? { draftId: id } : { sessionId: id }) });
  }
  const ids = readSessionTabIds();
  if (!ids.includes(id)) writeSessionTabIds([...ids, id]);
}

function forgetSessionTab(id: string): string | null {
  const ids = readSessionTabIds();
  const index = ids.indexOf(id);
  if (index < 0) return ids[0] || null;
  const next = ids.filter(tabId => tabId !== id);
  // 先算好 next，再关闭 TabStore（避免 closeTab 后 ids 已不含 id 导致 index 误判）
  const tabs = (window as any).__tabs;
  if (tabs) tabs.closeTab(id);
  writeSessionTabIds(next);
  removeSessionTabLabel(id);
  return next[Math.min(index, next.length - 1)] || next[index - 1] || null;
}

function indexSessionTabs(sessions: SessionInfo[], others: { project?: string; path?: string; sessions: SessionInfo[] }[]): void {
  const next = new Map<string, SessionInfo>();
  for (const session of sessions) next.set(session.id, session);
  for (const project of others) for (const session of project.sessions) next.set(session.id, session);
  _sessionTabLookup = next;
}

function sessionTabLabel(id: string): string {
  if (isDraftSessionId(id)) return readSessionTabLabels()[id] || '新会话';
  // 优先使用 localStorage 缓存的标签（用户重命名的名称）
  const cached = readSessionTabLabels()[id];
  if (cached) return cached;
  const session = _sessionTabLookup.get(id);
  if (session?.name && session.name.trim() !== '新会话') return session.name.trim();
  return '新会话';
}

/** @deprecated _syncMainArea 已接管主区切换，不再影响 activeId */
function focusChatView(): void {
  // no-op: _syncMainArea 根据 TabStore.activeId 自动切换主区显示
}

/** Session tab 渲染（已合并到 renderTabs，此函数仅触发 renderTabs） */
function renderSessionTabs(activeId?: string): void {
  // 确保旧字段 activeId 同步（renderTabs fallback 需要）
  if (activeId && !(window as any).__tabs?.getState?.().items?.length) {
    (window as any).__state._activeSessionTabId = activeId;
  }
  if (typeof (window as any).renderTabs === 'function') (window as any).renderTabs();
}

/** UiStateStore 保存快捷通道——通过 store 的 saveNow 写服务端 */
(window as any)._uiStateSave = function _uiStateSave(): void {
  const uis = (window as any).__uiStateStore;
  if (!uis?._state) return;
  const store = uis._state;
  const activeId = store.activeView?.type === 'session' ? store.activeView.id : null;
  if (activeId) {
    store.recent.lastSessionId = activeId;
    store.recent.sessions[activeId] = Date.now();
  }
  uis.saveNow();
};

/** 保存 UI 状态到服务端（不受随机端口影响） */
function saveUiState(): void {
  const tabs = (window as any).__tabs;
  // 确保 TabStore 同步到 UiStateStore（_syncToState 已处理 items/activeId 和 activeView）
  if (tabs) { tabs.getState(); } // 确保初始化
  const uis = (window as any).__uiStateStore;
  if (uis?._state) {
    const store = uis._state;
    const activeId = getActiveSessionTabId();
    store.panel.active = (window as any).__state?._activePanel || 'explorer';
    if (activeId) {
      store.recent.lastSessionId = activeId;
      store.recent.sessions[activeId] = Date.now();
    }
    uis.saveNow();
    return;
  }

  // 降级：没有 store 时用旧格式
  const ids = readSessionTabIds();
  const activeId = getActiveSessionTabId();
  const activePanel = (window as any).__state?._activePanel || 'explorer';
  try {
    fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        openSessionIds: ids,
        activeView: activeId ? { type: 'session', id: activeId } : { type: 'chat' },
        activePanel,
        panelClosed: false,
      }),
    }).catch(() => {});
  } catch {}
}

/** 启动时恢复完整 UI 状态：会话标签 + 活跃 session 消息 + 面板 */
async function restoreSessionTabs(): Promise<void> {
  // 先拉取会话元数据索引，确保顶部标签尽早显示正确标题
  fetchAndIndexSessions();

  // 从 UiStateStore hydrate（从服务端读，失败降级 localStorage）
  const uis = (window as any).__uiStateStore;
  if (uis?.hydrate) {
    const state = await uis.hydrate();
    window.__state._uiStateStore = state;
  }
  // hydrate 后立即恢复文件标签（确保 UiStateStore.tabs.items 可用，避免独立定时器的竞态）
  if (typeof (window as any).restoreFileTabs === 'function') (window as any).restoreFileTabs();
  // 从 hydrate 后的 store 读取状态（已含 workspace 隔离）
  const store = window.__state?._uiStateStore;
  const ids: string[] = store?.tabs?.sessions || readSessionTabIds();
  const activeId: string | null = store?.activeView?.type === 'session' ? store.activeView.id : getActiveSessionTabId() || null;
  const activePanel: string = store?.panel?.active || 'explorer';

  if (!activeId && ids.length === 0 && readSessionTabIds().length === 0) {
    return; // 无历史状态
  }

  // 回写 session-tabs + active-session-tab（同步 localStorage 供下游使用）
  writeSessionTabIds(ids);
  if (activeId) setActiveSessionTabId(activeId);
  renderSessionTabs(activeId || '');

  // 恢复左侧面板
  const appUI = (window as any).App?.UI;
  if (appUI?.restorePanel) appUI.restorePanel(activePanel);

  // 激活会话：加载消息
  if (activeId && !isDraftSessionId(activeId)) {
    try {
      const ws = localStorage.getItem(App.Constants.WS_KEY) || '';
      const r = await fetch('/api/sessions/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeId, workspace: ws }),
      });
      const data = await r.json() as {
        ok: boolean; messages?: Array<{ role: string; content: string; thinking?: string }>;
      };
      if (data.ok && Array.isArray(data.messages)) {
        const oldCS = window.__state.CS;
        if (oldCS) { oldCS.onmessage = null; oldCS.onerror = null; oldCS.close(); window.__state.CS = null; }
        window.__state.IL = false;
        App.Chat?.resetMsgKeys?.();
        window.__state.M = data.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          thinking: m.thinking || '',
          streaming: false,
          _compacted: (m as any)._compacted || false,
          turnId: (m as any).turnId || undefined,
          blocks: (m as any).blocks || undefined,
        }));
        if ((window as any).focusChatView) (window as any).focusChatView();
        const msgsEl = document.getElementById('ms');
        if (msgsEl) {
          msgsEl.innerHTML = window.__state.M.length > 0
            ? (window.msgs ? window.msgs() : '')
            : '<div class="wl"><h2>💬 新会话</h2><p>输入消息开始新的对话</p></div>';
        }
      }
    } catch { /* 静默降级 */ }
  }
  saveUiState();
}

/** 关闭当前 SSE 连接 + 重置忙状态 */
function _disposeActiveStream(): void {
  const oldCS = window.__state.CS;
  if (oldCS) { oldCS.onmessage = null; oldCS.onerror = null; oldCS.close(); window.__state.CS = null; }
  window.__state.IL = false;
}

/** 将 API 响应映射为 Message 数组 */
function _mapMessages(raw: any[]): Message[] {
  return (raw || []).map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
    thinking: m.thinking || '',
    streaming: false,
    _compacted: (m as any)._compacted || false,
    turnId: (m as any).turnId || undefined,
    blocks: (m as any).blocks || undefined,
  }));
}

/** 设置消息列表 + 刷新 UI + 记住会话 + 保存状态 */
function _applySessionMessages(data: { activeSessionId?: string; messages?: any[] }, fallbackId: string): void {
  App.Chat?.resetMsgKeys?.();
  window.__state.M = _mapMessages(data.messages);
  focusChatView();
  const msgsEl = $('ms');
  if (msgsEl) {
    msgsEl.innerHTML = window.__state.M.length > 0
      ? (window.msgs ? window.msgs() : '')
      : '<div class="wl"><h2>💬 新会话</h2><p>输入消息开始新的对话</p></div>';
    setTimeout(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }, 50);
  }
  const activeId = data.activeSessionId || fallbackId;
  if (activeId) { rememberSessionTab(activeId); setActiveSessionTabId(activeId); renderSessionTabs(activeId); }
  loadSessions();
  saveUiState();
}

/** 激活失败时的状态回滚 */
function _activateFailReset(): void {
  App.Chat?.resetMsgKeys?.();
  setActiveSessionTabId(null);
  window.__state.M = [];
  window.__state.IL = false;
  const oldCS = window.__state.CS;
  if (oldCS) { oldCS.onmessage = null; oldCS.onerror = null; oldCS.close(); window.__state.CS = null; }
  const ci = $('ci') as HTMLTextAreaElement | null;
  const cs = $('cs') as HTMLButtonElement | null;
  if (ci) { ci.disabled = false; ci.style.height = 'auto'; }
  if (cs) { cs.disabled = false; cs.title = '发送消息'; cs.innerHTML = window.S('iup', 16); }
}

/** 新草稿/空会话 */
function _setupDraftSession(id: string): void {
  rememberSessionTab(id);
  setActiveSessionTabId(id);
  App.Chat?.resetMsgKeys?.();
  window.__state.M = [];
  window.__state.IL = false;
  App.Chat?.clearAttachments?.();
  _disposeActiveStream();
  focusChatView();
  const ci = $('ci') as HTMLTextAreaElement | null;
  if (ci) { ci.value = ''; ci.style.height = 'auto'; }
  const msgsEl = $('ms');
  if (msgsEl) msgsEl.innerHTML = '<div class="wl"><h2>💬 新会话</h2><p>输入消息开始新的对话</p></div>';
  renderSessionTabs(id);
  loadSessions();
}

/** 保留向后兼容入口 */
function activateDraftSession(id: string): void {
  _setupDraftSession(id);
}

/** App.Tabs.close 的降级入口 */
function closeSessionTab(id: string): void {
  const T = (window as any).App?.Tabs;
  const ts = (window as any).__tabs;
  const tab = ts?.getTab?.(id);
  if (tab && (tab.kind === 'session' || tab.kind === 'chat')) {
    const handler = ts?.getTabBehavior?.(tab.kind);
    if (handler?.close) { handler.close(tab); return; }
  }
  // 降级
  const wasActive = getActiveSessionTabId() === id;
  const nextSessionId = forgetSessionTab(id);
  if (wasActive) {
    // 优先切换到其他会话标签
    if (nextSessionId) { renderSessionTabs(nextSessionId); switchSession(nextSessionId); return; }
    // 没有其他会话标签，但可能有文件标签 → 用 TabStore 自动选中的下一个
    const nextTab = ts?.getActiveTab?.();
    if (nextTab) {
      if (nextTab.kind === 'file') {
        setActiveSessionTabId(null);
        ts?.activateTab(nextTab.id);
        renderSessionTabs();
        loadSessions();
        saveUiState();
        return;
      }
      if (nextTab.kind === 'session' || nextTab.kind === 'chat') {
        renderSessionTabs(nextTab.id); switchSession(nextTab.id);
        return;
      }
    }
    // 真的没有其他标签了，才创建新会话
    App.Chat?.resetMsgKeys?.(); setActiveSessionTabId(null); window.__state.M = []; window.__state.IL = false; renderSessionTabs(''); const msgsEl = $('ms'); if (msgsEl) msgsEl.innerHTML = window.msgs ? window.msgs() : ''; loadSessions(); saveUiState();
    return;
  }
  renderSessionTabs(getActiveSessionTabId() || undefined);
  saveUiState();
}

function parseSessionTime(value?: string): number {
  if (!value) return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function formatSessionTime(value?: string): string {
  const time = parseSessionTime(value);
  if (!time) return '时间未知';
  const diff = Date.now() - time;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.max(1, Math.floor(diff / minute))} 分钟前`;
  if (diff < day) return `${Math.max(1, Math.floor(diff / hour))} 小时前`;
  if (diff < 7 * day) return `${Math.max(1, Math.floor(diff / day))} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(time));
}

function getSessionTimeValue(session: SessionInfo): number {
  return parseSessionTime(session.updatedAt || session.createdAt);
}

function isActiveSession(session: SessionInfo, openSessionIds: Set<string>): boolean {
  return openSessionIds.has(session.id);
}

function deriveThreadStatus(session: SessionInfo, activeId: string): ThreadStatus {
  if (session.archived) return 'archived';
  if (session.hasError) return 'error';
  if (session.isRunning) return 'running';
  if (session.pinned) return 'pinned';
  if (session.messageCount <= 0) return 'empty';
  return 'success';
}

function threadStatusLabel(status: ThreadStatus): string {
  if (status === 'running') return '运行中';
  if (status === 'error') return '需处理';
  if (status === 'archived') return '已归档';
  if (status === 'pinned') return '固定';
  if (status === 'empty') return '空线程';
  return '已完成';
}

function threadStatusHint(status: ThreadStatus): string {
  if (status === 'running') return '这条线程正在当前工作区推进';
  if (status === 'error') return '上次执行出现错误，建议先查看失败节点';
  if (status === 'archived') return '这条线程已归档，保留用于回看';
  if (status === 'pinned') return '固定线程会保留在顶部，方便继续';
  if (status === 'empty') return '这条线程还没有形成有效对话';
  return '这条任务线程可继续打开或作为分支起点';
}

function renderSessionEmptyState(title: string, message: string, actions: string[]): string {
  return `<div class="session-empty">
    <div class="session-empty-icon">${S('imsg', 20)}</div>
    <div class="session-empty-title">${E(title)}</div>
    <div class="session-empty-text">${E(message)}</div>
    <div class="session-empty-actions">${actions.join('')}</div>
  </div>`;
}

function renderSessionActions(): string {
  return `<div class="session-actions"><button class="sa-btn primary" onclick="newSession()">+ 新会话</button></div>`;
}

function renderSessionCard(session: SessionInfo, openSessionIds: Set<string>, scopeLabel: string): string {
  const name = session.name || '未命名会话';
  const messageText = session.messageCount > 0 ? `${session.messageCount} 条消息` : '暂无消息';
  const active = isActiveSession(session, openSessionIds);
  const status = deriveThreadStatus(session, active ? session.id : '');
  const timeText = formatSessionTime(session.updatedAt || session.createdAt);
  const className = `sess-item thread-item thread-${status}${active ? ' active' : ''}`;
  const pinTitle = session.pinned ? '取消固定' : '固定线程';
  const pinIcon = session.pinned ? S('ipin-off', 14) : S('ipin', 14);
  const branchText = session.branchFrom?.name ? `从 ${session.branchFrom.name} 分支` : session.branchFrom?.id ? '分支线程' : '';
  const hint = [threadStatusHint(status), messageText, scopeLabel, branchText].filter(Boolean).join(' · ');
  return `<div class="${className}" title="${E(hint)}" onclick="App.Tabs.activate('${session.id}')">
    <div class="thread-row">
      <div class="sess-info thread-info">
        <div class="sess-name thread-name">
          <span class="thread-title">${E(name)}</span>
        </div>
      </div>
      <div class="thread-time">${E(timeText)}</div>
      <div class="sess-ops thread-ops">
        <button class="sess-pin" title="${pinTitle}" aria-label="${pinTitle}" onclick="event.stopPropagation();pinSession('${session.id}',${session.pinned ? false : true})">${pinIcon}</button>
        <button class="sess-branch" title="创建分支" aria-label="创建分支" onclick="event.stopPropagation();branchSession('${session.id}')">${S('ibranch', 14)}</button>
        <button class="sess-rename" title="重命名" aria-label="重命名" onclick="event.stopPropagation();renameSession(this,'${session.id}')">${S('iedit', 14)}</button>
        <button class="sess-del" title="删除" aria-label="删除" onclick="event.stopPropagation();deleteSession('${session.id}')">${S('itrash', 14)}</button>
      </div>
    </div>
  </div>`;
}

function renderSessionGroup(title: string, hint: string, sessions: SessionInfo[], openSessionIds: Set<string>, scopeLabel: string): string {
  const count = sessions.length;
  const items = sessions.length > 0
    ? sessions.map(session => renderSessionCard(session, openSessionIds, scopeLabel)).join('')
    : `<div class="session-group-empty">${E(hint)}</div>`;
  return `<div class="session-group">
    <div class="session-group-head"><span>${E(title)}</span><span class="session-group-count">${count}</span></div>
    ${items}
  </div>`;
}

function buildSessionRenderKey(sessions: SessionInfo[], others: { project: string; path?: string; sessions: SessionInfo[] }[], openSessionIds: Set<string>): string {
  return JSON.stringify({
    openSessionIds: [...openSessionIds].sort(),
    sessions: sessions.map(session => ({
      id: session.id,
      name: session.name,
      active: session.active,
      messageCount: session.messageCount,
      updatedAt: session.updatedAt || session.createdAt,
      workspace: session.workspace || '',
      pinned: Boolean(session.pinned),
      archived: Boolean(session.archived),
      hasError: Boolean(session.hasError),
      isRunning: Boolean(session.isRunning),
      status: deriveThreadStatus(session, ''),
      branchFrom: session.branchFrom?.id || '',
    })),
    others: others.map(project => ({
      project: project.project,
      path: project.path || '',
      sessions: project.sessions.map(session => ({
        id: session.id,
        name: session.name,
        active: session.active,
        messageCount: session.messageCount,
        updatedAt: session.updatedAt || session.createdAt,
        pinned: Boolean(session.pinned),
        archived: Boolean(session.archived),
        hasError: Boolean(session.hasError),
        isRunning: Boolean(session.isRunning),
        status: deriveThreadStatus(session, ''),
        branchFrom: session.branchFrom?.id || '',
      })),
    })),
  });
}

function setSessionPanelStatus(text: string, kind: 'loading' | 'ready' | 'error' = 'ready'): void {
  void text;
  void kind;
}

/**
 * 仅拉取并索引会话元数据，不依赖 #sl DOM。
 * 启动时无论左栏是不是会话面板都调用，确保标签标题尽早回填。
 */
function fetchAndIndexSessions(): Promise<void> {
  const ws = localStorage.getItem(App.Constants.WS_KEY) || '';
  return fetch('/api/sessions?workspace=' + encodeURIComponent(ws) + '&other=1')
    .then(r => r.json())
    .then((data: { sessions?: SessionInfo[]; other?: { project: string; path?: string; sessions: SessionInfo[] }[]; error?: string }) => {
      if (data.error) return;
      const sessions = (data.sessions || []).slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
      const others = data.other || [];
      indexSessionTabs(sessions, others);
      const activeId = getActiveSessionTabId() || '';
      renderSessionTabs(activeId);
    })
    .catch(() => {});
}

function loadSessions(): void {
  const t0 = Date.now();
  const el = $('sl');
  if (!el) {
    // #sl 不存在时仍拉取数据索引，确保标签标题能回填
    fetchAndIndexSessions();
    _loadRetries++; if (_loadRetries > MAX_LOAD_RETRIES) return; console.log(`⏳ loadSessions retry #${_loadRetries}: no #sl`); setTimeout(loadSessions, 500); return;
  }
  _loadRetries = 0;
  const ws = localStorage.getItem(App.Constants.WS_KEY) || '';
  setSessionPanelStatus('正在刷新任务线程…', 'loading');
  el.classList.add('is-loading');
  console.log(`📋 loadSessions ws="${ws}"`);
  fetch('/api/sessions?workspace=' + encodeURIComponent(ws) + '&other=1').then(r => r.json()).then((data: { sessions?: SessionInfo[]; other?: { project: string; path?: string; sessions: SessionInfo[] }[]; activeSessionId?: string | null; error?: string }) => {
    console.log(`📋 loadSessions done in ${Date.now()-t0}ms, sessions=${data.sessions?.length}, other=${data.other?.length}`);
    if (!el) return;
    if (data.error) {
      _lastSessionRenderKey = '';
      el.classList.remove('is-loading');
      setSessionPanelStatus('加载失败', 'error');
      el.innerHTML = renderSessionEmptyState(
        '任务线程加载失败',
        data.error,
        [`<button class="sa-btn primary" onclick="loadSessions()">重新加载</button>`, `<button class="sa-btn" onclick="newSession()">+ 新会话</button>`],
      );
      return;
    }
    const activeId = getActiveSessionTabId() || '';
    const openSessionIds = readOpenRealSessionIds();
    const sessions = (data.sessions || []).slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
    const others = data.other || [];
    indexSessionTabs(sessions, others);
    renderSessionTabs(activeId);
    const renderKey = buildSessionRenderKey(sessions, others, openSessionIds);
      const needsInitialRender = !el.querySelector('.session-toolbar') && !el.querySelector('.session-empty') && !el.querySelector('.session-group');
      const hasChanged = needsInitialRender || renderKey !== _lastSessionRenderKey;
    const totalSessions = sessions.length + others.reduce((sum, project) => sum + project.sessions.length, 0);
    const pinnedSessions = sessions.filter(session => session.pinned);
    const activeSessions = sessions.filter(session => isActiveSession(session, openSessionIds));
    if (sessions.length === 0 && others.length === 0) {
      _lastSessionRenderKey = renderKey;
      el.classList.remove('is-loading');
      setSessionPanelStatus('暂无任务线程', 'ready');
      el.innerHTML = renderSessionEmptyState(
        '暂无任务线程',
        '新会话会出现在这里，按时间和活跃状态整理成可继续的任务线程。',
        [
          `<button class="sa-btn primary" onclick="newSession()">+ 新会话</button>`,
        ].filter(Boolean) as string[],
      );
      return;
    }

    const currentHint = activeSessions.length > 0
      ? '当前工作区里已打开的线程会高亮显示。'
      : '当前工作区还没有打开的线程。';

    const statusBits = [
      pinnedSessions.length > 0 ? `${pinnedSessions.length} 个固定` : '',
      activeSessions.length > 0 ? `${activeSessions.length} 个已打开` : '',
      others.length > 0 ? `${others.length} 个其他项目` : '',
    ].filter(Boolean);
    setSessionPanelStatus(statusBits.length > 0 ? `任务线程已刷新 · ${statusBits.join(' · ')}` : '任务线程已刷新', 'ready');
    el.classList.remove('is-loading');
    if (hasChanged) {
      let html = `<div class="session-toolbar">${renderSessionActions()}</div>`;
      if (pinnedSessions.length > 0) html += renderSessionGroup('固定线程', '固定的重要任务会留在这里。', pinnedSessions, openSessionIds, '当前项目');
      html += renderSessionGroup('当前工作区', currentHint, sessions.filter(session => !session.pinned), openSessionIds, '当前项目');

      if (others.length > 0) {
        html += `<div class="sess-other-header" data-label="其他项目 (${others.length})" onclick="toggleOtherSessions(this)">▸ 其他项目 (${others.length})</div>`;
        html += `<div class="sess-other-list" style="display:none">`;
        for (const proj of others) {
          const projLabel = proj.project === "未分类" ? "未分类（旧会话）" : E(proj.project);
          const projPath = proj.path ? ` <span class="sess-other-path">${E(proj.path)}</span>` : '';
          const otherSessions = proj.sessions.slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
          html += `<div class="sess-other-project"><div class="sess-other-title">${projLabel}${projPath}</div>`;
          html += otherSessions.map(s => renderSessionCard(s, openSessionIds, projLabel)).join('');
          html += `</div>`;
        }
        html += `</div>`;
      }

      el.innerHTML = html;
      _lastSessionRenderKey = renderKey;
    }
    if (!hasChanged) {
      console.log(`📋 loadSessions skipped redraw (${totalSessions} sessions unchanged)`);
    }
  }).catch(() => {
    const el = $('sl');
    if (el) {
      _lastSessionRenderKey = '';
      el.classList.remove('is-loading');
      setSessionPanelStatus('加载失败', 'error');
      el.innerHTML = renderSessionEmptyState(
        '网络错误',
        '会话列表暂时无法加载，可能是后端未启动或网络被中断。',
        [`<button class="sa-btn primary" onclick="loadSessions()">重新加载</button>`, `<button class="sa-btn" onclick="newSession()">+ 新会话</button>`],
      );
    }
    toast('加载会话列表失败', 'error');
  });
}

function toggleOtherSessions(header: HTMLElement): void {
  const list = header.nextElementSibling as HTMLElement | null;
  if (!list) return;
  const isOpen = list.style.display !== 'none';
  list.style.display = isOpen ? 'none' : 'block';
  const label = header.dataset.label || '其他项目';
  header.textContent = (isOpen ? '▸' : '▾') + ' ' + label;
}

function newSession(): void {
  const draftId = createDraftSessionId();
  _setupDraftSession(draftId);
  writeSessionTabLabel(draftId, '新会话');
  toast('已开启新会话', 'success');
}

function renameSession(el: HTMLElement, id: string): void {
  let item: HTMLElement | null = el;
  while (item && !item.classList.contains('sess-item')) item = item.parentNode as HTMLElement | null;
  if (!item) { toast('请稍后重试'); return; }
  const nameEl = item.querySelector('.thread-title') as HTMLElement | null;
  if (!nameEl) { toast('请稍后重试'); return; }
  const oldName = nameEl.textContent || '';
  const input = document.createElement('input');
  input.type = 'text'; input.value = oldName;
  input.className = 'sess-rename-input';
  input.style.cssText = 'width:100%;padding:2px 4px;border-radius:4px;border:1px solid var(--am);background:var(--bc);color:var(--tx);font-size:.72rem;font-family:var(--fb);outline:none;box-sizing:border-box';
  nameEl.innerHTML = ''; nameEl.appendChild(input);
  input.focus(); input.select();
  const nm = nameEl; // 闭包捕获，类型已收窄
  function save(): void {
    const val = input.value.trim();
    if (val && val !== oldName) {
      fetch('/api/sessions/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: val }) })
        .then(r => r.json()).then((r: { ok: boolean }) => {
          if (r.ok) { _lastSessionRenderKey = ''; writeSessionTabLabel(id, val); renderSessionTabs(id); toast('已重命名'); loadSessions(); }
          else { nm.textContent = oldName; toast('重命名失败'); }
        }).catch(() => { nm.textContent = oldName; toast('重命名失败'); });
    } else { nm.textContent = oldName; }
  }
  input.onkeydown = function (e: KeyboardEvent) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } };
  input.onblur = save;
}

async function deleteSession(id: string): Promise<void> {
  const ok = await confirmAsync('确定删除此会话？');
  if (!ok) return;
  const t0 = Date.now();
  console.log(`🗑️ Deleting session: ${id}`);

  // 先关闭 SSE
  const oldCS = window.__state.CS;
  if (oldCS) { oldCS.onmessage = null; oldCS.onerror = null; oldCS.close(); window.__state.CS = null; }

  fetch('/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    .then(r => r.json()).then((r: { ok: boolean }) => {
      if (r.ok) {
        console.log(`🗑️ Session deleted in ${Date.now()-t0}ms`);
        toast('已删除');

        // forgetSessionTab 会调用 TabStore.closeTab 自动选下一个标签
        const nextId = forgetSessionTab(id);
        const ts = (window as any).__tabs;

        if (nextId) {
          // 有下一个会话标签 → 切换到它
          renderSessionTabs(nextId); switchSession(nextId);
        } else {
          // 没有其他会话标签
          App.Chat?.resetMsgKeys?.();
          window.__state.M = [];
          window.__state.IL = false;

          const nextTab = ts?.getActiveTab?.();
          if (nextTab?.kind === 'file') {
            // 有文件标签 → 保持文件标签
          } else {
            // 真的没有其他标签了 → 欢迎页
            setActiveSessionTabId(null);
            const msgsEl = $('ms');
            if (msgsEl) { msgsEl.innerHTML = window.msgs ? window.msgs() : ''; msgsEl.scrollTop = 0; }
          }
        }

        // 重置输入框
        const ci = $('ci') as HTMLTextAreaElement | null;
        if (ci) { ci.disabled = false; ci.value = ''; ci.style.height = 'auto'; }
        const cs = $('cs') as HTMLButtonElement | null;
        if (cs) { cs.disabled = false; cs.title = '发送消息'; cs.innerHTML = window.S('iz', 16); }
        loadSessions();
      }
      else toast('删除失败');
    }).catch((err) => { console.error('🗑️ Delete failed:', err); toast('删除失败'); });
}

function pinSession(id: string, pinned: boolean): void {
  fetch('/api/sessions/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, pinned }),
  }).then(r => r.json()).then((r: { ok?: boolean; error?: string }) => {
    if (!r.ok) { toast('固定失败: ' + (r.error || ''), 'error'); return; }
    toast(pinned ? '已固定线程' : '已取消固定', 'success');
    _lastSessionRenderKey = '';
    loadSessions();
  }).catch(() => toast('固定失败', 'error'));
}

function branchSession(id: string): void {
  const ws = localStorage.getItem(App.Constants.WS_KEY) || '';
  fetch('/api/sessions/branch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, workspace: ws }),
  }).then(r => r.json()).then((data: { ok?: boolean; id?: string; activeSessionId?: string; messages?: Array<{ role: string; content: string; thinking?: string }>; error?: string }) => {
    if (!data.ok || data.error) { toast('创建分支失败: ' + (data.error || ''), 'error'); return; }
    const oldCS = window.__state.CS;
    if (oldCS) { oldCS.onmessage = null; oldCS.onerror = null; oldCS.close(); window.__state.CS = null; }
    window.__state.IL = false;
    App.Chat?.resetMsgKeys?.();
    window.__state.M = (data.messages || []).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, thinking: m.thinking || '', streaming: false, _compacted: (m as any)._compacted || false, turnId: (m as any).turnId || undefined, blocks: (m as any).blocks || undefined }));
    focusChatView();
    const activeId = data.activeSessionId || data.id || '';
    if (activeId) {
      
      rememberSessionTab(activeId);
      setActiveSessionTabId(activeId);
      renderSessionTabs(activeId);
    }
    const msgsEl = $('ms');
    if (msgsEl) { msgsEl.innerHTML = window.msgs ? window.msgs() : ''; setTimeout(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }, 50); }
    toast('已创建分支线程', 'success');
    loadSessions();
  }).catch(() => toast('创建分支失败', 'error'));
}

/** App.Tabs.activate 的降级入口（当 handler/fallback 调用时保留完整逻辑） */
function switchSession(id: string): void {
  const T = (window as any).App?.Tabs;
  const ts = (window as any).__tabs;
  const tab = ts?.getTab?.(id);
  if (tab && (tab.kind === 'session' || tab.kind === 'chat')) {
    const handler = ts?.getTabBehavior?.(tab.kind);
    if (handler?.activate) { handler.activate(tab); return; }
  }
  // 降级：TabStore 无此 tab 时直接执行（兼容测试/未迁移场景）
  if (isDraftSessionId(id)) { _setupDraftSession(id); return; }
  const ws = localStorage.getItem(App.Constants.WS_KEY) || '';
  fetch('/api/sessions/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, workspace: ws }) })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data: any) => {
      if (!data.ok || data.error) { toast('加载失败: ' + (data.error || '')); return; }
      _disposeActiveStream();
      _applySessionMessages(data, id);
      toast('已切换到会话 (' + window.__state.M.length + ' 条消息)');
    }).catch(() => { _activateFailReset(); toast('会话已失效'); loadSessions(); });
}

// 公开 API
window.loadSessions = loadSessions;
(window as any).readSessionTabIds = readSessionTabIds;
(window as any).writeSessionTabIds = writeSessionTabIds;
(window as any).sessionTabLabel = sessionTabLabel;
window.newSession = newSession;
window.renameSession = renameSession as any;
window.deleteSession = deleteSession;
window.pinSession = pinSession as any;
window.branchSession = branchSession as any;
(window as any).commitSessionTab = commitSessionTab;
(window as any).getActiveSessionTabId = getActiveSessionTabId;
(window as any).setActiveSessionTabId = setActiveSessionTabId;
(window as any).renderSessionTabs = renderSessionTabs;
(window as any).migrateSessionTabLabels = migrateSessionTabLabels;
(window as any).switchSession = switchSession;

// ─── App 命名空间绑定 ──────────────────────────────────────
const AppSess = (window as any).App?.Session;
if (AppSess) {
  AppSess.loadSessions = loadSessions;
  AppSess.newSession = newSession;
  AppSess.renameSession = renameSession;
  AppSess.deleteSession = deleteSession;
  AppSess.pinSession = pinSession;
  AppSess.branchSession = branchSession;
  AppSess.commitSessionTab = commitSessionTab;
  AppSess.getActiveSessionTabId = getActiveSessionTabId;
  AppSess.setActiveSessionTabId = setActiveSessionTabId;
  AppSess.renderSessionTabs = renderSessionTabs;
  AppSess.restoreSessionTabs = restoreSessionTabs;
  AppSess.saveUiState = saveUiState;
  AppSess.switchSession = switchSession;
}

// ─── Session/Chat handler（Phase 2：真实行为入口）────────
function _sessionActivate(tab: AppTab): void {
  if (tab.kind === 'chat' || isDraftSessionId(tab.id)) {
    _setupDraftSession(tab.id);
    return;
  }
  const ws = localStorage.getItem(App.Constants.WS_KEY) || '';
  fetch('/api/sessions/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tab.id, workspace: ws }),
  }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then((data: { ok: boolean; activeSessionId?: string; messages?: any[]; error?: string }) => {
    if (!data.ok || data.error) { toast('加载失败: ' + (data.error || '')); return; }
    _disposeActiveStream();
    _applySessionMessages(data, tab.id);
    toast('已切换到会话 (' + window.__state.M.length + ' 条消息)');
  }).catch(() => { _activateFailReset(); toast('会话已失效'); loadSessions(); });
}

function _sessionClose(tab: AppTab): void {
  // 必须在 forgetSessionTab 之前捕获 activeId（TabStore 会在 closeTab 后更新 activeId）
  const wasActive = getActiveSessionTabId() === tab.id;
  const nextId = forgetSessionTab(tab.id);
  const activeId = getActiveSessionTabId() || '';
  if (wasActive) {
    if (nextId) {
      // 先同步更新 DOM（让标签立即消失）
      renderSessionTabs(nextId);
      // 再异步激活下个 tab（加载消息、刷新列表）
      const tabs = (window as any).__tabs;
      const nextTab = tabs?.getTab?.(nextId);
      if (nextTab) { const handler = tabs?.getTabBehavior?.(nextTab.kind); handler?.activate?.(nextTab); }
      else switchSession(nextId);
    } else {
      App.Chat?.resetMsgKeys?.();
      setActiveSessionTabId(null);
      window.__state.M = [];
      window.__state.IL = false;
      renderSessionTabs('');
      const msgsEl = $('ms');
      if (msgsEl) msgsEl.innerHTML = window.msgs ? window.msgs() : '';
      loadSessions();
      saveUiState();
    }
    return;
  }
  renderSessionTabs(activeId);
  saveUiState();
}

// ─── TabBehavior 注册 ───────────────────────────────
{ const tabs = (window as any).__tabs;
  if (tabs?.registerTabBehavior) {
    tabs.registerTabBehavior('chat', {
      activate(tab: AppTab) { _sessionActivate(tab); },
      close(tab: AppTab) { _sessionClose(tab); },
    });
    tabs.registerTabBehavior('session', {
      activate(tab: AppTab) { _sessionActivate(tab); },
      close(tab: AppTab) { _sessionClose(tab); },
    });
  }
}

// ─── 启动时迁移 ───────────────────────────────────

/** 清理历史脏数据：值为"新会话"或看起来像 session ID 的缓存标签 */
function migrateSessionTabLabels(): void {
  try {
    const labels = readSessionTabLabels();
    let changed = false;
    for (const [id, label] of Object.entries(labels)) {
      if (label === '新会话' || /^会话 [a-f0-9]{6}$/.test(label)) {
        delete (labels as Record<string, string>)[id];
        changed = true;
      }
    }
    if (changed) {
      (window.__state as any)._sessionTabLabels = labels;
      const store = window.__state?._uiStateStore;
      if (store) { store.tabs.labels = labels; if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave(); }
    }
  } catch {}
}
migrateSessionTabLabels();

// 窗口关闭前保存 UI 状态
try { window.addEventListener('beforeunload', () => saveUiState()); } catch {}
