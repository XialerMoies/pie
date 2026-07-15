// Layout core — 组件组装器 + HTML 构建 + 标签渲染 + 会话恢复
// Tab/事件/快捷键/面板已拆至 layout-tabs / layout-panel / layout-shortcuts

const CHAT_TAB_OPEN_KEY = 'chat-tab-open';

function isChatTabOpen(): boolean {
  try { return localStorage.getItem(CHAT_TAB_OPEN_KEY) !== '0'; } catch { return true; }
}

function hasOpenSessionTabs(): boolean {
  try {
    const raw = localStorage.getItem('session-tabs');
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) && ids.length > 0;
  } catch { return false; }
}

function closeChatTab(): void {
  // 关闭当前 chat tab（只关激活的那个，不多关草稿）
  const tabs = (window as any).__tabs;
  if (tabs) {
    const active = tabs.getActiveTab();
    if (active && active.kind === 'chat') tabs.closeTab(active.id);
  }
  const store = window.__state?._uiStateStore;
  if (store) store.tabs.chatOpen = false;
  if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
  if (window.__state._activeFileTab === null && window.__state._fileTabs.length > 0) {
    (window as any).App?.Tabs?.activate(window.__state._fileTabs[0].id);
    return;
  }
  renderTabs();
}

function layout(): void {
  $('app')!.innerHTML = buildTopBar() + buildSideBar() + buildSidePanel() + buildMainArea();
  initResizeHandle();
  renderTabs();
  document.querySelectorAll('.sbar .b[data-side]').forEach(b =>
    (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.side === window.__state._activePanel));
  const pc = $('pc');
  if (pc) renderPanel(window.__state._activePanel, pc);
  bind();
  // 从 localStorage 恢复会话标签页（读取 session-tabs / active-session-tab / last-closed）
  (window as any).App?.Session?.restoreSessionTabs?.();
}

// ─── Top Bar ──────────────────────────────────────────────────
function buildTopBar(): string {
  return `<div class="topbar">
    <div class="nm"><span>PI</span></div>
    <div class="top-tabs">
      <button class="top-tab" onclick="toggleFileMenu(event)">文件</button>
    </div>
    <div class="win-controls">
      <button class="win-btn" onclick="winCtrl('minimize')">─</button>
      <button class="win-btn" onclick="winCtrl('maximize')">□</button>
      <button class="win-btn close" onclick="winCtrl('close')">✕</button>
    </div>
  </div>`;
}

function buildSideBar(): string {
  return `<div class="sbar">
    <button class="b" data-side="explorer" onclick="togglePanel('explorer')" title="资源管理器">${S('ifolder',20)}</button>
    <button class="b" data-side="chat" onclick="togglePanel('chat')" title="任务线程">${S('imsg',20)}</button>
    <button class="b" data-side="search" onclick="togglePanel('search')" title="搜索">${S('isearch',20)}</button>
    <button class="b" data-side="git" onclick="togglePanel('git')" title="Git">${S('igit',20)}</button>
    <div class="spcr"></div>
    <div class="bb">
      <button class="b" title="CLI" onclick="launchCli()">${S('iterm',20)}</button>
      <button class="b" title="设置" onclick="openSettingsModal()">${S('is',20)}</button>
    </div>
  </div>`;
}

function buildSidePanel(): string {
  return `<div class="sinfo" id="si"><div class="panel-content" id="pc"></div><div class="sinfo-handle" id="si-handle"></div></div>`;
}

