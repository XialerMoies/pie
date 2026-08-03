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
  titleSource?: SessionTitleSource;
  archived?: boolean;
  hasError?: boolean;
  isRunning?: boolean;
  branchFrom?: { id: string; name?: string };
}

type ThreadStatus = 'running' | 'error' | 'archived' | 'pinned' | 'success' | 'empty';
type SessionTitleSource = 'auto' | 'manual';

let _loadRetries = 0;
const MAX_LOAD_RETRIES = 8;
let _lastSessionRenderKey = '';

/** 会话列表缓存：fetchSessionIndex 写入，renderSessionPanel 读取 */
interface SessionDataCache {
  sessions: SessionInfo[];
  others: { project: string; path?: string; sessions: SessionInfo[] }[];
}
let _sessionDataCache: SessionDataCache | null = null;

let _sessionListSeq = 0;
const DRAFT_SESSION_PREFIX = 'draft:';
let _sessionTabLookup = new Map<string, SessionInfo>();
let _sessionRestorePromise: Promise<void> | null = null;

function bumpSessionListSeq(): number {
  _sessionListSeq += 1;
  return _sessionListSeq;
}

function isCurrentSessionListSeq(seq: number): boolean {
  return seq === _sessionListSeq;
}

function isDraftSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DRAFT_SESSION_PREFIX);
}

function createDraftSessionId(): string {
  return DRAFT_SESSION_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function ensureDraftSessionTab(): string {
  const activeId = getActiveSessionTabId();
  if (activeId) return activeId;
  const id = createDraftSessionId();
  rememberSessionTab(id);
  setActiveSessionTabId(id);
  renderSessionTabs(id);
  return id;
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
  const tabs = App.Tabs;
  return tabs?.getSessionTabIds ? tabs.getSessionTabIds() : [];
}

function writeSessionTabIds(ids: string[]): void {
  const next = normalizeSessionTabIds(ids);
  // 同步到 TabStore（作为 adapter 写入）
  const tabs = App.Tabs;
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
    const tabs = App.Tabs;
    return tabs?.getActiveSessionTabId ? tabs.getActiveSessionTabId() : null;
  } finally { _getActiveSessionTabIdDepth--; }
}

