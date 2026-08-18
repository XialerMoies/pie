/// <reference path="../dashboard.d.ts" />

interface ChatSseEvent {
  type: string;
  command?: string;
  reason?: string;
  permissionSuggestions?: any[];
  text?: string;
  thinking?: boolean;
  turnId?: string;
  sessionId?: string;
  message?: string;
  block?: any;
  blocks?: any[];
  event?: any;
  steering?: any[];
  followUp?: any[];
  failure?: PermissionFailurePayload;
  status?: 'done' | 'error';
  error?: string;
}

interface ChatSseControllerDependencies {
  chat: AppChat;
  chatState: AppChatState;
  chatStream: AppChatStream;
  chatViews: AppChatViews;
}

function permissionFailureToChatError(failure: PermissionFailurePayload): ChatErrorState {
  const actions: ChatErrorAction[] = failure.category === 'safety'
    ? ['copy']
    : failure.category === 'confirmation'
      ? ['reconnect', 'permissions', 'copy']
      : ['permissions', 'retry', 'copy'];
  return {
    title: failure.category === 'safety' ? '高风险操作已拦截' : '权限操作未完成',
    message: failure.message || '权限检查未通过，操作已安全拒绝。',
    reason: failure.reason,
    nextSteps: failure.suggestions?.map((suggestion) => suggestion.label).filter(Boolean) || [],
    raw: failure.reason,
    actions,
  };
}

class ChatSseControllerView {
  private readonly callbacks: ChatSseControllerCallbacks;
  private readonly dependencies: ChatSseControllerDependencies;
  private generation = 0;

  constructor(callbacks: ChatSseControllerCallbacks, dependencies: ChatSseControllerDependencies) {
    this.callbacks = callbacks;
    this.dependencies = dependencies;
  }

  bind(generation: number): boolean {
    this.generation = generation;
    return this.dependencies.chatStream.setHandlers(generation, {
      onMessage: (event) => this.handleMessage(generation, event),
      onError: (event) => this.handleError(generation, event),
      onOpen: (event) => this.handleOpen(generation, event),
    });
  }

  handleMessage(generation: number, event: MessageEvent): void {
    if (!this.isCurrent(generation)) return;
    try {
      if (!window.___sseFirst) {
        window.___sseFirst = true;
        mark('sse_first_event');
      }
      const data = JSON.parse(event.data) as ChatSseEvent;
      const messages = this.dependencies.chatState.getMessages();
      const last = messages[messages.length - 1];

      if (data.type === 'subagent_event' && data.event) {
        const updated = this.dependencies.chat.updateSubagentEvent?.(data.event) || false;
        if (!updated) this.callbacks.scheduleMessagesRender();
        else sb('ms');
        return;
      }
      if (data.type === 'command_confirm') {
        const confirmation = (this.dependencies.chatViews as any).ChatCommandConfirmationView;
        if (confirmation?.handle) void confirmation.handle(data);
        return;
      }
      if (data.type === 'queue_update') {
        const steering = Array.isArray(data.steering) ? data.steering.length : 0;
        const followUp = Array.isArray(data.followUp) ? data.followUp.length : 0;
        const total = steering + followUp;
        if (total > 0) toast(`${total} 条补充已排队`, 'info');
        return;
      }
      if (data.type === 'block') {
        this.handleBlock(last, data.block);
        return;
      }
      if (data.type === 'delta') {
        this.handleDelta(last, data);
        return;
      }
      if (data.type === 'thinking') {
        if (last) {
          last.thinking = (last.thinking || '') + (data.text || '');
          last._rv = (last._rv || 0) + 1;
        }
        sb('ms');
        return;
      }
      if (data.type === 'done') {
        if (data.status === 'error') {
          this.handleFailedTerminal(last, data);
          return;
        }
        this.handleDone(last, data);
        return;
      }
      if (data.type === 'cancelled') {
        this.handleCancelled(last, data);
        return;
      }
      if (data.type === 'error') this.handleBusinessError(data);
    } catch {
      // Ignore malformed payloads and keep the active stream alive.
    }
  }

  handleError(generation: number, _event: Event): void {
    if (!this.isCurrent(generation)) return;
    // EventSource owns reconnects and resumes with Last-Event-ID.
    toast('连接中断，正在重连…', 'info');
    this.callbacks.updateUI();
  }

  handleOpen(generation: number, _event: Event): void {
    if (!this.isCurrent(generation)) return;
    this.callbacks.updateUI();
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation && this.dependencies.chatStream.isCurrent(generation);
  }

