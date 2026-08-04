// ═══════════════════════════════════════════════════════════════════
//  Send / Stop — 消息发送 & SSE 流
// ═══════════════════════════════════════════════════════════════════

let _msgKeys: string[] = [];
let submitMessageHandler: ((text: string) => void) | null = null;

type ChatSendContext = {
  sessionId: string;
  persistent: boolean;
  draftId?: string;
};

let activeSendContext: ChatSendContext | null = null;
const CHAT_LATEST_THRESHOLD = 72;
let chatFollowLatest = true;
let chatSmoothScrollTimer: ReturnType<typeof setTimeout> | null = null;

function chatSetJumpLatestVisible(visible: boolean): void {
  const button = $('chat-jump-latest') as HTMLButtonElement | null;
  if (!button) return;
  button.classList.toggle('on', visible);
  button.setAttribute('aria-hidden', visible ? 'false' : 'true');
  button.tabIndex = visible ? 0 : -1;
}

function chatIsNearLatest(messages: HTMLElement): boolean {
  return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= CHAT_LATEST_THRESHOLD;
}

function chatSyncLatestState(): void {
  const messages = $('ms');
  if (!messages) return;
  const nearLatest = chatIsNearLatest(messages);
  chatFollowLatest = nearLatest;
  chatSetJumpLatestVisible(!nearLatest);
}

function chatScheduleSmoothScrollSync(): void {
  if (chatSmoothScrollTimer !== null) clearTimeout(chatSmoothScrollTimer);
  chatSmoothScrollTimer = setTimeout(() => {
    chatSmoothScrollTimer = null;
    chatSyncLatestState();
  }, 120);
}

function chatScrollToLatest(options: { force?: boolean; smooth?: boolean } = {}): boolean {
  const messages = $('ms');
  if (!messages) return false;
  if (!options.force && !chatFollowLatest) {
    chatSetJumpLatestVisible(true);
    return false;
  }

  chatFollowLatest = true;
  chatSetJumpLatestVisible(false);
  if (options.smooth && typeof messages.scrollTo === 'function') {
    messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
    chatScheduleSmoothScrollSync();
  } else {
    messages.scrollTop = messages.scrollHeight;
  }
  return true;
}

function chatGetActiveSessionTabId(): string | null {
  const fn = (window as any).getActiveSessionTabId;
  if (typeof fn === 'function') {
    const legacyId = fn();
    if (legacyId) return legacyId;
  }
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
  // 仅通过 writeSessionTabIds 写入（发送消息时 sessions.ts 已加载完毕）
  if (typeof (window as any).writeSessionTabIds === 'function') {
    const unique = Array.from(new Set(ids.filter((id) => typeof id === 'string' && id.length > 0)));
    (window as any).writeSessionTabIds(unique);
  }
}

