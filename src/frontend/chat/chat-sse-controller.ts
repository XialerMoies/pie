/// <reference path="../dashboard.d.ts" />

interface ChatSseEvent {
  type: string;
  command?: string;
  reason?: string;
  permissionSuggestions?: any[];
  id?: string;
  summary?: string;
  state?: unknown;
  text?: string;
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
  task?: { status?: string; reason?: string; retryDecisions?: Array<{ category?: string }> };
  evidenceState?: { status?: 'active' | 'cleared'; kind?: string; revision?: number };
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

const CONTRACT_ERROR_REASONS = new Set([
  'source_not_allowed',
  'tool_not_allowed',
  'sequence_required',
  'duplicate_attempt',
  'execution_contract_source_not_allowed',
  'execution_contract_tool_not_allowed',
]);

function contractErrorNode(data: ChatSseEvent): { text: string; reason: string } | undefined {
  const reason = data.task?.reason || data.error || '';
  if (!CONTRACT_ERROR_REASONS.has(reason)) return undefined;
  const type = data.task?.retryDecisions?.at(-1)?.category || 'validation_error';
  return { text: `${type}：${reason}`, reason };
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

      if (data.type === 'stream_ready') {
        if (data.evidenceState) this.dependencies.chat.applyEvidenceState?.(data.evidenceState);
        return;
      }

      if (data.type === 'subagent_event' && data.event) {
        const updated = this.dependencies.chat.updateSubagentEvent?.(data.event) || false;
        if (!updated) this.callbacks.scheduleMessagesRender();
        else {
          this.callbacks.markLastMessageRendered();
          sb('ms');
        }
        return;
      }
      if (data.type === 'command_confirm') {
        const confirmation = (this.dependencies.chatViews as any).ChatCommandConfirmationView;
        if (confirmation?.handle) void confirmation.handle(data);
        return;
      }
      if (data.type === 'plan_confirm') {
        void this.handlePlanConfirmation(data);
        return;
      }
      if (data.type === 'plan_state') {
        this.dependencies.chat.applyPlanState?.(data.state);
        return;
      }
      if (data.type === 'evidence_state') {
        this.dependencies.chat.applyEvidenceState?.(data.state);
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

  private async handlePlanConfirmation(data: ChatSseEvent): Promise<void> {
    if (!data.id) return;
    const approved = await confirmAsync(`
      <div style="font-weight:700;margin-bottom:8px">批准执行方案</div>
      <div style="font-size:.76rem;color:var(--ts);margin-bottom:10px">Agent 已完成规划。批准后才会进入执行状态。</div>
      <pre style="margin:0;max-width:560px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.18);border:1px solid var(--bd);border-radius:7px;padding:10px;font-family:var(--fm);font-size:.74rem;color:var(--tx)">${E(data.summary || '')}</pre>
    `);
    await fetch('/api/chat/plan-confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: data.id, allow: approved }),
    }).catch(() => undefined);
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
    if (!last || !block) return;
    if (!last.blocks) last.blocks = [];
    const index = last.blocks.findIndex((item: any) => item.blockId === block.blockId);
    // A terminal frame can race with the final tool completion frame. Keep
    // accepting updates for an already-mounted block so the live DOM receives
    // OUT instead of requiring a replay/refresh. Never create a new block after
    // the assistant has become terminal.
    if (!last.streaming && index < 0) return;
    if (index >= 0) last.blocks[index] = block;
    else last.blocks.push(block);
    last._rv = (last._rv || 0) + 1;
    const updated = this.dependencies.chat.updateLastBlock?.(block) || false;
    if (!updated) this.callbacks.scheduleMessagesRender();
    else {
      this.callbacks.markLastMessageRendered();
      sb('ms');
    }

    const permissionFailure = block.metadata?.permissionFailure;
    if (permissionFailure && typeof permissionFailure === 'object') {
      const failure = permissionFailureToChatError(permissionFailure as PermissionFailurePayload);
      this.finalizeOpenBlocks(last, failure.reason || failure.message);
      last.streaming = false;
      last._rv = (last._rv || 0) + 1;
      this.callbacks.setAssistantError(failure.title, failure.message, failure.reason, failure.nextSteps, failure.raw, failure.actions);
      this.dependencies.chatState.setBusy(false);
      this.dependencies.chatStream.close();
      this.callbacks.renderMessages();
      this.callbacks.refreshComposer();
      this.callbacks.failSend();
    }
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
    this.dependencies.chat.clearEvidenceState?.();
    this.dependencies.chatStream.close();
    const finalized = this.dependencies.chat.finalizeLastMessage?.() || false;
    if (finalized) this.callbacks.markLastMessageRendered();
    else this.callbacks.renderMessages();
    this.callbacks.refreshComposer();
    this.callbacks.completeSend(data.sessionId || '', data.text || '');
    sb('ms');
  }

  private finalizeOpenBlocks(last: any, reason: string): void {
    if (!last?.blocks?.length) return;
    let changed = false;
    last.blocks = last.blocks.map((block: any) => {
      if (block.type === 'thinking' && block.status === 'streaming') {
        changed = true;
        return { ...block, status: 'done' };
      }
      if ((block.type === 'tool' || block.type === 'tool_use' || block.type === 'step') && block.status === 'running') {
        changed = true;
        return { ...block, status: 'error', error: block.error || reason };
      }
      return block;
    });
    if (changed) last._rv = (last._rv || 0) + 1;
  }

  private handleFailedTerminal(last: any, data: ChatSseEvent): void {
    if (!last) return;
    if (data.turnId && !last.turnId) last.turnId = data.turnId;
    if (typeof data.text === 'string') last.content = data.text;
    if (Array.isArray(data.blocks)) last.blocks = data.blocks;
    const reason = data.error || data.message || 'Agent turn failed';
    const contractNode = contractErrorNode(data);
    if (contractNode) {
      const blocks = Array.isArray(last.blocks) ? last.blocks : (last.blocks = []);
      if (!blocks.some((block: any) => block.type === 'step' && block.blockId === `error-${data.turnId || 'terminal'}`)) {
        const seq = blocks.reduce((max: number, block: any) => Math.max(max, Number(block.seq) || 0), 0) + 1;
        blocks.push({
          type: 'step',
          status: 'error',
          variant: 'error',
          text: contractNode.text,
          turnId: data.turnId,
          blockId: `error-${data.turnId || 'terminal'}`,
          seq,
        });
      }
      last.error = undefined;
      last.streaming = false;
      last._rv = (last._rv || 0) + 1;
      this.dependencies.chatState.setBusy(false);
      this.dependencies.chat.clearEvidenceState?.();
      this.dependencies.chatStream.close();
      this.callbacks.renderMessages();
      this.callbacks.refreshComposer();
      this.callbacks.completeSend(data.sessionId || '', data.text || '');
      sb('ms');
      return;
    }
    const hasSpecificReason = reason !== 'Agent turn failed';
    this.finalizeOpenBlocks(last, reason);
    this.callbacks.setAssistantError(
      '回复失败',
      hasSpecificReason ? `当前回复未能完成：${reason}` : '当前回复未能完成。',
      undefined,
      undefined,
      hasSpecificReason ? reason : undefined,
      ['retry', 'copy'],
    );
    this.dependencies.chatState.setBusy(false);
    this.dependencies.chat.clearEvidenceState?.();
    this.dependencies.chatStream.close();
    this.callbacks.refreshComposer();
    this.callbacks.failSend();
    sb('ms');
  }

  private handleCancelled(last: any, data: ChatSseEvent): void {
    if (last) {
      if (data.turnId && !last.turnId) last.turnId = data.turnId;
      this.finalizeOpenBlocks(last, '本轮已取消');
      last.streaming = false;
      last.error = undefined;
      last._rv = (last._rv || 0) + 1;
    }
    this.dependencies.chatState.setBusy(false);
    this.dependencies.chat.clearEvidenceState?.();
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
      const last = this.dependencies.chatState.getMessages().at(-1);
      this.finalizeOpenBlocks(last, failure.reason || failure.message);
      if (last) {
        last.streaming = false;
        last._rv = (last._rv || 0) + 1;
      }
      this.callbacks.setAssistantError(failure.title, failure.message, failure.reason, failure.nextSteps, failure.raw, failure.actions);
      this.dependencies.chatState.setBusy(false);
      this.dependencies.chat.clearEvidenceState?.();
      this.dependencies.chatStream.close();
      this.callbacks.renderMessages();
      this.callbacks.refreshComposer();
      this.callbacks.failSend();
      sb('ms');
      return;
    }
    const reason = data.text || data.message || '未知错误';
    this.finalizeOpenBlocks(this.dependencies.chatState.getMessages().at(-1), reason);
    this.callbacks.setAssistantError(
      '发生了错误',
      '当前回复未能完成。请先查看错误详情，再决定是否重试。',
      reason,
      ['检查网络和模型配置', '确认工作区路径仍然有效', '重试发送当前消息'],
      reason,
    );
    this.dependencies.chatState.setBusy(false);
    this.dependencies.chat.clearEvidenceState?.();
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
