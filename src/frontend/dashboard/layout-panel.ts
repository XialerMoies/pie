// 面板管理 — 切换/缩放/状态渲染
// 从 dashboard-layout.ts 拆出

interface LayoutPanelDependencies {
  state: AppStateFacade;
}

const layoutPanelApp = (window as any).App;
const layoutPanelDependencies: LayoutPanelDependencies = {
  state: layoutPanelApp.State,
};
const layoutPanelState = layoutPanelDependencies.state;
const OPTIONAL_PANE_NAMES = new Set(["search", "git", "mcp"]);
let _mountedPaneName: string | null = null;
let _mountedPaneCleanup: (() => void) | null = null;

function disposeMountedPane(): void {
  const cleanup = _mountedPaneCleanup;
  _mountedPaneCleanup = null;
  _mountedPaneName = null;
  cleanup?.();
}

function isContributionActive(id: string): boolean {
  const registry = layoutPanelApp.UIContributions;
  return !registry?.get?.(id) || registry.isActive?.(id) !== false;
}

function _panelWidth(): number {
  const width = layoutPanelState.getSnapshot().panel.width;
  return width > 50 ? width : 0;
}

function _syncPanelToStore(active = layoutPanelState.getSnapshot().panel.active || 'explorer'): void {
  const si = document.getElementById('si');
  const panel: Partial<WorkspaceUiSnapshot['panel']> = {
    active,
    closed: si?.classList.contains('closed') ?? false,
  };
  // 只在面板打开时保存宽度（关闭时不覆盖，保留上一次打开的值）
  if (si && !si.classList.contains('closed') && si.offsetWidth > 50) {
    panel.width = si.offsetWidth;
  }
  layoutPanelState.updatePanel(panel);
}

function togglePanel(name: string): void {
  const si = $('si'), pc = $('pc');
  if (!si || !pc) return;
  const activePanel = layoutPanelState.getSnapshot().panel.active || 'explorer';
  const highlightedButton = document.querySelector('.sbar .b[data-side].on') as HTMLElement | null;
  const visiblePanel = highlightedButton?.dataset.side || activePanel;
  if (visiblePanel === name && !si.classList.contains('closed')) {
    disposeMountedPane();
    si.classList.add('closed');
    si.style.width = '';
    document.querySelectorAll('.sbar .b[data-side]').forEach(b => (b as HTMLElement).classList.remove('on'));
    _syncPanelToStore(name);
    return;
  }
  si.classList.remove('closed');
  const savedWidth = _panelWidth();
  si.style.width = (savedWidth > 50 ? savedWidth : 260) + 'px';
  document.querySelectorAll('.sbar .b[data-side]').forEach(b => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.side === name));
  renderPanel(name, pc);
  _syncPanelToStore(name);
}

/** 启动时恢复左侧面板（由 restoreSessionTabs 调用） */
function restorePanel(name: string): void {
  const pc = $('pc');
  if (!pc) return;
  const si = $('si');
  if (!si) return;

  const restoredPanel = name === 'permissions' ? 'explorer' : name;

  const panel = layoutPanelState.getSnapshot().panel;
  const isClosed = panel.closed === true;
  const savedWidth = panel.width > 50 ? panel.width : _panelWidth();

  if (isClosed) {
    disposeMountedPane();
    si.classList.add('closed');
    si.style.width = '';
  } else {
    si.classList.remove('closed');
    si.style.width = savedWidth + 'px';
  }
  document.querySelectorAll('.sbar .b[data-side]').forEach(b => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.side === restoredPanel));
  if (!isClosed) renderPanel(restoredPanel, pc);
  _syncPanelToStore(restoredPanel);
}