function chatSetActiveSessionTabId(id: string | null): void {
  const fn = (window as any).setActiveSessionTabId;
  if (typeof fn === 'function') {
    fn(id);
    return;
  }
  // TabStore._syncToState 已处理 activeId+activeView, 仅触发保存
  if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

function chatCommitSessionTab(oldId: string, newId: string): void {
  const fn = (window as any).commitSessionTab;
  if (typeof fn === 'function') {
    fn(oldId, newId);
    return;
  }
  const nextIds = chatReadLocalSessionTabIds().map(id => id === oldId ? newId : id);
  if (!nextIds.includes(newId)) nextIds.push(newId);
  chatWriteLocalSessionTabIds(nextIds);
  chatSetActiveSessionTabId(newId);
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
  const waitForRestore = (window as any).whenSessionRestoreReady
    || (window as any).App?.Session?.whenReady;
  if (typeof waitForRestore === 'function') await waitForRestore();

  // 恢复完成后重新读取 activeId；不能使用恢复开始前的空快照。
  let activeTabId = chatGetActiveSessionTabId();
  if (!activeTabId) {
    const ensureDraft = (window as any).ensureDraftSessionTab
      || (window as any).App?.Session?.ensureDraftSessionTab;
    if (typeof ensureDraft === 'function') activeTabId = ensureDraft() || null;
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
  loadSessions();
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
  if (chatSmoothScrollTimer !== null) clearTimeout(chatSmoothScrollTimer);
  chatSmoothScrollTimer = null;
  chatFollowLatest = true;
  chatSetJumpLatestVisible(false);
  App.ChatTimeline?.reset();
}

function bind(): void {
  const ci = $('ci') as HTMLTextAreaElement | null, cs = $('cs') as HTMLButtonElement | null;
  if (!ci || !cs) return;

  const messages = $('ms');
  const jumpLatest = $('chat-jump-latest') as HTMLButtonElement | null;
  messages?.addEventListener('scroll', () => {
    if (chatSmoothScrollTimer !== null) chatScheduleSmoothScrollSync();
    else chatSyncLatestState();
    App.ChatTimeline?.handleMessagesScroll();
  }, { passive: true });
  jumpLatest?.addEventListener('click', () => {
    chatScrollToLatest({ force: true, smooth: true });
  });
  App.ChatTimeline?.bind();
  chatSyncLatestState();

  ci.addEventListener('input', () => {
    ci.style.height = 'auto';
    ci.style.height = Math.min(ci.scrollHeight, 120) + 'px';
    // Slash command popup (sourced from chat-mode.ts)
    const fn = App.Chat?.handleSlash;
    if (fn) fn(ci);
  });

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

  function submitMessage(rawText: string): void {
    const ci2 = ci!;
    const ciVal = rawText.trim();
    if (!ciVal) return;
    ci2.value = '';
    ci2.style.height = 'auto';

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
        void deleteEphemeralSession(context.sessionId).then(() => loadSessions());
      } else {
        loadSessions();
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
        if (d.type === 'command_confirm') {
          const id = d.id || '';
          if (!id) return;
          void (async () => {
            const choice = typeof confirmCommandAsync === 'function'
              ? await confirmCommandAsync({
                command: d.command || '',
                reason: d.reason || '该命令需要确认',
                permissionSuggestions: d.permissionSuggestions || [],
              })
              : ((await confirmAsync(`
                <div style="font-weight:700;margin-bottom:8px">确认执行命令</div>
                <div style="font-size:.76rem;color:var(--ts);margin-bottom:10px">${E(d.reason || '该命令需要确认')}</div>
                <pre style="margin:0;max-width:560px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.18);border:1px solid var(--bd);border-radius:7px;padding:10px;font-family:var(--fm);font-size:.74rem;color:var(--tx)">${E(d.command || '')}</pre>
              `)) ? 'session' : 'deny');
            await fetch('/api/chat/command-confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id,
                allow: choice !== 'deny',
                scope: choice === 'workspace'
                  ? 'workspace'
                  : choice === 'session' ? 'session' : 'once',
              }),
            }).catch(() => undefined);
          })();
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
          const _cs = $('cs') as HTMLButtonElement | null;
          const _ci = $('ci') as HTMLTextAreaElement | null;
          if (_cs) { _cs.disabled = false; _cs.title = '发送消息'; _cs.innerHTML = S('iup', 16); }
          if (_ci) _ci.disabled = false;
          const sessionId = (d as any).sessionId || activeSendContext?.sessionId || '';
          const sendContext = activeSendContext;
          activeSendContext = null;
          if (sendContext && !sendContext.persistent && sessionId) {
            void deleteEphemeralSession(sessionId).then(() => loadSessions());
          } else {
            const titleFn = (window as any).maybeAutoTitleSession;
            if (sendContext?.persistent && sessionId && typeof titleFn === 'function') {
              void Promise.resolve(titleFn(sessionId, d.text || '')).finally(() => loadSessions());
            } else {
              loadSessions();
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
          const _cs2 = $('cs') as HTMLButtonElement | null;
          const _ci2 = $('ci') as HTMLTextAreaElement | null;
          if (_cs2) { _cs2.disabled = false; _cs2.title = '发送消息'; _cs2.innerHTML = S('iup', 16); }
          if (_ci2) _ci2.disabled = false;
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

  function sendOrStop(): void {
    if (App.ChatState.isBusy()) {
      App.ChatStream.close();
      const messages = App.ChatState.getMessages();
      const last = messages[messages.length - 1];
      if (last?.streaming) last.streaming = false;
      App.ChatState.setBusy(false); updateUI(); sb('ms');
      return;
    }
    submitMessage(ci.value);
  }

  ci.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendOrStop(); }
    if (e.key === 'Escape') { const se = $('fi-slash'); if (se) se.style.display = 'none'; }
    if (e.key === 'Tab' && ci.value.startsWith('/')) {
      e.preventDefault();
      const slashEl = $('fi-slash');
      if (slashEl && slashEl.style.display !== 'none') {
        const first = slashEl.querySelector('.fi-slash-item') as HTMLElement | null;
        if (first) first.click();
      }
    }
  });
  cs.addEventListener('click', sendOrStop);

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

  // ─── Wire up file attach + button ───
  const fileBtn = $('fi-file-btn');
  if (fileBtn) {
    fileBtn.addEventListener('click', async () => {
      const api = (window as any).electronAPI as ElectronAPI | undefined;
      if (api?.openFile) {
        const p = await api.openFile();
        if (p) {
          const ws = ExplorerService.getWorkspacePath();
          const relPath = ws ? p.replace(ws.replace(/\\/g, '/'), '').replace(/^\/+/, '') : p;
          const name = p.split(/[/\\]/).pop() || p;
          App.Chat?.addAttachment?.({ kind: 'file', path: relPath, name });
        }
      } else {
        toast('请使用 Electron 桌面版', 'info');
      }
    });
  }

  // ─── Drag & Drop from explorer tree ───
  const fiArea = $('fi');
  if (fiArea) {
    fiArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      App.Chat?.showDropZone?.(true);
    });
    fiArea.addEventListener('dragleave', (e) => {
      if (!fiArea.contains(e.relatedTarget as Node)) {
        App.Chat?.showDropZone?.(false);
      }
    });
    fiArea.addEventListener('drop', (e) => {
      e.preventDefault();
      App.Chat?.showDropZone?.(false);
      let treeNodeId = e.dataTransfer?.getData('text/tree-node');
      if (!treeNodeId) {
        const plain = e.dataTransfer?.getData('text/plain') || '';
        if (plain.startsWith('tree-node:')) treeNodeId = plain.slice(10);
      }
      if (treeNodeId) {
        const ws = ExplorerService.getWorkspacePath();
        if (!ws) { toast('请先选择工作区', 'error'); return; }
        const name = treeNodeId.split('/').pop() || treeNodeId;
        const tree = (ExplorerService as any)._getTree?.();
        const node = tree?._findNodeById?.(treeNodeId);
        if (node?.isDir) {
          App.Chat?.addAttachment?.({ kind: 'folder', path: treeNodeId, name: name + '/' });
        } else {
          App.Chat?.addAttachment?.({ kind: 'file', path: treeNodeId, name });
        }
        toast(`已添加: ${name}`, 'success');
      } else if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        toast('请使用文件菜单或目录树添加文件', 'info');
      }
    });
  }
  const slashEl = $('fi-slash');
  if (slashEl) {
    slashEl.querySelectorAll('.fi-slash-item').forEach(item => {
      item.addEventListener('click', () => {
        const cmd = (item as HTMLElement).dataset.cmd || '';
        ci.value = cmd + ' ';
        ci.focus();
        slashEl.style.display = 'none';
        ci.style.height = 'auto';
      });
    });
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
  const ci = $("ci") as HTMLTextAreaElement | null, cs = $("cs") as HTMLButtonElement | null;
  const stIL = App.ChatState.isBusy();
  if (ci) ci.disabled = stIL;
  if (cs) {
    cs.disabled = stIL ? false : !ci?.value.trim();
    cs.title = stIL ? "中止" : "发送消息";
    cs.innerHTML = stIL ? S("ipause", 16) : S("iup", 16);
  }
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
  const existing = $('model-picker');
  if (existing) { existing.remove(); return; }
  const target = e.currentTarget as HTMLElement || $('fi-model-btn');
  fetch('/api/models').then(r => r.json()).then((data: { models?: Array<{ provider: string; id: string }> }) => {
    if (!data.models || !data.models.length) { toast('没有可用模型'); return; }
    const rect = target.getBoundingClientRect();
    const picker = document.createElement('div');
    picker.id = 'model-picker';
    picker.style.cssText = `position:fixed;bottom:${window.innerHeight - rect.top + 4}px;left:${rect.left}px;z-index:999;background:var(--be);border:1px solid var(--bd);border-radius:8px;padding:4px;max-height:200px;overflow-y:auto;min-width:200px;box-shadow:0 8px 32px rgba(0,0,0,.5)`;
    const grouped: Record<string, Array<{ provider: string; id: string }>> = {};
    for (const m of data.models) {
      if (!grouped[m.provider]) grouped[m.provider] = [];
      grouped[m.provider].push(m);
    }
    for (const [provider, models] of Object.entries(grouped)) {
      const header = document.createElement('div');
      header.style.cssText = 'font-size:.6rem;font-weight:600;text-transform:uppercase;color:var(--tm);padding:6px 10px 3px;letter-spacing:.05em;font-family:var(--fd)';
      header.textContent = provider;
      picker.appendChild(header);
      for (const m of models) {
        const item = document.createElement('div');
        const stD = App.ChatState.getDashboard();
        const active = (m.provider === stD?.modelProvider && m.id === stD?.modelId);
        item.style.cssText = `padding:6px 10px;border-radius:4px;cursor:pointer;font-size:.78rem;font-family:var(--fm);color:${active?'var(--am)':'var(--ts)'};background:${active?'rgba(245,158,11,.1)':'transparent'}`;
        item.textContent = m.id;
        item.addEventListener('mouseenter', () => { item.style.background = 'var(--bc)'; });
        item.addEventListener('mouseleave', () => { item.style.background = active ? 'rgba(245,158,11,.1)' : 'transparent'; });
        item.addEventListener('click', () => {
          fetch('/api/model/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, modelId: m.id }) })
            .then(r => r.json()).then((r: { ok: boolean; error?: string }) => {
              if (r.ok) { toast('已切换: ' + m.id, 'success'); getD(); picker.remove(); }
              else toast('切换失败: ' + (r.error || ''), 'error');
            }).catch(() => toast('切换失败', 'error'));
        });
        picker.appendChild(item);
      }
    }
    document.body.appendChild(picker);
    const close = function (ev: MouseEvent) { if (!picker.contains(ev.target as Node) && ev.target !== target) { picker.remove(); document.removeEventListener('click', close, true); } };
    setTimeout(() => document.addEventListener('click', close as any, true), 0);
  }).catch((err) => { console.error("[model picker]", err); toast("加载模型列表失败"); });
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
} }
