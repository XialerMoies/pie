/// <reference path="../dashboard.d.ts" />

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

interface ChatSubagentDependencies {
  renderMarkdown: (text: string) => string;
}

const chatSubagentDependencies: ChatSubagentDependencies = {
  renderMarkdown: (text) => E(text || ''),
};

function chatSubagentConfigure(dependencies: Partial<ChatSubagentDependencies>): void {
  if (dependencies.renderMarkdown) chatSubagentDependencies.renderMarkdown = dependencies.renderMarkdown;
}

function chatSubagentReplaceRoot(root: HTMLElement, next: HTMLElement): void {
  root.className = next.className;
  for (const attribute of Array.from(root.attributes)) {
    if (!next.hasAttribute(attribute.name)) root.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(next.attributes)) root.setAttribute(attribute.name, attribute.value);
  root.replaceChildren(...Array.from(next.childNodes));
}

function chatSubagentElementFromHtml(html: string, componentName: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const root = template.content.firstElementChild as HTMLElement | null;
  if (!root) throw new Error(`${componentName} did not render a root element`);
  return root;
}

function chatSubagentStatusText(status: string): string {
  const labels: Record<string, string> = {
    queued: '排队中', running: '运行中', completed: '已完成', partial: '部分完成',
    failed: '失败', aborted: '已中止', timed_out: '已超时', limit_reached: '达到限制', interrupted: '已中断',
  };
  return labels[status] || status;
}

function chatSubagentProfileText(profile: string | undefined): string {
  const labels: Record<string, string> = {
    explorer: '探索', reviewer: '审查', planner: '规划', general: '通用',
  };
  return labels[profile || ''] || profile || '子 Agent';
}

function chatSubagentShortText(value: unknown, max = 4000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '\n... truncated' : text;
}

function chatSubagentHasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function chatSubagentDelegateInput(input: unknown): { tasks: DelegateTaskInput[]; maxConcurrent: number } {
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

function chatSubagentRawDetails(input: unknown, output: unknown, error: unknown): string {
  const inputText = chatSubagentHasValue(input) ? chatSubagentShortText(input) : '';
  const result = error || output;
  const outputText = chatSubagentHasValue(result) ? chatSubagentShortText(result) : '';
  if (!inputText && !outputText) return '';
  const sections = [
    inputText ? `<div class="subagent-raw-section"><div class="subagent-raw-label">输入</div><pre>${E(inputText)}</pre></div>` : '',
    outputText ? `<div class="subagent-raw-section"><div class="subagent-raw-label">${error ? '错误' : '结果'}</div><pre>${E(outputText)}</pre></div>` : '',
  ].join('');
  return `<details class="subagent-raw"><summary>原始详情</summary><div class="subagent-raw-body">${sections}</div></details>`;
}

function chatSubagentNormalizeDelegation(data: SubagentDelegationData): NormalizedSubagentDelegation {
  const owned = selectSubagentBatchesForTool(data.batches, data.toolCallId);
  const latestBatch = owned[owned.length - 1];
  const input = chatSubagentDelegateInput(data.input);
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
    raw: chatSubagentRawDetails(data.input, data.output, data.error),
    unconfirmed: data.status === 'error'
      && /not confirmed|requires explicit user confirmation|delegation_not_confirmed|用户拒绝|未确认/i.test(errorText),
  };
}

