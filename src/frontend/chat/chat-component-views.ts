/// <reference path="../dashboard.d.ts" />

interface ChatViewDependencies {
  renderMarkdown: (text: string) => string;
}

interface ChatErrorActions {
  retry?: () => void;
  copy?: () => void | Promise<void>;
  refresh?: () => void;
  settings?: () => void;
}

interface EditedFileSummary {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
}

interface DelegateTaskInput {
  profile?: string;
  agentId?: string;
  prompt?: string;
}

interface SubagentDelegationData {
  input: unknown;
  output?: unknown;
  error?: unknown;
  status?: string;
  toolCallId?: string;
  batches?: readonly FrontendSubagentBatch[];
}

interface NormalizedSubagentDelegation {
  batchId?: string;
  status: FrontendSubagentStatus;
  maxConcurrent: number;
  tasks: FrontendSubagentTask[];
  raw: string;
  unconfirmed: boolean;
}

const chatViewDependencies: ChatViewDependencies = {
  renderMarkdown: (text) => E(text || ''),
};

function chatViewConfigure(dependencies: Partial<ChatViewDependencies>): void {
  if (dependencies.renderMarkdown) chatViewDependencies.renderMarkdown = dependencies.renderMarkdown;
}

function chatViewReplaceRoot(root: HTMLElement, next: HTMLElement): void {
  root.className = next.className;
  for (const attribute of Array.from(root.attributes)) {
    if (!next.hasAttribute(attribute.name)) root.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(next.attributes)) root.setAttribute(attribute.name, attribute.value);
  root.replaceChildren(...Array.from(next.childNodes));
}

function chatViewElementFromHtml(html: string, componentName: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const root = template.content.firstElementChild as HTMLElement | null;
  if (!root) throw new Error(`${componentName} did not render a root element`);
  return root;
}

function chatViewNormalizeDiffPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/\.\//g, '/').replace(/\/$/, '').toLowerCase();
}

function chatViewDiffRelativePath(workspace: string, filePath: string): string | null {
  const root = chatViewNormalizeDiffPath(workspace);
  let target = filePath.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!root || !target) return null;
  const normalizedTarget = chatViewNormalizeDiffPath(target);
  const isAbsolute = /^[a-z]:\//i.test(target) || target.startsWith('/') || target.startsWith('//');
  if (isAbsolute) {
    if (normalizedTarget === root || !normalizedTarget.startsWith(root + '/')) return null;
    target = target.slice(workspace.replaceAll('\\', '/').replace(/\/$/, '').length + 1);
  }
  target = target.replace(/^\/+/, '').replace(/\/+/g, '/');
  if (!target || target === '.' || target.split('/').some(part => part === '..')) return null;
  return target;
}

