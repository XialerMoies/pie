// Layout core — 组件组装器 + HTML 构建 + 标签渲染 + 会话恢复
// Tab/事件/快捷键/面板已拆至 layout-tabs / layout-panel / layout-shortcuts

function isChatTabOpen(): boolean {
  return App.State.getSnapshot().tabs.chatOpen !== false;
}

function closeChatTab(): void {
  // 关闭当前 chat tab（只关激活的那个，不多关草稿）
  const active = App.Tabs.getActiveTab?.();
  if (active?.kind === 'chat') App.Tabs.close(active.id);
  App.State.setChatOpen(false);
  const fileTabIds = App.Tabs.getFileTabIds?.() || [];
  if (App.Tabs.getActiveFileTabId?.() === null && fileTabIds.length > 0) {
    App.Tabs.activate(fileTabIds[0]);
    return;
  }
  renderTabs();
}

/** 输入玻璃面板高度变化时同步消息区底部内边距与淡出位置，保证最后一条消息可滚到面板上方 */
function syncMsgScrollPadding(): void {
  const fi = $('fi');
  const ms = $('ms');
  if (!fi || !ms) return;
  const panelHeight = fi.offsetHeight;
  if (panelHeight > 0) {
    ms.style.paddingBottom = `${panelHeight + 24}px`;
    ms.style.setProperty('--fade-bottom', `${panelHeight}px`);
  }
}

function layout(): void {
  const app = $('app')!;
  const lightweightDashboard = (window as any).__emptyWorkspaceMode || (window as any).__workspaceStatusMode;
  app.innerHTML = buildTopBar() + buildSideBar() + buildSidePanel() + buildMainArea() + buildStatusBar();
  renderStatusNotice();
  bindLayoutActions(app);
  initResizeHandle();
  renderTabs();
  const activePanel = App.State.getSnapshot().panel.active || 'explorer';
  document.querySelectorAll('.sbar .b[data-side]').forEach(b =>
    (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.side === activePanel));
  const pc = $('pc');
  if (pc) {
    if ((window as any).__workspaceStatusMode) pc.innerHTML = '';
    else renderPanel(activePanel, pc);
  }
  if (!lightweightDashboard) bind();
  syncMsgScrollPadding();
  const fi = $('fi');
  if (fi && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => syncMsgScrollPadding());
    ro.observe(fi);
  }
  // 从 UiStateStore 快照恢复会话和文件标签页。
  if (!lightweightDashboard) {
    (window as any).App?.Session?.restoreSessionTabs?.();
  }
  // Problems 底部栏初始化（DOM 已就绪）
  _initProblemsBar();
  if (!lightweightDashboard) void refreshPermissionModeBadge();
  // 空闲预加载 Monaco，让首次文件打开不卡（首屏稳定后 1s）
  setTimeout(() => {
    if (typeof loadMonaco === 'function' && !(window as any).__monaco && !lightweightDashboard) {
      loadMonaco().catch(() => {});
    }
  }, 1000);
}

// ─── Top Bar ──────────────────────────────────────────────────
function buildTopBar(): string {
  return `<div class="topbar">
    <div class="nm"><span>PI</span></div>
    <div class="top-tabs">
      <button class="top-tab" data-layout-action="file-menu">文件</button>
    </div>
    <div class="win-controls">
      <button class="win-btn" data-layout-action="window" data-window-action="minimize">─</button>
      <button class="win-btn" data-layout-action="window" data-window-action="maximize">□</button>
      <button class="win-btn close" data-layout-action="window" data-window-action="close">✕</button>
    </div>
  </div>`;
}

function buildSideBar(): string {
  return `<div class="sbar">
    <button class="b" data-side="explorer" data-layout-action="panel" title="资源管理器">${S('ifolder',20)}</button>
    <button class="b" data-side="chat" data-layout-action="panel" title="会话资源管理器">${S('imsg',20)}</button>
    <button class="b" data-side="search" data-layout-action="panel" title="搜索">${S('isearch',20)}</button>
    <button class="b" data-side="git" data-layout-action="panel" title="Git">${S('igit',20)}</button>
    <button class="b" data-side="mcp" data-layout-action="panel" title="MCP">${S('iatom',20)}</button>
    <div class="mcp-bar" id="mcp-bar" title="MCP 服务器">MCP <span id="mcp-bar-count">0</span></div>
    <div class="spcr"></div>
    <div class="bb">
      <button class="b" title="CLI" data-layout-action="launch-cli">${S('iterm',20)}</button>
      <button class="b" title="设置" data-layout-action="settings">${S('is',20)}</button>
    </div>
  </div>`;
}