function buildMainArea(): string {
  return `<div class="main">
    <div class="main-tabs" id="main-tabs"></div>
    <div class="mc">
      <div class="msgs" id="ms">${window.msgs ? window.msgs() : ''}</div>
      <div class="file-content" id="file-content" style="display:none">
        <div class="fc-toolbar"><span class="fc-status" id="fc-status"></span></div>
        <div class="fc-editor" id="fc-editor"></div>
      </div>
      <div class="fi-area" id="fi">
        <div class="fi-token-box" id="fi-token">
          <div class="fi-tk-top"><span class="fi-tk-hd">Tokens</span><span class="fi-tk-ctx" id="fi-tk-ctx">— / —</span></div>
          <div class="fi-tk-bar"><div class="fi-tk-fill" id="fi-tk-fill" style="width:0%"></div></div>
          <div class="fi-tk-grid" id="fi-tk-grid">
            <span class="fi-tk-l">输入</span><span class="fi-tk-v" id="fi-tk-in">—</span>
            <span class="fi-tk-l">输出</span><span class="fi-tk-v" id="fi-tk-out">—</span>
            <span class="fi-tk-l">命中</span><span class="fi-tk-v" id="fi-tk-ch">—</span>
            <span class="fi-tk-l">未命</span><span class="fi-tk-v" id="fi-tk-cm">—</span>
            <span class="fi-tk-l">命中率</span><span class="fi-tk-v" id="fi-tk-rate">—</span>
            <span class="fi-tk-sep"></span>
            <span class="fi-tk-l">费用</span><span class="fi-tk-v" id="fi-tk-cost">—</span>
          </div>
        </div>
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
          <textarea id="ci" rows="1" placeholder="输入消息...（输入 / 使用快捷命令）" ${window.__state.IL?'disabled':''}></textarea>
          <div class="fi-divider"></div>
          <div class="fi-actions-bar">
            <button class="fi-abtn fi-model" id="fi-model-btn" title="切换模型"><span id="fi-model-name">claude-sonnet</span> <span class="fi-arrow">▾</span></button>
            <button class="fi-abtn fi-mode" id="fi-mode-btn" title="切换模式"><span id="fi-mode-name">自动</span> <span class="fi-arrow">▾</span></button>
            <button class="fi-abtn fi-file" id="fi-file-btn" title="添加本机文件">${window.S('iplus', 14)}</button>
            <span class="fi-spacer"></span>
            <button id="cs" class="fi-send-btn" title="${window.__state.IL?'中止':'发送消息'}">${window.S('iup', 16)}</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// ─── 标签渲染（统一容器）───────────────────────────────────
function renderTabs(): void {
  const el = $('main-tabs');
  if (!el) return;
  const tabs = (window as any).__tabs;
  const state = tabs?.getState?.();
  const hasTabStore = state !== undefined && state !== null;

  // 统一路径：从 TabStore 读取
  let items: AppTab[] = [];
  let activeId: string | null = null;
  if (hasTabStore && state!.items !== undefined) {
    items = state!.items;
    activeId = state!.activeId;
    // TabStore 中 session/chat tab 的 title 为 '新会话'（openTab 时写入），
    // 从 sessionTabLabel() 实时解析真实名称
    if (typeof (window as any).sessionTabLabel === 'function') {
      items = items.map(t => t.kind !== 'file' ? { ...t, title: (window as any).sessionTabLabel(t.id) } : t);
    }
  } else if (!hasTabStore) {
    // 回退：从旧字段构建（兼容测试/未迁移场景）
    const st = (window as any).__state;
    const fileTabs = st?._fileTabs ?? [];
    for (const ft of fileTabs) {
      items.push({ id: ft.id, kind: 'file', title: ft.label, order: items.length, path: ft.id } as AppTab);
    }
    // 从 readSessionTabIds（暴露在 window）读，兼容旧 localStorage 持久化
    let sessionIds: string[] = [];
    if (typeof (window as any).readSessionTabIds === 'function') {
      sessionIds = (window as any).readSessionTabIds();
    }
    if (!sessionIds.length) sessionIds = st?._sessionTabs ?? [];
    const getLabel = (window as any).sessionTabLabel || ((s: string) => s.startsWith('draft:') ? '新会话' : '新会话');
    for (const sid of sessionIds) {
      const isDraft = sid.startsWith('draft:');
      items.push({
        id: sid, kind: isDraft ? 'chat' : 'session', title: getLabel(sid), order: items.length,
        ...(isDraft ? { draftId: sid } : { sessionId: sid }),
      } as AppTab);
    }
    activeId = st?._activeSessionTabId ?? null;
  }

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
    // 无 active tab → 空白主区
    ms.style.display = 'none';
    if (fc) fc.style.display = 'none';
    fi.style.display = 'none';
    mc?.classList.remove('editing');
    return;
  }

  const activeTab = items.find(t => t.id === activeId);
  if (activeTab?.kind === 'file') {
    // file tab → 显示编辑器
    ms.style.display = 'none';
    if (fc) fc.style.display = '';
    mc?.classList.add('editing');
    // 输入区对 file tab 也隐藏（聊天输入不显示在文件编辑模式）
    fi.style.display = 'none';
  } else {
    // chat/session tab → 显示消息区和输入区
    ms.style.display = '';
    if (fc) fc.style.display = 'none';
    fi.style.display = '';
    mc?.classList.remove('editing');
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

// ─── 滚轮滚动 ────────────────────────
document.addEventListener('wheel', (e) => {
  const target = (e.target as HTMLElement).closest('.tb-scroll') as HTMLElement | null;
  if (!target) return;
  target.scrollLeft += e.deltaY;
}, { passive: true });

// ─── 恢复上次的文件标签页 ──────────────────────────────
function restoreFileTabs(): void {
  try {
    const intendedTarget = localStorage.getItem('last-active-tab') ?? '__chat__';
    // 从 UiStateStore.tabs.items 读取持久化的 file tab 列表
    const uis = (window as any).__uiStateStore;
    const items: any[] = uis?._state?.tabs?.items ?? [];
    const fileTabs: Array<{ id: string; lang?: string }> = items.filter((t: any) => t.kind === 'file');
    if (fileTabs.length === 0) { restoreActiveTabWith(intendedTarget); return; }

    let loaded = 0;
    const total = fileTabs.length;
    for (const ft of fileTabs) {
      const ws = ExplorerService.getWorkspacePath();
      if (ws) {
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(ft.id)}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return;
            const content = d.encoding === 'base64' ? '[二进制文件，无法预览]' : d.content;
            openFileTab(ft.id, content, ft.lang || '');
          })
          .catch(() => {})
          .finally(() => {
            loaded++;
            if (loaded >= total) restoreActiveTabWith(intendedTarget);
          });
      } else {
        loaded++;
        if (loaded >= total) restoreActiveTabWith(intendedTarget);
      }
    }
  } catch {}
}

function restoreActiveTabWith(target: string): void {
  try {
    // UiStateStore.activeView 是权威恢复源
    const uis = (window as any).__uiStateStore;
    const activeView = uis?._state?.activeView;

    if (activeView?.type === 'session' && activeView.id) {
      App?.Tabs?.activate(activeView.id);
      return;
    }
    if (activeView?.type === 'file' && activeView.id) {
      const exists = window.__state._fileTabs.some(t => t.id === activeView.id);
      if (exists) { App?.Tabs?.activate(activeView.id); return; }
    }
    if (activeView?.type === 'chat' || !target || target === '__chat__') {
      const ts = (window as any).__tabs; if (ts) ts.activateTab(null);
      return;
    }
    // localStorage last-active-tab 仅作为旧格式兜底（UiStateStore.activeView 不存在或不可用时）
    const exists = window.__state._fileTabs.some(t => t.id === target);
    if (exists) App?.Tabs?.activate(target);
    else { const ts = (window as any).__tabs; if (ts) ts.activateTab(null); }
  } catch { const ts = (window as any).__tabs; if (ts) ts.activateTab(null); }
}

// 页面加载完成后恢复面板宽度
document.addEventListener('DOMContentLoaded', () => {
  const si = $('si');
  if (si) {
    try {
      const savedWidth = parseInt(localStorage.getItem('panel-width') || '', 10);
      if (savedWidth > 50) si.style.width = savedWidth + 'px';
    } catch {}
  }
});

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