async function chatViewOpenDiffFile(filePath: string): Promise<void> {
  const workspace = (globalThis as any).ExplorerService?.getWorkspacePath?.()
    || (globalThis as any).App?.State?.getWorkspacePath?.()
    || '';
  const relativePath = chatViewDiffRelativePath(String(workspace), filePath);
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

function chatViewDiffForBlock(block: any, blocks: any[]): any | null {
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

function chatViewCollectEditedFiles(blocks: any[]): EditedFileSummary[] {
  const files = new Map<string, EditedFileSummary>();
  for (const block of [...blocks].sort((a: any, b: any) => a.seq - b.seq)) {
    const diff = chatViewDiffForBlock(block, blocks);
    if (!diff || typeof diff.filePath !== 'string' || !diff.filePath.trim()) continue;
    const filePath = diff.filePath.trim();
    const key = chatViewNormalizeDiffPath(filePath);
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

class EditedFileRowView {
  private root: HTMLElement | null = null;
  private file: EditedFileSummary;
  private readonly onClick = (event: Event) => {
    event.stopPropagation();
    void chatViewOpenDiffFile(this.file.filePath);
  };

  constructor(file: EditedFileSummary) {
    this.file = file;
  }

  static render(file: EditedFileSummary): string {
    return `<button type="button" class="trace-edit-file" data-diff-file-path="${E(file.filePath)}" title="打开文件"><span class="trace-edit-file-path">${E(file.filePath)}</span><span class="trace-edit-file-stat"><span class="add">+${file.linesAdded}</span> <span class="del">-${file.linesRemoved}</span></span></button>`;
  }

  mount(container: HTMLElement): HTMLElement {
    if (this.root) return this.root;
    this.root = chatViewElementFromHtml(EditedFileRowView.render(this.file), 'EditedFileRowView');
    this.root.addEventListener('click', this.onClick);
    container.appendChild(this.root);
    return this.root;
  }

  adopt(root: HTMLElement): HTMLElement {
    if (this.root) return this.root;
    this.root = root;
    this.root.addEventListener('click', this.onClick);
    return this.root;
  }

  update(file: EditedFileSummary): void {
    this.file = file;
    if (this.root) chatViewReplaceRoot(this.root, chatViewElementFromHtml(EditedFileRowView.render(file), 'EditedFileRowView'));
  }

  dispose(): void {
    this.root?.removeEventListener('click', this.onClick);
    this.root?.remove();
    this.root = null;
  }
}

class EditSummaryView {
  private root: HTMLElement | null = null;
  private blocks: any[];
  private expanded: boolean;
  private readonly rows = new Map<string, EditedFileRowView>();
  private readonly onClick = (event: Event) => {
    const target = event.target as Element | null;
    const toggle = target?.closest<HTMLElement>('[data-edit-summary-toggle]');
    if (!toggle || !this.root?.contains(toggle)) return;
    event.stopPropagation();
    this.expanded = !this.expanded;
    this.syncDisclosure();
  };

  constructor(blocks: any[], expanded = true) {
    this.blocks = blocks;
    this.expanded = expanded;
  }

  static render(blocks: any[], expanded = true): string {
    const files = chatViewCollectEditedFiles(blocks);
    if (files.length === 0) return '';
    const added = files.reduce((total, file) => total + file.linesAdded, 0);
    const removed = files.reduce((total, file) => total + file.linesRemoved, 0);
    const rows = files.map(file => EditedFileRowView.render(file)).join('');
    const collapseIcon = typeof S === 'function' ? S(expanded ? 'ich-down' : 'ich-right', 16) : '';
    return `<section class="trace-edit-summary" data-edit-summary><div class="trace-edit-summary-head"><div class="trace-edit-summary-title"><span class="trace-edit-summary-icon">${typeof S === 'function' ? S('iedit', 22) : ''}</span><div><div class="trace-edit-summary-label">已编辑 ${files.length} 个文件</div><div class="trace-edit-summary-total"><span class="add">+${added}</span> <span class="del">-${removed}</span></div></div></div><button type="button" class="trace-edit-toggle" data-edit-summary-toggle aria-expanded="${expanded}" aria-label="${expanded ? '收起' : '展开'}已编辑文件" title="${expanded ? '收起' : '展开'}">${collapseIcon}</button></div><div class="trace-edit-files" data-edit-summary-files${expanded ? '' : ' hidden'}>${rows}</div></section>`;
  }

  mount(container: HTMLElement): HTMLElement {
    if (this.root) return this.root;
    this.root = chatViewElementFromHtml(EditSummaryView.render(this.blocks, this.expanded), 'EditSummaryView');
    this.root.addEventListener('click', this.onClick);
    container.appendChild(this.root);
    this.adoptRows();
    return this.root;
  }

  adopt(root: HTMLElement): HTMLElement {
    if (this.root) return this.root;
    this.root = root;
    this.expanded = root.querySelector<HTMLElement>('[data-edit-summary-toggle]')?.getAttribute('aria-expanded') !== 'false';
    this.root.addEventListener('click', this.onClick);
    this.adoptRows();
    return this.root;
  }

  update(blocks: any[]): void {
    this.blocks = blocks;
    if (!this.root) return;
    const files = chatViewCollectEditedFiles(blocks);
    const added = files.reduce((total, file) => total + file.linesAdded, 0);
    const removed = files.reduce((total, file) => total + file.linesRemoved, 0);
    const label = this.root.querySelector<HTMLElement>('.trace-edit-summary-label');
    const total = this.root.querySelector<HTMLElement>('.trace-edit-summary-total');
    const host = this.root.querySelector<HTMLElement>('[data-edit-summary-files]');
    if (label) label.textContent = `已编辑 ${files.length} 个文件`;
    if (total) total.innerHTML = `<span class="add">+${added}</span> <span class="del">-${removed}</span>`;
    if (host) {
      const active = new Set<string>();
      for (const file of files) {
        const key = chatViewNormalizeDiffPath(file.filePath);
        active.add(key);
        let row = this.rows.get(key);
        if (!row) {
          row = new EditedFileRowView(file);
          this.rows.set(key, row);
          row.mount(host);
        } else {
          row.update(file);
        }
        const rowRoot = Array.from(host.querySelectorAll<HTMLElement>('[data-diff-file-path]'))
          .find(candidate => chatViewNormalizeDiffPath(candidate.dataset.diffFilePath || '') === key);
        if (rowRoot) host.appendChild(rowRoot);
      }
      for (const [key, row] of this.rows) {
        if (active.has(key)) continue;
        row.dispose();
        this.rows.delete(key);
      }
    }
    this.syncDisclosure();
  }

  dispose(): void {
    this.root?.removeEventListener('click', this.onClick);
    for (const row of this.rows.values()) row.dispose();
    this.rows.clear();
    this.root?.remove();
    this.root = null;
  }

  private syncDisclosure(): void {
    if (!this.root) return;
    const toggle = this.root.querySelector<HTMLElement>('[data-edit-summary-toggle]');
    const files = this.root.querySelector<HTMLElement>('[data-edit-summary-files]');
    if (!toggle || !files) return;
    files.hidden = !this.expanded;
    toggle.setAttribute('aria-expanded', String(this.expanded));
    toggle.setAttribute('aria-label', this.expanded ? '收起已编辑文件' : '展开已编辑文件');
    toggle.title = this.expanded ? '收起' : '展开';
    toggle.innerHTML = typeof S === 'function' ? S(this.expanded ? 'ich-down' : 'ich-right', 16) : '';
  }

  private adoptRows(): void {
    if (!this.root) return;
    const files = chatViewCollectEditedFiles(this.blocks);
    const elements = Array.from(this.root.querySelectorAll<HTMLElement>('[data-edit-summary-files] > [data-diff-file-path]'));
    for (const file of files) {
      const key = chatViewNormalizeDiffPath(file.filePath);
      const element = elements.find(candidate => chatViewNormalizeDiffPath(candidate.dataset.diffFilePath || '') === key);
      if (!element) continue;
      const row = new EditedFileRowView(file);
      row.adopt(element);
      this.rows.set(key, row);
    }
  }
}

function chatViewSubagentStatusText(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中', running: '运行中', completed: '已完成', partial: '部分完成',
    failed: '失败', aborted: '已中止', timed_out: '已超时', limit_reached: '达到限制', interrupted: '已中断',
  };
  return labels[status] || status;
}

function chatViewSubagentProfileText(profile: string | undefined): string {
  const labels: Record<string, string> = {
    explorer: '探索', reviewer: '审查', planner: '规划', general: '通用',
  };
  return labels[profile || ''] || profile || '子 Agent';
}

function chatViewShortText(value: unknown, max = 4000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n... truncated' : text;
}

function chatViewHasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function chatViewDelegateInput(input: unknown): { tasks: DelegateTaskInput[]; maxConcurrent: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { tasks: [], maxConcurrent: 2 };
  const value = input as Record<string, unknown>;
  const tasks = Array.isArray(value.tasks) ? value.tasks.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const task = item as Record<string, unknown>;
    return [{
      profile: typeof task.profile === 'string' ? task.profile : undefined,
      agentId: typeof task.agentId === 'string' ? task.agentId : undefined,
      prompt: typeof task.prompt === 'string' ? task.prompt : undefined,
    }];
  }) : [];
  const requestedConcurrency = Number(value.maxConcurrent);
  return {
    tasks,
    maxConcurrent: Number.isFinite(requestedConcurrency)
      ? Math.min(30, Math.max(1, Math.trunc(requestedConcurrency)))
      : 2,
  };
}

function chatViewRawDetails(input: unknown, output: unknown, error: unknown): string {
  const inputText = chatViewHasValue(input) ? chatViewShortText(input) : '';
  const result = error || output;
  const outputText = chatViewHasValue(result) ? chatViewShortText(result) : '';
  if (!inputText && !outputText) return '';
  const sections = [
    inputText ? `<div class="subagent-raw-section"><div class="subagent-raw-label">输入</div><pre>${E(inputText)}</pre></div>` : '',
    outputText ? `<div class="subagent-raw-section"><div class="subagent-raw-label">${error ? '错误' : '结果'}</div><pre>${E(outputText)}</pre></div>` : '',
  ].join('');
  return `<details class="subagent-raw"><summary>原始详情</summary><div class="subagent-raw-body">${sections}</div></details>`;
}

function chatViewNormalizeDelegation(data: SubagentDelegationData): NormalizedSubagentDelegation {
  const owned = selectSubagentBatchesForTool(data.batches, data.toolCallId);
  const latestBatch = owned[owned.length - 1];
  const input = chatViewDelegateInput(data.input);
  const status = (latestBatch?.status
    || (data.status === 'success' ? 'completed' : data.status === 'error' ? 'failed' : data.status === 'queued' ? 'queued' : 'running')) as FrontendSubagentStatus;
  const tasks = latestBatch?.tasks?.length
    ? latestBatch.tasks
    : input.tasks.map((task, index): FrontendSubagentTask => ({
      taskId: `input-${index}`,
      status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'queued',
      ...task,
      findings: [],
      evidence: [],
      events: [],
    }));
  const errorText = String(data.error || data.output || '');
  return {
    batchId: latestBatch?.batchId,
    status,
    maxConcurrent: latestBatch?.maxConcurrent ?? input.maxConcurrent,
    tasks,
    raw: chatViewRawDetails(data.input, data.output, data.error),
    unconfirmed: data.status === 'error'
      && /not confirmed|requires explicit user confirmation|delegation_not_confirmed|用户拒绝|未确认/i.test(errorText),
  };
}

function chatViewDelegationData(value: FrontendSubagentBatch | SubagentDelegationData): SubagentDelegationData {
  if ('batchId' in value) {
    return { input: undefined, toolCallId: value.parentToolCallId, batches: [value], status: value.status };
  }
  return value;
}

class SubagentTaskView {
  private root: HTMLDetailsElement | null = null;
  private task: FrontendSubagentTask;
  private index: number;

  constructor(task: FrontendSubagentTask, index = 0) {
    this.task = task;
    this.index = index;
  }

  static render(task: FrontendSubagentTask, index = 0, open = task.status === 'running'): string {
    const title = task.prompt || `${task.profile || 'agent'} ${index + 1}`;
    const agentLabel = task.agentName || task.agentId;
    const profile = agentLabel || chatViewSubagentProfileText(task.profile);
    const details = [
      task.summary ? `<div class="subagent-task-summary">${chatViewDependencies.renderMarkdown(task.summary)}</div>` : '',
      task.findings?.length ? `<ul class="subagent-task-list">${task.findings.map(item => `<li>${E(item)}</li>`).join('')}</ul>` : '',
      task.evidence?.length ? `<div class="subagent-evidence">${task.evidence.map(item => `<div>${E(item)}</div>`).join('')}</div>` : '',
    ].join('');
    const row = `<span class="subagent-status-dot"></span><span class="subagent-task-profile" title="${E(agentLabel || task.profile || 'agent')}">${E(profile)}</span><span class="subagent-task-title">${E(title)}</span><span class="subagent-task-status">${E(chatViewSubagentStatusText(task.status))}</span><span class="subagent-task-disclosure${details ? '' : ' subagent-task-disclosure-placeholder'}" aria-hidden="true"></span>`;
    return `<details class="subagent-task subagent-${E(task.status)}" data-subagent-task-id="${E(task.taskId)}" data-subagent-task-index="${index}"${open && details ? ' open' : ''}><summary>${row}</summary>${details ? `<div class="subagent-task-body">${details}</div>` : ''}</details>`;
  }

  mount(container: HTMLElement): HTMLDetailsElement {
    if (this.root) return this.root;
    this.root = chatViewElementFromHtml(SubagentTaskView.render(this.task, this.index), 'SubagentTaskView') as HTMLDetailsElement;
    container.appendChild(this.root);
    return this.root;
  }

  adopt(root: HTMLDetailsElement): HTMLDetailsElement {
    if (this.root) return this.root;
    this.root = root;
    return this.root;
  }

  update(task: FrontendSubagentTask, index = this.index): void {
    const open = this.root?.open ?? task.status === 'running';
    this.task = task;
    this.index = index;
    if (!this.root) return;
    const next = chatViewElementFromHtml(SubagentTaskView.render(task, index, open), 'SubagentTaskView') as HTMLDetailsElement;
    chatViewReplaceRoot(this.root, next);
    this.root.open = open;
  }

  dispose(): void {
    this.root?.remove();
    this.root = null;
  }
}

class SubagentBatchView {
  private root: HTMLElement | null = null;
  private data: SubagentDelegationData;
  private readonly tasks = new Map<string, SubagentTaskView>();

  constructor(value: FrontendSubagentBatch | SubagentDelegationData) {
    this.data = chatViewDelegationData(value);
  }

  static render(value: FrontendSubagentBatch | SubagentDelegationData): string {
    const data = chatViewDelegationData(value);
    const model = chatViewNormalizeDelegation(data);
    if (model.unconfirmed) {
      return `<section class="trace-node trace-tool trace-error subagent-delegation subagent-delegation-warning"><div class="trace-dot"></div><div class="subagent-delegation-panel"><div class="subagent-warning-row"><span class="subagent-warning-title">子任务未启动</span><span class="subagent-warning-reason">未确认</span></div>${model.raw}</div></section>`;
    }
    const tasks = model.tasks.map((task, index) => SubagentTaskView.render(task, index)).join('');
    const traceStatus = model.status === 'running' || model.status === 'queued'
      ? 'running'
      : model.status === 'completed' || model.status === 'partial' ? 'success' : 'error';
    const summary = `${model.tasks.length} 个子任务 · 并发 ${model.maxConcurrent} · ${chatViewSubagentStatusText(model.status)}`;
    const batchId = model.batchId ? ` data-subagent-batch-id="${E(model.batchId)}"` : '';
    return `<section class="trace-node trace-tool trace-${traceStatus} subagent-delegation subagent-${E(model.status)}"${batchId}><div class="trace-dot"></div><div class="subagent-delegation-panel"><div class="subagent-delegation-head"><span class="subagent-delegation-title">委派子任务</span><span class="subagent-delegation-summary">${E(summary)}</span></div><div class="subagent-tasks">${tasks}</div>${model.raw}</div></section>`;
  }

  mount(container: HTMLElement): HTMLElement {
    if (this.root) return this.root;
    this.root = chatViewElementFromHtml(SubagentBatchView.render(this.data), 'SubagentBatchView');
    container.appendChild(this.root);
    this.adoptTasks();
    return this.root;
  }

  adopt(root: HTMLElement): HTMLElement {
    if (this.root) return this.root;
    this.root = root;
    this.adoptTasks();
    return this.root;
  }

  update(value: FrontendSubagentBatch | SubagentDelegationData): void {
    this.data = chatViewDelegationData(value);
    if (this.root) this.reconcile();
  }

  dispose(): void {
    for (const task of this.tasks.values()) task.dispose();
    this.tasks.clear();
    this.root?.remove();
    this.root = null;
  }

  private reconcile(): void {
    if (!this.root) return;
    const model = chatViewNormalizeDelegation(this.data);
    const next = chatViewElementFromHtml(SubagentBatchView.render(this.data), 'SubagentBatchView');
    if (model.unconfirmed) {
      chatViewReplaceRoot(this.root, next);
      for (const task of this.tasks.values()) task.dispose();
      this.tasks.clear();
      return;
    }
    const rawOpen = this.root.querySelector<HTMLDetailsElement>('.subagent-raw')?.open === true;
    this.root.className = next.className;
    for (const attribute of Array.from(this.root.attributes)) {
      if (!next.hasAttribute(attribute.name)) this.root.removeAttribute(attribute.name);
    }
    for (const attribute of Array.from(next.attributes)) this.root.setAttribute(attribute.name, attribute.value);
    const nextPanel = next.querySelector<HTMLElement>('.subagent-delegation-panel');
    const panel = this.root.querySelector<HTMLElement>('.subagent-delegation-panel');
    const nextHead = nextPanel?.querySelector<HTMLElement>('.subagent-delegation-head');
    const head = panel?.querySelector<HTMLElement>('.subagent-delegation-head');
    const host = panel?.querySelector<HTMLElement>('.subagent-tasks');
    if (!panel || !host || !nextHead) return;
    if (head) chatViewReplaceRoot(head, nextHead); else panel.prepend(nextHead);
    const active = new Set<string>();
    model.tasks.forEach((task, index) => {
      active.add(task.taskId);
      let view = this.tasks.get(task.taskId);
      if (!view) {
        view = new SubagentTaskView(task, index);
        this.tasks.set(task.taskId, view);
        view.mount(host);
      } else {
        view.update(task, index);
      }
      const taskRoot = Array.from(host.querySelectorAll<HTMLElement>('[data-subagent-task-id]'))
        .find(candidate => candidate.dataset.subagentTaskId === task.taskId);
      if (taskRoot) host.appendChild(taskRoot);
    });
    for (const [taskId, view] of this.tasks) {
      if (active.has(taskId)) continue;
      view.dispose();
      this.tasks.delete(taskId);
    }
    panel.querySelector('.subagent-raw')?.remove();
    const nextRaw = nextPanel?.querySelector<HTMLElement>('.subagent-raw');
    if (nextRaw) {
      panel.appendChild(nextRaw);
      if (rawOpen) (nextRaw as HTMLDetailsElement).open = true;
    }
  }

  private adoptTasks(): void {
    if (!this.root) return;
    const model = chatViewNormalizeDelegation(this.data);
    const host = this.root.querySelector<HTMLElement>('.subagent-tasks');
    if (!host) return;
    model.tasks.forEach((task, index) => {
      const taskRoot = Array.from(host.querySelectorAll<HTMLDetailsElement>('[data-subagent-task-id]'))
        .find(candidate => candidate.dataset.subagentTaskId === task.taskId);
      if (!taskRoot) return;
      const view = new SubagentTaskView(task, index);
      view.adopt(taskRoot);
      this.tasks.set(task.taskId, view);
    });
  }
}

class ChatErrorView {
  private root: HTMLElement | null = null;
  private error: ChatErrorState;
  private readonly actions: ChatErrorActions;
  private readonly onClick = (event: Event) => {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-chat-error-action]');
    if (!target || !this.root?.contains(target)) return;
    event.stopPropagation();
    const action = target.dataset.chatErrorAction as keyof ChatErrorActions;
    void this.actions[action]?.();
  };

  constructor(error: ChatErrorState, actions: ChatErrorActions = {}) {
    this.error = error;
    this.actions = actions;
  }

  static render(error: ChatErrorState): string {
    const nextSteps = Array.isArray(error.nextSteps) ? error.nextSteps.filter(Boolean) : [];
    const raw = error.raw ? `<details class="msg-error-raw"><summary>错误详情</summary><pre>${E(error.raw)}</pre></details>` : '';
    const reason = error.reason ? `<div class="msg-error-block"><div class="msg-error-label">可能原因</div><div class="msg-error-text">${E(error.reason)}</div></div>` : '';
    const steps = nextSteps.length > 0
      ? `<div class="msg-error-block"><div class="msg-error-label">下一步操作</div><ul class="msg-error-steps">${nextSteps.map(step => `<li>${E(step)}</li>`).join('')}</ul></div>`
      : '';
    return `<details class="msg-error"><summary><span class="msg-error-title">${E(error.title || '发生了错误')}</span><span class="msg-error-summary">${E(error.message || '点击查看详情')}</span></summary><div class="msg-error-body"><div class="msg-error-message">${E(error.message || '发生了错误')}</div>${reason}${steps}${raw}<div class="msg-error-actions"><button type="button" class="msg-error-btn" data-chat-error-action="retry">重新发送</button><button type="button" class="msg-error-btn" data-chat-error-action="copy">复制错误</button><button type="button" class="msg-error-btn" data-chat-error-action="refresh">刷新工作区</button><button type="button" class="msg-error-btn" data-chat-error-action="settings">打开设置</button></div></div></details>`;
  }

  mount(container: HTMLElement): HTMLElement {
    if (this.root) return this.root;
    this.root = chatViewElementFromHtml(ChatErrorView.render(this.error), 'ChatErrorView');
    this.root.addEventListener('click', this.onClick);
    container.appendChild(this.root);
    return this.root;
  }

  update(error: ChatErrorState): void {
    const open = (this.root as HTMLDetailsElement | null)?.open ?? false;
    this.error = error;
    if (!this.root) return;
    chatViewReplaceRoot(this.root, chatViewElementFromHtml(ChatErrorView.render(error), 'ChatErrorView'));
    (this.root as HTMLDetailsElement).open = open;
  }

  dispose(): void {
    this.root?.removeEventListener('click', this.onClick);
    this.root?.remove();
    this.root = null;
  }
}