function buildSidePanel(): string {
  return `<div class="sinfo" id="si"><div class="panel-content" id="pc"></div><div class="sinfo-handle" id="si-handle"></div></div>`;
}

function buildMainArea(): string {
  const chatBusy = App.Chat?.isBusy?.() === true;
  return `<div class="main">
    <div class="main-tabs" id="main-tabs"></div>
    <div class="mc">
      <div class="tr-rail" id="tr-rail" title="点击查看用量详情">
        <span class="tr-pct" id="tr-pct" title="上下文占用">--%</span>
        <span class="tr-source" id="tr-source" aria-live="polite"></span>
        <span class="tr-cr" id="tr-cr" title="缓存命中率">--%</span>
        <button class="tr-btn" id="tr-btn" title="压缩上下文">压缩</button>
      </div>
      <div class="msgs" id="ms">${window.msgs ? window.msgs() : ''}</div>
      <nav class="chat-timeline" id="chat-timeline" aria-label="会话时间线" aria-hidden="true"></nav>
      <div class="file-content" id="file-content" style="display:none">
        <div class="fc-toolbar"><span class="fc-status" id="fc-status"></span></div>
        <div class="fc-editor" id="fc-editor"></div>
      </div>
      <div class="fi-area" id="fi">
        <button class="chat-jump-latest" id="chat-jump-latest" type="button" title="回到最新消息" aria-label="回到最新消息" aria-hidden="true" tabindex="-1">${window.S('idown', 16)}</button>
        <div class="command-confirm-slot" id="command-confirm-slot" aria-live="polite"></div>
        <div class="fi-box" id="fi-box">
          <div class="fi-drop-zone" id="fi-drop-zone">松开添加文件引用</div>
          <div class="fi-slash" id="fi-slash" style="display:none">
            <div class="fi-slash-item" data-cmd="/explain"><span class="cmd">/explain</span> <span class="desc">解释代码</span></div>
            <div class="fi-slash-item" data-cmd="/refactor"><span class="cmd">/refactor</span> <span class="desc">重构建议</span></div>
            <div class="fi-slash-item" data-cmd="/test"><span class="cmd">/test</span> <span class="desc">生成测试</span></div>
            <div class="fi-slash-item" data-cmd="/optimize"><span class="cmd">/optimize</span> <span class="desc">优化性能</span></div>
            <div class="fi-slash-item" data-cmd="/audit"><span class="cmd">/audit</span> <span class="desc">安全审计</span></div>
            <div class="fi-slash-item" data-cmd="/fix"><span class="cmd">/fix</span> <span class="desc">修复问题</span></div>
            <div class="fi-slash-divider"></div>
            <div class="fi-slash-item" data-cmd="/clear"><span class="cmd">/clear</span> <span class="desc">清除缓存</span></div>
          </div>
          <div class="fi-attach-bar" id="fi-attach-bar" style="display:none"></div>
          <textarea id="ci" rows="1" placeholder="输入消息...（输入 / 使用快捷命令）"></textarea>
          <div class="fi-divider"></div>
          <div class="fi-actions-bar">
            <button class="fi-abtn fi-model" id="fi-model-btn" title="切换模型"><span id="fi-model-name">claude-sonnet</span> <span class="fi-arrow">▾</span></button>
            <button class="fi-abtn fi-mode" id="fi-mode-btn" title="切换策略"><span id="fi-mode-name">自动</span><span id="fi-evidence-state" class="fi-evidence-state" hidden aria-hidden="true"></span> <span class="fi-arrow">▾</span></button>
            <button class="fi-abtn fi-file" id="fi-file-btn" title="添加本机文件">${window.S('iplus', 14)}</button>
            <span class="fi-spacer"></span>
            <button id="chat-note-mode" class="fi-abtn fi-note-mode" title="补充处理时机" style="${chatBusy ? '' : 'display:none'}">当前步骤后</button>
            <button id="chat-stop" class="fi-stop-btn" title="中止当前任务" aria-label="中止当前任务" style="${chatBusy ? '' : 'display:none'}">${window.S('ipause', 16)}</button>
            <button id="cs" class="fi-send-btn" title="发送消息">${window.S('iup', 16)}</button>
          </div>
        </div>
      </div>
    </div>
    ${buildProblemsPanel()}
  </div>`;
}

