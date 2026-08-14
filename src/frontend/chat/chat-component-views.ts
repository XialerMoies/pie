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


const chatViewDependencies: ChatViewDependencies = {
  renderMarkdown: (text) => E(text || ''),
};

function chatViewConfigure(dependencies: Partial<ChatViewDependencies>): void {
  if (dependencies.renderMarkdown) chatViewDependencies.renderMarkdown = dependencies.renderMarkdown;
  (window as any).App?.ChatViews?.configureSubagent?.(dependencies);
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
    ChatErrorView,
    renderEditSummary: EditSummaryView.render,
    refreshEditSummary: chatViewRefreshEditSummary,
    renderErrorCard: ChatErrorView.render,
  };
}
chatViewBindDelegatedActions();

export {};