function chatViewRenderSubagentBatches(
  batches: readonly FrontendSubagentBatch[] | undefined,
  toolCallId?: string,
): string {
  return selectSubagentBatchesForTool(batches, toolCallId).map(batch => SubagentBatchView.render(batch)).join('');
}

function chatViewRenderSubagentDelegation(data: SubagentDelegationData): string {
  return SubagentBatchView.render(data);
}

function chatViewRefreshSubagentBatches(
  toolRoot: HTMLElement,
  batches: readonly FrontendSubagentBatch[] | undefined,
  toolCallId?: string,
): boolean {
  const owned = selectSubagentBatchesForTool(batches, toolCallId);
  const existingRoots = Array.from(toolRoot.querySelectorAll<HTMLElement>('[data-subagent-batch-id]'));
  const active = new Set<string>();
  const host = toolRoot.querySelector<HTMLElement>('details.trace-details')
    || toolRoot.querySelector<HTMLElement>('.trace-node')
    || toolRoot;
  for (const batch of owned) {
    active.add(batch.batchId);
    let root = existingRoots.find(candidate => candidate.dataset.subagentBatchId === batch.batchId);
    let view = (root as any)?.__subagentBatchView as SubagentBatchView | undefined;
    if (!view) {
      view = new SubagentBatchView(batch);
      root = root ? view.adopt(root) : view.mount(host);
      (root as any).__subagentBatchView = view;
    }
    view.update(batch);
    host.appendChild(root!);
  }
  for (const root of existingRoots) {
    const batchId = root.dataset.subagentBatchId || '';
    if (active.has(batchId)) continue;
    ((root as any).__subagentBatchView as SubagentBatchView | undefined)?.dispose();
    root.remove();
  }
  return owned.length > 0;
}