function setActiveSessionTabId(id: string | null): void {
  // 同步到 TabStore（_syncToState 已处理 activeView → UiStateStore）
  const tabs = App.Tabs;
  if (tabs) tabs.activateTab(id);
  // TabStore 不可用时回退触发保存
  if (!tabs && typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

function readOpenRealSessionIds(): Set<string> {
  return new Set(readSessionTabIds().filter(id => !isDraftSessionId(id)));
}

function readSessionTabLabels(): Record<string, string> {
  return { ...App.State.getSnapshot().tabs.labels };
}

function normalizeTitleSource(value: unknown): SessionTitleSource | undefined {
  return value === 'auto' || value === 'manual' ? value : undefined;
}

function readSessionTitleSources(): Record<string, SessionTitleSource> {
  let result: Record<string, SessionTitleSource> = {};
  const storeSources = App.State.getSnapshot().tabs.titleSources;
  if (storeSources && typeof storeSources === 'object') {
    for (const [id, source] of Object.entries(storeSources)) {
      const normalized = normalizeTitleSource(source);
      if (normalized) result[id] = normalized;
    }
  }
  return result;
}

function writeSessionTitleSources(sources: Record<string, SessionTitleSource>): void {
  App.State.updateSessionMetadata(readSessionTabLabels(), sources);
}

function writeSessionTitleSource(id: string, source: SessionTitleSource): void {
  if (!id) return;
  writeSessionTitleSources({ ...readSessionTitleSources(), [id]: source });
}

function removeSessionTitleSource(id: string): void {
  const sources = { ...readSessionTitleSources() };
  if (!(id in sources)) return;
  delete sources[id];
  writeSessionTitleSources(sources);
}

function writeSessionTabLabel(id: string, label: string, source?: SessionTitleSource): void {
  if (!id || !label.trim()) return;
  const labels = { ...readSessionTabLabels(), [id]: label.trim() };
  App.State.updateSessionMetadata(labels, readSessionTitleSources());
  // 同步到 TabStore 标题
  const tabs = App.Tabs;
  if (tabs) tabs.replaceTab(id, { title: label.trim() });
  if (source) writeSessionTitleSource(id, source);
}

function removeSessionTabLabel(id: string): void {
  const labels = { ...readSessionTabLabels() };
  if (id in labels) {
    delete labels[id];
    App.State.updateSessionMetadata(labels, readSessionTitleSources());
  }
  removeSessionTitleSource(id);
}

function commitSessionTab(draftId: string, sessionId: string, label?: string): void {
  if (!sessionId) return;
  // TabStore 原地升级（chat→session）
  const tabs = App.Tabs;
  if (tabs && tabs.getTab(draftId)) {
    tabs.replaceTab(draftId, { kind: 'session', id: sessionId, sessionId, draftId: undefined, status: 'running' });
    tabs.activateTab(sessionId);
  }
  const ids = readSessionTabIds();
  const index = ids.indexOf(draftId);
  const next = index >= 0 ? ids.map(id => id === draftId ? sessionId : id) : [...ids, sessionId];
  writeSessionTabIds(next);

  const labels = readSessionTabLabels();
  const sources = readSessionTitleSources();
  const nextLabel = (label || labels[draftId] || '').trim();
  const nextSource = sources[draftId] || (label && nextLabel !== '新会话' ? 'manual' : undefined);
  delete labels[draftId];
  delete sources[draftId];
  if (nextLabel && nextLabel !== '新会话') labels[sessionId] = nextLabel;
  else delete labels[sessionId];
  if (nextSource && nextLabel && nextLabel !== '新会话') sources[sessionId] = nextSource;
  else delete sources[sessionId];
  App.State.updateSessionMetadata(labels, sources);

  setActiveSessionTabId(sessionId);
  renderSessionTabs(sessionId);
}

function rememberSessionTab(id: string): void {
  if (!id) return;
  const tabs = App.Tabs;
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
  const tabs = App.Tabs;
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
  // 优先使用 UiStateStore 缓存的标签（用户重命名的名称）
  const cached = readSessionTabLabels()[id];
  if (cached) return cached;
  const session = _sessionTabLookup.get(id);
  if (session?.name && session.name.trim() !== '新会话') return session.name.trim();
  return '新会话';
}

function isGenericSessionTitle(title: string): boolean {
  const clean = title.trim();
  return !clean
    || clean === '新会话'
    || clean === '未命名会话'
    || /^会话\s+[a-f0-9]{4,}$/i.test(clean)
    || /^新的?(任务|会话|对话)$/.test(clean);
}

function isLowValueTitleCandidate(text: string): boolean {
  const clean = text.replace(/\s+/g, '').replace(/[。.!！?？,，、；;:：]+/g, '');
  return clean.length < 3
    || /^(可以|好|好的|嗯|对|是的|行|继续|做吧|改吧|试试|修|收到|完成了|什么意思|真的吗)$/.test(clean);
}

function truncateSessionTitle(title: string, max = 28): string {
  const clean = title.trim();
  return clean.length > max ? clean.slice(0, max).trimEnd() + '…' : clean;
}

function cleanTitleCandidate(text: string): string {
  let clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/[*_#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  clean = clean
    .replace(/^仅解释，不要修改任何文件或执行命令。/, '')
    .replace(/^不要执行任何操作。输出结构化方案：目标 → 步骤 → 涉及文件 → 风险。/, '')
    .replace(/^请进行?深度分析，考虑多种可能性和边界情况。/, '')
    .replace(/^请深入分析，考虑边界情况。/, '')
    .replace(/^简要回答即可。/, '')
    .trim();
  clean = clean
    .replace(/^注意到.*?了吗[，,]\s*/, '')
    .replace(/^(请帮我|请帮忙|麻烦你?|帮我|帮忙|可以|能不能|能否|看看|看一下|审查一下|分析一下|实现一下|改一下|修一下|请)\s*/, '')
    .replace(/^[。.!！?？,，、；;:：\s]+/g, '')
    .trim();
  const sentenceParts = clean.split(/[。！？!?]\s*/).filter(Boolean);
  if (sentenceParts.length > 0) clean = sentenceParts[0].trim();
  clean = clean
    .replace(/^(关于|有关)\s*/, '')
    .replace(/[。.!！?？,，、；;:：\s]+$/g, '')
    .trim();
  return truncateSessionTitle(clean);
}

function scoreTitleCandidate(candidate: string, recency: number): number {
  if (!candidate || isLowValueTitleCandidate(candidate)) return -100;
  let score = recency;
  if (candidate.length >= 6 && candidate.length <= 36) score += 5;
  if (/[A-Za-z_][\w.-]*/.test(candidate)) score += 2;
  if (/(bug|问题|报错|失败|修复|实现|优化|重构|安全|权限|标题|标签|会话|菜单|测试|方案|架构|搜索|文件|命令|解析)/i.test(candidate)) score += 4;
  if (/[\u4e00-\u9fff]/.test(candidate)) score += 1;
  if (candidate.length > 48) score -= 4;
  return score;
}

function deriveAutoSessionTitle(messages: Message[], assistantText?: string): string {
  let best = '';
  let bestScore = -Infinity;
  const recentUsers = messages
    .map((msg, index) => ({ msg, index }))
    .filter(item => item.msg.role === 'user' && item.msg.content.trim())
    .slice(-8);
  for (let i = recentUsers.length - 1; i >= 0; i--) {
    const candidate = cleanTitleCandidate(recentUsers[i].msg.content);
    const score = scoreTitleCandidate(candidate, recentUsers.length - i);
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  if (bestScore > -100 && best) return best;
  const fallback = cleanTitleCandidate(assistantText || '');
  return isLowValueTitleCandidate(fallback) ? '' : fallback;
}

function canAutoTitleSession(id: string): boolean {
  if (!id || isDraftSessionId(id)) return false;
  const source = readSessionTitleSources()[id];
  if (source === 'manual') return false;
  const indexedSource = _sessionTabLookup.get(id)?.titleSource;
  if (indexedSource === 'manual') return false;
  const label = sessionTabLabel(id);
  if (!isGenericSessionTitle(label)) return false;
  return true;
}

async function maybeAutoTitleSession(id: string, assistantText?: string): Promise<string | null> {
  if (!canAutoTitleSession(id)) return null;
  const title = deriveAutoSessionTitle(App.ChatState.getMessages(), assistantText);
  if (!title || isGenericSessionTitle(title)) return null;
  writeSessionTabLabel(id, title, 'auto');
  _lastSessionRenderKey = '';
  renderSessionTabs(id);
  try {
    await fetch('/api/sessions/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: title, titleSource: 'auto' }),
    });
  } catch {}
  return title;
}

/** @deprecated _syncMainArea 已接管主区切换，不再影响 activeId */
function focusChatView(): void {
  // no-op: _syncMainArea 根据 TabStore.activeId 自动切换主区显示
}

/** Session tab 渲染（已合并到 renderTabs，此函数仅触发 renderTabs） */
function renderSessionTabs(activeId?: string): void {
  // 确保旧字段 activeId 同步（renderTabs fallback 需要）
  if (typeof (window as any).renderTabs === 'function') (window as any).renderTabs();
}

/** UiStateStore 保存快捷通道——通过 store 的 saveNow 写服务端 */
(window as any)._uiStateSave = function _uiStateSave(): void {
  const activeView = App.State.getSnapshot().activeView;
  if (activeView.type === 'session') App.State.touchSession(activeView.id);
  void App.State.saveNow();
};

/** 保存 UI 状态到服务端（不受随机端口影响） */
function saveUiState(): void {
  const tabs = App.Tabs;
  if (tabs) { tabs.getState(); } // 确保初始化
  const activeId = getActiveSessionTabId();
  const activePanel = App.State.getSnapshot().panel.active || 'explorer';
  App.State.updatePanel({ active: activePanel });
  if (activeId) App.State.touchSession(activeId);
  void App.State.saveNow();
}

/** 启动时恢复完整 UI 状态：会话标签 + 活跃 session 消息 + 面板 */
async function restoreSessionTabsImpl(): Promise<void> {
  // 先拉取会话元数据索引，确保顶部标签尽早显示正确标题
  fetchSessionIndex().catch(() => {});

  const store = await App.State.hydrate();
  // 用户已手动激活过标签（hydrate 慢，恢复流程晚到）→ 跳过恢复，避免把 activeId/
  // 标签列表快照回持久化状态覆盖用户正在进行的操作。
  if ((window as any).hasUserInteractedWithTabs?.()) {
    const appUI = (window as any).App?.UI;
    if (appUI?.restorePanel) appUI.restorePanel(store.panel.active || 'explorer');
    return;
  }
  const items = store.tabs.items || [];
  // 草稿没有独立的 session 文件，刷新后无法恢复其内容；持久化空草稿会
  // 把一次启动/发送竞态变成永久的“新会话”标签。真实 session 标签照常恢复。
  const restoredItems = items.filter(tab => !(tab.kind === 'chat' && isDraftSessionId(tab.id)));
  const persistedActiveId = store.tabs.activeId || (store.activeView.type !== 'chat' ? store.activeView.id : null);
  const preferredActiveId = persistedActiveId && !isDraftSessionId(persistedActiveId)
    ? persistedActiveId
    : null;
  const activeId = preferredActiveId && restoredItems.some(tab => tab.id === preferredActiveId)
    ? preferredActiveId
    : restoredItems.find(tab => tab.kind === 'session')?.id || null;
  App.Tabs?.restoreTabs?.(restoredItems, activeId);
  // restoreTabs 是内存操作；同步一次 canonical 快照，确保清理的 draft
  // 不会在随后 saveUiState 时又从 UiStateStore 旧快照写回来。
  App.State.syncTabs?.(restoredItems, activeId);
  // hydrate 后立即恢复文件标签（确保 UiStateStore.tabs.items 可用，避免独立定时器的竞态）
  if (typeof (window as any).restoreFileTabs === 'function') (window as any).restoreFileTabs();
  const ids = restoredItems.filter(tab => tab.kind === 'session' || tab.kind === 'chat').map(tab => tab.id);
  const activePanel = store.panel.active || 'explorer';

  if (!activeId && ids.length === 0 && readSessionTabIds().length === 0) {
    if (restoredItems.length !== items.length) saveUiState();
    return; // 无历史状态
  }

  // 更新旧字段投影，持久化仍由 TabStore/App.State 负责。
  writeSessionTabIds(ids);
  if (activeId) setActiveSessionTabId(activeId);
  renderSessionTabs(activeId || '');

  // 恢复左侧面板
  const appUI = (window as any).App?.UI;
  if (appUI?.restorePanel) appUI.restorePanel(activePanel);

  // 激活会话：加载消息
  if (activeId && !isDraftSessionId(activeId)) {
    try {
      const ws = App.State.getWorkspacePath();
      const r = await fetch('/api/sessions/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: activeId, workspace: ws }),
      });
      const data = await r.json() as {
        ok: boolean; messages?: Array<{ role: string; content: string; thinking?: string }>;
      };
      if (data.ok && Array.isArray(data.messages)) {
        App.ChatStream.close();
        App.ChatState.setBusy(false);
        App.Chat?.resetMsgKeys?.();
        App.ChatState.replaceMessages(data.messages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
          thinking: m.thinking || '',
          streaming: false,
          _compacted: (m as any)._compacted || false,
          turnId: (m as any).turnId || undefined,
          blocks: (m as any).blocks || undefined,
        })));
        if ((window as any).focusChatView) (window as any).focusChatView();
        const msgsEl = document.getElementById('ms');
        if (msgsEl) {
          msgsEl.innerHTML = App.ChatState.getMessages().length > 0
            ? (window.msgs ? window.msgs() : '')
            : '<div class="wl"><h2>💬 新会话</h2><p>输入消息开始新的对话</p></div>';
        }
      }
    } catch { /* 静默降级 */ }
  }
  saveUiState();
}