function buildProblemsPanel(): string {
  return `<section class="pb-panel" id="pb-panel" aria-label="问题" style="display:none">
    <div class="pb-resize-handle" id="pb-resize-handle" role="separator" aria-orientation="horizontal" aria-valuemin="48" aria-valuemax="600" aria-valuenow="0" tabindex="0" title="调整问题栏高度"></div>
    <div class="pb-panel-head"><span>问题</span></div>
    <div class="pb-body" id="pb-body"></div>
  </section>`;
}

type StatusNoticeKind = 'info' | 'success' | 'error';

let _statusNoticeMessage = '';
let _statusNoticeKind: StatusNoticeKind = 'info';
let _statusNoticeTimer: ReturnType<typeof setTimeout> | null = null;
let _statusNoticeGeneration = 0;

function renderStatusNotice(): void {
  const notice = $('status-notice');
  if (!notice) return;
  notice.textContent = _statusNoticeMessage;
  notice.dataset.kind = _statusNoticeKind;
  notice.dataset.active = String(Boolean(_statusNoticeMessage));
}

function setStatusNotice(message: string, kind: StatusNoticeKind = 'info', durationMs = 3200): void {
  _statusNoticeMessage = message.trim();
  _statusNoticeKind = kind;
  const generation = ++_statusNoticeGeneration;
  if (_statusNoticeTimer) {
    clearTimeout(_statusNoticeTimer);
    _statusNoticeTimer = null;
  }
  renderStatusNotice();
  if (_statusNoticeMessage && durationMs > 0) {
    _statusNoticeTimer = setTimeout(() => {
      if (generation !== _statusNoticeGeneration) return;
      _statusNoticeMessage = '';
      _statusNoticeTimer = null;
      renderStatusNotice();
    }, durationMs);
  }
}

function clearStatusNotice(): void {
  setStatusNotice('', 'info', 0);
}

function buildStatusBar(): string {
  return `<footer class="statusbar" aria-label="状态栏">
    <button class="status-problems" id="pb-status-trigger" type="button" aria-controls="pb-panel" aria-expanded="false" title="显示问题">
      ${S('iissue', 14)}
      <span class="status-problems-label">问题</span>
      <span class="status-problems-counts" id="pb-status-counts"></span>
    </button>
    <span class="status-notice" id="status-notice" role="status" aria-live="polite" aria-atomic="true" data-active="false"></span>
    <span class="permission-mode-badge" id="permission-mode-badge" aria-label="权限模式"></span>
  </footer>`;
}

async function refreshPermissionModeBadge(): Promise<void> {
  try {
    const response = await fetch('/api/permissions/mode');
    if (!response.ok) return;
    const body = await response.json();
    const badge = document.getElementById('permission-mode-badge');
    if (!badge) return;
    const yes = body.mode === 'yes';
    badge.textContent = yes ? 'YES' : '';
    badge.classList.toggle('on', yes);
  } catch {
    // The badge is informational; a server restart should not affect layout.
  }
}

function bindLayoutActions(container: HTMLElement): void {
  if (container.dataset.layoutActions === '1') return;
  container.dataset.layoutActions = '1';
  container.addEventListener('click', (event: MouseEvent) => {
    const eventTarget = event.target as Element | null;
    const target = typeof eventTarget?.closest === 'function'
      ? eventTarget.closest<HTMLElement>('[data-layout-action]')
      : null;
    if (!target || !container.contains(target)) return;

    const appNamespace = (window as any).App;
    switch (target.dataset.layoutAction) {
      case 'file-menu': {
        const handler = appNamespace?.File?.toggleFileMenu || (window as any).toggleFileMenu;
        if (typeof handler === 'function') handler(event, target);
        break;
      }
      case 'window':
        if (target.dataset.windowAction) winCtrl(target.dataset.windowAction);
        break;
      case 'panel':
        if (target.dataset.side) togglePanel(target.dataset.side);
        break;
      case 'launch-cli': {
        const handler = appNamespace?.File?.launchCli || (window as any).launchCli;
        if (typeof handler === 'function') handler();
        break;
      }
      case 'settings': {
        const handler = appNamespace?.Settings?.openSettingsModal || (window as any).openSettingsModal;
        if (typeof handler === 'function') handler();
        break;
      }
    }
  });
}

