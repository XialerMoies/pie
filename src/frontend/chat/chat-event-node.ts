interface ChatEventNodeDependencies {
  renderMarkdown: (text: string) => string;
  chatViews: AppChatViews;
  fileDiff: AppFileDiff;
}

const chatEventNodeApp = (window as any).App;
const chatEventNodeDependencies: ChatEventNodeDependencies = {
  renderMarkdown: (text) => E(text || ''),
  chatViews: chatEventNodeApp.ChatViews,
  fileDiff: chatEventNodeApp.FileDiff,
};
const chatEventNodeChatViews = chatEventNodeDependencies.chatViews;
const chatEventNodeFileDiff = chatEventNodeDependencies.fileDiff;

function chatEventNodeConfigure(dependencies: Partial<ChatEventNodeDependencies>): void {
  if (dependencies.renderMarkdown) chatEventNodeDependencies.renderMarkdown = dependencies.renderMarkdown;
}

function chatEventNodeMarkdown(text: string): string {
  return chatEventNodeDependencies.renderMarkdown(text);
}

function chatEventNodeShortText(value: unknown, max = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n... truncated' : text;
}

function chatEventNodeRenderEditSummary(blocks: any[], expanded = true): string {
  return chatEventNodeChatViews.EditSummaryView.render(blocks, expanded);
}

function chatEventNodeRefreshEditSummary(flow: HTMLElement, blocks: any[]): void {
  chatEventNodeChatViews.refreshEditSummary(flow, blocks);
}

function chatEventNodeFirstSummaryLine(value: string, max = 220): string {
  const line = value.split(/\r?\n/).find(item => item.trim())?.trim() || '';
  return line.length > max ? line.slice(0, max) + '...' : line;
}

function chatEventNodeToolTitle(name: string): string {
  const lower = String(name || 'tool').toLowerCase().replace(/[-_]+/g, '-');
  if (lower === 'search') return '搜索代码';
  if (lower === 'file-read' || lower === 'fileread') return '读取文件';
  if (lower === 'file-write' || lower === 'filewrite' || lower === 'apply-patch' || lower === 'edit') return '修改文件';
  if (lower === 'explorer-list' || lower === 'explorerlist') return '浏览目录';
  if (lower === 'git-status') return '验证结果';
  if (lower === 'git-log') return '查看提交历史';
  if (lower === 'file-outline' || lower === 'fileoutline') return '代码结构';
  return (name || '工具').replace(/[-_]+/g, ' ');
}

