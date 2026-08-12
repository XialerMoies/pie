interface SessionActivationCallbacks {
  rememberSessionTab(id: string, workspace?: string): void;
  loadSessions(): void;
  setupDraftSession(id: string): void;
}

const sessionActivationApp = (window as any).App as AppNamespace;
let activationCallbacks: SessionActivationCallbacks | null = null;
let sessionActivationSeq = 0;

interface ActivationSubscriber {
  sessionId: string | null;
  cb: (sessionId: string) => void;
  active: boolean;
}

let activationSubscribers: ActivationSubscriber[] = [];

function initSessionActivation(options: SessionActivationCallbacks): void {
  activationCallbacks = options;
}

function onceSessionActivated(cb: ActivationSubscriber['cb']): () => void;
function onceSessionActivated(sessionId: string, cb: ActivationSubscriber['cb']): () => void;
function onceSessionActivated(
  sessionIdOrCb: string | ActivationSubscriber['cb'],
  cb?: ActivationSubscriber['cb'],
): () => void {
  if (typeof sessionIdOrCb !== 'function' && !cb) return () => {};
  const subscription: ActivationSubscriber = typeof sessionIdOrCb === 'function'
    ? { sessionId: null, cb: sessionIdOrCb, active: true }
    : { sessionId: sessionIdOrCb, cb: cb as ActivationSubscriber['cb'], active: true };
  activationSubscribers.push(subscription);
  return () => {
    subscription.active = false;
    const index = activationSubscribers.indexOf(subscription);
    if (index >= 0) activationSubscribers.splice(index, 1);
  };
}

function emitSessionActivated(sessionId: string): void {
  const snapshot = activationSubscribers.slice();
  const remaining: ActivationSubscriber[] = [];
  for (const subscription of snapshot) {
    if (!subscription.active) continue;
    if (subscription.sessionId === null || subscription.sessionId === sessionId) {
      subscription.active = false;
      try { subscription.cb(sessionId); } catch {}
    } else {
      remaining.push(subscription);
    }
  }
  activationSubscribers = remaining.filter(subscription => subscription.active);
}

function disposeActiveStream(): void {
  sessionActivationApp.ChatStream.close();
  sessionActivationApp.ChatState.setBusy(false);
}

function mapMessages(raw: any[]): Message[] {
  return (raw || []).map(message => ({
    role: message.role as 'user' | 'assistant',
    content: message.content,
    thinking: message.thinking || '',
    streaming: false,
    _compacted: message._compacted || false,
    turnId: message.turnId || undefined,
    blocks: message.blocks || undefined,
    subagentEvents: message.subagentEvents || undefined,
    subagentBatches: message.subagentBatches || undefined,
  }));
}

function renderMessages(options: SessionActivationOptions): void {
  const messagesElement = document.getElementById('ms');
  if (!messagesElement) return;
  messagesElement.innerHTML = sessionActivationApp.ChatState.getMessages().length > 0
    ? ((window as any).msgs ? (window as any).msgs() : '')
    : '';
  if (options.scroll !== 'none') {
    setTimeout(() => { messagesElement.scrollTop = messagesElement.scrollHeight; }, 50);
  }
}

function applySessionMessages(
  data: { activeSessionId?: string; messages?: any[] },
  fallbackId: string,
  options: SessionActivationOptions = {},
): void {
  sessionActivationApp.Chat?.resetMsgKeys?.();
  sessionActivationApp.ChatState.replaceMessages(mapMessages(data.messages || []));
  renderMessages(options);
  sessionActivationApp.ChatTimeline?.sync();

  const activeId = data.activeSessionId || fallbackId;
  if (activeId && !options.skipTabState) {
    activationCallbacks?.rememberSessionTab(activeId, options.workspace);
    sessionActivationApp.SessionTabs.setActiveSessionTabId(activeId);
    sessionActivationApp.SessionTabs.renderSessionTabs(activeId);
  }
  if (options.refreshSessions !== false) activationCallbacks?.loadSessions();
  if (!options.skipTabState) sessionActivationApp.SessionTabs.saveUiState();
  if (activeId && !options.silent) emitSessionActivated(activeId);
}

function activateFailReset(): void {
  sessionActivationApp.Chat?.resetMsgKeys?.();
  sessionActivationApp.SessionTabs.setActiveSessionTabId(null);
  sessionActivationApp.ChatState.clearMessages();
  sessionActivationApp.ChatState.setBusy(false);
  sessionActivationApp.ChatStream.close();
  const input = document.getElementById('ci') as HTMLTextAreaElement | null;
  const send = document.getElementById('cs') as HTMLButtonElement | null;
  if (input) { input.disabled = false; sessionActivationApp.Chat?.resizeComposerInput?.(input); }
  if (send) {
    send.disabled = false;
    send.title = '发送消息';
    send.innerHTML = typeof (window as any).S === 'function' ? (window as any).S('iup', 16) : '';
  }
}

function activateById(id: string, options: SessionActivationOptions = {}): Promise<void> {
  if (!activationCallbacks) return Promise.reject(new Error('SessionActivation is not initialized'));
  if (!options.silent) sessionActivationApp.SessionRestore.markUserInteraction();

  if (sessionActivationApp.SessionTabs.isDraftSessionId(id)) {
    sessionActivationSeq++;
    activationCallbacks.setupDraftSession(id);
    return Promise.resolve();
  }

  const seq = ++sessionActivationSeq;
  const workspace = options.workspace || sessionActivationApp.State.getWorkspacePath();
  return fetch('/api/sessions/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, workspace }),
  }).then(async response => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || ('HTTP ' + response.status));
    return data;
  }).then((data: { ok: boolean; activeSessionId?: string; messages?: any[]; error?: string }) => {
    if (seq !== sessionActivationSeq) return;
    if (!data.ok || data.error) {
      if (!options.silent) toast('加载失败: ' + (data.error || ''));
      return;
    }
    disposeActiveStream();
    applySessionMessages(data, id, options);
    if (!options.silent) {
      toast('已切换到会话 (' + sessionActivationApp.ChatState.getMessages().length + ' 条消息');
    }
  }).catch((error: unknown) => {
    if (seq !== sessionActivationSeq || options.silent) return;
    activateFailReset();
    const reason = error instanceof Error && error.message ? `：${error.message}` : '';
    toast('会话加载失败' + reason);
    activationCallbacks?.loadSessions();
  });
}

function activate(tab: AppTab, options?: SessionActivationOptions): Promise<void> {
  return activateById(tab.id, { ...options, workspace: options?.workspace || tab.workspace });
}

function _switchSession(id: string, options?: SessionActivationOptions): void {
  const tab = sessionActivationApp.Tabs?.getTab?.(id);
  if (tab && (tab.kind === 'session' || tab.kind === 'chat')) {
    void activate(tab, options);
    return;
  }
  void activateById(id, options);
}

function invalidateSessionActivation(): void {
  sessionActivationSeq++;
  sessionActivationApp.SessionRestore.markUserInteraction();
}

const sessionActivationApi: AppSessionActivation = {
  init: initSessionActivation,
  activate,
  activateById,
  switchSession: _switchSession,
  onceActivated: onceSessionActivated,
  emitActivated: emitSessionActivated,
  invalidate: invalidateSessionActivation,
};

sessionActivationApp.SessionActivation = sessionActivationApi;
(window as any).onceSessionActivated = onceSessionActivated;
(window as any).emitSessionActivated = emitSessionActivated;
(window as any).invalidateSessionActivation = invalidateSessionActivation;

export {};
