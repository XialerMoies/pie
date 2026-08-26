// ═══════════════════════════════════════════════════════════════════
//  Send / Stop — 消息发送 & SSE 流
// ═══════════════════════════════════════════════════════════════════

interface DashboardChatApi extends AppChat {
  renderMessage?: (message: Message, messageIndex?: number) => string;
  handleSlash?: (input: HTMLTextAreaElement) => void;
  loadModeState?: () => void;
  showModePopup?: (button: HTMLElement) => void;
  permissionFailureToChatError?: (failure: PermissionFailurePayload) => ChatErrorState;
  ensureSessionForProfile?: (profileId: string) => Promise<{ profile?: unknown } | null>;
  createSessionWithProfile?: (profileId: string) => Promise<{ profile?: unknown } | null>;
}

interface DashboardChatDependencies {
  chat: AppChat;
  chatState: AppChatState;
  chatStream: AppChatStream;
  chatTimeline?: AppChatTimeline;
  chatViews: AppChatViews;
  tabs: AppTabs;
  state: AppStateFacade;
  session: AppSession;
  getSessionTabs: () => AppSessionTabs;
  getSessionRestore: () => AppSessionRestore;
  getGit: () => AppGit | undefined;
}

const dashboardChatApp = (window as any).App;
const dashboardChatDependencies: DashboardChatDependencies = {
  chat: dashboardChatApp.Chat,
  chatState: dashboardChatApp.ChatState,
  chatStream: dashboardChatApp.ChatStream,
  chatTimeline: dashboardChatApp.ChatTimeline,
  chatViews: dashboardChatApp.ChatViews,
  tabs: dashboardChatApp.Tabs,
  state: dashboardChatApp.State,
  session: dashboardChatApp.Session,
  getSessionTabs: () => dashboardChatApp.SessionTabs,
  getSessionRestore: () => dashboardChatApp.SessionRestore,
  getGit: () => dashboardChatApp.Git,
};
const dashboardChatChat = dashboardChatDependencies.chat as DashboardChatApi;
const dashboardChatState = dashboardChatDependencies.state;
const dashboardChatRuntimeState = dashboardChatDependencies.chatState;
const dashboardChatStream = dashboardChatDependencies.chatStream;
const dashboardChatTimeline = dashboardChatDependencies.chatTimeline;
const dashboardChatViews = dashboardChatDependencies.chatViews;
const dashboardChatTabs = dashboardChatDependencies.tabs;
const dashboardChatSession = dashboardChatDependencies.session;

let _msgKeys: string[] = [];
let submitMessageHandler: ((text: string) => void) | null = null;
let chatComposerView: AppChatComposer | null = null;
let chatAttachmentInputView: AppChatAttachmentInput | null = null;
let chatReadingControlsView: AppChatReadingControls | null = null;
let chatSseControllerView: AppChatSseController | null = null;

type ChatSendContext = {
  sessionId: string;
  persistent: boolean;
  draftId?: string;
};

let activeSendContext: ChatSendContext | null = null;

function chatGetReadingControls(): AppChatReadingControls {
  if (!chatReadingControlsView) {
    chatReadingControlsView = dashboardChatViews.createReadingControls({
      onScroll: () => dashboardChatTimeline?.handleMessagesScroll(),
    });
  }
  return chatReadingControlsView;
}

function chatScrollToLatest(options: { force?: boolean; smooth?: boolean } = {}): boolean {
  return chatGetReadingControls().scrollToLatest(options);
}

function reconnectChatStream(): void {
  const generation = dashboardChatStream.open();
  chatSseControllerView?.bind(generation);
  toast('正在重新连接对话流', 'info');
}

function refreshReadingSettings(): void {
  chatGetReadingControls().refreshSettings();
}

function chatGetActiveSessionTabId(): string | null {
  const activeTab = dashboardChatTabs?.getActiveTab?.();
  if (activeTab && (activeTab.kind === 'session' || activeTab.kind === 'chat')) return activeTab.id;
  return dashboardChatTabs?.getActiveSessionTabId?.() || null;
}

function chatIsDraftSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('draft:');
}

function chatReadLocalSessionTabIds(): string[] {
  return dashboardChatTabs?.getSessionTabIds?.() || [];
}

function chatWriteLocalSessionTabIds(ids: string[]): void {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
  dashboardChatDependencies.getSessionTabs().writeSessionTabIds(unique);
}

function chatSetActiveSessionTabId(id: string | null): void {
  dashboardChatDependencies.getSessionTabs().setActiveSessionTabId(id);
}

function chatCommitSessionTab(oldId: string, newId: string): void {
  dashboardChatSession.commitSessionTab(oldId, newId);
}

function chatCreateFallbackDraftTab(): string | null {
  const tabs = dashboardChatTabs;
  if (!tabs?.openTab || !tabs.activateTab) return null;
  const id = `draft:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  tabs.openTab({ kind: 'chat', id, title: '新会话', draftId: id });
  tabs.activateTab(id);
  return id;
}

function chatBindCreatedSession(sessionId: string, draftId?: string): string | undefined {
  if (!sessionId) return undefined;
  let sourceDraftId = draftId && chatIsDraftSessionId(draftId) ? draftId : undefined;
  const activeId = chatGetActiveSessionTabId();
  if (!sourceDraftId && activeId && chatIsDraftSessionId(activeId)) sourceDraftId = activeId;
  if (!sourceDraftId) sourceDraftId = chatCreateFallbackDraftTab() || undefined;
  if (sourceDraftId) chatCommitSessionTab(sourceDraftId, sessionId);
  else {
    const tabs = dashboardChatTabs;
    if (tabs?.openTab) tabs.openTab({ kind: 'session', id: sessionId, title: '新会话', sessionId });
    chatSetActiveSessionTabId(sessionId);
  }
  return sessionId;
}

async function ensureSessionForSend(): Promise<ChatSendContext> {
  await dashboardChatDependencies.getSessionRestore().whenReady();

  // 恢复完成后重新读取 activeId；不能使用恢复开始前的空快照。
  let activeTabId = chatGetActiveSessionTabId();
  if (!activeTabId) {
    activeTabId = dashboardChatSession.ensureDraftSessionTab?.() || null;
  }
  if (activeTabId && !chatIsDraftSessionId(activeTabId)) {
    return { sessionId: activeTabId, persistent: true };
  }

  const ws = dashboardChatState.getWorkspacePath();
  try {
    const response = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: ws }),
    });
    const data = await response.json().catch(() => ({} as { id?: string }));
    const sessionId = typeof data.id === 'string' ? data.id : '';
    if (sessionId) {
      chatBindCreatedSession(sessionId, activeTabId || undefined);
      return { sessionId, persistent: true, draftId: activeTabId };
    }
    return { sessionId, persistent: Boolean(sessionId), draftId: activeTabId && chatIsDraftSessionId(activeTabId) ? activeTabId : undefined };
  } catch {
    const draftId = activeTabId && chatIsDraftSessionId(activeTabId) ? activeTabId : undefined;
    return {
      sessionId: draftId || '',
      persistent: Boolean(draftId),
      draftId,
    };
  }
}

async function deleteEphemeralSession(sessionId: string): Promise<void> {
  if (!sessionId) return;
  try {
    await fetch('/api/sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId }),
    });
  } catch {}
}

function extractLastUserMessage(): string {
  const messages = dashboardChatRuntimeState.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && msg.content.trim()) return msg.content.trim();
  }
  return '';
}

function retryLastTurn(): void {
  if (dashboardChatRuntimeState.isBusy()) return;
  const text = extractLastUserMessage();
  if (!text) { toast('没有可重发的消息', 'error'); return; }
  const input = $('ci') as HTMLTextAreaElement | null;
  if (submitMessageHandler) submitMessageHandler(text);
  else if (input) { input.value = text; updateUI(); }
}

async function copyLastError(): Promise<void> {
  const last = [...dashboardChatRuntimeState.getMessages()].reverse().find(m => m.error?.message || m.error?.reason || m.error?.raw);
  const error = last?.error;
  if (!error) { toast('没有可复制的错误', 'error'); return; }
  const text = [
    error.title,
    error.message,
    error.reason ? `可能原因：${error.reason}` : '',
    error.nextSteps?.length ? `下一步操作：${error.nextSteps.join('；')}` : '',
    error.raw ? `详情：${error.raw}` : '',
  ].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制错误', 'success');
  } catch {
    toast('复制失败', 'error');
  }
}

function refreshWorkspaceState(): void {
  // 切换工作区时清理 ProblemsStore，避免旧 workspace 诊断数据残留
  const pstore = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
  if (pstore) pstore.clear();
  dashboardChatSession.loadSessions();
  getD();
  const pc = $('pc');
  if (pc) renderPanel(dashboardChatState.getSnapshot().panel.active || 'explorer', pc);
  const git = dashboardChatDependencies.getGit();
  if (git?.refreshGit) setTimeout(() => git.refreshGit(), 200);
}

function _messageKey(m: any): string {
  const err = m.error;
  const c = m.content || "";
  return `${m.role}:${c.length}:${c.slice(0, 40)}:${c.slice(-40)}:${(m as any).streaming ? "1" : "0"}:${err ? (err.title || "") + "|" + (err.message || "") : ""}:${(m as any).blocks?.length || 0}:${(m as any).turnId || ""}:${(m as any)._rv || 0}:${(m as any)._compacted ? "1" : "0"}`;
}

/** 节点级消息 diff：逐条检查 key，变才渲染 + replaceWith；无中间字符串层 */
function _applyMsgsDiff(msgsEl: HTMLElement, scroll: boolean): void {
  const M = dashboardChatRuntimeState.getMessages();
  const rm = dashboardChatChat.renderMessage;
  if (!rm) {
    const fallback = (window as any).msgs ? (window as any).msgs() || "" : "";
    msgsEl.innerHTML = fallback;
    dashboardChatTimeline?.sync();
    if (scroll) sb("ms");
    return;
  }

  // M 被整体替换（如 newSession/clear/draft）后 key 缓存可能过时
  if (_msgKeys.length > 0 && M.length === 0) _msgKeys = [];

  // 同步 _msgKeys 长度
  while (_msgKeys.length < M.length) _msgKeys.push("");
  while (_msgKeys.length > M.length) _msgKeys.pop();

  const existingChildren = Array.from(msgsEl.children);
  let changed = false;

  for (let i = 0; i < M.length; i++) {
    const mk = _messageKey(M[i]);
    const existing = existingChildren[i];

    if (mk === _msgKeys[i]) continue; // 未变，跳过（零字符串 / 零 DOM）

    // 变了：渲染新节点并替换
    _msgKeys[i] = mk;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = rm(M[i], i);
    const newChild = wrapper.firstElementChild;
    if (!newChild) continue;

    if (existing) {
      existing.replaceWith(newChild);
    } else {
      msgsEl.appendChild(newChild);
    }
    changed = true;
  }

  // 移除多余节点
  while (msgsEl.children.length > M.length) {
    msgsEl.lastElementChild?.remove();
    changed = true;
  }

  // 空 M → 欢迎屏
  if (M.length === 0) {
    msgsEl.innerHTML = (window as any).msgs ? (window as any).msgs() : "";
    changed = true;
  }

  dashboardChatTimeline?.sync();
  if (changed && scroll) sb("ms");
}

function markLastMessageRendered(): void {
  const M = dashboardChatRuntimeState.getMessages();
  while (_msgKeys.length < M.length) _msgKeys.push("");
  while (_msgKeys.length > M.length) _msgKeys.pop();
  if (M.length > 0) {
    _msgKeys[M.length - 1] = _messageKey(M[M.length - 1]);
  }
}

/**
 * Materialize a front-end draft tab before changing its capability profile.
 * Draft tabs intentionally avoid creating a session until the first send, but
 * profile selection is itself session-scoped and therefore needs a real empty
 * session to persist the choice.
 */
async function ensureSessionForProfile(profileId: string): Promise<{ profile?: unknown } | null> {
  await dashboardChatDependencies.getSessionRestore().whenReady();
  let activeTabId = chatGetActiveSessionTabId();
  if (!activeTabId) activeTabId = dashboardChatSession.ensureDraftSessionTab?.() || null;
  if (!activeTabId || !chatIsDraftSessionId(activeTabId)) return null;

  const response = await fetch('/api/sessions/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace: dashboardChatState.getWorkspacePath(),
      profileId,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data?.id !== 'string' || !data.id) {
    throw new Error(typeof data?.error === 'string' ? data.error : `创建会话失败 (HTTP ${response.status})`);
  }
  chatBindCreatedSession(data.id, activeTabId);
  return { profile: data.profile };
}

async function createSessionWithProfile(profileId: string): Promise<{ profile?: unknown } | null> {
  await dashboardChatDependencies.getSessionRestore().whenReady();
  const response = await fetch('/api/sessions/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace: dashboardChatState.getWorkspacePath(), profileId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data?.id !== 'string' || !data.id) {
    throw new Error(typeof data?.error === 'string' ? data.error : `创建会话失败 (HTTP ${response.status})`);
  }
  chatBindCreatedSession(data.id);
  dashboardChatRuntimeState.clearMessages();
  dashboardChatChat.resetMsgKeys();
  dashboardChatTimeline?.sync();
  return { profile: data.profile };
}

/** 重置消息 key 缓存（用于 M 被整体替换的场景） */
function resetMsgKeys(): void {
  _msgKeys = [];
  chatReadingControlsView?.reset();
  dashboardChatTimeline?.reset();
}

function bind(): void {
  const ci = $('ci') as HTMLTextAreaElement | null, cs = $('cs') as HTMLButtonElement | null;
  if (!ci || !cs) return;

  chatComposerView = dashboardChatViews.createComposer({
    isBusy: () => dashboardChatRuntimeState.isBusy(),
    getInputHistory: () => dashboardChatRuntimeState.getMessages()
      .filter((message) => message.role === 'user' && typeof message.content === 'string')
      .map((message) => message.content.trim())
      .filter(Boolean),
    onInput: (input) => {
      const fn = dashboardChatChat.handleSlash;
      if (fn) fn(input);
      updateUI();
    },
    onSubmit: submitMessage,
    onSubmitNote: submitNote,
    onAbort: abortRun,
  });
  chatComposerView.bind();

  chatGetReadingControls().bind();
  dashboardChatTimeline?.bind();
  refreshReadingSettings();

  let renderFrame: number | null = null;

  function setAssistantError(title: string, message: string, reason?: string, _nextSteps?: string[], _raw?: string, _actions?: ChatErrorAction[]): void {
    const messages = dashboardChatRuntimeState.getMessages();
    const last = messages[messages.length - 1];
    if (!last) return;
    const errorText = `${title || 'error'}：${reason || message || 'unknown_error'}`;
    const blocks = Array.isArray(last.blocks) ? last.blocks : (last.blocks = []);
    const blockId = `error-${last.turnId || 'terminal'}`;
    if (!blocks.some((block) => block.type === 'step' && block.blockId === blockId)) {
      const seq = blocks.reduce((max, block) => Math.max(max, Number(block.seq) || 0), 0) + 1;
      blocks.push({
        type: 'step',
        status: 'error',
        variant: 'error',
        text: errorText,
        turnId: last.turnId,
        blockId,
        seq,
      });
    }
    // Error details remain available to the retry/copy state owner, but are
    // rendered as the terminal event node rather than a separate card.
    last.error = undefined;
    last.streaming = false;
    last.thinking = '';
    last._rv = (last._rv || 0) + 1;
    updateUI();
  }

  function finalizeSendContext(context: ChatSendContext | null): void {
    if (context && !context.persistent && context.sessionId) {
      void deleteEphemeralSession(context.sessionId).then(() => dashboardChatSession.loadSessions());
    } else {
      dashboardChatSession.loadSessions();
    }
  }

  function updateNoteStatus(noteId: string, status: 'queued' | 'delivered' | 'failed'): void {
    const messages = dashboardChatRuntimeState.getMessages();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      const block = message.blocks?.find(item => item.type === 'user_note' && item.noteId === noteId);
      if (!block) continue;
      block.status = status;
      message._rv = (message._rv || 0) + 1;
      const updated = index === messages.length - 1 && dashboardChatChat.updateLastBlock?.(block);
      if (!updated) scheduleMessagesRender(false);
      return;
    }
  }

  function insertQueuedNote(text: string, noteId: string, mode: 'steer' | 'followUp'): boolean {
    const messages = dashboardChatRuntimeState.getMessages();
    const assistant = [...messages].reverse()
      .find(message => message.role === 'assistant' && message.streaming);
    if (!assistant) return false;
    if (!assistant.blocks) assistant.blocks = [];
    const maxSeq = assistant.blocks.reduce((max, block) => Math.max(max, Number(block.seq) || 0), 0);
    assistant.blocks.push({
      type: 'user_note', noteId, mode, text, status: 'queued', turnId: assistant.turnId,
      blockId: 'note-' + noteId, seq: maxSeq + 0.5,
    });
    assistant._rv = (assistant._rv || 0) + 1;
    return true;
  }

  function submitNote(rawText: string, mode: 'steer' | 'followUp'): void {
    const text = rawText.trim();
    if (!text || !dashboardChatRuntimeState.isBusy()) return;
    ci.value = '';
    dashboardChatViews.resizeComposerInput(ci);
    const noteId = 'note-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    if (!insertQueuedNote(text, noteId, mode)) return;
    updateUI();
    chatScrollToLatest({ force: true });
    void fetch('/api/chat/note', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, mode, noteId }),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.ok !== true) throw new Error(data?.error || '补充消息未送达');
      updateNoteStatus(noteId, 'delivered');
      toast(mode === 'followUp' ? '补充已排队，任务完成后处理' : '补充已送达，当前步骤完成后处理', 'info');
    }).catch((error: unknown) => {
      updateNoteStatus(noteId, 'failed');
      toast(error instanceof Error ? error.message : '补充消息未送达', 'error');
    });
  }

  function abortRun(): void {
    if (!dashboardChatRuntimeState.isBusy()) return;
    dashboardChatStream.close();
    const messages = dashboardChatRuntimeState.getMessages();
    const last = [...messages].reverse().find((message) => message.role === 'assistant' && message.streaming);
    if (last) last.streaming = false;
    dashboardChatRuntimeState.setBusy(false);
    updateUI();
    sb('ms');
    void fetch('/api/chat/abort', { method: 'POST' }).catch(() => undefined);
  }

  function submitMessage(rawText: string): void {
    const ci2 = ci!;
    const ciVal = rawText.trim();
    if (!ciVal) return;
    ci2.value = '';
    dashboardChatViews.resizeComposerInput(ci2);

    if (ciVal === '/clear') {
      dashboardChatRuntimeState.setBusy(false);
      fetch('/api/clear', { method: 'POST' })
        .then(r => r.json())
        .then((d: { ok: boolean }) => toast(d.ok ? '缓存已清除' : '清除失败', d.ok ? 'success' : 'error'))
        .catch(() => toast('清除失败', 'error'));
      updateUI();
      return;
    }

    dashboardChatRuntimeState.appendMessage({ role: 'user', content: ciVal });
    dashboardChatRuntimeState.setBusy(true);
    dashboardChatRuntimeState.appendMessage({ role: 'assistant', content: '', thinking: '', streaming: true });
    updateUI(); chatScrollToLatest({ force: true });
    const _ws = dashboardChatState.getWorkspacePath();
    dashboardChatStream.close();
    const gen = dashboardChatStream.open({}, { freshTurn: true });
    const activeTabId = chatGetActiveSessionTabId();
    activeSendContext = activeTabId && !chatIsDraftSessionId(activeTabId)
      ? { sessionId: activeTabId, persistent: true }
      : activeTabId && chatIsDraftSessionId(activeTabId)
        ? { sessionId: '', persistent: true, draftId: activeTabId }
        : { sessionId: '', persistent: false };

    void (async () => {
      const streamReady = await dashboardChatStream.waitUntilOpen?.(gen, 5_000) ?? true;
      if (!streamReady || !dashboardChatStream.isCurrent(gen) || !dashboardChatRuntimeState.isBusy()) {
        if (dashboardChatStream.isCurrent(gen) && dashboardChatRuntimeState.isBusy()) {
          setAssistantError('连接失败', '对话流未能建立，请重新发送。', 'SSE connection did not become ready');
          dashboardChatRuntimeState.setBusy(false);
          dashboardChatStream.close();
          updateUI();
        }
        return;
      }
      const prepared = await ensureSessionForSend();
      if (!dashboardChatStream.isCurrent(gen) || !dashboardChatRuntimeState.isBusy()) return;
      activeSendContext = prepared;

      const atts = dashboardChatChat.getPendingAttachments?.();
      const pending = atts && atts.length > 0 ? atts : undefined;
      const finalMsg = dashboardChatChat.buildInstruction?.(ciVal) || ciVal;
      const body = pending ? { message: finalMsg, workspace: _ws, attachments: pending } : { message: finalMsg, workspace: _ws };
      fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(async (response) => {
          const data = await response.json().catch(() => ({} as { ok?: boolean; error?: string; failure?: PermissionFailurePayload }));
          if (!response.ok || data?.ok !== true) {
            const error = new Error(data?.error || `请求失败 (${response.status})`) as Error & { permissionFailure?: PermissionFailurePayload };
            error.permissionFailure = data?.failure;
            throw error;
          }
          if (pending) dashboardChatChat.clearAttachments?.();
        })
        .catch((err: unknown) => {
          if (!dashboardChatStream.isCurrent(gen)) return;
          const failure = (err as { permissionFailure?: PermissionFailurePayload })?.permissionFailure;
          const failureError = failure ? dashboardChatChat.permissionFailureToChatError?.(failure) : undefined;
          if (failureError) {
            setAssistantError(failureError.title, failureError.message, failureError.reason, failureError.nextSteps, failureError.raw, failureError.actions);
          } else {
          setAssistantError(
            '发送失败',
            '消息没有成功送达后端，请检查当前连接。',
            err instanceof Error ? err.message : '请求 `/api/chat` 失败',
            ['确认后端服务是否仍在运行', '检查当前工作区是否有效', '重新发送当前消息'],
            err instanceof Error ? err.stack || err.message : String(err),
          );
          }
          dashboardChatRuntimeState.setBusy(false);
          updateUI();
          const failedContext = activeSendContext;
          activeSendContext = null;
          finalizeSendContext(failedContext);
        });
    })();

    chatSseControllerView?.bind(gen);
  }
  submitMessageHandler = submitMessage;

    /** Per-message content signature */


  /** 对 msgs 容器执行节点级 diff */


  function renderMessages(scroll = true): void {
    if (renderFrame !== null) { cancelAnimationFrame(renderFrame); renderFrame = null; }
    const msgsEl = $("ms");
    if (!msgsEl || !(window as any).msgs) return;
    _applyMsgsDiff(msgsEl, scroll);
  }

  function scheduleMessagesRender(scroll = true): void {
    if (renderFrame !== null) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = null;
      renderMessages(scroll);
    });
  }
  dashboardChatChat.scheduleMessagesRender = scheduleMessagesRender;

  chatSseControllerView = dashboardChatViews.createSseController({
    scheduleMessagesRender,
    updateUI,
    markLastMessageRendered,
    renderMessages,
    refreshComposer: () => chatComposerView?.refresh(),
    setAssistantError,
    completeSend: (sessionId, assistantText) => {
      const effectiveSessionId = sessionId || activeSendContext?.sessionId || '';
      const sendContext = activeSendContext;
      activeSendContext = null;
      if (sendContext && !sendContext.persistent && effectiveSessionId) {
        void deleteEphemeralSession(effectiveSessionId).then(() => dashboardChatSession.loadSessions());
      } else if (sendContext?.persistent && effectiveSessionId) {
        void Promise.resolve(dashboardChatSession.maybeAutoTitleSession(effectiveSessionId, assistantText))
          .finally(() => dashboardChatSession.loadSessions());
      } else {
        dashboardChatSession.loadSessions();
      }
    },
    failSend: () => {
      const failedContext = activeSendContext;
      activeSendContext = null;
      finalizeSendContext(failedContext);
    },
  });

  chatAttachmentInputView = dashboardChatViews.createAttachmentInput();
  chatAttachmentInputView.bind();

  // ─── Wire up model button ───
  const modelBtn = $('fi-model-btn');
  if (modelBtn) {
    modelBtn.addEventListener('click', (e) => {
      const st = dashboardChatRuntimeState.getDashboard();
      if (!st || st.modelId === 'N/A' || st.modelId === 'unknown') {
        (window as any).openSettingsModal?.();
      } else {
        showModelPicker(e);
      }
    });
    updateModelName();
  }

  // ─── Wire up mode button ───
  dashboardChatChat.loadModeState?.();
  const modeBtn = $('fi-mode-btn');
  if (modeBtn) {
    modeBtn.addEventListener('click', () => dashboardChatChat.showModePopup?.(modeBtn));
  }

  // ─── Token usage events → Token Rail + Usage 面板 ───
  (window as any).startTokenUpdates?.();
}

function updateModelName(): void {
  const mn = $('fi-model-name');
  if (!mn) return;
  const st = dashboardChatRuntimeState.getDashboard();
  if (!st || st.modelId === 'N/A' || !st.modelId) {
    mn.textContent = '未配置';
    mn.style.color = 'var(--tm)';
  } else {
    mn.textContent = st.modelId;
    mn.style.color = '';
  }
}

// ═══════════════════════════════════════════════════════════════════
//  UI Sync
// ═══════════════════════════════════════════════════════════════════

function updateUI(): void {
  chatComposerView?.refresh();
  const msgsEl = $("ms");
  if (msgsEl && (window as any).msgs) {
    _applyMsgsDiff(msgsEl, false);
  }
}

function isBusy(): boolean {
  return dashboardChatRuntimeState.isBusy();
}

// ═══════════════════════════════════════════════════════════════════
//  模型选择弹出 (仪表盘面板内点击切换)
// ═══════════════════════════════════════════════════════════════════

function showModelPicker(e: MouseEvent): void {
  dashboardChatViews.openModelPicker(e);
}

// ─── App 命名空间绑定 ──────────────────────────────────────
window.bind = bind;
window.updateUI = updateUI;
window.showModelPicker = showModelPicker;

{ const dashboardChatPublicApi = dashboardChatChat; if (dashboardChatPublicApi) {
  dashboardChatPublicApi.bind = bind;
  dashboardChatPublicApi.updateUI = updateUI;
  dashboardChatPublicApi.showModelPicker = showModelPicker;
  dashboardChatPublicApi.isBusy = isBusy;
  dashboardChatPublicApi.updateModelName = updateModelName;
  dashboardChatPublicApi.retryLastTurn = retryLastTurn;
  dashboardChatPublicApi.copyLastError = copyLastError;
  dashboardChatPublicApi.reconnect = reconnectChatStream;
  dashboardChatPublicApi.ensureSessionForProfile = ensureSessionForProfile;
  dashboardChatPublicApi.createSessionWithProfile = createSessionWithProfile;
  dashboardChatPublicApi.permissionFailureToChatError = dashboardChatViews.permissionFailureToChatError;
  dashboardChatPublicApi.refreshWorkspaceState = refreshWorkspaceState;
  dashboardChatPublicApi.resetMsgKeys = resetMsgKeys;
  dashboardChatPublicApi.scrollToLatest = chatScrollToLatest;
  dashboardChatPublicApi.refreshReadingSettings = refreshReadingSettings;
  dashboardChatPublicApi.resizeComposerInput = (input) => dashboardChatViews.resizeComposerInput(input);
} }