/** 启动恢复只允许有一个实例，发送流程可以等待同一个 Promise。 */
function restoreSessionTabs(): Promise<void> {
  if (!_sessionRestorePromise) {
    _sessionRestorePromise = restoreSessionTabsImpl().catch((error) => {
      // 恢复失败不能让后续发送永久卡在 rejected Promise 上；发送流程仍可
      // 在当前空状态创建并绑定一个新的草稿会话。
      console.warn('[session-restore] failed', error);
    });
  }
  return _sessionRestorePromise;
}

function whenSessionRestoreReady(): Promise<void> {
  return _sessionRestorePromise || Promise.resolve();
}

/** 关闭当前 SSE 连接 + 重置忙状态 */
function _disposeActiveStream(): void {
  App.ChatStream.close();
  App.ChatState.setBusy(false);
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

/** 会话激活选项 */
interface ApplySessionMessagesOptions {
  scroll?: 'bottom' | 'none';
  refreshSessions?: boolean;
}

/** 设置消息列表 + 刷新 UI + 记住会话 + 保存状态 */
function _applySessionMessages(
  data: { activeSessionId?: string; messages?: any[] },
  fallbackId: string,
  options?: ApplySessionMessagesOptions,
): void {
  App.Chat?.resetMsgKeys?.();
  App.ChatState.replaceMessages(_mapMessages(data.messages));
  focusChatView();
  const opts = options || {};
  const msgsEl = $('ms');
  if (msgsEl) {
    msgsEl.innerHTML = App.ChatState.getMessages().length > 0
      ? (window.msgs ? window.msgs() : '')
      : '<div class="wl"><h2>💬 新会话</h2><p>输入消息开始新的对话</p></div>';
    if (opts.scroll !== 'none') {
      setTimeout(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }, 50);
    }
  }
  const activeId = data.activeSessionId || fallbackId;
  if (activeId) { rememberSessionTab(activeId); setActiveSessionTabId(activeId); renderSessionTabs(activeId); }
  if (opts.refreshSessions !== false) loadSessions();
  saveUiState();
  // 通知订阅者（仅消费匹配目标 session 的订阅）
  if (activeId) emitSessionActivated(activeId);
}

