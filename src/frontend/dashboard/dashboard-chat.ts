// ═══════════════════════════════════════════════════════════════════
//  Send / Stop — 消息发送 & SSE 流
// ═══════════════════════════════════════════════════════════════════

let _msgKeys: string[] = [];
let submitMessageHandler: ((text: string) => void) | null = null;
let chatComposerView: AppChatComposer | null = null;
let chatAttachmentInputView: AppChatAttachmentInput | null = null;
let chatReadingControlsView: AppChatReadingControls | null = null;

type ChatSendContext = {
  sessionId: string;
  persistent: boolean;
  draftId?: string;
};

let activeSendContext: ChatSendContext | null = null;

function chatGetReadingControls(): AppChatReadingControls {
  if (!chatReadingControlsView) {
    chatReadingControlsView = App.ChatViews.createReadingControls({
      onScroll: () => App.ChatTimeline?.handleMessagesScroll(),
    });
  }
  return chatReadingControlsView;
}

function chatScrollToLatest(options: { force?: boolean; smooth?: boolean } = {}): boolean {
  return chatGetReadingControls().scrollToLatest(options);
}

function refreshReadingSettings(): void {
  chatGetReadingControls().refreshSettings();
}

function chatGetActiveSessionTabId(): string | null {
  const activeTab = App.Tabs?.getActiveTab?.();
  if (activeTab && (activeTab.kind === 'session' || activeTab.kind === 'chat')) return activeTab.id;
  return App.Tabs?.getActiveSessionTabId?.() || null;
}

function chatIsDraftSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('draft:');
}

function chatReadLocalSessionTabIds(): string[] {
  return App.Tabs?.getSessionTabIds?.() || [];
}

function chatWriteLocalSessionTabIds(ids: string[]): void {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
  App.SessionTabs.writeSessionTabIds(unique);
}

function chatSetActiveSessionTabId(id: string | null): void {
  App.SessionTabs.setActiveSessionTabId(id);
}

function chatCommitSessionTab(oldId: string, newId: string): void {
  App.Session.commitSessionTab(oldId, newId);
}

function chatCreateFallbackDraftTab(): string | null {
  const tabs = App.Tabs;
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
    const tabs = App.Tabs;
    if (tabs?.openTab) tabs.openTab({ kind: 'session', id: sessionId, title: '新会话', sessionId });
    chatSetActiveSessionTabId(sessionId);
  }
  return sessionId;
}

async function ensureSessionForSend(): Promise<ChatSendContext> {
  await App.SessionRestore.whenReady();

  // 恢复完成后重新读取 activeId；不能使用恢复开始前的空快照。
  let activeTabId = chatGetActiveSessionTabId();
  if (!activeTabId) {
    activeTabId = App.Session.ensureDraftSessionTab?.() || null;
  }
  if (activeTabId && !chatIsDraftSessionId(activeTabId)) {
    return { sessionId: activeTabId, persistent: true };
  }

  const ws = App.State.getWorkspacePath();
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
  const messages = App.ChatState.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'user' && msg.content.trim()) return msg.content.trim();
  }
  return '';
}

function retryLastTurn(): void {
  if (App.ChatState.isBusy()) return;
  const text = extractLastUserMessage();
  if (!text) { toast('没有可重发的消息', 'error'); return; }
  const input = $('ci') as HTMLTextAreaElement | null;
  if (submitMessageHandler) submitMessageHandler(text);
  else if (input) { input.value = text; updateUI(); }
}

async function copyLastError(): Promise<void> {
  const last = [...App.ChatState.getMessages()].reverse().find(m => m.error?.message || m.error?.reason || m.error?.raw);
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
  App.Session.loadSessions();
  getD();
  const pc = $('pc');
  if (pc) renderPanel(App.State.getSnapshot().panel.active || 'explorer', pc);
  if (App.Git?.refreshGit) setTimeout(() => App.Git.refreshGit(), 200);
}

function _messageKey(m: any): string {
  const err = m.error;
  const c = m.content || "";
  const t = m.thinking || "";
  return `${m.role}:${c.length}:${c.slice(0, 40)}:${c.slice(-40)}:${t.length}:${t.slice(0, 40)}:${t.slice(-40)}:${(m as any).streaming ? "1" : "0"}:${err ? (err.title || "") + "|" + (err.message || "") : ""}:${(m as any).blocks?.length || 0}:${(m as any).turnId || ""}:${(m as any)._rv || 0}:${(m as any)._compacted ? "1" : "0"}`;
}