// ─── 标签渲染（统一容器）───────────────────────────────────
function renderTabs(): void {
  const el = $('main-tabs');
  if (!el) return;
  const state = App.Tabs.getState();

  // App.Tabs facade owns the TabStore/legacy compatibility decision.
  let items: AppTab[] = state.items;
  const activeId = state.activeId;
  // TabStore 中 session/chat tab 的 title 为 '新会话'（openTab 时写入），
  // 从 App.Session 实时解析真实名称
  items = items.map(t => t.kind !== 'file'
    ? { ...t, title: App.Session.getTabLabel(t.id) || t.title }
    : t);

  let scroll = '';
  for (let i = 0; i < items.length; i++) {
    const tab = items[i];
    const active = tab.id === activeId;
    const kindClass = tab.kind !== 'file' ? ' session-tab' : '';
    scroll += `<div class="tb-item${active ? ' active' : ''}${kindClass}" draggable="true" data-tab-index="${i}" data-tab="${E(tab.id)}" data-kind="${tab.kind}">
      <span class="tb-icon">${tab.kind === 'file' ? ExplorerService.iconFor(tab.title, false) : S('ic',13)}</span>
      <span class="tb-label">${E(tab.title)}</span>
      <button type="button" class="tb-close" draggable="false" aria-label="${tab.kind === 'file' ? '关闭文件标签' : '关闭标签'}">✕</button>
    </div>`;
  }
  el.innerHTML = `<div class="tb-scroll">${scroll}</div>${items.length > 0 ? '<div class="tb-more" title="更多操作">···</div>' : ''}`;
  // 自动滚动到活跃标签
  setTimeout(() => {
    const active = el.querySelector('.tb-item.active') as HTMLElement | null;
    if (active) active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, 0);
  if (items.length > 0 && typeof setupTabDrag === 'function') setupTabDrag(el);
  _setupTabEvents(el);
  _syncMainArea(activeId, items);
}

/** 统一主区显示：根据 active tab kind 切换消息区/编辑器/空白 */
function _syncMainArea(activeId: string | null, items: AppTab[]): void {
  const ms = $('ms');
  const fc = $('file-content');
  const fi = $('fi');
  const mc = document.querySelector('.mc');
  if (!ms || !fi) return;

  if (!activeId) {
    ms.style.display = 'none';
    if (fc) fc.style.display = 'none';
    fi.style.display = 'none';
    mc?.classList.remove('editing');
    return;
  }

  const activeTab = items.find(t => t.id === activeId);
  if (activeTab?.kind === 'file') {
    ms.style.display = 'none';
    if (fc) fc.style.display = '';
    mc?.classList.add('editing');
    fi.style.display = 'none';
  } else {
    ms.style.display = '';
    if (fc) fc.style.display = 'none';
    fi.style.display = '';
    mc?.classList.remove('editing');
  }
  const scheduleRailSync = window.requestAnimationFrame || ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
  scheduleRailSync(() => (window as any).syncTokenRailPosition?.());
}

// ─── 标签事件委托（替代 inline onclick，修复 ' 转义风险）───

function _setupTabEvents(container: HTMLElement): void {
  if (container.dataset.tabEvents === '1') return;
  container.dataset.tabEvents = '1';

  // 点击委托：tab 激活 / 关闭
  container.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // 关闭按钮
    if (target.classList.contains('tb-close')) {
      e.stopPropagation();
      const tabEl = target.closest('.tb-item') as HTMLElement | null;
      if (!tabEl) return;
      const id = tabEl.dataset.tab;
      if (!id) return;
      const AT = (window as any).App?.Tabs;
      if (AT) AT.close(id);
      return;
    }
    // tab 本身点击 → 激活
    const tabEl = target.closest('.tb-item') as HTMLElement | null;
    if (!tabEl) return;
    const id = tabEl.dataset.tab;
    if (!id) return;
    (window as any).App?.Tabs?.activate(id);
  });

  // 阻止 close 按钮的 mousedown（避免失去焦点）
  container.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).classList.contains('tb-close')) {
      e.stopPropagation();
      e.preventDefault();
    }
  });

  // 右键菜单委托
  container.addEventListener('contextmenu', (e: MouseEvent) => {
    const tabEl = (e.target as HTMLElement).closest('.tb-item') as HTMLElement | null;
    if (!tabEl) return;
    const id = tabEl.dataset.tab;
    if (!id) return;
    e.preventDefault();
    App.Tabs.contextMenu(e, id);
  });

  // 更多菜单
  container.addEventListener('click', (e: MouseEvent) => {
    const more = (e.target as HTMLElement).closest('.tb-more') as HTMLElement | null;
    if (!more) return;
    (window as any).tabMoreMenu?.(e);
  });
}