function chatViewRefreshSubagentDelegation(toolRoot: HTMLElement, data: SubagentDelegationData): boolean {
  let root = toolRoot.querySelector<HTMLElement>('.subagent-delegation');
  let view = (root as any)?.__subagentBatchView as SubagentBatchView | undefined;
  if (!view) {
    view = new SubagentBatchView(data);
    if (root) view.adopt(root);
    else root = view.mount(toolRoot);
    (root as any).__subagentBatchView = view;
  }
  view.update(data);
  return true;
}

function chatViewRefreshEditSummary(flow: HTMLElement, blocks: any[]): void {
  const trace = flow.querySelector<HTMLElement>('.trace.block-trace');
  if (!trace) return;
  const current = trace.querySelector<HTMLElement>('[data-edit-summary]');
  const existing = (current as any)?.__editSummaryView as EditSummaryView | undefined;
  if (chatViewCollectEditedFiles(blocks).length === 0) {
    existing?.dispose();
    current?.remove();
    return;
  }
  if (existing) {
    existing.update(blocks);
    return;
  }
  const expanded = current?.querySelector<HTMLElement>('[data-edit-summary-toggle]')?.getAttribute('aria-expanded') !== 'false';
  const view = new EditSummaryView(blocks, expanded);
  const root = current ? view.adopt(current) : view.mount(trace);
  (root as any).__editSummaryView = view;
  view.update(blocks);
}

