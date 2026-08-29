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
  App.UI.disposeMountedPane?.();
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
  App.UI.reconcileContributions?.();
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
    <button class="b" data-side="components" data-layout-action="panel" title="扩展与集成">${S('ipuzzle',20)}</button>
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
      <div class="msgs" id="ms">${App.Chat?.msgs ? App.Chat.msgs() : ''}</div>
      <nav class="chat-timeline" id="chat-timeline" aria-label="会话时间线" aria-hidden="true"></nav>
      <div class="file-content" id="file-content" style="display:none">
        <div class="fc-toolbar"><span class="fc-status" id="fc-status"></span></div>
        <div class="fc-editor" id="fc-editor"></div>
      </div>
      <div class="component-content" id="component-content" style="display:none" aria-live="polite"></div>
      <div class="fi-area" id="fi">
        <button class="chat-jump-latest" id="chat-jump-latest" type="button" title="回到最新消息" aria-label="回到最新消息" aria-hidden="true" tabindex="-1">${App.UI.S('idown', 16)}</button>
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
            <button class="fi-abtn fi-file" id="fi-file-btn" title="添加本机文件">${App.UI.S('iplus', 14)}</button>
            <span class="fi-spacer"></span>
            <button id="chat-note-mode" class="fi-abtn fi-note-mode" title="补充处理时机" style="${chatBusy ? '' : 'display:none'}">当前步骤后</button>
            <button id="chat-stop" class="fi-stop-btn" title="中止当前任务" aria-label="中止当前任务" style="${chatBusy ? '' : 'display:none'}">${App.UI.S('ipause', 16)}</button>
            <button id="cs" class="fi-send-btn" title="发送消息">${App.UI.S('iup', 16)}</button>
          </div>
        </div>
      </div>
    </div>
    ${buildProblemsPanel()}
  </div>`;
}

function buildProblemsPanel(): string {
  return `<section class="pb-panel" id="pb-panel" aria-label="问题" style="display:none">
    <div class="pb-resize-handle" id="pb-resize-handle" role="separator" aria-orientation="horizontal" aria-valuemin="48" aria-valuemax="48" aria-valuenow="48" tabindex="0" title="调整问题栏高度"></div>
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
        const handler = appNamespace?.File?.toggleFileMenu;
        if (typeof handler === 'function') handler(event, target);
        break;
      }
      case 'window':
        if (target.dataset.windowAction) App.UI.winCtrl(target.dataset.windowAction);
        break;
      case 'panel':
        if (target.dataset.side) togglePanel(target.dataset.side);
        break;
      case 'launch-cli': {
        const handler = appNamespace?.File?.launchCli;
        if (typeof handler === 'function') handler();
        break;
      }
      case 'settings': {
        const handler = appNamespace?.Settings?.openSettingsModal;
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
  items = items.map(t => t.kind === 'session' || t.kind === 'chat'
    ? { ...t, title: App.Session.getTabLabel(t.id) || t.title }
    : t);

  let scroll = '';
  for (let i = 0; i < items.length; i++) {
    const tab = items[i];
    const active = tab.id === activeId;
    // Keep the historical session-tab hook for both persisted sessions and
    // draft chats; extensions can still target their specific kind class.
    const kindClass = tab.kind === 'file' ? '' : ` ${tab.kind === 'session' || tab.kind === 'chat' ? 'session-tab ' : ''}${tab.kind}-tab`;
    const icon = tab.kind === 'file' ? ExplorerService.iconFor(tab.title, false)
      : tab.kind === 'component' ? S('ipuzzle', 13) : S('ic', 13);
    scroll += `<div class="tb-item${active ? ' active' : ''}${kindClass}" draggable="true" data-tab-index="${i}" data-tab="${E(tab.id)}" data-kind="${tab.kind}">
      <span class="tb-icon">${icon}</span>
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
  const componentContent = $('component-content');
  const mc = document.querySelector('.mc');
  if (!ms || !fi) return;
  if (!activeId) {
    ms.style.display = 'none';
    if (fc) fc.style.display = 'none';
    if (componentContent) componentContent.style.display = 'none';
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
    if (componentContent) componentContent.style.display = 'none';
  } else if (activeTab?.kind === 'component') {
    ms.style.display = 'none';
    if (fc) fc.style.display = 'none';
    fi.style.display = 'none';
    if (componentContent) componentContent.style.display = '';
    mc?.classList.remove('editing');
    renderComponentTab(activeTab);
  } else {
    ms.style.display = '';
    if (fc) fc.style.display = 'none';
    if (componentContent) componentContent.style.display = 'none';
    fi.style.display = '';
    mc?.classList.remove('editing');
  }
  const scheduleRailSync = window.requestAnimationFrame || ((callback: FrameRequestCallback) => window.setTimeout(callback, 0));
  scheduleRailSync(() => App.Chat?.syncTokenRailPosition?.());
}

type ComponentTabManifest = NonNullable<AppTab['componentManifest']>;

function renderComponentTab(tab: AppTab): void {
  const root = $('component-content');
  const manifest = tab.componentManifest;
  if (!root || !manifest) return;
  if (manifest.source === 'mcp') {
    void renderMcpServerTab(tab, manifest, root);
    return;
  }
  const source = manifest.source === 'builtin' ? '原生' : manifest.source === 'mcp' ? 'MCP' : '第三方';
  const kind = manifest.kind === 'required' ? '必需组件' : '可选组件';
  const state = tab.componentEnabled === false || tab.componentStatus === 'disabled' ? '已停用' : '已启用';
  const canManage = manifest.source === 'builtin' && manifest.kind === 'optional' && tab.componentInstalled !== false;
  const value = (item: unknown): string => typeof item === 'string' && item.trim() ? E(item) : '未提供';
  root.innerHTML = `<article class="component-detail" data-component-detail="${E(manifest.id)}">
    <header class="component-detail-header"><div class="component-detail-title"><span class="component-detail-icon">${S('ipuzzle', 22)}</span><div><h1>${E(manifest.displayName || manifest.id)}</h1><p>${value(manifest.description)}</p></div></div>${canManage ? `<div class="component-detail-actions"><button class="component-detail-action" data-component-action="toggle" type="button">${state === '已停用' ? '启用' : '停用'}</button><button class="component-detail-action danger" data-component-action="uninstall" type="button">卸载</button></div>` : ''}</header>
    <section class="component-detail-section"><h2>组件信息</h2><dl class="component-detail-grid"><div><dt>归属</dt><dd>${value(manifest.hostSurface)}</dd></div><div><dt>类型</dt><dd>${kind}</dd></div><div><dt>来源</dt><dd>${source}</dd></div><div><dt>版本</dt><dd>${value(manifest.version)}</dd></div><div><dt>能力</dt><dd>${value(manifest.capability)}</dd></div><div><dt>状态</dt><dd>${state}</dd></div></dl></section>
    <section class="component-detail-section"><h2>依赖</h2><p class="component-detail-deps">${manifest.dependencies?.length ? manifest.dependencies.map((dependency) => E(typeof dependency === 'string' ? dependency : dependency.id)).join('、') : '无声明依赖'}</p></section>
  </article>`;
  const bindAction = (name: string, endpoint: string, success: string) => root.querySelector<HTMLButtonElement>(`[data-component-action="${name}"]`)?.addEventListener('click', async () => {
    const button = root.querySelector<HTMLButtonElement>(`[data-component-action="${name}"]`);
    if (!button) return;
    if (name === 'uninstall' && !window.confirm(`确定卸载组件 ${manifest.id}？`)) return;
    button.disabled = true;
    try {
      const response = await fetch(`/api/components/${encodeURIComponent(manifest.id)}/${endpoint}`, { method: 'POST', credentials: 'include' });
      if (!response.ok) throw new Error(`组件${success}失败`);
      if (name === 'uninstall') { App.UI.toast?.(`${manifest.id} 已卸载`, 'success'); App.Tabs.close(tab.id); }
      else { App.UI.toast?.(`${manifest.id} ${success}`, 'success'); App.Tabs.replaceTab?.(tab.id, { componentEnabled: success !== '已停用', componentStatus: success === '已停用' ? 'disabled' : 'active' }); renderComponentTab({ ...tab, componentEnabled: success !== '已停用', componentStatus: success === '已停用' ? 'disabled' : 'active' }); }
      App.UI.syncComponents?.();
    } catch (error) { App.UI.toast?.(error instanceof Error ? error.message : `组件${success}失败`, 'error'); button.disabled = false; }
  });
  if (canManage) {
    bindAction('toggle', state === '已停用' ? 'enable' : 'disable', state === '已停用' ? '已启用' : '已停用');
    bindAction('uninstall', 'uninstall', '卸载');
  }
}

async function renderMcpServerTab(tab: AppTab, manifest: ComponentTabManifest, root: HTMLElement): Promise<void> {
  const name = manifest.displayName || manifest.id.replace(/^mcp-server\./, '');
  root.innerHTML = `<article class="component-detail" data-component-detail="${E(manifest.id)}"><header class="component-detail-header"><div class="component-detail-title"><span class="component-detail-icon">${S('ipuzzle', 22)}</span><div><h1>${E(name)}</h1><p>MCP Server</p></div></div></header><p class="component-detail-deps">正在读取 MCP Server 状态…</p></article>`;
  try {
    const response = await fetch('/api/mcp/servers', { credentials: 'include', cache: 'no-store' });
    const servers = await response.json().catch(() => []) as McpServerStatus[];
    if (!response.ok || !Array.isArray(servers)) throw new Error('无法读取 MCP Server 状态');
    const server = servers.find((candidate) => candidate.name === name);
    if (!server) {
      root.innerHTML = `<article class="component-detail"><header class="component-detail-header"><div class="component-detail-title"><span class="component-detail-icon">${S('ipuzzle', 22)}</span><div><h1>${E(name)}</h1><p>MCP Server 已不在当前配置中。</p></div></div></header></article>`;
      return;
    }
    const connection = App.McpState.normalize(server.state);
    const enabled = server.config?.enabled !== false;
    const endpoint = server.config?.transport === 'http' || server.config?.transport === 'sse'
      ? server.config.url || '未提供'
      : [server.config?.command, ...(server.config?.args || [])].filter(Boolean).join(' ') || '未提供';
    root.innerHTML = `<article class="component-detail" data-component-detail="${E(manifest.id)}">
      <header class="component-detail-header"><div class="component-detail-title"><span class="component-detail-icon">${S('ipuzzle', 22)}</span><div><h1>${E(server.name)}</h1><p>${E(App.McpState.label(connection))}${server.error ? ` · ${E(server.error)}` : ''}</p></div></div>
      <div class="component-detail-actions"><button class="component-detail-action" data-mcp-action="toggle" type="button">${enabled ? '停用' : '启用'}</button>${server.error?.includes('未信任') ? '<button class="component-detail-action" data-mcp-action="trust" type="button">信任</button>' : ''}${server.canDelete !== false ? '<button class="component-detail-action danger" data-mcp-action="remove" type="button">删除</button>' : ''}</div></header>
      <section class="component-detail-section"><h2>连接</h2><dl class="component-detail-grid"><div><dt>状态</dt><dd>${E(App.McpState.label(connection))}</dd></div><div><dt>启用</dt><dd>${enabled ? '是' : '否'}</dd></div><div><dt>传输</dt><dd>${E(server.config?.transport || 'stdio')}</dd></div><div><dt>目标</dt><dd>${E(endpoint)}</dd></div></dl></section>
      <section class="component-detail-section"><h2>已发现工具</h2><p class="component-detail-deps">${server.tools.length ? server.tools.map((tool) => E(tool)).join('、') : '当前未发现工具'}</p></section>
    </article>`;
    const call = async (action: 'toggle' | 'trust' | 'remove'): Promise<void> => {
      const button = root.querySelector<HTMLButtonElement>(`[data-mcp-action="${action}"]`);
      if (!button) return;
      if (action === 'remove' && !window.confirm(`确定删除 MCP Server ${server.name}？`)) return;
      button.disabled = true;
      try {
        const request = action === 'remove'
          ? fetch('/api/mcp/uninstall', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: server.name }) })
          : fetch(`/api/mcp/servers/${encodeURIComponent(server.name)}/${action}`, { method: 'POST', credentials: 'include' });
        const result = await request;
        const body = await result.json().catch(() => null) as { ok?: boolean; error?: string; message?: string } | null;
        if (!result.ok || body?.ok === false) throw new Error(body?.error || 'MCP Server 操作失败');
        if (action === 'remove') {
          App.UI.toast?.(`${server.name} 已删除`, 'success');
          App.Tabs.close(tab.id);
        } else {
          App.UI.toast?.(body?.message || `${server.name} 已更新`, 'success');
          await App.UI.syncComponents?.();
          await renderMcpServerTab(tab, manifest, root);
        }
      } catch (error) {
        App.UI.toast?.(error instanceof Error ? error.message : 'MCP Server 操作失败', 'error');
        button.disabled = false;
      }
    };
    root.querySelector<HTMLButtonElement>('[data-mcp-action="toggle"]')?.addEventListener('click', () => void call('toggle'));
    root.querySelector<HTMLButtonElement>('[data-mcp-action="trust"]')?.addEventListener('click', () => void call('trust'));
    root.querySelector<HTMLButtonElement>('[data-mcp-action="remove"]')?.addEventListener('click', () => void call('remove'));
  } catch (error) {
    root.innerHTML = `<article class="component-detail"><header class="component-detail-header"><div class="component-detail-title"><span class="component-detail-icon">${S('ipuzzle', 22)}</span><div><h1>${E(name)}</h1><p>${E(error instanceof Error ? error.message : '无法读取 MCP Server 状态')}</p></div></div></header></article>`;
  }
}

function openComponentTab(component: ComponentTabManifest): void {
  const id = `component:${component.id}`;
  const existing = App.Tabs.getTab?.(id);
  if (existing) { App.Tabs.activate(id); return; }
  const { enabled, status, installed, ...manifest } = component as ComponentTabManifest & { enabled?: boolean; status?: AppTab['componentStatus']; installed?: boolean };
  App.Tabs.openTab({ kind: 'component', id, title: component.displayName || component.id, componentId: component.id, componentManifest: { ...manifest }, componentEnabled: enabled, componentStatus: status, componentInstalled: installed });
  App.Tabs.activate(id);
  renderTabs();
}

{ const tabs = App.Tabs;
  if (tabs?.registerTabBehavior) {
    tabs.registerTabBehavior('component', {
      activate(tab: AppTab) { tabs.activateTab(tab.id); renderTabs(); },
      close(tab: AppTab) { tabs.closeTab(tab.id); renderTabs(); },
    });
  }
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
    App.Chat?.openCompactModal?.();
    return;
  }
  App.Chat?.openUsagePanel?.();
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
        App.UI.openFileTab(ft.id, '', ext, ft.renderer, { activate: false });
        loaded++;
        if (loaded >= total) restoreActiveTab();
        continue;
      }
      if (ws) {
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(ft.id)}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return;
            App.UI.openFileTab(ft.id, d.content, (d.path?.split('.').pop() || ''), ft.renderer, { activate: false });
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
    if (activeView?.type === 'component' && activeView.id) {
      const exists = App.Tabs.getTab?.(activeView.id)?.kind === 'component';
      if (exists) { App?.Tabs?.activate(activeView.id); return; }
    }
    if (activeView?.type === 'file' && activeView.id) {
      const exists = App.Tabs.getTab?.(activeView.id)?.kind === 'file';
      if (exists) { App?.Tabs?.activate(activeView.id); return; }
    }
    App.Tabs.clearActiveTab?.();
  } catch {}
}

// 页面加载完成后恢复面板宽度
document.addEventListener('DOMContentLoaded', () => { App.UI.mark('dom_ready');
  const si = $('si');
  if (si) {
    const savedWidth = App.State.getSnapshot().panel.width;
    if (savedWidth > 50) si.style.width = savedWidth + 'px';
  }
});

// ─── Problems 底部栏 ─────────────────────────────────────

let _pbExpanded = false;
let _problemsComponentActive = true;

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
    const fn = App.UI.openFileTab;
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
  if (!_problemsComponentActive) force = false;
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
  schedule(() => App.Chat?.syncTokenRailPosition?.());
}

const PB_MIN_HEIGHT = 48;

function _pbMaxHeight(): number {
  const main = document.querySelector<HTMLElement>('.main');
  const available = main?.getBoundingClientRect().height || window.innerHeight;
  return Math.max(PB_MIN_HEIGHT, Math.floor(available * 0.8));
}

function _pbSyncResizeA11y(): void {
  const panel = $('pb-panel');
  const handle = $('pb-resize-handle');
  if (!handle) return;
  const current = panel?.getBoundingClientRect().height || PB_MIN_HEIGHT;
  handle.setAttribute('aria-valuemin', String(PB_MIN_HEIGHT));
  handle.setAttribute('aria-valuemax', String(_pbMaxHeight()));
  handle.setAttribute('aria-valuenow', String(Math.round(current)));
}

function _pbSetHeight(height: number): void {
  const panel = $('pb-panel');
  const handle = $('pb-resize-handle');
  if (!panel) return;
  const clamped = Math.max(PB_MIN_HEIGHT, Math.min(Math.round(height), _pbMaxHeight()));
  panel.style.height = `${clamped}px`;
  panel.style.maxHeight = 'none';
  _pbSyncResizeA11y();
  handle?.setAttribute('aria-valuenow', String(clamped));
  App.Chat?.syncTokenRailPosition?.();
}

function _pbInitResize(): void {
  const handle = $('pb-resize-handle');
  const panel = $('pb-panel');
  if (!handle || !panel || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';
  _pbSyncResizeA11y();

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
function setProblemsComponentActive(active: boolean): void {
  _problemsComponentActive = active;
  const trigger = $('pb-status-trigger');
  if (trigger) {
    trigger.hidden = !active;
    trigger.setAttribute('aria-hidden', String(!active));
  }
  if (!active) _pbToggle(false);
  else {
    _pbToggle(_pbExpanded);
    _updateProblemsBar();
  }
}

function _initProblemsBar(): void {
  // 解除前一次订阅，避免 layout() 重建时累积
  if (_pbUnsubscribe) { _pbUnsubscribe(); _pbUnsubscribe = null; }

  const trigger = $('pb-status-trigger');
  if (trigger) trigger.addEventListener('click', () => {
    if (_problemsComponentActive) _pbToggle();
  });
  _pbInitResize();

  const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
  if (store) {
    _pbUnsubscribe = store.subscribe(() => {
      if (_problemsComponentActive && document.getElementById('pb-status-trigger')) _updateProblemsBar();
    });
  }
  setProblemsComponentActive(_problemsComponentActive);
}

// ─── App 命名空间绑定 ──────────────────────────────────────
{ const U = (window as any).App?.UI; if (U) {
  U.layout = layout;
  U.renderTabs = renderTabs;
  U.closeChatTab = closeChatTab;
  U.restoreFileTabs = restoreFileTabs;
  U.openComponentTab = openComponentTab;
  U.setProblemsComponentActive = setProblemsComponentActive;
} }
{ const appNamespace = (window as any).App || ((window as any).App = {});
  const statusBar = appNamespace.StatusBar || (appNamespace.StatusBar = {});
  statusBar.setNotice = setStatusNotice;
  statusBar.clearNotice = clearStatusNotice;
}
