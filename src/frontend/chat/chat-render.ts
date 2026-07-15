// ═══════════════════════════════════════════════════════════════════
//  消息渲染 & 流式追加
// ═══════════════════════════════════════════════════════════════════

/** 渲染 markdown 为 HTML（过滤可能影响布局的标签） */
function mdRender(text: string): string {
  const md = (window as any).marked as typeof import("marked") | undefined;
  if (!md || !text) return E(text || '');
  try {
    const html = md.parse(text, { breaks: true, gfm: true }) as string;
    return html.replace(/<link[^>]*>/gi, '');
  } catch {
    return E(text);
  }
}

function shortText(value: unknown, max = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n... truncated' : text;
}

function toolTitle(name: string): string {
  const lower = String(name || 'tool').toLowerCase().replace(/[-_]+/g, '-');
  if (lower === 'search') return '搜索代码';
  if (lower === 'file-read' || lower === 'fileread') return '读取文件';
  if (lower === 'file-write' || lower === 'filewrite' || lower === 'apply-patch' || lower === 'edit') return '修改文件';
  if (lower === 'explorer-list' || lower === 'explorerlist') return '浏览目录';
  if (lower === 'git-status') return '验证结果';
  if (lower === 'git-log') return '查看提交历史';
  return (name || '工具').replace(/[-_]+/g, ' ');
}