  private handleBlock(last: any, block: any): void {
    if (!last?.streaming || !block) return;
    if (!last.blocks) last.blocks = [];
    const index = last.blocks.findIndex((item: any) => item.blockId === block.blockId);
    if (index >= 0) last.blocks[index] = block;
    else last.blocks.push(block);
    last._rv = (last._rv || 0) + 1;
    const updated = this.dependencies.chat.updateLastBlock?.(block) || false;
    if (!updated) this.callbacks.scheduleMessagesRender();
    else sb('ms');

    const permissionFailure = block.metadata?.permissionFailure;
    if (permissionFailure && typeof permissionFailure === 'object') {
      const failure = permissionFailureToChatError(permissionFailure as PermissionFailurePayload);
      this.callbacks.setAssistantError(failure.title, failure.message, failure.reason, failure.nextSteps, failure.raw, failure.actions);
      this.dependencies.chatState.setBusy(false);
      this.dependencies.chatStream.close();
      this.callbacks.refreshComposer();
      this.callbacks.failSend();
    }
  }

  private handleDelta(last: any, data: ChatSseEvent): void {
    if (data.thinking) {
      sb('ms');
      return;
    }
    if (last?.streaming) {
      if (!last.blocks?.length) this.dependencies.chat.appendDelta?.(data.text || '');
    } else {
      this.dependencies.chatState.appendMessage({ role: 'assistant', content: data.text || '', thinking: '', streaming: true });
      this.callbacks.updateUI();
    }
    sb('ms');
  }

  private handleDone(last: any, data: ChatSseEvent): void {
    if (!last) return;
    if (data.turnId && !last.turnId) last.turnId = data.turnId;
    last.content = data.text || '';
    last.streaming = false;
    last.error = undefined;
    if (Array.isArray(data.blocks)) last.blocks = data.blocks;
    last._rv = (last._rv || 0) + 1;
    this.dependencies.chatState.setBusy(false);
    this.dependencies.chatStream.close();
    const finalized = this.dependencies.chat.finalizeLastMessage?.() || false;
    if (finalized) this.callbacks.markLastMessageRendered();
    else this.callbacks.renderMessages();
    this.callbacks.refreshComposer();
    this.callbacks.completeSend(data.sessionId || '', data.text || '');
    sb('ms');
  }

  private handleFailedTerminal(last: any, data: ChatSseEvent): void {
    if (!last) return;
    if (data.turnId && !last.turnId) last.turnId = data.turnId;
    if (typeof data.text === 'string') last.content = data.text;
    if (Array.isArray(data.blocks)) last.blocks = data.blocks;
    const reason = data.error || data.message || 'Agent turn failed';
    this.callbacks.setAssistantError(
      '回复失败',
      '当前回复未能完成。请查看错误详情后重试。',
      reason,
      ['检查模型与网络状态', '重新发送当前消息'],
      reason,
      ['retry', 'copy'],
    );
    this.dependencies.chatState.setBusy(false);
    this.dependencies.chatStream.close();
    this.callbacks.refreshComposer();
    this.callbacks.failSend();
    sb('ms');
  }

  private handleCancelled(last: any, data: ChatSseEvent): void {
    if (last) {
      if (data.turnId && !last.turnId) last.turnId = data.turnId;
      last.streaming = false;
      last.error = undefined;
      last._rv = (last._rv || 0) + 1;
    }
    this.dependencies.chatState.setBusy(false);
    this.dependencies.chatStream.close();
    const finalized = last && (this.dependencies.chat.finalizeLastMessage?.() || false);
    if (finalized) this.callbacks.markLastMessageRendered();
    else this.callbacks.renderMessages();
    this.callbacks.refreshComposer();
    this.callbacks.failSend();
    sb('ms');
  }

  private handleBusinessError(data: ChatSseEvent): void {
    if (data.failure) {
      const failure = permissionFailureToChatError(data.failure);
      this.callbacks.setAssistantError(failure.title, failure.message, failure.reason, failure.nextSteps, failure.raw, failure.actions);
      this.dependencies.chatState.setBusy(false);
      this.dependencies.chatStream.close();
      this.callbacks.renderMessages();
      this.callbacks.refreshComposer();
      this.callbacks.failSend();
      sb('ms');
      return;
    }
    const reason = data.text || data.message || '未知错误';
    this.callbacks.setAssistantError(
      '发生了错误',
      '当前回复未能完成。请先查看错误详情，再决定是否重试。',
      reason,
      ['检查网络和模型配置', '确认工作区路径仍然有效', '重试发送当前消息'],
      reason,
    );
    this.dependencies.chatState.setBusy(false);
    this.dependencies.chatStream.close();
    this.callbacks.renderMessages();
    this.callbacks.refreshComposer();
    this.callbacks.failSend();
    sb('ms');
    console.error('[chat] SSE error:', data.text || data.message);
  }
}

const chatSseControllerApp = (window as any).App;
if (chatSseControllerApp) {
  chatSseControllerApp.ChatViews = {
    ...(chatSseControllerApp.ChatViews || {}),
    ChatSseControllerView,
    permissionFailureToChatError,
    createSseController: (callbacks: ChatSseControllerCallbacks): AppChatSseController => new ChatSseControllerView(callbacks, {
      chat: chatSseControllerApp.Chat,
      chatState: chatSseControllerApp.ChatState,
      chatStream: chatSseControllerApp.ChatStream,
      chatViews: chatSseControllerApp.ChatViews,
    }),
  };
}

export {};
