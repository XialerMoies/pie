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

let _sessionListSeq = 0;
let _sessionTabLookup = new Map<string, SessionInfo>();
let sessionListPanelView: AppSessionListPanel | null = null;

const {
  isDraftSessionId,
  readSessionTabIds,
  writeSessionTabIds,
  setActiveSessionTabId,
  renderSessionTabs,
  saveUiState,
} = App.SessionTabs;

function bumpSessionListSeq(): number {
  _sessionListSeq += 1;
  return _sessionListSeq;
}

function isCurrentSessionListSeq(seq: number): boolean {
  return seq === _sessionListSeq;
}

function createDraftSessionId(): string {
  return 'draft:' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function ensureDraftSessionTab(): string {
  const activeId = App.Tabs.getActiveSessionTabId();
  if (activeId) return activeId;
  const id = createDraftSessionId();
  rememberSessionTab(id);
  setActiveSessionTabId(id);
  renderSessionTabs(id);
  return id;
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

function rememberSessionTab(id: string, workspace?: string): void {
  if (!id) return;
  const tabs = App.Tabs;
  if (tabs && !tabs.getTab(id)) {
    const isDraft = id.startsWith('draft:');
    const sessionTab = { kind: isDraft ? 'chat' as const : 'session' as const, id, title: '新会话', ...(isDraft ? { draftId: id } : { sessionId: id, workspace }) };
    tabs.openTab(sessionTab);
  } else if (workspace && tabs?.getTab(id)?.kind === 'session') {
    tabs.replaceTab(id, { workspace });
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
  getSessionListPanel().invalidate();
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

/** UiStateStore 保存快捷通道——通过 store 的 saveNow 写服务端 */
(window as any)._uiStateSave = function _uiStateSave(): void {
  const activeView = App.State.getSnapshot().activeView;
  if (activeView.type === 'session') App.State.touchSession(activeView.id);
  void App.State.saveNow();
};

const restoreSessionTabs = (): Promise<void> => App.SessionRestore.restoreSessionTabs();
const whenSessionRestoreReady = (): Promise<void> => App.SessionRestore.whenReady();

function _setupDraftSession(id: string): void {
  rememberSessionTab(id);
  setActiveSessionTabId(id);
  App.Chat?.resetMsgKeys?.();
  App.ChatState.clearMessages();
  App.ChatState.setBusy(false);
  App.Chat?.clearAttachments?.();
  App.ChatStream.close();
  const ci = $('ci') as HTMLTextAreaElement | null;
  if (ci) { ci.value = ''; App.Chat?.resizeComposerInput?.(ci); }
  const msgsEl = $('ms');
  if (msgsEl) msgsEl.innerHTML = '<div class="wl"><h2>💬 新会话</h2><p>输入消息开始新的对话</p></div>';
  App.ChatTimeline?.sync();
  renderSessionTabs(id);
  loadSessions();
}

/** 会话激活与启动恢复接线 */
App.SessionActivation.init({
  rememberSessionTab,
  loadSessions,
  setupDraftSession: _setupDraftSession,
});

App.SessionRestore.init({
  prefetchSessionIndex: () => fetchSessionIndex(),
  onActiveSession: id => App.SessionActivation.activateById(id, {
    silent: true,
    skipTabState: true,
    refreshSessions: false,
  }),
});

function closeSessionTab(id: string): void {
  const ts = App.Tabs;
  const tab = ts?.getTab?.(id);
  if (tab && (tab.kind === 'session' || tab.kind === 'chat')) {
    const handler = ts?.getTabBehavior?.(tab.kind);
    if (handler?.close) { handler.close(tab); return; }
  }
  // 降级
  const wasActive = App.Tabs.getActiveSessionTabId() === id;
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
    App.Chat?.resetMsgKeys?.();
    setActiveSessionTabId(null);
    App.ChatState.clearMessages();
    App.ChatState.setBusy(false);
    renderSessionTabs('');
    const msgsEl = $('ms');
    if (msgsEl) msgsEl.innerHTML = App.Chat?.msgs ? App.Chat.msgs() : '';
    App.ChatTimeline?.sync();
    loadSessions();
    saveUiState();
    return;
  }
  renderSessionTabs(App.Tabs.getActiveSessionTabId() || undefined);
  saveUiState();
}

function getSessionListPanel(): AppSessionListPanel {
  if (!sessionListPanelView) {
    sessionListPanelView = App.SessionViews.createSessionListPanel({
      isConversationSearchActive: () => Boolean(App.Session.isConversationSearchActive?.()),
      getActiveSessionTabId: () => App.Tabs.getActiveSessionTabId() || null,
      getOpenSessionIds: readOpenRealSessionIds,
      indexSessionTabs,
      renderSessionTabs,
      setupListHandler: setupSessionListHandler,
    });
  }
  return sessionListPanelView;
}

/** 拉取并索引会话元数据，不触碰会话列表面板。 */
function fetchSessionIndex(): Promise<void> {
  return getSessionListPanel().fetchIndex();
}

/** 从已缓存的会话元数据渲染会话列表面板。 */
function renderSessionPanel(): void {
  getSessionListPanel().render();
}

/** 组合函数：先取数据、索引，再渲染会话面板。 */
function loadSessions(): Promise<void> {
  return getSessionListPanel().load();
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
          if (r.ok) { getSessionListPanel().invalidate(); writeSessionTabLabel(id, val, 'manual'); renderSessionTabs(id); toast('已重命名'); loadSessions(); }
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
          if (msgsEl) { msgsEl.innerHTML = App.Chat?.msgs ? App.Chat.msgs() : ''; msgsEl.scrollTop = 0; }
          App.ChatTimeline?.sync();
        }

        // 重置输入框
        const ci = $('ci') as HTMLTextAreaElement | null;
        if (ci) { ci.disabled = false; ci.value = ''; App.Chat?.resizeComposerInput?.(ci); }
        const cs = $('cs') as HTMLButtonElement | null;
        if (cs) { cs.disabled = false; cs.title = '发送消息'; cs.innerHTML = App.UI.S('iz', 16); }
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
    getSessionListPanel().invalidate();
    loadSessions();
  }).catch(() => toast('固定失败', 'error'));
}