function readTracePath(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  if (typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  return String(obj.path || obj.filePath || obj.root || obj.cwd || obj.query || obj.dir || obj.directory || obj.name || '').trim();
}

function shouldCollapseTrace(t: any, output: string): boolean {
  if (t.type === 'thinking') return false;
  if (t.type === 'tool' && t.status === 'error') return false;
  return output.length > 260;
}

function traceSummaryText(t: any, input: string, output: string): string {
  if (t.type === 'thinking') return '';
  if (t.type === 'tool' && t.status === 'error') {
    return shortText(t.error || output || '工具失败', 220);
  }
  // stage 映射与 toolTitle 相同，但用于摘要文本
  const name = String(t.name || '').toLowerCase().replace(/[-_]+/g, '-');
  const path = readTracePath(t.input);
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
  if (name === 'git-log') {
    return '查看提交历史';
  }
  return shortText(output || input || '', 180);
}

function renderErrorCard(error: ChatErrorState): string {
  const nextSteps = Array.isArray(error.nextSteps) ? error.nextSteps.filter(Boolean) : [];
  const raw = error.raw ? `<details class="msg-error-raw"><summary>错误详情</summary><pre>${E(error.raw)}</pre></details>` : '';
  const reason = error.reason ? `<div class="msg-error-block"><div class="msg-error-label">可能原因</div><div class="msg-error-text">${E(error.reason)}</div></div>` : '';
  const steps = nextSteps.length > 0
    ? `<div class="msg-error-block"><div class="msg-error-label">下一步操作</div><ul class="msg-error-steps">${nextSteps.map(step => `<li>${E(step)}</li>`).join('')}</ul></div>`
    : '';
  return `<details class="msg-error"><summary><span class="msg-error-title">${E(error.title || '发生了错误')}</span><span class="msg-error-summary">${E(error.message || '点击查看详情')}</span></summary><div class="msg-error-body"><div class="msg-error-message">${E(error.message || '发生了错误')}</div>${reason}${steps}${raw}<div class="msg-error-actions"><button type="button" class="msg-error-btn" onclick="App.Chat.retryLastTurn()">重新发送</button><button type="button" class="msg-error-btn" onclick="App.Chat.copyLastError()">复制错误</button><button type="button" class="msg-error-btn" onclick="App.Chat.refreshWorkspaceState()">刷新工作区</button><button type="button" class="msg-error-btn" onclick="openSettingsModal()">打开设置</button></div></div></details>`;
}

function hasTraceValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function renderTraceItem(t: any): string {
  if (t.type === 'thinking') {
    const text = shortText(t.text || '思考中...', 1000);
    const status = t.status === 'done' ? 'done' : 'streaming';
    return `<div class="trace-node trace-thinking trace-${status}"><div class="trace-dot"></div><details class="trace-thought"${status === 'streaming' ? ' open' : ''}><summary>Thought${status === 'streaming' ? '...' : ''}</summary><div class="trace-thinking-text">${mdRender(text)}</div></details></div>`;
  }
  if (t.type === 'tool') {
    const status = t.status || 'running';
    const input = hasTraceValue(t.input) ? shortText(t.input, 900) : '';
    const result = t.error || t.output;
    const output = hasTraceValue(result) ? shortText(result, 1200) : '';
    const inputBlock = input ? `<div class="trace-card"><div class="trace-card-label">IN</div><pre>${E(input)}</pre></div>` : '';
    const outputLabel = t.status === 'error' ? 'ERROR' : 'OUT';
    const outputBlock = output ? `<div class="trace-card"><div class="trace-card-label${t.status === 'error' ? ' error' : ''}">${outputLabel}</div><pre>${E(output)}</pre></div>` : '';
    const collapsed = shouldCollapseTrace(t, output);
    const title = toolTitle(t.name);
    const rawSummary = traceSummaryText(t, input, output);
    const summary = rawSummary !== title && (!output || collapsed || !output.includes(rawSummary)) ? rawSummary : '';
    const summaryBlock = summary ? `<div class="trace-summary-text">${E(summary)}</div>` : '';
    const head = `<div class="trace-head"><div class="trace-title"><span class="trace-summary-title">${E(title)}</span></div>${summaryBlock}</div>`;
    if (!inputBlock && !outputBlock) {
      return `<div class="trace-node trace-tool trace-${status}"><div class="trace-dot"></div>${head}</div>`;
    }
    return `<details class="trace-node trace-tool trace-${status} trace-details"${collapsed ? '' : ' open'}><summary class="trace-summary"><div class="trace-dot"></div>${head}</summary><div class="trace-body">${inputBlock}${outputBlock}</div></details>`;
  }
  if (t.type === 'step') {
    return `<div class="trace-node trace-step trace-${t.status || 'info'}"><div class="trace-dot"></div><div class="trace-body"><div class="trace-title"><span class="trace-summary-title">${E(t.text || '')}</span></div></div></div>`;
  }
  return '';
}

function blockId(b: any): string {
  return String(b.blockId || `${b.type || 'block'}-${b.seq || 0}`);
}

function renderEventBlock(b: any, blocks: any[]): string {
  if (b.type === 'thinking') {
    return renderTraceItem({
      type: 'thinking',
      status: b.status || 'streaming',
      text: b.text || '',
      id: blockId(b),
    });
  }
  if (b.type === 'tool_use') {
    const result = blocks.find(item => item.type === 'tool_result' && item.toolUseId && item.toolUseId === b.toolCallId);
    const status = result ? (result.isError ? 'error' : 'success') : (b.status || 'running');
    return renderTraceItem({
      type: 'tool',
      status,
      name: b.name || 'tool',
      input: b.input,
      output: result?.isError ? undefined : result?.output,
      error: result?.isError ? result?.output : undefined,
      id: blockId(b),
    });
  }
  if (b.type === 'tool_result') {
    const toolUse = blocks.find(item => item.type === 'tool_use' && item.toolCallId && item.toolCallId === b.toolUseId);
    if (toolUse) return '';
    return renderTraceItem({
      type: 'tool',
      status: b.isError ? 'error' : 'success',
      name: '结果',
      output: b.isError ? undefined : b.output,
      error: b.isError ? b.output : undefined,
      id: blockId(b),
    });
  }
  if (b.type === 'step') {
    return renderTraceItem({
      type: 'step',
      status: b.status || 'info',
      text: b.text || '',
      id: blockId(b),
    });
  }
  return '';
}

function renderBlocks(blocks: any[]): string {
  const sorted = [...blocks].sort((a: any, b: any) => a.seq - b.seq);
  const parts: string[] = [];
  let eventBlocks: string[] = [];
  const flushEvents = () => {
    if (eventBlocks.length === 0) return;
    parts.push(`<div class="trace block-trace">${eventBlocks.join('')}</div>`);
    eventBlocks = [];
  };

  for (const block of sorted) {
    const id = E(blockId(block));
    if (block.type === 'text') {
      flushEvents();
      parts.push(`<div class="assistant-block block-text" data-block-id="${id}">${mdRender(block.text || '')}</div>`);
      continue;
    }
    const eventHtml = renderEventBlock(block, sorted);
    if (eventHtml) {
      eventBlocks.push(`<div class="assistant-block block-event" data-block-id="${id}">${eventHtml}</div>`);
    }
  }
  flushEvents();
  return `<div class="assistant-blocks">${parts.join('')}</div>`;
}

function renderMessage(m: any): string {
  const c = m.role + (m.streaming ? ' go' : ''), lb = m.role === 'user' ? '你' : 'Pi';
  const ty = m.streaming ? `<div class="ty"><span class="ty-d"></span><span class="ty-d"></span><span class="ty-d"></span></div>` : '';
  const error = m.error ? renderErrorCard(m.error) : '';

  if (m.blocks && m.blocks.length > 0) {
    return `<div class="m ${c}${m.error ? ' error' : ''}"><div class="ml">${lb}</div>${error}<div class="mt block-flow">${renderBlocks(m.blocks)}</div>${ty}</div>`;
  }

  const content = m.content ? mdRender(m.content) : '';
  const think = m.thinking ? `<details class="think"><summary>🤔 思考过程</summary>${mdRender(m.thinking)}</details>` : '';
  return `<div class="m ${c}${m.error ? ' error' : ''}"><div class="ml">${lb}</div>${error}${think}<div class="mt">${content}</div>${ty}</div>`;
}

function msgs(): string {
  const M = window.__state.M;
  if (M.length === 0) return '<div class="wl"><h2>Pi — 你的代码助手</h2><p>在下方输入，开始编码</p></div>';
  return M.map(renderMessage).join('\n');
}

function updateLastBlock(block: any): boolean {
  const messages = window.__state.M;
  const message = messages[messages.length - 1] as any;
  const messagesElement = $('ms');
  if (!message?.blocks?.length || !messagesElement) return false;
  const messageElements = messagesElement.querySelectorAll('.m');
  const lastMessageElement = messageElements[messageElements.length - 1] as HTMLElement | undefined;
  if (!lastMessageElement) return false;

  const flow = lastMessageElement.querySelector('.assistant-blocks') as HTMLElement | null;
  if (!flow) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = renderMessage(message);
    const replacement = wrapper.firstElementChild;
    if (!replacement) return false;
    lastMessageElement.replaceWith(replacement);
    return true;
  }

  const target = Array.from(flow.querySelectorAll<HTMLElement>('[data-block-id]'))
    .find(element => element.dataset.blockId === blockId(block));
  if (target && block.type === 'text') {
    target.innerHTML = mdRender(block.text || '');
    return true;
  }
  if (target && block.type === 'thinking') {
    const textElement = target.querySelector('.trace-thinking-text') as HTMLElement | null;
    if (textElement) {
      textElement.innerHTML = mdRender(block.text || '');
      return true;
    }
  }

  flow.outerHTML = renderBlocks(message.blocks);
  return true;
}

function appendDelta(text: string): void {
  const M = window.__state.M;
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
    updateLastBlock(textBlocks[textBlocks.length - 1] || last.blocks[last.blocks.length - 1]);
    return;
  }

  last.content += text;
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
  AppChat.appendDelta = appendDelta;
  AppChat.updateLastBlock = updateLastBlock;
} }