// ─── Token Rail 事件委托 ──────────────────────────────
document.addEventListener('click', (e: MouseEvent) => {
  const rail = (e.target as HTMLElement).closest('.tr-rail') as HTMLElement | null;
  if (!rail) return;
  if ((e.target as HTMLElement).closest('.tr-btn') && !(e.target as HTMLButtonElement).disabled) {
    (window as any).openCompactModal?.();
    return;
  }
  (window as any).openUsagePanel?.();
});

// ─── 滚轮滚动 ────────────────────────
document.addEventListener('wheel', (e) => {
  const target = (e.target as HTMLElement).closest('.tb-scroll') as HTMLElement | null;
  if (!target) return;
  target.scrollLeft += e.deltaY;
}, { passive: true });

// ─── 恢复上次的文件标签页 ──────────────────────────────
function restoreFileTabs(): void {
  try {
    // 从 UiStateStore.tabs.items 读取持久化的 file tab 列表
    const items = App.State.getSnapshot().tabs.items || [];
    const fileTabs = items.filter((t: any) => t.kind === 'file');
    if (fileTabs.length === 0) { restoreActiveTab(); return; }

    let loaded = 0;
    const total = fileTabs.length;
    for (const ft of fileTabs) {
      const ws = ExplorerService.getWorkspacePath();
      // 媒体 tab：直接开标签，不读取文本内容
      if (ft.renderer === 'image' || ft.renderer === 'video') {
        const ext = '.' + (ft.id.split('.').pop() || '').toLowerCase();
        openFileTab(ft.id, '', ext, ft.renderer, { activate: false });
        loaded++;
        if (loaded >= total) restoreActiveTab();
        continue;
      }
      if (ws) {
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(ft.id)}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return;
            openFileTab(ft.id, d.content, (d.path?.split('.').pop() || ''), ft.renderer, { activate: false });
          })
          .catch(() => {})
          .finally(() => {
            loaded++;
            if (loaded >= total) restoreActiveTab();
          });
      } else {
        loaded++;
        if (loaded >= total) restoreActiveTab();
      }
    }
  } catch {}
}

function restoreActiveTab(): void {
  try {
    // 用户已手动激活过标签 → 跳过恢复（restoreFileTabs 的异步 fetch 可能晚到，
    // 不得把 activeView 快照回持久化会话覆盖用户当前操作）
    if (App.SessionRestore.hasUserInteracted()) return;
    // UiStateStore.activeView 是权威恢复源
    const activeView = App.State.getSnapshot().activeView;

    if (activeView?.type === 'session' && activeView.id) {
      App?.Tabs?.activate(activeView.id);
      return;
    }
    if (activeView?.type === 'file' && activeView.id) {
      const exists = App.Tabs.getTab?.(activeView.id)?.kind === 'file';
      if (exists) { App?.Tabs?.activate(activeView.id); return; }
    }
    App.Tabs.clearActiveTab?.();
  } catch {}
}