function branchSession(id: string): void {
  const ws = App.State.getWorkspacePath();
  fetch('/api/sessions/branch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, workspace: ws }),
  }).then(r => r.json()).then((data: { ok?: boolean; id?: string; activeSessionId?: string; messages?: Array<{ role: string; content: string }>; error?: string }) => {
    if (!data.ok || data.error) { toast('创建分支失败: ' + (data.error || ''), 'error'); return; }
    App.ChatStream.close();
    App.ChatState.setBusy(false);
    App.Chat?.resetMsgKeys?.();
    App.ChatState.replaceMessages((data.messages || []).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content, streaming: false, _compacted: (m as any)._compacted || false, turnId: (m as any).turnId || undefined, blocks: (m as any).blocks || undefined })));
    const activeId = data.activeSessionId || data.id || '';
    if (activeId) {
      
      rememberSessionTab(activeId);
      setActiveSessionTabId(activeId);
      renderSessionTabs(activeId);
    }
    const msgsEl = $('ms');
    if (msgsEl) { msgsEl.innerHTML = App.Chat?.msgs ? App.Chat.msgs() : ''; setTimeout(() => { msgsEl.scrollTop = msgsEl.scrollHeight; }, 50); }
    App.ChatTimeline?.sync();
    toast('已创建分支线程', 'success');
    loadSessions();
  }).catch(() => toast('创建分支失败', 'error'));
}

/** App.Tabs.activate 的向后兼容入口 */
function switchSession(id: string, options?: SessionActivationOptions): void {
  App.SessionActivation.switchSession(id, options);
}

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
      const session = _sessionTabLookup.get(card.dataset.sessionId);
      App.Tabs.activate(card.dataset.sessionId, { workspace: session?.workspace });
    }
  });
}

// ─── App 命名空间绑定 ──────────────────────────────────────
const AppSess = App.Session;
AppSess.loadSessions = loadSessions;
AppSess.bumpSessionListSeq = bumpSessionListSeq;
AppSess.isCurrentSessionListSeq = isCurrentSessionListSeq;
AppSess.newSession = newSession;
AppSess.renameSession = renameSession;
AppSess.deleteSession = deleteSession;
AppSess.pinSession = pinSession;
AppSess.branchSession = branchSession;
AppSess.toggleOtherSessions = toggleOtherSessions;
AppSess.commitSessionTab = commitSessionTab;
AppSess.maybeAutoTitleSession = maybeAutoTitleSession;
AppSess.getTabLabel = sessionTabLabel;
AppSess.getActiveSessionTabId = () => App.Tabs.getActiveSessionTabId();
AppSess.setActiveSessionTabId = setActiveSessionTabId;
AppSess.ensureDraftSessionTab = ensureDraftSessionTab;
AppSess.whenReady = whenSessionRestoreReady;
AppSess.renderSessionTabs = renderSessionTabs;
AppSess.restoreSessionTabs = restoreSessionTabs;
AppSess.saveUiState = saveUiState;
AppSess.migrateSessionTabLabels = migrateSessionTabLabels;

// ─── Session/Chat 标签行为 ───
function _sessionClose(tab: AppTab): void {
  // 必须在 forgetSessionTab 之前捕获 activeId（TabStore 会在 closeTab 后更新 activeId）
  // 直接读取 TabStore 的权威 activeId，避免兼容入口参与关闭判定。
  const wasActive = App.Tabs.getActiveTab?.()?.id === tab.id;
  forgetSessionTab(tab.id);
  if (!wasActive) {
    // 关闭的是非激活会话：保持当前 active，仅刷新标签栏
    renderSessionTabs(App.Tabs.getActiveSessionTabId() || undefined);
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
  if (msgsEl) msgsEl.innerHTML = App.Chat?.msgs ? App.Chat.msgs() : '';
  App.ChatTimeline?.sync();
  loadSessions();
  saveUiState();
}

// ─── TabBehavior 注册 ───────────────────────────────
{ const tabs = App.Tabs;
  if (tabs?.registerTabBehavior) {
    tabs.registerTabBehavior('chat', {
      activate(tab: AppTab, options?: SessionActivationOptions) { void App.SessionActivation.activate(tab, options); },
      close(tab: AppTab) { _sessionClose(tab); },
    });
    tabs.registerTabBehavior('session', {
      activate(tab: AppTab, options?: SessionActivationOptions) { void App.SessionActivation.activate(tab, options); },
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