function chatSubagentDelegationData(value: FrontendSubagentBatch | SubagentDelegationData): SubagentDelegationData {
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
    const profile = agentLabel || chatSubagentProfileText(task.profile);
    const details = [
      task.summary ? `<div class="subagent-task-summary">${chatSubagentDependencies.renderMarkdown(task.summary)}</div>` : '',
      task.findings?.length ? `<ul class="subagent-task-list">${task.findings.map(item => `<li>${E(item)}</li>`).join('')}</ul>` : '',
      task.evidence?.length ? `<div class="subagent-evidence">${task.evidence.map(item => `<div>${E(item)}</div>`).join('')}</div>` : '',
    ].join('');
    const row = `<span class="subagent-status-dot"></span><span class="subagent-task-profile" title="${E(agentLabel || task.profile || 'agent')}">${E(profile)}</span><span class="subagent-task-title">${E(title)}</span><span class="subagent-task-status">${E(chatSubagentStatusText(task.status))}</span><span class="subagent-task-disclosure${details ? '' : ' subagent-task-disclosure-placeholder'}" aria-hidden="true"></span>`;
    return `<details class="subagent-task subagent-${E(task.status)}" data-subagent-task-id="${E(task.taskId)}" data-subagent-task-index="${index}"${open && details ? ' open' : ''}><summary>${row}</summary>${details ? `<div class="subagent-task-body">${details}</div>` : ''}</details>`;
  }

  mount(container: HTMLElement): HTMLDetailsElement {
    if (this.root) return this.root;
    this.root = chatSubagentElementFromHtml(SubagentTaskView.render(this.task, this.index), 'SubagentTaskView') as HTMLDetailsElement;
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
    const next = chatSubagentElementFromHtml(SubagentTaskView.render(task, index, open), 'SubagentTaskView') as HTMLDetailsElement;
    chatSubagentReplaceRoot(this.root, next);
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
    this.data = chatSubagentDelegationData(value);
  }

  static render(value: FrontendSubagentBatch | SubagentDelegationData): string {
    const data = chatSubagentDelegationData(value);
    const model = chatSubagentNormalizeDelegation(data);
    if (model.unconfirmed) {
      return `<section class="trace-node trace-tool trace-error subagent-delegation subagent-delegation-warning"><div class="trace-dot"></div><div class="subagent-delegation-panel"><div class="subagent-warning-row"><span class="subagent-warning-title">子任务未启动</span><span class="subagent-warning-reason">未确认</span></div>${model.raw}</div></section>`;
    }
    const tasks = model.tasks.map((task, index) => SubagentTaskView.render(task, index)).join('');
    const traceStatus = model.status === 'running' || model.status === 'queued'
      ? 'running'
      : model.status === 'completed' || model.status === 'partial' ? 'success' : 'error';
    const summary = `${model.tasks.length} 个子任务 · 并发 ${model.maxConcurrent} · ${chatSubagentStatusText(model.status)}`;
    const batchId = model.batchId ? ` data-subagent-batch-id="${E(model.batchId)}"` : '';
    return `<section class="trace-node trace-tool trace-${traceStatus} subagent-delegation subagent-${E(model.status)}"${batchId}><div class="trace-dot"></div><div class="subagent-delegation-panel"><div class="subagent-delegation-head"><span class="subagent-delegation-title">委派子任务</span><span class="subagent-delegation-summary">${E(summary)}</span></div><div class="subagent-tasks">${tasks}</div>${model.raw}</div></section>`;
  }

  mount(container: HTMLElement): HTMLElement {
    if (this.root) return this.root;
    this.root = chatSubagentElementFromHtml(SubagentBatchView.render(this.data), 'SubagentBatchView');
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
    this.data = chatSubagentDelegationData(value);
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
    const model = chatSubagentNormalizeDelegation(this.data);
    const next = chatSubagentElementFromHtml(SubagentBatchView.render(this.data), 'SubagentBatchView');
    if (model.unconfirmed) {
      chatSubagentReplaceRoot(this.root, next);
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
    if (head) chatSubagentReplaceRoot(head, nextHead); else panel.prepend(nextHead);
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
    const model = chatSubagentNormalizeDelegation(this.data);
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

function chatSubagentRenderBatches(
  batches: readonly FrontendSubagentBatch[] | undefined,
  toolCallId?: string,
): string {
  return selectSubagentBatchesForTool(batches, toolCallId).map(batch => SubagentBatchView.render(batch)).join('');
}

function chatSubagentRenderDelegation(data: SubagentDelegationData): string {
  return SubagentBatchView.render(data);
}

function chatSubagentRefreshBatches(
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

function chatSubagentRefreshDelegation(toolRoot: HTMLElement, data: SubagentDelegationData): boolean {
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

const chatSubagentViewsApp = (window as any).App;
if (chatSubagentViewsApp) {
  chatSubagentViewsApp.ChatViews = {
    ...(chatSubagentViewsApp.ChatViews || {}),
    configureSubagent: chatSubagentConfigure,
    SubagentTaskView,
    SubagentBatchView,
    renderSubagentBatches: chatSubagentRenderBatches,
    refreshSubagentBatches: chatSubagentRefreshBatches,
    renderSubagentDelegation: chatSubagentRenderDelegation,
    refreshSubagentDelegation: chatSubagentRefreshDelegation,
  };
}

export {};