// 页面加载完成后恢复面板宽度
document.addEventListener('DOMContentLoaded', () => { mark('dom_ready');
  const si = $('si');
  if (si) {
    const savedWidth = App.State.getSnapshot().panel.width;
    if (savedWidth > 50) si.style.width = savedWidth + 'px';
  }
});

// ─── Problems 底部栏 ─────────────────────────────────────

let _pbExpanded = false;

function _updateProblemsBar(): void {
  const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
  const counts = $('pb-status-counts');
  const trigger = $('pb-status-trigger');
  if (!store || !counts) return;

  const errors = store.getErrorCount();
  const warnings = store.getWarningCount();
  const total = store.getProblems().length;

  const chips: string[] = [];
  if (errors > 0) chips.push(`<span class="status-problems-error">${errors}</span>`);
  if (warnings > 0) chips.push(`<span class="status-problems-warning">${warnings}</span>`);
  counts.innerHTML = chips.join('');
  trigger?.classList.toggle('has-errors', errors > 0);
  trigger?.setAttribute('aria-label', total > 0 ? `问题：${errors} 个错误，${warnings} 个警告` : '没有问题');

  if (_pbExpanded) _renderProblemsList(store);
}

function _renderProblemsList(store: ProblemsStoreAPI): void {
  const body = $('pb-body');
  if (!body) return;

  const all = store.getProblems();
  if (all.length === 0) {
    body.innerHTML = '<div class="pb-empty">当前没有检测到问题 ✦</div>';
    return;
  }

  const errors = all.filter(p => p.severity === 'error');
  const warnings = all.filter(p => p.severity === 'warning');
  const infos = all.filter(p => p.severity === 'info');

  let html = '';
  if (errors.length) html += _pbRenderGroup('错误', errors, 'var(--ud)');
  if (warnings.length) html += _pbRenderGroup('警告', warnings, 'var(--uw)');
  if (infos.length) html += _pbRenderGroup('信息', infos, 'var(--in)');
  body.innerHTML = html;
  _pbBindClicks(body);
}

function _pbRenderGroup(label: string, items: ProblemItem[], color: string): string {
  let html = `<div class="pf-group">
    <div class="pf-group-hd" style="border-left-color:${color}"><span class="pf-group-label">${label}</span><span class="pf-group-cnt">${items.length}</span></div>`;
  const byFile = new Map<string, ProblemItem[]>();
  for (const p of items) {
    const list = byFile.get(p.filePath) || [];
    list.push(p); byFile.set(p.filePath, list);
  }
  for (const [filePath, fileProblems] of byFile) {
    const fileName = filePath.split('/').pop() || filePath;
    for (const p of fileProblems) {
      const line = _pbNormalizePosition(p.line);
      const column = _pbNormalizePosition(p.column);
      html += `<div class="pf-item" data-file="${E(p.filePath)}" data-line="${line}" data-col="${column}" title="${E(p.message)}">
        <span class="pf-sev-dot" style="background:${color}"></span>
        <span class="pf-msg">${E(p.message)}</span>
        <span class="pf-loc">${E(fileName)}:${line}:${column}</span>
      </div>`;
    }
  }
  html += '</div>';
  return html;
}

function _pbNormalizePosition(value: unknown): number {
  const position = Number(value);
  return Number.isFinite(position) && position >= 1 ? Math.trunc(position) : 1;
}

function _pbBindClicks(container: HTMLElement): void {
  container.querySelectorAll('.pf-item').forEach(el => {
    el.addEventListener('click', () => {
      const file = (el as HTMLElement).dataset.file;
      if (!file) return;
      _pbNavigateToProblem(file, parseInt((el as HTMLElement).dataset.line || '1', 10), parseInt((el as HTMLElement).dataset.col || '1', 10));
      _pbToggle(false);
    });
  });
}

async function _pbNavigateToProblem(filePath: string, line: number, col: number): Promise<void> {
  const tab = App.Tabs.getTab?.(filePath);
  if (tab) App.Tabs.activate(filePath);
  else {
    const fn = (window as any).openFileTab as ((id: string, content: string, lang?: string) => void) | undefined;
    if (fn) {
      const root = App.State.getWorkspacePath();
      fetch(`/api/file/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(filePath)}`)
        .then(r => r.json())
        .then((d: any) => { fn!(filePath, d?.content || '', '.' + (filePath.split('.').pop() || '').toLowerCase()); })
        .catch(() => fn!(filePath, '', ''));
    }
  }
  const m = (window as any).__monaco as MonacoAPI | undefined;
  if (!m) return;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (m.isReady?.() && m.getCurrentFile?.() === filePath) {
      m.revealPosition(line, col);
      return;
    }
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }
  try { m.revealPosition(line, col); } catch {}
}