/** 节点级消息 diff：逐条检查 key，变才渲染 + replaceWith；无中间字符串层 */
function _applyMsgsDiff(msgsEl: HTMLElement, scroll: boolean): void {
  const M = App.ChatState.getMessages();
  const rm = (window as any).App?.Chat?.renderMessage;
  if (!rm) {
    const fallback = (window as any).msgs ? (window as any).msgs() || "" : "";
    msgsEl.innerHTML = fallback;
    App.ChatTimeline?.sync();
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

  App.ChatTimeline?.sync();
  if (changed && scroll) sb("ms");
}

function markLastMessageRendered(): void {
  const M = App.ChatState.getMessages();
  while (_msgKeys.length < M.length) _msgKeys.push("");
  while (_msgKeys.length > M.length) _msgKeys.pop();
  if (M.length > 0) _msgKeys[M.length - 1] = _messageKey(M[M.length - 1]);
}

/** 重置消息 key 缓存（用于 M 被整体替换的场景） */
function resetMsgKeys(): void {
  _msgKeys = [];
  chatReadingControlsView?.reset();
  App.ChatTimeline?.reset();
}

function bind(): void {
  const ci = $('ci') as HTMLTextAreaElement | null, cs = $('cs') as HTMLButtonElement | null;
  if (!ci || !cs) return;

  chatComposerView = App.ChatViews.createComposer({
    isBusy: () => App.ChatState.isBusy(),
    onInput: (input) => {
      const fn = App.Chat?.handleSlash;
      if (fn) fn(input);
      updateUI();
    },
    onSubmit: submitMessage,
    onSubmitNote: submitNote,
    onAbort: abortRun,
  });
  chatComposerView.bind();

  chatGetReadingControls().bind();
  App.ChatTimeline?.bind();
  refreshReadingSettings();

  let renderFrame: number | null = null;

  function makeErrorState(title: string, message: string, reason?: string, nextSteps?: string[], raw?: string): ChatErrorState {
    return { title, message, reason, nextSteps, raw };
  }

  function setAssistantError(title: string, message: string, reason?: string, nextSteps?: string[], raw?: string): void {
    const messages = App.ChatState.getMessages();
    const last = messages[messages.length - 1];
    if (!last) return;
    last.error = makeErrorState(title, message, reason, nextSteps, raw);
    last.streaming = false;
    last.thinking = '';
    last._rv = (last._rv || 0) + 1;
    updateUI();
  }

  function updateNoteStatus(noteId: string, status: 'queued' | 'delivered' | 'failed'): void {
    const messages = App.ChatState.getMessages();
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      const block = message.blocks?.find(item => item.type === 'user_note' && item.noteId === noteId);
      if (!block) continue;
      block.status = status;
      message._rv = (message._rv || 0) + 1;
      const updated = index === messages.length - 1 && App.Chat?.updateLastBlock?.(block);
      if (!updated) scheduleMessagesRender(false);
      return;
    }
  }

  function insertQueuedNote(text: string, noteId: string, mode: 'steer' | 'followUp'): boolean {
    const messages = App.ChatState.getMessages();
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
    if (!text || !App.ChatState.isBusy()) return;
    ci.value = '';
    App.ChatViews.resizeComposerInput(ci);
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
    if (!App.ChatState.isBusy()) return;
    App.ChatStream.close();
    const messages = App.ChatState.getMessages();
    const last = [...messages].reverse().find((message) => message.role === 'assistant' && message.streaming);
    if (last) last.streaming = false;
    App.ChatState.setBusy(false);
    updateUI();
    sb('ms');
    void fetch('/api/chat/abort', { method: 'POST' }).catch(() => undefined);
  }

  function submitMessage(rawText: string): void {
    const ci2 = ci!;
    const ciVal = rawText.trim();
    if (!ciVal) return;
    ci2.value = '';
    App.ChatViews.resizeComposerInput(ci2);

    if (ciVal === '/clear') {
      App.ChatState.setBusy(false);
      fetch('/api/clear', { method: 'POST' })
        .then(r => r.json())
        .then((d: { ok: boolean }) => toast(d.ok ? '缓存已清除' : '清除失败', d.ok ? 'success' : 'error'))
        .catch(() => toast('清除失败', 'error'));
      updateUI();
      return;
    }

    App.ChatState.appendMessage({ role: 'user', content: ciVal });
    App.ChatState.setBusy(true);
    App.ChatState.appendMessage({ role: 'assistant', content: '', thinking: '', streaming: true });
    updateUI(); chatScrollToLatest({ force: true });
    const _ws = App.State.getWorkspacePath();
    App.ChatStream.close();
    const gen = App.ChatStream.open();
    const activeTabId = chatGetActiveSessionTabId();
    activeSendContext = activeTabId && !chatIsDraftSessionId(activeTabId)
      ? { sessionId: activeTabId, persistent: true }
      : activeTabId && chatIsDraftSessionId(activeTabId)
        ? { sessionId: '', persistent: true, draftId: activeTabId }
        : { sessionId: '', persistent: false };

    const finalizeSendContext = (context: ChatSendContext | null): void => {
      if (context && !context.persistent && context.sessionId) {
        void deleteEphemeralSession(context.sessionId).then(() => App.Session.loadSessions());
      } else {
        App.Session.loadSessions();
      }
    };

    void (async () => {
      const prepared = await ensureSessionForSend();
      if (!App.ChatStream.isCurrent(gen) || !App.ChatState.isBusy()) return;
      activeSendContext = prepared;

      const atts = App.Chat?.getPendingAttachments?.();
      const pending = atts && atts.length > 0 ? atts : undefined;
      const finalMsg = App.Chat?.buildInstruction?.(ciVal) || ciVal;
      const body = pending ? { message: finalMsg, workspace: _ws, attachments: pending } : { message: finalMsg, workspace: _ws };
      fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(() => { if (pending) App.Chat?.clearAttachments?.(); })
        .catch((err: unknown) => {
          if (!App.ChatStream.isCurrent(gen)) return;
          setAssistantError(
            '发送失败',
            '消息没有成功送达后端，请检查当前连接。',
            err instanceof Error ? err.message : '请求 `/api/chat` 失败',
            ['确认后端服务是否仍在运行', '检查当前工作区是否有效', '重新发送当前消息'],
            err instanceof Error ? err.stack || err.message : String(err),
          );
          App.ChatState.setBusy(false);
          updateUI();
          const failedContext = activeSendContext;
          activeSendContext = null;
          finalizeSendContext(failedContext);
        });
    })();

    App.ChatStream.setHandlers(gen, {
      onMessage: (e: MessageEvent) => {
      if (!App.ChatStream.isCurrent(gen)) return;
      try {
        if (!window.___sseFirst) { window.___sseFirst = true; mark('sse_first_event'); } const d = JSON.parse(e.data) as { type: string; id?: string; command?: string; reason?: string; permissionSuggestions?: any[]; text?: string; thinking?: boolean; turnId?: string; sessionId?: string; message?: string; block?: any; blocks?: any[] };
        const messages = App.ChatState.getMessages();
        const last = messages[messages.length - 1];
        if (d.type === 'subagent_event' && (d as any).event) {
          const updated = App.Chat?.updateSubagentEvent?.((d as any).event) || false;
          if (!updated) scheduleMessagesRender();
          else sb('ms');
          return;
        } else if (d.type === 'command_confirm') {
          void ChatCommandConfirmationView.handle(d);
          return;
        } else if (d.type === 'queue_update') {
          const steering = Array.isArray((d as any).steering) ? (d as any).steering.length : 0;
          const followUp = Array.isArray((d as any).followUp) ? (d as any).followUp.length : 0;
          const total = steering + followUp;
          if (total > 0) toast(`${total} 条补充已排队`, 'info');
          return;
        } else if (d.type === 'block') {
          if (last?.streaming && d.block) {
            if (!last.blocks) last.blocks = [];
            const idx = last.blocks.findIndex((b: any) => b.blockId === d.block.blockId);
            if (idx >= 0) last.blocks[idx] = d.block;
            else last.blocks.push(d.block);
            last._rv = (last._rv || 0) + 1;
            const updated = App.Chat?.updateLastBlock?.(d.block) || false;
            if (!updated) scheduleMessagesRender();
            else sb('ms');
          }
          return;
        } else if (d.type === 'delta') {
          if (d.thinking) { sb('ms'); return; }
          if (last?.streaming) {
            if (!last?.blocks?.length) App.Chat?.appendDelta?.(d.text || '');
          } else {
            App.ChatState.appendMessage({ role: 'assistant', content: d.text || '', thinking: '', streaming: true });
            updateUI();
          }
          sb('ms');
        } else if (d.type === 'thinking') {
          if (last) { last.thinking = (last.thinking || '') + (d.text || ''); last._rv = (last._rv || 0) + 1; }
          sb('ms');
        } else if (d.type === 'done') {
          if (!last) return;
          if (d.turnId && !last.turnId) last.turnId = d.turnId;
          last.content = d.text || '';
          last.streaming = false;
          last.error = undefined;
          if (Array.isArray(d.blocks)) last.blocks = d.blocks;
          last._rv = (last._rv || 0) + 1;
            App.ChatState.setBusy(false); App.ChatStream.close();
          const finalized = App.Chat?.finalizeLastMessage?.() || false;
          if (finalized) markLastMessageRendered();
          else renderMessages();
          chatComposerView?.refresh();
          const sessionId = (d as any).sessionId || activeSendContext?.sessionId || '';
          const sendContext = activeSendContext;
          activeSendContext = null;
          if (sendContext && !sendContext.persistent && sessionId) {
            void deleteEphemeralSession(sessionId).then(() => App.Session.loadSessions());
          } else {
            if (sendContext?.persistent && sessionId) {
              void Promise.resolve(App.Session.maybeAutoTitleSession(sessionId, d.text || ''))
                .finally(() => App.Session.loadSessions());
            } else {
              App.Session.loadSessions();
            }
          }
          sb('ms');
        } else if (d.type === 'error') {
          const reason = d.text || d.message || '未知错误';
          setAssistantError(
            '发生了错误',
            '当前回复未能完成。请先查看错误详情，再决定是否重试。',
            reason,
            ['检查网络和模型配置', '确认工作区路径仍然有效', '重试发送当前消息'],
            reason,
          );
          App.ChatState.setBusy(false); App.ChatStream.close();
          renderMessages();
          chatComposerView?.refresh();
          const failedContext = activeSendContext;
          activeSendContext = null;
          finalizeSendContext(failedContext);
          sb('ms');
          console.error('[chat] SSE error:', d.text || d.message);
        }
      } catch { /* ignore */ }
      },
      onError: () => {
      if (!App.ChatStream.isCurrent(gen)) return;
      // EventSource owns transport reconnects and will resume with
      // Last-Event-ID. Keep this turn alive until a business event finishes it.
      toast('连接中断，正在重连…', 'info');
      updateUI();
      },
      onOpen: () => {
        if (!App.ChatStream.isCurrent(gen)) return;
        updateUI();
      },
    });
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
  App.Chat.scheduleMessagesRender = scheduleMessagesRender;

  chatAttachmentInputView = App.ChatViews.createAttachmentInput();
  chatAttachmentInputView.bind();

  // ─── Wire up model button ───
  const modelBtn = $('fi-model-btn');
  if (modelBtn) {
    modelBtn.addEventListener('click', (e) => {
      const st = App.ChatState.getDashboard();
      if (!st || st.modelId === 'N/A' || st.modelId === 'unknown') {
        (window as any).openSettingsModal?.();
      } else {
        showModelPicker(e);
      }
    });
    updateModelName();
  }

  // ─── Wire up mode button ───
  App.Chat?.loadModeState?.();
  const modeBtn = $('fi-mode-btn');
  if (modeBtn) {
    modeBtn.addEventListener('click', () => App.Chat?.showModePopup?.(modeBtn));
  }

  // ─── Token usage events → Token Rail + Usage 面板 ───
  (window as any).startTokenUpdates?.();
}

function updateModelName(): void {
  const mn = $('fi-model-name');
  if (!mn) return;
  const st = App.ChatState.getDashboard();
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
  return App.ChatState.isBusy();
}

// ═══════════════════════════════════════════════════════════════════
//  模型选择弹出 (仪表盘面板内点击切换)
// ═══════════════════════════════════════════════════════════════════

function showModelPicker(e: MouseEvent): void {
  App.ChatViews.openModelPicker(e);
}

// ─── App 命名空间绑定 ──────────────────────────────────────
window.bind = bind;
window.updateUI = updateUI;
window.showModelPicker = showModelPicker;

{ const AppChat = (window as any).App?.Chat; if (AppChat) {
  AppChat.bind = bind;
  AppChat.updateUI = updateUI;
  AppChat.showModelPicker = showModelPicker;
  AppChat.isBusy = isBusy;
  AppChat.updateModelName = updateModelName;
  App.Chat.retryLastTurn = retryLastTurn;
  App.Chat.copyLastError = copyLastError;
  App.Chat.refreshWorkspaceState = refreshWorkspaceState;
  App.Chat.resetMsgKeys = resetMsgKeys;
  App.Chat.scrollToLatest = chatScrollToLatest;
  App.Chat.refreshReadingSettings = refreshReadingSettings;
  App.Chat.resizeComposerInput = (input) => App.ChatViews.resizeComposerInput(input);
} }
