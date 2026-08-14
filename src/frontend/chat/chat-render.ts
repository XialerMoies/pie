// ═══════════════════════════════════════════════════════════════════
//  消息渲染 & 流式追加
// ═══════════════════════════════════════════════════════════════════

/** 渲染 markdown 为 HTML（过滤可能影响布局的标签） */
function safeMarkdownUrl(value: unknown, image = false): string | null {
  const href = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (!href || href.startsWith('//')) return null;
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch { /* keep the original */ }
  if (/^(?:javascript|vbscript|data|file):/i.test(decoded)) return null;
  const scheme = decoded.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && !['http', 'https', 'mailto'].includes(scheme)) return null;
  if (image && scheme === 'mailto') return null;
  try {
    const probe = document.createElement('a');
    probe.href = href;
    const protocol = probe.protocol.toLowerCase();
    if (['javascript:', 'vbscript:', 'data:', 'file:'].includes(protocol)) return null;
    if (image && protocol === 'mailto:') return null;
  } catch { /* URL probing is defense in depth. */ }
  return href;
}

function escapeMarkup(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mdRender(text: string): string {
  const md = (window as any).marked as typeof import("marked") | undefined;
  if (!md || !text) return E(text || '');
  try {
    const renderer = new md.Renderer();
    renderer.html = ({ text: raw }: any) => escapeMarkup(raw);
    renderer.link = function (this: any, token: any): string {
      const label = this.parser.parseInline(token.tokens || []);
      const href = safeMarkdownUrl(token.href);
      if (!href) return label;
      const title = token.title ? ` title="${escapeMarkup(token.title)}"` : '';
      return `<a href="${escapeMarkup(href)}"${title}>${label}</a>`;
    };
    renderer.image = function (this: any, token: any): string {
      const href = safeMarkdownUrl(token.href, true);
      if (!href) return escapeMarkup(token.text || '');
      const title = token.title ? ` title="${escapeMarkup(token.title)}"` : '';
      return `<img src="${escapeMarkup(href)}" alt="${escapeMarkup(token.text || '')}"${title}>`;
    };
    const html = md.parse(text, { breaks: true, gfm: true, renderer }) as string;
    return html;
  } catch {
    return E(text);
  }
}

function renderErrorCard(error: ChatErrorState): string {
  return App.ChatViews.ChatErrorView.render(error);
}

App.ChatViews?.configure?.({ renderMarkdown: mdRender });
App.ChatViews?.ChatEventNodeView?.configure?.({ renderMarkdown: mdRender });
function renderBlocks(blocks: any[], subagentBatches?: readonly FrontendSubagentBatch[]): string {
  return App.ChatViews.ChatEventNodeView.renderBlocks(blocks, subagentBatches);
}

function renderEventBlock(block: any, blocks: any[], defaultOpen?: boolean, subagentBatches?: readonly FrontendSubagentBatch[]): string {
  return App.ChatViews.ChatEventNodeView.renderEventBlock(block, blocks, defaultOpen, subagentBatches);
}

function replaceBlockContents(target: HTMLElement, html: string): void {
  App.ChatViews.ChatEventNodeView.replaceBlockContents(target, html);
}

function insertBlockNode(flow: HTMLElement, block: any, blocks: any[]): boolean {
  return App.ChatViews.ChatEventNodeView.insertBlockNode(flow, block, blocks);
}

function refreshEditSummary(flow: HTMLElement, blocks: any[]): void {
  App.ChatViews.ChatEventNodeView.refreshEditSummary(flow, blocks);
}

function subagentDelegationData(block: any, blocks: any[], batches?: readonly FrontendSubagentBatch[]): SubagentDelegationData {
  return App.ChatViews.ChatEventNodeView.subagentDelegationData(block, blocks, batches);
}

function blockId(block: any): string {
  return App.ChatViews.ChatEventNodeView.blockId(block);
}

function renderMessage(m: any, messageIndex = -1): string {
  const c = m.role + (m.streaming ? ' go' : ''), lb = m.role === 'user' ? '你' : 'Pi';
  const ty = m.streaming ? `<div class="ty"><span class="ty-d"></span><span class="ty-d"></span><span class="ty-d"></span></div>` : '';
  const error = m.error ? renderErrorCard(m.error) : '';
  const indexAttr = Number.isInteger(messageIndex) && messageIndex >= 0
    ? ` data-message-index="${messageIndex}"`
    : '';

  // Compact summary 专用渲染
  if (m._compacted) {
    const content = m.content ? mdRender(m.content) : '';
    return `<div class="compact-summary"${indexAttr}>${content}</div>`;
  }

  if (m.blocks && m.blocks.length > 0) {
    return `<div class="m ${c}${m.error ? ' error' : ''}"${indexAttr}><div class="ml">${lb}</div>${error}<div class="mt block-flow">${renderBlocks(m.blocks, m.subagentBatches)}</div>${ty}</div>`;
  }

  const content = m.content ? mdRender(m.content) : '';
  const think = m.thinking ? `<details class="think"><summary>🤔 思考过程</summary>${mdRender(m.thinking)}</details>` : '';
  return `<div class="m ${c}${m.error ? ' error' : ''}"${indexAttr}><div class="ml">${lb}</div>${error}${think}<div class="mt">${content}</div>${ty}</div>`;
}

function msgs(): string {
  const M = App.ChatState.getMessages();
  if (M.length === 0) return '<div class="wl"><h2>Pi — 你的代码助手</h2><p>在下方输入，开始编码</p></div>';
  return M.map((message, index) => renderMessage(message, index)).join('\n');
}

function updateLastBlock(block: any): boolean {
  const messages = App.ChatState.getMessages();
  const message = messages[messages.length - 1] as any;
  const messagesElement = $('ms');
  if (!message?.blocks?.length || !messagesElement) return false;
  const messageElements = messagesElement.querySelectorAll('.m');
  const lastMessageElement = messageElements[messageElements.length - 1] as HTMLElement | undefined;
  if (!lastMessageElement) return false;

  const flow = lastMessageElement.querySelector('.assistant-blocks') as HTMLElement | null;
  if (!flow) {
    const contentElement = lastMessageElement.querySelector('.mt') as HTMLElement | null;
    if (!contentElement) return false;
    contentElement.classList.add('block-flow');
    contentElement.innerHTML = renderBlocks(message.blocks, message.subagentBatches);
    return true;
  }
  refreshEditSummary(flow, message.blocks);

  const target = Array.from(flow.querySelectorAll<HTMLElement>('[data-block-id]'))
    .find(element => element.dataset.blockId === blockId(block));
  if (target && block.name === 'delegate_tasks') {
    App.ChatViews.refreshSubagentDelegation(target, subagentDelegationData(block, message.blocks, message.subagentBatches));
    refreshEditSummary(flow, message.blocks);
    return true;
  }
  if (target && block.type === 'text') {
    const textBody = target.querySelector('.trace-text-body') as HTMLElement | null;
      if (textBody) textBody.innerHTML = mdRender(block.text || '');
      else replaceBlockContents(target, renderEventBlock(block, message.blocks, undefined, message.subagentBatches));
      refreshEditSummary(flow, message.blocks);
      return true;
  }
  if (target && block.type === 'thinking') {
    const textElement = target.querySelector('.trace-thinking-text') as HTMLElement | null;
      if (textElement) {
        textElement.innerHTML = mdRender(block.text || '');
        refreshEditSummary(flow, message.blocks);
        return true;
    }
  }
  if (target && (block.type === 'tool' || block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'step' || block.type === 'user_note')) {
    replaceBlockContents(target, renderEventBlock(block, message.blocks, undefined, message.subagentBatches));
    refreshEditSummary(flow, message.blocks);
    return true;
  }
  if (block.type === 'tool_result') {
    const toolUse = message.blocks.find((item: any) => item.type === 'tool_use' && item.toolCallId && item.toolCallId === block.toolUseId);
    if (toolUse) {
      const toolTarget = Array.from(flow.querySelectorAll<HTMLElement>('[data-block-id]'))
        .find(element => element.dataset.blockId === blockId(toolUse));
      if (toolTarget) {
        replaceBlockContents(toolTarget, renderEventBlock(toolUse, message.blocks, undefined, message.subagentBatches));
        refreshEditSummary(flow, message.blocks);
        return true;
      }
    }
  }

  const inserted = insertBlockNode(flow, block, message.blocks);
  refreshEditSummary(flow, message.blocks);
  return inserted;
}

function finalizeLastMessage(): boolean {
  const messages = App.ChatState.getMessages();
  const message = messages[messages.length - 1] as any;
  const messagesElement = $('ms');
  if (!message || !messagesElement) return false;
  const messageElements = messagesElement.querySelectorAll('.m');
  const lastMessageElement = messageElements[messageElements.length - 1] as HTMLElement | undefined;
  if (!lastMessageElement) return false;

  lastMessageElement.classList.remove('go');
  lastMessageElement.querySelector('.ty')?.remove();

  const contentElement = lastMessageElement.querySelector('.mt') as HTMLElement | null;
  if (!contentElement) return false;

  if (message.blocks?.length) {
    contentElement.classList.add('block-flow');
    const flow = contentElement.querySelector('.assistant-blocks') as HTMLElement | null;
    if (!flow) {
      contentElement.innerHTML = renderBlocks(message.blocks, message.subagentBatches);
      return true;
    }

    let fullySynced = true;
    for (const block of [...message.blocks].sort((a: any, b: any) => a.seq - b.seq)) {
      const target = Array.from(flow.querySelectorAll<HTMLElement>('[data-block-id]'))
        .find(element => element.dataset.blockId === blockId(block));
      if (target && block.type === 'text') {
        const textBody = target.querySelector('.trace-text-body') as HTMLElement | null;
        if (textBody) textBody.innerHTML = mdRender(block.text || '');
        else replaceBlockContents(target, renderEventBlock(block, message.blocks, undefined, message.subagentBatches));
      } else if (target && block.type === 'thinking') {
        const textElement = target.querySelector('.trace-thinking-text') as HTMLElement | null;
        if (textElement) textElement.innerHTML = mdRender(block.text || '');
        else fullySynced = false;
      } else if (target && block.type === 'tool_use') {
        if (block.name === 'delegate_tasks') {
          App.ChatViews.refreshSubagentDelegation(target, subagentDelegationData(block, message.blocks, message.subagentBatches));
        } else {
          replaceBlockContents(target, renderEventBlock(block, message.blocks, undefined, message.subagentBatches));
        }
      } else if (block.type === 'tool_result') {
        const toolUse = message.blocks.find((item: any) => item.type === 'tool_use' && item.toolCallId && item.toolCallId === block.toolUseId);
        const toolTarget = toolUse ? Array.from(flow.querySelectorAll<HTMLElement>('[data-block-id]'))
          .find(element => element.dataset.blockId === blockId(toolUse)) : null;
        if (toolTarget) replaceBlockContents(toolTarget, renderEventBlock(toolUse, message.blocks, undefined, message.subagentBatches));
        else fullySynced = false;
      } else {
        fullySynced = false;
      }
    }
    if (!fullySynced) contentElement.innerHTML = renderBlocks(message.blocks, message.subagentBatches);
    else refreshEditSummary(flow, message.blocks);
    return true;
  }

  contentElement.classList.remove('block-flow');
  contentElement.innerHTML = mdRender(message.content || '');
  const thinkingElement = lastMessageElement.querySelector('.think') as HTMLElement | null;
  if (message.thinking) {
    const html = `<details class="think"><summary>🤔 思考过程</summary>${mdRender(message.thinking)}</details>`;
    if (thinkingElement) thinkingElement.outerHTML = html;
    else contentElement.insertAdjacentHTML('beforebegin', html);
  } else {
    thinkingElement?.remove();
  }
  return true;
}

function updateSubagentEvent(event: FrontendSubagentEvent): boolean {
  const messages = App.ChatState.getMessages();
  let messageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].blocks?.some((candidate) =>
      candidate.name === 'delegate_tasks' && candidate.toolCallId === event.parentToolCallId
    )) {
      messageIndex = index;
      break;
    }
  }
  if (messageIndex < 0) messageIndex = messages.length - 1;
  const message = messages[messageIndex];
  if (!message || event.type !== 'subagent_event') return false;
  message.subagentEvents = [...(message.subagentEvents ?? []), event];
  message.subagentBatches = reduceFrontendSubagentEvents(message.subagentEvents);
  message._rv = (message._rv || 0) + 1;
  const block = message.blocks?.find((candidate) =>
    candidate.name === 'delegate_tasks' && candidate.toolCallId === event.parentToolCallId
  );
  if (!block || messageIndex !== messages.length - 1) return false;
  const messagesElement = $('ms');
  const messageElements = messagesElement?.querySelectorAll('.m');
  const lastMessageElement = messageElements?.[messageElements.length - 1] as HTMLElement | undefined;
  const blockRoot = lastMessageElement
    ? Array.from(lastMessageElement.querySelectorAll<HTMLElement>('[data-block-id]'))
      .find(element => element.dataset.blockId === blockId(block))
    : null;
  if (blockRoot) {
    App.ChatViews.refreshSubagentDelegation(blockRoot, subagentDelegationData(block, message.blocks || [], message.subagentBatches));
    return true;
  }
  return updateLastBlock(block);
}