function _pbToggle(force?: boolean): void {
  _pbExpanded = force !== undefined ? force : !_pbExpanded;
  const panel = $('pb-panel');
  const trigger = $('pb-status-trigger');
  if (panel) panel.style.display = _pbExpanded ? '' : 'none';
  if (trigger) {
    trigger.setAttribute('aria-expanded', String(_pbExpanded));
    trigger.title = _pbExpanded ? '隐藏问题' : '显示问题';
    trigger.classList.toggle('active', _pbExpanded);
  }
  if (_pbExpanded) _updateProblemsBar();
  const schedule = window.requestAnimationFrame || ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
  schedule(() => (window as any).syncTokenRailPosition?.());
}

const PB_MIN_HEIGHT = 48;

function _pbMaxHeight(): number {
  const main = document.querySelector<HTMLElement>('.main');
  const available = main?.getBoundingClientRect().height || window.innerHeight;
  return Math.max(PB_MIN_HEIGHT, Math.floor(available * 0.8));
}

function _pbSetHeight(height: number): void {
  const panel = $('pb-panel');
  const handle = $('pb-resize-handle');
  if (!panel) return;
  const clamped = Math.max(PB_MIN_HEIGHT, Math.min(Math.round(height), _pbMaxHeight()));
  panel.style.height = `${clamped}px`;
  panel.style.maxHeight = 'none';
  handle?.setAttribute('aria-valuenow', String(clamped));
  (window as any).syncTokenRailPosition?.();
}

function _pbInitResize(): void {
  const handle = $('pb-resize-handle');
  const panel = $('pb-panel');
  if (!handle || !panel || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';

  handle.addEventListener('mousedown', (event: MouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    panel.classList.add('resizing');
    const onMove = (moveEvent: MouseEvent) => _pbSetHeight(startHeight + startY - moveEvent.clientY);
    const onUp = () => {
      panel.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  handle.addEventListener('keydown', (event: KeyboardEvent) => {
    const current = panel.getBoundingClientRect().height || PB_MIN_HEIGHT;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      _pbSetHeight(current + (event.key === 'ArrowUp' ? 16 : -16));
    } else if (event.key === 'Home') {
      event.preventDefault();
      _pbSetHeight(PB_MIN_HEIGHT);
    } else if (event.key === 'End') {
      event.preventDefault();
      _pbSetHeight(_pbMaxHeight());
    }
  });
}

// 初始化底部栏（由 layout() 在 DOM 创建后调用）
let _pbUnsubscribe: (() => void) | null = null;
function _initProblemsBar(): void {
  // 解除前一次订阅，避免 layout() 重建时累积
  if (_pbUnsubscribe) { _pbUnsubscribe(); _pbUnsubscribe = null; }

  const trigger = $('pb-status-trigger');
  if (trigger) trigger.addEventListener('click', () => _pbToggle());
  _pbInitResize();

  const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
  if (store) {
    _pbUnsubscribe = store.subscribe(() => {
      if (document.getElementById('pb-status-trigger')) _updateProblemsBar();
    });
  }
  _pbToggle(_pbExpanded);
}

// ─── window 别名 ──────────────────────────────────
window.layout = layout;
(window as any).renderTabs = renderTabs;

(window as any).closeChatTab = closeChatTab;
(window as any).restoreFileTabs = restoreFileTabs;

// ─── App 命名空间绑定 ──────────────────────────────────────
{ const U = (window as any).App?.UI; if (U) {
  U.layout = layout;
  U.renderTabs = renderTabs;
} }
{ const appNamespace = (window as any).App || ((window as any).App = {});
  const statusBar = appNamespace.StatusBar || (appNamespace.StatusBar = {});
  statusBar.setNotice = setStatusNotice;
  statusBar.clearNotice = clearStatusNotice;
}