function chatEventNodeReadTracePath(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  if (typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  return String(obj.path || obj.filePath || obj.root || obj.cwd || obj.query || obj.dir || obj.directory || obj.name || '').trim();
}

function chatEventNodeShouldCollapseTrace(t: any, output: string): boolean {
  if (t.type === 'thinking') return false;
  if (t.type === 'tool' && t.status === 'error') return false;
  return output.length > 260;
}

function chatEventNodeTraceSummaryText(t: any, input: string, output: string): string {
  if (t.type === 'thinking') return '';
  if (t.type === 'tool' && t.status === 'error') {
    return chatEventNodeShortText(t.error || output || '工具失败', 220);
  }
  const name = String(t.name || '').toLowerCase().replace(/[-_]+/g, '-');
  const path = chatEventNodeReadTracePath(t.input);
  if (name === 'search') {
    const firstLine = String(output || '').split('\n').find(line => line.trim()) || '';
    const match = firstLine.match(/共\s*(\d+)\s*处匹配，\s*(\d+)\s*个文件/);
    if (match) return `找到 ${match[1]} 处匹配，${match[2]} 个文件`;
    if (path) return `搜索关键词：${path}`;
    return firstLine || '搜索代码';
  }
  if (name === 'file-read' || name === 'fileread') {
    return path ? `读取文件：${path}` : '读取文件';
  }
  if (name === 'file-write' || name === 'filewrite' || name === 'apply-patch' || name === 'edit') {
    return path ? `修改文件：${path}` : '修改文件';
  }
  if (name === 'explorer-list' || name === 'explorerlist') {
    return path ? `浏览目录：${path}` : '浏览目录';
  }
  if (name === 'git-status') {
    const firstLine = String(output || '').split('\n').find(line => line.trim()) || '';
    return firstLine || '验证结果';
  }
  if (name === 'git-log') return '查看提交历史';
  return chatEventNodeShortText(output || input || '', 180);
}

function chatEventNodeHasTraceValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function chatEventNodeRenderTraceItem(t: any, defaultOpen?: boolean): string {
  if (t.type === 'thinking') {
    const text = chatEventNodeShortText(t.text || '思考中...', 1000);
    const status = t.status === 'done' ? 'done' : 'streaming';
    const open = defaultOpen || status === 'streaming';
    return `<div class="trace-node trace-thinking trace-${status}"><div class="trace-dot"></div><details class="trace-thought"${open ? ' open' : ''}><summary>Thought${status === 'streaming' ? '...' : ''}</summary><div class="trace-thinking-text">${chatEventNodeMarkdown(text)}</div></details></div>`;
  }
  if (t.type === 'tool') {
    const status = t.status || 'running';
    const input = chatEventNodeHasTraceValue(t.input) ? chatEventNodeShortText(t.input, 900) : '';
    const result = t.error || t.output;
    const output = chatEventNodeHasTraceValue(result) ? chatEventNodeShortText(result, 1200) : '';
    const diffBlock = chatEventNodeFileDiff?.render?.(t.metadata?.diff) || '';
    const inputSection = input ? `<div class="trace-card-section trace-card-in"><div class="trace-card-label">IN</div><pre>${E(input)}</pre></div>` : '';
    const outputLabel = t.status === 'error' ? 'ERROR' : 'OUT';
    const outputSection = output ? `<div class="trace-card-section trace-card-out"><div class="trace-card-label${t.status === 'error' ? ' error' : ''}">${outputLabel}</div><pre>${E(output)}</pre></div>` : '';
    const ioBlock = inputSection || outputSection ? `<div class="trace-card">${inputSection}${outputSection}</div>` : '';
    const diffSummaryText = diffBlock ? chatEventNodeFirstSummaryLine(output) : '';
    const diffSummary = diffSummaryText ? `<div class="trace-diff-summary">${E(diffSummaryText)}</div>` : '';
    const eventContent = diffBlock ? `<div class="trace-diff-event">${diffSummary}${diffBlock}</div>` : ioBlock;
    const collapsed = chatEventNodeShouldCollapseTrace(t, output);
    const title = chatEventNodeToolTitle(t.name);
    const rawSummary = chatEventNodeTraceSummaryText(t, input, output);
    const summary = rawSummary !== title && (!output || collapsed || !output.includes(rawSummary)) ? rawSummary : '';
    const summaryBlock = summary ? `<div class="trace-summary-text">${E(summary)}</div>` : '';
    const head = `<div class="trace-head"><div class="trace-title"><span class="trace-summary-title">${E(title)}</span></div>${summaryBlock}</div>`;
    if (!eventContent) return `<div class="trace-node trace-tool trace-${status}"><div class="trace-dot"></div>${head}</div>`;
    return `<details class="trace-node trace-tool trace-${status} trace-details"${collapsed ? '' : ' open'}><summary class="trace-summary"><div class="trace-dot"></div>${head}</summary><div class="trace-body">${eventContent}</div></details>`;
  }
  if (t.type === 'step') {
    if (t.variant === 'error' || t.status === 'error') {
      return `<div class="trace-node trace-error-node trace-error"><div class="trace-error-rule"></div><div class="trace-error-text">${E(t.text || '')}</div></div>`;
    }
    return `<div class="trace-node trace-step trace-${t.status || 'info'}"><div class="trace-dot"></div><div class="trace-body"><div class="trace-title"><span class="trace-summary-title">${E(t.text || '')}</span></div></div></div>`;
  }
  if (t.type === 'user_note') {
    const status = t.status === 'failed' ? 'failed' : t.status === 'delivered' ? 'delivered' : 'queued';
    const statusText = status === 'failed' ? '发送失败' : status === 'delivered' ? '已送达' : '排队中';
    const modeText = t.mode === 'followUp' ? '做完再处理' : '当前步骤后';
    return `<div class="trace-node trace-user-note trace-${status}"><div class="trace-dot"></div><div class="trace-body"><div class="trace-title"><span class="trace-summary-title">你 · 补充</span><span class="trace-note-mode">${modeText}</span><span class="trace-note-status">${statusText}</span></div><div class="trace-note-text">${chatEventNodeMarkdown(t.text || '')}</div></div></div>`;
  }
  if (t.type === 'text') return `<div class="trace-node trace-text"><div class="trace-dot"></div><div class="trace-body trace-text-body">${chatEventNodeMarkdown(t.text || '')}</div></div>`;
  return '';
}

function chatEventNodeBlockId(block: any): string {
  return String(block.blockId || `${block.type || 'block'}-${block.seq || 0}`);
}

function chatEventNodeSubagentData(block: any, blocks: any[], batches?: readonly FrontendSubagentBatch[]): SubagentDelegationData {
  if (block.type === 'tool_use') {
    const result = blocks.find(item => item.type === 'tool_result' && item.toolUseId === block.toolCallId);
    return {
      input: block.input,
      output: result?.isError ? undefined : (result?.output || block.output),
      error: result?.isError ? result?.output : undefined,
      status: result ? (result.isError ? 'error' : 'success') : (block.status || 'running'),
      toolCallId: block.toolCallId,
      batches,
    };
  }
  return {
    input: block.input,
    output: block.error ? undefined : block.output,
    error: block.error,
    status: block.status || 'running',
    toolCallId: block.toolCallId,
    batches,
  };
}

function chatEventNodeRenderBlock(block: any, blocks: any[], defaultOpen?: boolean, batches?: readonly FrontendSubagentBatch[]): string {
  if (block.type === 'thinking') return chatEventNodeRenderTraceItem({ type: 'thinking', status: block.status || 'streaming', text: block.text || '', id: chatEventNodeBlockId(block) }, defaultOpen);
  if (block.type === 'tool') {
    if (block.name === 'delegate_tasks') return chatEventNodeChatViews.renderSubagentDelegation(chatEventNodeSubagentData(block, blocks, batches));
    return chatEventNodeRenderTraceItem({ type: 'tool', status: block.status || 'running', name: block.name || 'tool', input: block.input, output: block.error ? undefined : block.output, error: block.error, metadata: block.metadata, id: chatEventNodeBlockId(block) });
  }
  if (block.type === 'tool_use') {
    const result = blocks.find(item => item.type === 'tool_result' && item.toolUseId && item.toolUseId === block.toolCallId);
    const status = result ? (result.isError ? 'error' : 'success') : (block.status || 'running');
    if (block.name === 'delegate_tasks') return chatEventNodeChatViews.renderSubagentDelegation(chatEventNodeSubagentData(block, blocks, batches));
    return chatEventNodeRenderTraceItem({ type: 'tool', status, name: block.name || 'tool', input: block.input, output: result?.isError ? undefined : (result?.output || block.output), error: result?.isError ? result?.output : undefined, metadata: result?.metadata || block.metadata, id: chatEventNodeBlockId(block) });
  }
  if (block.type === 'tool_result') {
    const toolUse = blocks.find(item => item.type === 'tool_use' && item.toolCallId && item.toolCallId === block.toolUseId);
    if (toolUse) return '';
    return chatEventNodeRenderTraceItem({ type: 'tool', status: block.isError ? 'error' : 'success', name: '结果', output: block.isError ? undefined : block.output, error: block.isError ? block.output : undefined, id: chatEventNodeBlockId(block) });
  }
  if (block.type === 'step') return chatEventNodeRenderTraceItem({ type: 'step', status: block.status || 'info', text: block.text || '', id: chatEventNodeBlockId(block) });
  if (block.type === 'user_note') return chatEventNodeRenderTraceItem({ type: 'user_note', text: block.text || '', status: block.status || 'queued', mode: block.mode || 'steer', id: chatEventNodeBlockId(block) });
  if (block.type === 'text') return chatEventNodeRenderTraceItem({ type: 'text', text: block.text || '', id: chatEventNodeBlockId(block) });
  return '';
}

function chatEventNodeRenderBlocks(blocks: any[], batches?: readonly FrontendSubagentBatch[]): string {
  const sorted = [...blocks].sort((a: any, b: any) => a.seq - b.seq);
  const parts: string[] = [];
  let eventBlocks: string[] = [];
  const flushEvents = () => {
    if (eventBlocks.length === 0) return;
    parts.push(`<div class="trace block-trace">${eventBlocks.join('')}</div>`);
    eventBlocks = [];
  };
  let firstThinking = true;
  for (const block of sorted) {
    const id = E(chatEventNodeBlockId(block));
    const defaultOpen = block.type === 'thinking' && firstThinking;
    if (block.type === 'thinking') firstThinking = false;
    const eventHtml = chatEventNodeRenderBlock(block, sorted, defaultOpen, batches);
    if (eventHtml) eventBlocks.push(`<div class="assistant-block block-event" data-block-id="${id}">${eventHtml}</div>`);
  }
  flushEvents();
  const editSummary = chatEventNodeRenderEditSummary(sorted);
  if (editSummary) {
    const trace = parts[parts.length - 1];
    parts[parts.length - 1] = trace.replace(/<\/div>$/, `${editSummary}</div>`);
  }
  return `<div class="assistant-blocks">${parts.join('')}</div>`;
}

function chatEventNodeRenderNode(block: any, blocks: any[]): HTMLElement | null {
  const html = chatEventNodeRenderBlock(block, blocks);
  if (!html) return null;
  const node = document.createElement('div');
  node.className = 'assistant-block block-event';
  node.dataset.blockId = chatEventNodeBlockId(block);
  node.innerHTML = html;
  return node;
}

function chatEventNodeReplaceContents(target: HTMLElement, html: string): void {
  const traceDetails = target.firstElementChild?.matches('details.trace-details') ? target.firstElementChild as HTMLDetailsElement : null;
  const traceWasOpen = traceDetails?.open === true;
  const openSubagentTasks = new Set(Array.from(target.querySelectorAll<HTMLDetailsElement>('.subagent-task[open]')).map(item => item.dataset.subagentTaskIndex).filter((value): value is string => value !== undefined));
  const rawWasOpen = target.querySelector<HTMLDetailsElement>('.subagent-raw')?.open === true;
  target.innerHTML = html;
  if (traceWasOpen && target.firstElementChild?.matches('details.trace-details')) target.firstElementChild.setAttribute('open', '');
  for (const taskIndex of openSubagentTasks) target.querySelector<HTMLDetailsElement>(`.subagent-task[data-subagent-task-index="${taskIndex}"]`)?.setAttribute('open', '');
  if (rawWasOpen) target.querySelector<HTMLDetailsElement>('.subagent-raw')?.setAttribute('open', '');
}

function chatEventNodeInsertNode(flow: HTMLElement, block: any, blocks: any[]): boolean {
  const node = chatEventNodeRenderNode(block, blocks);
  if (!node) return false;
  const seq = Number.isFinite(block.seq) ? block.seq : Number.MAX_SAFE_INTEGER;
  const before = Array.from(flow.querySelectorAll<HTMLElement>('[data-block-id]')).find(child => {
    const existing = blocks.find(item => chatEventNodeBlockId(item) === child.dataset.blockId);
    return existing && (Number.isFinite(existing.seq) ? existing.seq : Number.MAX_SAFE_INTEGER) > seq;
  });
  if (before) before.parentElement?.insertBefore(node, before);
  else {
    let trace = flow.querySelector<HTMLElement>('.trace.block-trace');
    if (!trace) {
      trace = document.createElement('div');
      trace.className = 'trace block-trace';
      flow.appendChild(trace);
    }
    trace.appendChild(node);
  }
  return true;
}

class ChatEventNodeView {
  static configure(dependencies: Partial<ChatEventNodeDependencies>): void { chatEventNodeConfigure(dependencies); }
  static renderEventBlock(block: any, blocks: any[], defaultOpen?: boolean, batches?: readonly FrontendSubagentBatch[]): string { return chatEventNodeRenderBlock(block, blocks, defaultOpen, batches); }
  static renderBlocks(blocks: any[], batches?: readonly FrontendSubagentBatch[]): string { return chatEventNodeRenderBlocks(blocks, batches); }
  static renderBlockNode(block: any, blocks: any[]): HTMLElement | null { return chatEventNodeRenderNode(block, blocks); }
  static replaceBlockContents(target: HTMLElement, html: string): void { chatEventNodeReplaceContents(target, html); }
  static insertBlockNode(flow: HTMLElement, block: any, blocks: any[]): boolean { return chatEventNodeInsertNode(flow, block, blocks); }
  static refreshEditSummary(flow: HTMLElement, blocks: any[]): void { chatEventNodeRefreshEditSummary(flow, blocks); }
  static subagentDelegationData(block: any, blocks: any[], batches?: readonly FrontendSubagentBatch[]): SubagentDelegationData { return chatEventNodeSubagentData(block, blocks, batches); }
  static blockId(block: any): string { return chatEventNodeBlockId(block); }
}

if (chatEventNodeApp) {
  chatEventNodeApp.ChatViews = {
    ...(chatEventNodeApp.ChatViews || {}),
    ChatEventNodeView,
  };
}

export {};