function initResizeHandle(): void {
  const handle = $('si-handle'), si = $('si');
  if (!handle || !si) return;
  handle.addEventListener('mousedown', function (e: MouseEvent) {
    e.preventDefault();
    si!.classList.add('dragging');
    const startX = e.clientX, startW = si!.offsetWidth;
    const appRect = document.querySelector('.app')!.getBoundingClientRect();
    const maxW = appRect.width * 0.8 - 60;
    function onMove(ev: MouseEvent) {
      let newW = startW + (ev.clientX - startX);
      newW = Math.max(0, Math.min(newW, maxW));
      si!.style.width = newW + 'px';
      si!.classList.remove('closed');
    }
    function onUp() {
      si!.classList.remove('dragging');
      if (si!.offsetWidth < 20) { si!.classList.add('closed'); si!.style.width = ''; }
      _syncPanelToStore();
      document.removeEventListener('mousemove', onMove as any);
      document.removeEventListener('mouseup', onUp as any);
    }
    document.addEventListener('mousemove', onMove as any);
    document.addEventListener('mouseup', onUp as any);
  });
}

function renderPanel(name: string, pc?: HTMLElement | null): void {
  if (!pc) pc = $('pc');
  if (!pc) return;
  disposeMountedPane();
  if ((window as any).__emptyWorkspaceMode && name !== 'explorer') {
    const labels: Record<string, string> = {
      chat: '\u4f1a\u8bdd',
      search: '\u641c\u7d22',
      git: 'Git',
      mcp: 'MCP',
    };
    pc.innerHTML = `<div class="sg-t">${E(labels[name] || name)}</div>`
      + `<div data-empty-workspace-panel="${E(name)}" style="padding:12px;font-size:.72rem;color:var(--tm);text-align:center">`
      + '\u5c1a\u672a\u9009\u62e9\u5de5\u4f5c\u533a'
      + '</div>';
    return;
  }
  const contribution = layoutPanelApp.UIContributions?.get?.(`ui.pane.${name}`);
  if (contribution) {
    try {
      _mountedPaneCleanup = contribution.mount(pc);
      _mountedPaneName = name;
      return;
    } catch (error) {
      if (!isContributionActive(`ui.pane.${name}`)) {
        pc.innerHTML = `<div class="sg-item dim" data-inactive-contribution="${E(name)}">此能力组件已停用</div>`;
        return;
      }
      throw error;
    }
  }
  const paneFn = layoutPanelApp.UI?.getPane?.(name);
  if (paneFn) {
    const cleanup = paneFn(pc);
    _mountedPaneCleanup = typeof cleanup === 'function' ? cleanup : null;
    _mountedPaneName = name;
    return;
  }
  pc.innerHTML = `<div class="sg-item dim">面板 "${E(name)}" 未注册</div>`;
}

/** Reconcile existing DOM with the host's component catalog without reloading code. */
function reconcileContributions(): void {
  for (const name of OPTIONAL_PANE_NAMES) {
    const active = isContributionActive(`ui.pane.${name}`);
    const button = document.querySelector<HTMLElement>(`.sbar .b[data-side="${name}"]`);
    if (button) {
      button.hidden = !active;
      button.tabIndex = active ? 0 : -1;
      button.setAttribute('aria-hidden', String(!active));
    }
    if (name === 'mcp') {
      const indicator = document.getElementById('mcp-bar') as HTMLElement | null;
      if (indicator) indicator.hidden = !active;
    }
  }

  const problemsActive = isContributionActive('ui.problems');
  layoutPanelApp.UI?.setProblemsComponentActive?.(problemsActive);
  layoutPanelApp.UI?.reconcileTypeScriptContribution?.();

  const activePanel = layoutPanelState.getSnapshot().panel.active || 'explorer';
  if (OPTIONAL_PANE_NAMES.has(activePanel) && !isContributionActive(`ui.pane.${activePanel}`)) {
    layoutPanelState.updatePanel({ active: 'explorer' });
    const si = $('si');
    if (si?.classList.contains('closed')) disposeMountedPane();
    else renderPanel('explorer');
  }
}

// ─── App 绑定 ──────────────────────────────────────
{ const U = (window as any).App?.UI; if (U) {
  U.togglePanel = togglePanel;
  U.renderPanel = renderPanel;
  U.restorePanel = restorePanel;
  U.disposeMountedPane = disposeMountedPane;
  U.reconcileContributions = reconcileContributions;
} }