function chatViewBindDelegatedActions(): void {
  const guardedDocument = document as Document & { __chatComponentActionsBound?: boolean };
  if (guardedDocument.__chatComponentActionsBound) return;
  guardedDocument.__chatComponentActionsBound = true;
  document.addEventListener('click', (event: MouseEvent) => {
    const target = event.target as Element | null;
    const toggle = target?.closest<HTMLElement>('[data-edit-summary-toggle]');
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
    const diffPath = target?.closest<HTMLElement>('[data-diff-file-path]');
    if (diffPath && !diffPath.dataset.gitAction) {
      event.preventDefault();
      void chatViewOpenDiffFile(diffPath.dataset.diffFilePath || '');
      return;
    }
    const errorAction = target?.closest<HTMLElement>('[data-chat-error-action]');
    if (!errorAction) return;
    const app = (window as any).App;
    switch (errorAction.dataset.chatErrorAction) {
      case 'retry': app?.Chat?.retryLastTurn?.(); break;
      case 'copy': void app?.Chat?.copyLastError?.(); break;
      case 'refresh': app?.Chat?.refreshWorkspaceState?.(); break;
      case 'settings': app?.Settings?.openSettingsModal?.(); break;
    }
  });
}

const chatViewsApp = (window as any).App;
if (chatViewsApp) {
  chatViewsApp.ChatViews = {
    ...(chatViewsApp.ChatViews || {}),
    configure: chatViewConfigure,
    EditedFileRowView,
    EditSummaryView,
    SubagentTaskView,
    SubagentBatchView,
    ChatErrorView,
    renderEditSummary: EditSummaryView.render,
    refreshEditSummary: chatViewRefreshEditSummary,
    renderSubagentBatches: chatViewRenderSubagentBatches,
    refreshSubagentBatches: chatViewRefreshSubagentBatches,
    renderSubagentDelegation: chatViewRenderSubagentDelegation,
    refreshSubagentDelegation: chatViewRefreshSubagentDelegation,
    renderErrorCard: ChatErrorView.render,
  };
}
chatViewBindDelegatedActions();

export {};
