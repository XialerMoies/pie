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

function shortText(value: unknown, max = 1200): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n... truncated' : text;
}

function diffForBlock(block: any, blocks: any[]): any | null {
  if (block.type === 'tool') return block.metadata?.diff || null;
  if (block.type === 'tool_use') {
    const result = blocks.find(item => item.type === 'tool_result' && item.toolUseId && item.toolUseId === block.toolCallId);
    return result?.metadata?.diff || block.metadata?.diff || null;
  }
  if (block.type === 'tool_result') {
    const toolUse = blocks.find(item => item.type === 'tool_use' && item.toolCallId && item.toolCallId === block.toolUseId);
    return toolUse ? null : block.metadata?.diff || null;
  }
  return null;
}

function collectEditedFiles(blocks: any[]): Array<{ filePath: string; linesAdded: number; linesRemoved: number }> {
  const files = new Map<string, { filePath: string; linesAdded: number; linesRemoved: number }>();
  for (const block of [...blocks].sort((a: any, b: any) => a.seq - b.seq)) {
    const diff = diffForBlock(block, blocks);
    if (!diff || typeof diff.filePath !== 'string' || !diff.filePath.trim()) continue;
    const filePath = diff.filePath.trim();
    const key = normalizeDiffPath(filePath);
    const added = Number.isFinite(Number(diff.linesAdded))
      ? Number(diff.linesAdded)
      : (diff.type === 'create' ? App.FileDiff.countContentLines(String(diff.content || '')) : 0);
    const removed = Number.isFinite(Number(diff.linesRemoved)) ? Number(diff.linesRemoved) : 0;
    const current = files.get(key);
    if (current) {
      current.linesAdded += added;
      current.linesRemoved += removed;
    } else {
      files.set(key, { filePath, linesAdded: added, linesRemoved: removed });
    }
  }
  return [...files.values()];
}

function renderEditSummary(blocks: any[], expanded = true): string {
  const files = collectEditedFiles(blocks);
  if (files.length === 0) return '';
  const added = files.reduce((total, file) => total + file.linesAdded, 0);
  const removed = files.reduce((total, file) => total + file.linesRemoved, 0);
  const rows = files.map(file => `<button type="button" class="trace-edit-file" data-diff-file-path="${E(file.filePath)}" title="打开文件"><span class="trace-edit-file-path">${E(file.filePath)}</span><span class="trace-edit-file-stat"><span class="add">+${file.linesAdded}</span> <span class="del">-${file.linesRemoved}</span></span></button>`).join('');
  const collapseIcon = typeof S === 'function' ? S(expanded ? 'ich-down' : 'ich-right', 16) : '';
  return `<section class="trace-edit-summary" data-edit-summary><div class="trace-edit-summary-head"><div class="trace-edit-summary-title"><span class="trace-edit-summary-icon">${typeof S === 'function' ? S('iedit', 22) : ''}</span><div><div class="trace-edit-summary-label">已编辑 ${files.length} 个文件</div><div class="trace-edit-summary-total"><span class="add">+${added}</span> <span class="del">-${removed}</span></div></div></div><button type="button" class="trace-edit-toggle" data-edit-summary-toggle aria-expanded="${expanded}" aria-label="${expanded ? '收起' : '展开'}已编辑文件" title="${expanded ? '收起' : '展开'}">${collapseIcon}</button></div><div class="trace-edit-files" data-edit-summary-files${expanded ? '' : ' hidden'}>${rows}</div></section>`;
}

function refreshEditSummary(flow: HTMLElement, blocks: any[]): void {
  const trace = flow.querySelector<HTMLElement>('.trace.block-trace');
  if (!trace) return;
  const current = trace.querySelector<HTMLElement>('[data-edit-summary]');
  const expanded = current?.querySelector<HTMLElement>('[data-edit-summary-toggle]')?.getAttribute('aria-expanded') !== 'false';
  const html = renderEditSummary(blocks, expanded);
  if (!html) { current?.remove(); return; }
  if (current) current.outerHTML = html;
  else trace.insertAdjacentHTML('beforeend', html);
}

function firstSummaryLine(value: string, max = 220): string {
  const line = value.split(/\r?\n/).find(item => item.trim())?.trim() || '';
  return line.length > max ? line.slice(0, max) + '...' : line;
}

function normalizeDiffPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/\.\//g, '/').replace(/\/$/, '').toLowerCase();
}

function diffRelativePath(workspace: string, filePath: string): string | null {
  const root = normalizeDiffPath(workspace);
  let target = filePath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!root || !target) return null;
  const normalizedTarget = normalizeDiffPath(target);
  const isAbsolute = /^[a-z]:\//i.test(target) || target.startsWith('/') || target.startsWith('//');
  if (isAbsolute) {
    if (normalizedTarget === root) return null;
    if (!normalizedTarget.startsWith(root + '/')) return null;
    target = target.slice(workspace.replaceAll('\\', '/').replace(/\/$/, '').length + 1);
  }
  target = target.replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!target || target === '.' || target.split('/').some(part => part === '..')) return null;
  return target;
}

async function openDiffFile(filePath: string): Promise<void> {
  const workspace = (globalThis as any).ExplorerService?.getWorkspacePath?.()
    || (globalThis as any).App?.State?.getWorkspacePath?.()
    || '';
  const relativePath = diffRelativePath(String(workspace), filePath);
  if (!relativePath) {
    (window as any).toast?.('文件不在当前工作区内', 'error');
    return;
  }
  const tabs = (window as any).App?.Tabs;
  const existing = tabs?.getTab?.(relativePath) || tabs?.getTab?.(filePath);
  if (existing) {
    tabs.activate?.(existing.id);
    return;
  }
  try {
    const response = await fetch(`/api/file/read?root=${encodeURIComponent(String(workspace))}&path=${encodeURIComponent(relativePath)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || '文件读取失败');
    const lang = relativePath.split('.').pop() || '';
    (window as any).openFileTab?.(relativePath, String(data?.content || ''), lang);
  } catch (error) {
    (window as any).toast?.(error instanceof Error ? error.message : '文件读取失败', 'error');
  }
}

let diffFileLinksBound = false;

function bindDiffFileLinks(): void {
  const guardedDocument = document as Document;
  if (diffFileLinksBound) return;
  diffFileLinksBound = true;
  document.addEventListener('click', (event: MouseEvent) => {
    const eventTarget = event.target as Element | null;
    const toggle = typeof eventTarget?.closest === 'function'
      ? eventTarget.closest<HTMLElement>('[data-edit-summary-toggle]')
      : null;
    if (toggle) {
      const summary = toggle.closest<HTMLElement>('[data-edit-summary]');
      const files = summary?.querySelector<HTMLElement>('[data-edit-summary-files]');
      if (!files) return;
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      const nextExpanded = !expanded;
      files.hidden = !nextExpanded;
      toggle.setAttribute('aria-expanded', String(nextExpanded));
      toggle.setAttribute('aria-label', nextExpanded ? '收起已编辑文件' : '展开已编辑文件');
      toggle.title = nextExpanded ? '收起' : '展开';
      toggle.innerHTML = typeof S === 'function' ? S(nextExpanded ? 'ich-down' : 'ich-right', 16) : '';
      return;
    }
    const target = typeof eventTarget?.closest === 'function'
      ? eventTarget.closest<HTMLElement>('[data-diff-file-path]')
      : null;
    if (!target) return;
    event.preventDefault();
    void openDiffFile(target.dataset.diffFilePath || '');
  });
}

bindDiffFileLinks();

function toolTitle(name: string): string {
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
  return `<details class="msg-error"><summary><span class="msg-error-title">${E(error.title || '发生了错误')}</span><span class="msg-error-summary">${E(error.message || '点击查看详情')}</span></summary><div class="msg-error-body"><div class="msg-error-message">${E(error.message || '发生了错误')}</div>${reason}${steps}${raw}<div class="msg-error-actions"><button type="button" class="msg-error-btn" data-chat-error-action="retry">重新发送</button><button type="button" class="msg-error-btn" data-chat-error-action="copy">复制错误</button><button type="button" class="msg-error-btn" data-chat-error-action="refresh">刷新工作区</button><button type="button" class="msg-error-btn" data-chat-error-action="settings">打开设置</button></div></div></details>`;
}

function bindChatErrorActions(): void {
  const guardedDocument = document as Document & { __chatErrorActionsBound?: boolean };
  if (guardedDocument.__chatErrorActionsBound) return;
  guardedDocument.__chatErrorActionsBound = true;
  document.addEventListener('click', (event: MouseEvent) => {
    const eventTarget = event.target as Element | null;
    const target = typeof eventTarget?.closest === 'function'
      ? eventTarget.closest<HTMLElement>('[data-chat-error-action]')
      : null;
    if (!target) return;
    const appNamespace = (window as any).App;
    switch (target.dataset.chatErrorAction) {
      case 'retry':
        appNamespace?.Chat?.retryLastTurn?.();
        break;
      case 'copy':
        void appNamespace?.Chat?.copyLastError?.();
        break;
      case 'refresh':
        appNamespace?.Chat?.refreshWorkspaceState?.();
        break;
      case 'settings':
        appNamespace?.Settings?.openSettingsModal?.();
        break;
    }
  });
}
bindChatErrorActions();

function hasTraceValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function renderTraceItem(t: any, defaultOpen?: boolean): string {
  if (t.type === 'thinking') {
    const text = shortText(t.text || '思考中...', 1000);
    const status = t.status === 'done' ? 'done' : 'streaming';
    const open = defaultOpen || status === 'streaming';
    return `<div class="trace-node trace-thinking trace-${status}"><div class="trace-dot"></div><details class="trace-thought"${open ? ' open' : ''}><summary>Thought${status === 'streaming' ? '...' : ''}</summary><div class="trace-thinking-text">${mdRender(text)}</div></details></div>`;
  }
  if (t.type === 'tool') {
    const status = t.status || 'running';
    const input = hasTraceValue(t.input) ? shortText(t.input, 900) : '';
    const result = t.error || t.output;
    const output = hasTraceValue(result) ? shortText(result, 1200) : '';
    const diffBlock = App.FileDiff?.render?.(t.metadata?.diff) || '';
    const inputSection = input ? `<div class="trace-card-section trace-card-in"><div class="trace-card-label">IN</div><pre>${E(input)}</pre></div>` : '';
    const outputLabel = t.status === 'error' ? 'ERROR' : 'OUT';
    const outputSection = output ? `<div class="trace-card-section trace-card-out"><div class="trace-card-label${t.status === 'error' ? ' error' : ''}">${outputLabel}</div><pre>${E(output)}</pre></div>` : '';
    const ioBlock = inputSection || outputSection ? `<div class="trace-card">${inputSection}${outputSection}</div>` : '';
    const diffSummaryText = diffBlock ? firstSummaryLine(output) : '';
    const diffSummary = diffSummaryText ? `<div class="trace-diff-summary">${E(diffSummaryText)}</div>` : '';
    const eventContent = diffBlock ? `<div class="trace-diff-event">${diffSummary}${diffBlock}</div>` : ioBlock;
    const collapsed = shouldCollapseTrace(t, output);
    const title = toolTitle(t.name);
    const rawSummary = traceSummaryText(t, input, output);
    const summary = rawSummary !== title && (!output || collapsed || !output.includes(rawSummary)) ? rawSummary : '';
    const summaryBlock = summary ? `<div class="trace-summary-text">${E(summary)}</div>` : '';
    const head = `<div class="trace-head"><div class="trace-title"><span class="trace-summary-title">${E(title)}</span></div>${summaryBlock}</div>`;
    if (!eventContent) {
      return `<div class="trace-node trace-tool trace-${status}"><div class="trace-dot"></div>${head}</div>`;
    }
    return `<details class="trace-node trace-tool trace-${status} trace-details"${collapsed ? '' : ' open'}><summary class="trace-summary"><div class="trace-dot"></div>${head}</summary><div class="trace-body">${eventContent}</div></details>`;
  }
  if (t.type === 'step') {
    return `<div class="trace-node trace-step trace-${t.status || 'info'}"><div class="trace-dot"></div><div class="trace-body"><div class="trace-title"><span class="trace-summary-title">${E(t.text || '')}</span></div></div></div>`;
  }
  if (t.type === 'user_note') {
    const status = t.status === 'failed' ? 'failed' : t.status === 'delivered' ? 'delivered' : 'queued';
    const statusText = status === 'failed' ? '发送失败' : status === 'delivered' ? '已送达' : '排队中';
    const modeText = t.mode === 'followUp' ? '做完再处理' : '当前步骤后';
    return `<div class="trace-node trace-user-note trace-${status}"><div class="trace-dot"></div><div class="trace-body"><div class="trace-title"><span class="trace-summary-title">你 · 补充</span><span class="trace-note-mode">${modeText}</span><span class="trace-note-status">${statusText}</span></div><div class="trace-note-text">${mdRender(t.text || '')}</div></div></div>`;
  }
  if (t.type === 'text') {
    return `<div class="trace-node trace-text"><div class="trace-dot"></div><div class="trace-body trace-text-body">${mdRender(t.text || '')}</div></div>`;
  }
  return '';
}

function blockId(b: any): string {
  return String(b.blockId || `${b.type || 'block'}-${b.seq || 0}`);
}

function subagentStatusText(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中', running: '运行中', completed: '已完成', partial: '部分完成',
    failed: '失败', aborted: '已中止', timed_out: '已超时', limit_reached: '达到限制', interrupted: '已中断',
  };
  return labels[status] || status;
}

interface DelegateTaskInput {
  profile?: string;
  prompt?: string;
}

function delegateTaskInput(input: unknown): { tasks: DelegateTaskInput[]; maxConcurrent: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { tasks: [], maxConcurrent: 2 };
  const value = input as Record<string, unknown>;
  const tasks = Array.isArray(value.tasks) ? value.tasks.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const task = item as Record<string, unknown>;
    return [{
      profile: typeof task.profile === 'string' ? task.profile : undefined,
      prompt: typeof task.prompt === 'string' ? task.prompt : undefined,
    }];
  }) : [];
  const requestedConcurrency = Number(value.maxConcurrent);
  const maxConcurrent = Number.isFinite(requestedConcurrency)
    ? Math.min(4, Math.max(1, Math.trunc(requestedConcurrency)))
    : 2;
  return { tasks, maxConcurrent };
}

function subagentProfileText(profile: string | undefined): string {
  const labels: Record<string, string> = {
    explorer: '探索', reviewer: '审查', planner: '规划', general: '通用',
  };
  return labels[profile || ''] || profile || '子 Agent';
}

function delegateStatus(status: string | undefined, batches: readonly FrontendSubagentBatch[]): string {
  if (batches.length > 0) return batches[batches.length - 1].status;
  if (status === 'success') return 'completed';
  if (status === 'error') return 'failed';
  return status === 'queued' ? 'queued' : 'running';
}

function delegateTraceStatus(status: string): 'running' | 'success' | 'error' {
  if (status === 'running' || status === 'queued') return 'running';
  if (status === 'completed' || status === 'partial') return 'success';
  return 'error';
}

function renderDelegateRawDetails(input: unknown, output: unknown, error: unknown): string {
  const inputText = hasTraceValue(input) ? shortText(input, 4000) : '';
  const result = error || output;
  const outputText = hasTraceValue(result) ? shortText(result, 4000) : '';
  if (!inputText && !outputText) return '';
  const sections = [
    inputText ? `<div class="subagent-raw-section"><div class="subagent-raw-label">输入</div><pre>${E(inputText)}</pre></div>` : '',
    outputText ? `<div class="subagent-raw-section"><div class="subagent-raw-label">${error ? '错误' : '结果'}</div><pre>${E(outputText)}</pre></div>` : '',
  ].join('');
  return `<details class="subagent-raw"><summary>原始详情</summary><div class="subagent-raw-body">${sections}</div></details>`;
}

function renderDelegateTasksBlock(options: {
  input: unknown;
  output?: unknown;
  error?: unknown;
  status?: string;
  toolCallId?: string;
  batches?: readonly FrontendSubagentBatch[];
}): string {
  const owned = selectSubagentBatchesForTool(options.batches, options.toolCallId);
  const latestBatch = owned[owned.length - 1];
  const input = delegateTaskInput(options.input);
  const eventTasks = latestBatch?.tasks ?? [];
  const taskCount = Math.max(input.tasks.length, eventTasks.length);
  const status = delegateStatus(options.status, owned);
  const raw = renderDelegateRawDetails(options.input, options.output, options.error);
  const errorText = String(options.error || options.output || '');
  const unconfirmed = options.status === 'error' && /not confirmed|requires explicit user confirmation|delegation_not_confirmed|用户拒绝|未确认/i.test(errorText);

  if (unconfirmed) {
    return `<section class="trace-node trace-tool trace-error subagent-delegation subagent-delegation-warning"><div class="trace-dot"></div><div class="subagent-delegation-panel"><div class="subagent-warning-row"><span class="subagent-warning-title">子任务未启动</span><span class="subagent-warning-reason">未确认</span></div>${raw}</div></section>`;
  }

  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const spec = input.tasks[index];
    const task = eventTasks[index];
    const taskStatus = task?.status
      || (status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'queued');
    const profile = task?.profile || spec?.profile;
    const title = task?.prompt || spec?.prompt || `${profile || 'agent'} ${index + 1}`;
    const findings = Array.isArray(task?.findings) ? task.findings : [];
    const evidence = Array.isArray(task?.evidence) ? task.evidence : [];
    const details = [
      task?.summary ? `<div class="subagent-task-summary">${mdRender(task.summary)}</div>` : '',
      findings.length ? `<ul class="subagent-task-list">${findings.map((item) => `<li>${E(item)}</li>`).join('')}</ul>` : '',
      evidence.length ? `<div class="subagent-evidence">${evidence.map((item) => `<div>${E(item)}</div>`).join('')}</div>` : '',
    ].join('');
    const row = `<span class="subagent-status-dot"></span><span class="subagent-task-profile" title="${E(profile || 'agent')}">${E(subagentProfileText(profile))}</span><span class="subagent-task-title">${E(title)}</span><span class="subagent-task-status">${E(subagentStatusText(taskStatus))}</span><span class="subagent-task-disclosure${details ? '' : ' subagent-task-disclosure-placeholder'}" aria-hidden="true"></span>`;
    return details
      ? `<details class="subagent-task subagent-${E(taskStatus)}" data-subagent-task-index="${index}"><summary>${row}</summary><div class="subagent-task-body">${details}</div></details>`
      : `<div class="subagent-task subagent-${E(taskStatus)}" data-subagent-task-index="${index}"><div class="subagent-task-row">${row}</div></div>`;
  }).join('');
  const summary = `${taskCount} 个子任务 · 并发 ${input.maxConcurrent} · ${subagentStatusText(status)}`;
  const batchId = latestBatch?.batchId;
  return `<section class="trace-node trace-tool trace-${delegateTraceStatus(status)} subagent-delegation subagent-${E(status)}"${batchId ? ` data-subagent-batch-id="${E(batchId)}"` : ''}><div class="trace-dot"></div><div class="subagent-delegation-panel"><div class="subagent-delegation-head"><span class="subagent-delegation-title">委派子任务</span><span class="subagent-delegation-summary">${E(summary)}</span></div><div class="subagent-tasks">${tasks}</div>${raw}</div></section>`;
}

function renderEventBlock(b: any, blocks: any[], defaultOpen?: boolean, subagentBatches?: readonly FrontendSubagentBatch[]): string {
  if (b.type === 'thinking') {
    return renderTraceItem({
      type: 'thinking',
      status: b.status || 'streaming',
      text: b.text || '',
      id: blockId(b),
    }, defaultOpen);
  }
  if (b.type === 'tool') {
    if (b.name === 'delegate_tasks') {
      return renderDelegateTasksBlock({
        input: b.input,
        output: b.error ? undefined : b.output,
        error: b.error,
        status: b.status || 'running',
        toolCallId: b.toolCallId,
        batches: subagentBatches,
      });
    }
    // B-5：tool 合并 block——直接渲染（含 input/output/error/status）
    return renderTraceItem({
      type: 'tool',
      status: b.status || 'running',
      name: b.name || 'tool',
      input: b.input,
      output: b.error ? undefined : b.output,
      error: b.error,
      metadata: b.metadata,
      id: blockId(b),
    });
  }
  if (b.type === 'tool_use') {
    const result = blocks.find(item => item.type === 'tool_result' && item.toolUseId && item.toolUseId === b.toolCallId);
    const status = result ? (result.isError ? 'error' : 'success') : (b.status || 'running');
    if (b.name === 'delegate_tasks') {
      return renderDelegateTasksBlock({
        input: b.input,
        output: result?.isError ? undefined : (result?.output || b.output),
        error: result?.isError ? result?.output : undefined,
        status,
        toolCallId: b.toolCallId,
        batches: subagentBatches,
      });
    }
    return renderTraceItem({
      type: 'tool',
      status,
      name: b.name || 'tool',
      input: b.input,
      output: result?.isError ? undefined : (result?.output || b.output),
      error: result?.isError ? result?.output : undefined,
      metadata: result?.metadata || b.metadata,
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
  if (b.type === 'user_note') {
    return renderTraceItem({
      type: 'user_note',
      text: b.text || '',
      status: b.status || 'queued',
      mode: b.mode || 'steer',
      id: blockId(b),
    });
  }
  if (b.type === 'text') {
    return renderTraceItem({
      type: 'text',
      text: b.text || '',
      id: blockId(b),
    });
  }
  return '';
}

function renderBlocks(blocks: any[], subagentBatches?: readonly FrontendSubagentBatch[]): string {
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
    const id = E(blockId(block));
    const defaultOpen = block.type === 'thinking' && firstThinking;
    if (block.type === 'thinking') firstThinking = false;
    const eventHtml = renderEventBlock(block, sorted, defaultOpen, subagentBatches);
    if (eventHtml) {
      eventBlocks.push(`<div class="assistant-block block-event" data-block-id="${id}">${eventHtml}</div>`);
    }
  }
  flushEvents();
  const editSummary = renderEditSummary(sorted);
  if (editSummary) {
    const trace = parts[parts.length - 1];
    parts[parts.length - 1] = trace.replace(/<\/div>$/, `${editSummary}</div>`);
  }
  return `<div class="assistant-blocks">${parts.join('')}</div>`;
}

function renderBlockNode(block: any, blocks: any[]): HTMLElement | null {
  const html = renderEventBlock(block, blocks);
  if (!html) return null;
  const node = document.createElement('div');
  node.className = 'assistant-block block-event';
  node.dataset.blockId = blockId(block);
  node.innerHTML = html;
  return node;
}

function replaceBlockContents(target: HTMLElement, html: string): void {
  const traceDetails = target.firstElementChild?.matches('details.trace-details')
    ? target.firstElementChild as HTMLDetailsElement
    : null;
  const traceWasOpen = traceDetails?.open === true;
  const openSubagentTasks = new Set(Array.from(target.querySelectorAll<HTMLDetailsElement>('.subagent-task[open]'))
    .map((item) => item.dataset.subagentTaskIndex)
    .filter((value): value is string => value !== undefined));
  const rawWasOpen = target.querySelector<HTMLDetailsElement>('.subagent-raw')?.open === true;
  target.innerHTML = html;
  if (traceWasOpen && target.firstElementChild?.matches('details.trace-details')) {
    target.firstElementChild.setAttribute('open', '');
  }
  for (const taskIndex of openSubagentTasks) {
    target.querySelector<HTMLDetailsElement>(`.subagent-task[data-subagent-task-index="${taskIndex}"]`)?.setAttribute('open', '');
  }
  if (rawWasOpen) target.querySelector<HTMLDetailsElement>('.subagent-raw')?.setAttribute('open', '');
}

function insertBlockNode(flow: HTMLElement, block: any, blocks: any[]): boolean {
  const node = renderBlockNode(block, blocks);
  if (!node) return false;
  const seq = Number.isFinite(block.seq) ? block.seq : Number.MAX_SAFE_INTEGER;
  // block 节点在 .trace 容器内层（assistant-blocks > trace > block-event[data-block-id]），
  // 用 querySelectorAll 而非 children 才能在正确位置插入（seq 乱序时新 block 插到更大的 block 之前）。
  const before = Array.from(flow.querySelectorAll<HTMLElement>('[data-block-id]'))
    .find((child) => {
      const id = child.dataset.blockId;
      const existing = blocks.find((item) => blockId(item) === id);
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
        replaceBlockContents(target, renderEventBlock(block, message.blocks, undefined, message.subagentBatches));
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
  return block && messageIndex === messages.length - 1 ? updateLastBlock(block) : false;
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