// ─── 会话激活通知系统（session-aware，只消费匹配的订阅）──
interface _ActivationSub {
  sessionId: string | null; // null = 匹配任意 session
  cb: (sessionId: string) => void;
  active: boolean;
}
let _activationSubs: _ActivationSub[] = [];

/** 订阅下次会话激活（只触发一次，匹配目标 session 后清理） */
function onceSessionActivated(cb: _ActivationSub['cb']): (() => void);
function onceSessionActivated(sessionId: string, cb: _ActivationSub['cb']): (() => void);
function onceSessionActivated(sessionIdOrCb: string | _ActivationSub['cb'], cb?: _ActivationSub['cb']): (() => void) {
  if (typeof sessionIdOrCb !== 'function' && !cb) return () => {};
  const sub: _ActivationSub = typeof sessionIdOrCb === 'function'
    ? { sessionId: null, cb: sessionIdOrCb, active: true }
    : { sessionId: sessionIdOrCb, cb: cb as _ActivationSub['cb'], active: true };
  _activationSubs.push(sub);
  // 返回取消函数
  return () => {
    sub.active = false;
    const idx = _activationSubs.indexOf(sub);
    if (idx >= 0) _activationSubs.splice(idx, 1);
  };
}
/** 触发全部待处理的激活订阅（仅消费匹配的，不匹配的保留） */
function emitSessionActivated(sessionId: string): void {
  const snapshot = _activationSubs.slice();
  const remaining: _ActivationSub[] = [];
  for (const sub of snapshot) {
    if (!sub.active) continue;
    if (sub.sessionId === null || sub.sessionId === sessionId) {
      sub.active = false;
      try { sub.cb(sessionId); } catch {}
    } else {
      remaining.push(sub);
    }
  }
  _activationSubs = remaining.filter(sub => sub.active);
}
window.onceSessionActivated = onceSessionActivated;
window.emitSessionActivated = emitSessionActivated;

/** 让所有在途的会话激活请求过期（文件/其他标签激活时调用——统一竞态防护） */
window.invalidateSessionActivation = (): void => { _sessionActivationSeq++; _markUserTabInteraction(); };