function appendDelta(text: string): void {
  const M = App.ChatState.getMessages();
  const msgsEl = $('ms');
  if (!msgsEl) return;
  const last = M[M.length - 1];
  if (!last) return;

  // Block 模式：text delta 追加到最后一个 text block
  if (last.blocks && last.blocks.length > 0) {
    const textBlocks = last.blocks.filter((b): b is AssistantBlock => b.type === 'text');
    if (textBlocks.length > 0) {
      textBlocks[textBlocks.length - 1].text += text;
    } else {
      last.blocks.push({ type: 'text', text, blockId: 'text-live', seq: last.blocks.length + 1 });
    }
    last._rv = (last._rv || 0) + 1;
    updateLastBlock(textBlocks[textBlocks.length - 1] || last.blocks[last.blocks.length - 1]);
    return;
  }

  last.content += text;
  last._rv = (last._rv || 0) + 1;
  const msgDivs = msgsEl.querySelectorAll('.m');
  const lastMsg = msgDivs[msgDivs.length - 1];
  if (lastMsg) {
    const cd = lastMsg.querySelector('.mt');
    if (cd) { cd.innerHTML = mdRender(last.content); return; }
  }
  msgsEl.innerHTML = msgs();
}

// ─── App 命名空间绑定 ──────────────────────────────────────
window.msgs = msgs;
{ const AppChat = (window as any).App?.Chat; if (AppChat) {
  AppChat.msgs = msgs;
  AppChat.renderMessage = renderMessage;
  AppChat.appendDelta = appendDelta;
  AppChat.updateLastBlock = updateLastBlock;
  AppChat.updateSubagentEvent = updateSubagentEvent;
  AppChat.finalizeLastMessage = finalizeLastMessage;
} }