/** 激活失败时的状态回滚 */
function _activateFailReset(): void {
  App.Chat?.resetMsgKeys?.();
  setActiveSessionTabId(null);
  App.ChatState.clearMessages();
  App.ChatState.setBusy(false);
  App.ChatStream.close();
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
  App.ChatState.clearMessages();
  App.ChatState.setBusy(false);
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
  const ts = App.Tabs;
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
        const handler = ts?.getTabBehavior?.('file');
        if (handler?.activate) handler.activate(nextTab);
        else ts?.activateTab(nextTab.id);
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
    App.Chat?.resetMsgKeys?.(); setActiveSessionTabId(null); App.ChatState.clearMessages(); App.ChatState.setBusy(false); renderSessionTabs(''); const msgsEl = $('ms'); if (msgsEl) msgsEl.innerHTML = window.msgs ? window.msgs() : ''; loadSessions(); saveUiState();
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
  return `<div class="session-actions"><button class="sa-btn primary" data-action="new-session">+ 新会话</button></div>`;
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
  return `<div class="${className}" title="${E(hint)}" data-session-id="${E(session.id)}">
    <div class="thread-row">
      <div class="sess-info thread-info">
        <div class="sess-name thread-name">
          <span class="thread-title">${E(name)}</span>
        </div>
      </div>
      <div class="thread-time">${E(timeText)}</div>
      <div class="sess-ops thread-ops">
        <button class="sess-pin" title="${pinTitle}" aria-label="${pinTitle}" data-action="pin" data-session-id="${E(session.id)}" data-pinned="${session.pinned ? 'true' : 'false'}">${pinIcon}</button>
        <button class="sess-branch" title="创建分支" aria-label="创建分支" data-action="branch" data-session-id="${E(session.id)}">${S('ibranch', 14)}</button>
        <button class="sess-rename" title="重命名" aria-label="重命名" data-action="rename" data-session-id="${E(session.id)}">${S('iedit', 14)}</button>
        <button class="sess-del" title="删除" aria-label="删除" data-action="delete" data-session-id="${E(session.id)}">${S('itrash', 14)}</button>
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
 * 拉取并索引会话元数据，存入 _sessionDataCache，不碰 #sl。
 * 无论左侧面板是什么都调用，确保标签标题尽早回填。
 */
function fetchSessionIndex(): Promise<void> {
  const ws = App.State.getWorkspacePath();
  setSessionPanelStatus('正在刷新任务线程…', 'loading');
  return fetch('/api/sessions?workspace=' + encodeURIComponent(ws) + '&other=1')
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data: { sessions?: SessionInfo[]; other?: { project: string; path?: string; sessions: SessionInfo[] }[]; error?: string }) => {
      if (data.error) throw new Error(data.error);
      const sessions = (data.sessions || []).slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
      const others = data.other || [];
      _sessionDataCache = { sessions, others };
      indexSessionTabs(sessions, others);
      const activeId = getActiveSessionTabId() || '';
      renderSessionTabs(activeId);
    });
  // 注意：错误由调用方处理（loadSessions UI 路径 / 后台路径各自决定是否吞错）
}

/**
 * 从 _sessionDataCache 渲染 #sl（会话列表面板）。
 * 搜索活跃时不执行。
 */
function renderSessionPanel(): void {
  if ((window as any).isConversationSearchActive?.()) return;
  const el = $('sl');
  if (!el) return;
  if (!_sessionDataCache) { loadSessions(); return; }

  const { sessions, others } = _sessionDataCache;
  const activeId = getActiveSessionTabId() || '';
  const openSessionIds = readOpenRealSessionIds();

  const renderKey = buildSessionRenderKey(sessions, others, openSessionIds);
  const needsInitialRender = !el.querySelector('.session-toolbar') && !el.querySelector('.session-empty') && !el.querySelector('.session-group');
  const hasChanged = needsInitialRender || renderKey !== _lastSessionRenderKey;
  const totalSessions = sessions.length + others.reduce((sum, project) => sum + project.sessions.length, 0);
  const pinnedSessions = sessions.filter(s => s.pinned);
  const activeSessions = sessions.filter(s => isActiveSession(s, openSessionIds));

  if (sessions.length === 0 && others.length === 0) {
    _lastSessionRenderKey = renderKey;
    el.classList.remove('is-loading');
    setSessionPanelStatus('暂无任务线程', 'ready');
    el.innerHTML = renderSessionEmptyState(
      '暂无任务线程',
      '新会话会出现在这里，按时间和活跃状态整理成可继续的任务线程。',
      [`<button class="sa-btn primary" data-action="new-session">+ 新会话</button>`],
    );
    setupSessionListHandler();
    return;
  }

  const statusBits = [
    pinnedSessions.length > 0 ? `${pinnedSessions.length} 个固定` : '',
    activeSessions.length > 0 ? `${activeSessions.length} 个已打开` : '',
    others.length > 0 ? `${others.length} 个其他项目` : '',
  ].filter(Boolean);
  setSessionPanelStatus(statusBits.length > 0 ? `任务线程已刷新 · ${statusBits.join(' · ')}` : '任务线程已刷新', 'ready');
  el.classList.remove('is-loading');
  if (!hasChanged) return;

  let html = '';
  if (pinnedSessions.length > 0) html += renderSessionGroup('固定线程', '固定的重要任务会留在这里。', pinnedSessions, openSessionIds, '当前项目');
  html += sessions.filter(s => !s.pinned).map(s => renderSessionCard(s, openSessionIds, '当前项目')).join('');

  if (others.length > 0) {
    html += `<div class="sess-other-header" data-action="toggle-other" data-label="其他项目 (${others.length})">▸ 其他项目 (${others.length})</div>`;
    html += `<div class="sess-other-list" style="display:none">`;
    for (const proj of others) {
      const projLabel = proj.project === "未分类" ? "未分类（旧会话）" : E(proj.project);
      const projPath = proj.path ? ` <span class="sess-other-path">${E(proj.path)}</span>` : '';
      const ordered = proj.sessions.slice().sort((a, b) => getSessionTimeValue(b) - getSessionTimeValue(a));
      html += `<div class="sess-other-project"><div class="sess-other-title">${projLabel}${projPath}</div>`;
      html += ordered.map(s => renderSessionCard(s, openSessionIds, projLabel)).join('');
      html += `</div>`;
    }
    html += `</div>`;
  }

  el.innerHTML = html;
  _lastSessionRenderKey = renderKey;
  setupSessionListHandler();
}

/** 组合函数：先取数据、索引，再渲染会话面板 */
function loadSessions(): void {
  const el = $('sl');
  if (!el) {
    // #sl 不存在时仅后台索引，不 retry（chatPaneRender 挂载后会主动调）
    fetchSessionIndex().catch(() => {});
    return;
  }
  if ((window as any).isConversationSearchActive?.()) return;
  _loadRetries = 0;
  el.classList.add('is-loading');
  fetchSessionIndex().then(() => renderSessionPanel()).catch(() => {
    const list = $('sl');
    if (list) {
      _lastSessionRenderKey = '';
      el.classList.remove('is-loading');
      setSessionPanelStatus('加载失败', 'error');
      list.innerHTML = renderSessionEmptyState(
        '网络错误',
        '会话列表暂时无法加载，可能是后端未启动或网络被中断。',
        [`<button class="sa-btn primary" data-action="retry">重新加载</button>`, `<button class="sa-btn" data-action="new-session">+ 新会话</button>`],
      );
      setupSessionListHandler();
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
      fetch('/api/sessions/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: val, titleSource: 'manual' }) })
        .then(r => r.json()).then((r: { ok: boolean }) => {
          if (r.ok) { _lastSessionRenderKey = ''; writeSessionTabLabel(id, val, 'manual'); renderSessionTabs(id); toast('已重命名'); loadSessions(); }
          else { nm.textContent = oldName; toast('重命名失败'); }
        }).catch(() => { nm.textContent = oldName; toast('重命名失败'); });
    } else { nm.textContent = oldName; }
  }
  input.addEventListener('keydown', function (e: KeyboardEvent) { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  input.addEventListener('blur', save);
}

async function deleteSession(id: string): Promise<void> {
  const ok = await confirmAsync('确定删除此会话？');
  if (!ok) return;
  const t0 = Date.now();
  console.log(`🗑️ Deleting session: ${id}`);

  // 先关闭 SSE
  App.ChatStream.close();

  fetch('/api/sessions/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) })
    .then(r => r.json()).then((r: { ok: boolean }) => {
      if (r.ok) {
        console.log(`🗑️ Session deleted in ${Date.now()-t0}ms`);
        toast('已删除');

        // forgetSessionTab 会调用 TabStore.closeTab 自动选下一个标签
        forgetSessionTab(id);
        const ts = App.Tabs;

        // 激活 TabStore 自动选中的下一个（_getNextActiveId：右邻优先、无右邻选左，
        // 跨文件/会话标签）。不要按会话列表选——混合标签时会漏掉右侧文件邻居。
        const nextTab = ts?.getActiveTab?.();
        if (nextTab) {
          renderSessionTabs(nextTab.id);
          const handler = ts?.getTabBehavior?.(nextTab.kind);
          if (handler?.activate) { handler.activate(nextTab); }
          else if (nextTab.kind === 'file') {
            const m = (window as any).__monaco;
            if (m?.tsCloseFile) m.tsCloseFile(id);
            ts?.activateTab(nextTab.id);
            if (m?.setValue) { m.setValue(nextTab.content || ''); m.setLang(nextTab.id); }
          } else {
            switchSession(nextTab.id);
          }
        } else {
          // 真的没有其他标签了 → 欢迎页（需 renderTabs 移除已删会话的标签）
          App.Chat?.resetMsgKeys?.();
          App.ChatState.clearMessages();
          App.ChatState.setBusy(false);
          setActiveSessionTabId(null);
          renderSessionTabs('');
          const msgsEl = $('ms');
          if (msgsEl) { msgsEl.innerHTML = window.msgs ? window.msgs() : ''; msgsEl.scrollTop = 0; }
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
  const ws = App.State.getWorkspacePath();
  fetch('/api/sessions/branch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, workspace: ws }),
  }).then(r => r.json()).then((data: { ok?: boolean; id?: string; activeSessionId?: string; messages?: Array<{ role: string; content: string; thinking?: string }>; error?: string }) => {
    if (!data.ok || data.error) { toast('创建分支失败: ' + (data.error || ''), 'error'); return; }
    App.ChatStream.close();
    App.ChatState.setBusy(false);
    App.Chat?.resetMsgKeys?.();
    App.ChatState.replaceMessages((data.messages || []).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, thinking: m.thinking || '', streaming: false, _compacted: (m as any)._compacted || false, turnId: (m as any).turnId || undefined, blocks: (m as any).blocks || undefined })));
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
function switchSession(id: string, options?: ApplySessionMessagesOptions): void {
  const T = (window as any).App?.Tabs;
  const ts = App.Tabs;
  const tab = ts?.getTab?.(id);
  if (tab && (tab.kind === 'session' || tab.kind === 'chat')) {
    const handler = ts?.getTabBehavior?.(tab.kind);
    if (handler?.activate) { handler.activate(tab, options); return; }
  }
  // 降级：TabStore 无此 tab 时直接执行（兼容测试/未迁移场景）
  // 兜底路径同样参与 seq 竞态防护：旧请求晚到不得重开已关闭标签/覆盖当前内容
  _markUserTabInteraction();
  if (isDraftSessionId(id)) { _sessionActivationSeq++; _setupDraftSession(id); return; }
  const seq = ++_sessionActivationSeq;
  const ws = App.State.getWorkspacePath();
  fetch('/api/sessions/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, workspace: ws }) })
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data: any) => {
      if (seq !== _sessionActivationSeq) return; // 已被更新的激活取代 → 丢弃
      if (!data.ok || data.error) { toast('加载失败: ' + (data.error || '')); return; }
      _disposeActiveStream();
      _applySessionMessages(data, id, options);
      toast('已切换到会话 (' + App.ChatState.getMessages().length + ' 条消息)');
    }).catch(() => {
      if (seq !== _sessionActivationSeq) return; // 过期失败不重置当前标签
      _activateFailReset(); toast('会话已失效'); loadSessions();
    });
}

// ─── 会话列表事件委托（替代 inline onclick）────────────────
let _boundSessionListEl: HTMLElement | null = null;

function setupSessionListHandler(): void {
  const sl = document.getElementById("sl");
  if (!sl || _boundSessionListEl === sl) return;
  _boundSessionListEl = sl;
  sl.addEventListener("click", (e: Event) => {
    const target = e.target as HTMLElement;
    // 1. action buttons
    const actionBtn = target.closest("[data-action]") as HTMLElement | null;
    if (actionBtn) {
      e.stopPropagation();
      const action = actionBtn.dataset.action;
      const sid = actionBtn.dataset.sessionId;
      if (action === "pin" && sid) {
        const pinned = actionBtn.dataset.pinned === "true";
        pinSession(sid, !pinned);
      } else if (action === "branch" && sid) {
        branchSession(sid);
      } else if (action === "rename" && sid) {
        renameSession(actionBtn, sid);
      } else if (action === "delete" && sid) {
        deleteSession(sid);
      } else if (action === "toggle-other") {
        toggleOtherSessions(actionBtn);
      } else if (action === "new-session") {
        newSession();
      } else if (action === "retry") {
        loadSessions();
      }
      return;
    }
    // 2. session card（搜索结果卡片由 chat pane 委托处理）
    const card = target.closest(".sess-item") as HTMLElement | null;
    if (card && card.dataset.sessionId && !card.dataset.msgIndex) {
      App.Tabs.activate(card.dataset.sessionId);
    }
  });
}

// 公开 API
window.loadSessions = loadSessions;
(window as any).bumpSessionListSeq = bumpSessionListSeq;
(window as any).isCurrentSessionListSeq = isCurrentSessionListSeq;
(window as any).readSessionTabIds = readSessionTabIds;
(window as any).writeSessionTabIds = writeSessionTabIds;
(window as any).sessionTabLabel = sessionTabLabel;
window.newSession = newSession;
window.renameSession = renameSession as any;
window.deleteSession = deleteSession;
window.pinSession = pinSession as any;
window.branchSession = branchSession as any;
(window as any).toggleOtherSessions = toggleOtherSessions;
(window as any).commitSessionTab = commitSessionTab;
(window as any).maybeAutoTitleSession = maybeAutoTitleSession;
(window as any).getActiveSessionTabId = getActiveSessionTabId;
(window as any).setActiveSessionTabId = setActiveSessionTabId;
(window as any).ensureDraftSessionTab = ensureDraftSessionTab;
(window as any).whenSessionRestoreReady = whenSessionRestoreReady;
(window as any).renderSessionTabs = renderSessionTabs;
(window as any).migrateSessionTabLabels = migrateSessionTabLabels;
(window as any).switchSession = switchSession;

// ─── App 命名空间绑定 ──────────────────────────────────────
const AppSess = (window as any).App?.Session;
if (AppSess) {
  AppSess.loadSessions = loadSessions;
  AppSess.bumpSessionListSeq = bumpSessionListSeq;
  AppSess.isCurrentSessionListSeq = isCurrentSessionListSeq;
  AppSess.newSession = newSession;
  AppSess.renameSession = renameSession;
  AppSess.deleteSession = deleteSession;
  AppSess.pinSession = pinSession;
  AppSess.branchSession = branchSession;
  AppSess.commitSessionTab = commitSessionTab;
  AppSess.maybeAutoTitleSession = maybeAutoTitleSession;
  AppSess.getActiveSessionTabId = getActiveSessionTabId;
  AppSess.setActiveSessionTabId = setActiveSessionTabId;
  AppSess.ensureDraftSessionTab = ensureDraftSessionTab;
  AppSess.whenReady = whenSessionRestoreReady;
  AppSess.renderSessionTabs = renderSessionTabs;
  AppSess.restoreSessionTabs = restoreSessionTabs;
  AppSess.saveUiState = saveUiState;
  AppSess.switchSession = switchSession;
}

// ─── Session/Chat handler（Phase 2：真实行为入口）────────

// 会话激活请求序号。每次 _sessionActivate 递增；回调只在序号仍是当前值时生效。
// 防止异步竞态：关闭/切换后，旧会话的迟到响应重新打开已关闭标签并覆盖当前内容。
// （只丢弃旧响应，不改变激活时机——区别于按 tab.id 比对 activeId 的做法）
let _sessionActivationSeq = 0;

// 用户是否已手动激活过标签（会话/文件/草稿）。用于阻止启动恢复流程（异步 hydrate /
// 文件内容 fetch）晚到时覆盖用户正在进行的操作（把 activeId 快照回持久化的会话）。
let _userInteractedWithTabs = false;
(window as any).hasUserInteractedWithTabs = () => _userInteractedWithTabs;
function _markUserTabInteraction(): void { _userInteractedWithTabs = true; }

function _sessionActivate(tab: AppTab, options?: ApplySessionMessagesOptions): void {
  _markUserTabInteraction();
  if (tab.kind === 'chat' || isDraftSessionId(tab.id)) {
    // 切到草稿同样使在途的会话请求过期，避免旧响应晚到覆盖草稿页
    _sessionActivationSeq++;
    _setupDraftSession(tab.id);
    return;
  }
  const seq = ++_sessionActivationSeq;
  const ws = App.State.getWorkspacePath();
  fetch('/api/sessions/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tab.id, workspace: ws }),
  }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then((data: { ok: boolean; activeSessionId?: string; messages?: any[]; error?: string }) => {
    if (seq !== _sessionActivationSeq) return; // 已被更新的激活取代 → 丢弃
    if (!data.ok || data.error) { toast('加载失败: ' + (data.error || '')); return; }
    _disposeActiveStream();
    _applySessionMessages(data, tab.id, options);
    toast('已切换到会话 (' + App.ChatState.getMessages().length + ' 条消息)');
  }).catch(() => {
    if (seq !== _sessionActivationSeq) return; // 过期失败不重置当前标签
    _activateFailReset(); toast('会话已失效'); loadSessions();
  });
}

function _sessionClose(tab: AppTab): void {
  // 必须在 forgetSessionTab 之前捕获 activeId（TabStore 会在 closeTab 后更新 activeId）
  // 用 TabStore 底层 activeId 判定"是否激活标签"（不经 getActiveSessionTabId 的
  // 递归深度守卫——它触发时返回 null 会让 wasActive 误判为 false，导致关闭不切换）
  const wasActive = App.Tabs.getActiveTab?.()?.id === tab.id;
  forgetSessionTab(tab.id);
  if (!wasActive) {
    // 关闭的是非激活会话：保持当前 active，仅刷新标签栏
    renderSessionTabs(getActiveSessionTabId() || undefined);
    saveUiState();
    return;
  }

  // 关闭的是当前激活会话 → 激活 TabStore 自动选中的下一个。
  // closeTab 的 _getNextActiveId 遵循"右邻优先、无右邻选左"规则，跨文件/会话标签。
  // （不要按会话列表选 nextId——混合标签时会漏掉右侧的文件邻居）
  const ts = App.Tabs;
  const nextTab = ts?.getActiveTab?.();
  if (nextTab) {
    renderSessionTabs(nextTab.id);
    const handler = ts?.getTabBehavior?.(nextTab.kind);
    if (handler?.activate) { handler.activate(nextTab); return; }
    // 降级（handler 未注册时）
    if (nextTab.kind === 'file') {
      const m = (window as any).__monaco;
      if (m?.tsCloseFile) m.tsCloseFile(tab.id);
      ts?.activateTab(nextTab.id);
      if (m?.setValue) { m.setValue(nextTab.content || ''); m.setLang(nextTab.id); }
      renderSessionTabs(nextTab.id);
      saveUiState();
      return;
    }
    switchSession(nextTab.id);
    return;
  }

  // 真的没有其他标签了 → 欢迎页
  App.Chat?.resetMsgKeys?.();
  App.ChatState.clearMessages();
  App.ChatState.setBusy(false);
  setActiveSessionTabId(null);
  renderSessionTabs('');
  const msgsEl = $('ms');
  if (msgsEl) msgsEl.innerHTML = window.msgs ? window.msgs() : '';
  loadSessions();
  saveUiState();
}

// ─── TabBehavior 注册 ───────────────────────────────
{ const tabs = App.Tabs;
  if (tabs?.registerTabBehavior) {
    tabs.registerTabBehavior('chat', {
      activate(tab: AppTab, options?: ApplySessionMessagesOptions) { _sessionActivate(tab, options); },
      close(tab: AppTab) { _sessionClose(tab); },
    });
    tabs.registerTabBehavior('session', {
      activate(tab: AppTab, options?: ApplySessionMessagesOptions) { _sessionActivate(tab, options); },
      close(tab: AppTab) { _sessionClose(tab); },
    });
  }
}

// ─── 启动时迁移 ───────────────────────────────────

/** 清理历史脏数据：值为"新会话"或看起来像 session ID 的缓存标签 */
function migrateSessionTabLabels(): void {
  try {
    const labels = readSessionTabLabels();
    const sources = readSessionTitleSources();
    let changed = false;
    for (const [id, label] of Object.entries(labels)) {
      if (label === '新会话' || /^会话 [a-f0-9]{6}$/.test(label)) {
        delete (labels as Record<string, string>)[id];
        delete sources[id];
        changed = true;
      }
    }
    if (changed) {
      App.State.updateSessionMetadata(labels, sources);
    }
  } catch {}
}
migrateSessionTabLabels();

// 窗口关闭前保存 UI 状态
try { window.addEventListener('beforeunload', () => saveUiState()); } catch {}





