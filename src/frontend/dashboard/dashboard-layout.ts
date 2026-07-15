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
  try { localStorage.setItem(CHAT_TAB_OPEN_KEY, '0'); } catch {}
  if (window.__state._activeFileTab === null && window.__state._fileTabs.length > 0) {
    switchTab(window.__state._fileTabs[0].id);
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

// ─── 标签渲染 ───────────────────────────────────────────────
function renderTabs(): void {
  const el = $('main-tabs');
  if (!el) return;
  const active = window.__state._activeFileTab;
  const hasTabs = window.__state._fileTabs.length > 0;
  const chatOpen = isChatTabOpen();
  const sessionOpen = hasOpenSessionTabs();
  let scroll = '';
  if (chatOpen) {
    scroll += `<div class="tb-item${active === null && !sessionOpen ? ' active' : ''}" data-tab="chat" onclick="switchTab(null)">
      <span class="tb-icon">${S('ic',13)}</span>
      <span class="tb-label">对话</span>
      <span class="tb-close" onclick="event.stopPropagation();closeChatTab()">✕</span>
    </div>`;
  }
  for (let i = 0; i < window.__state._fileTabs.length; i++) {
    const ft = window.__state._fileTabs[i];
    const icon = ExplorerService.iconFor(ft.label, false);
    scroll += `<div class="tb-item${ft.id === active ? ' active' : ''}" draggable="true" data-tab-index="${i}" data-tab="${E(ft.id)}" onclick="switchTab('${E(ft.id)}')" oncontextmenu="tabContextMenu(event,'${E(ft.id)}')">
      <span class="tb-icon">${icon}</span>
      <span class="tb-label">${E(ft.label)}</span>
      <span class="tb-close" onclick="event.stopPropagation();closeFileTab('${E(ft.id)}')">✕</span>
    </div>`;
  }
  const sessionTabs = `<div class="session-tabs empty" id="session-tabs"></div>`;
  el.innerHTML = `${sessionTabs}<div class="tb-scroll">${scroll}</div>${hasTabs ? '<div class="tb-more" onclick="tabMoreMenu(event)" title="更多操作">···</div>' : ''}`;
  if (hasTabs) setupTabDrag(el);
  (window as any).App?.Session?.renderSessionTabs?.(localStorage.getItem('active-session-tab') || undefined);
}

// ─── 滚轮滚动 ────────────────────────
document.addEventListener('wheel', (e) => {
  const target = (e.target as HTMLElement).closest('.tb-scroll') as HTMLElement | null;
  if (!target) return;
  target.scrollLeft += e.deltaY;
}, { passive: true });

// ─── 恢复上次的标签页 ──────────────────────────────────────
function restoreFileTabs(): void {
  try {
    const intendedTarget = localStorage.getItem('last-active-tab') ?? '__chat__';
    const raw = localStorage.getItem('file-tabs');
    if (!raw) { restoreActiveTabWith(intendedTarget); return; }
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) { restoreActiveTabWith(intendedTarget); return; }
    window.__state._fileTabs = [];
    let loaded = 0;
    const total = saved.length;
    for (const st of saved) {
      const ws = ExplorerService.getWorkspacePath();
      if (ws) {
        fetch(`/api/file/read?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(st.id)}`)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d) return;
            const content = d.encoding === 'base64' ? '[二进制文件，无法预览]' : d.content;
            openFileTab(st.id, content, st.lang || '');
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
    if (total === 0) restoreActiveTabWith(intendedTarget);
  } catch {}
}

function restoreActiveTabWith(target: string): void {
  try {
    if (target === '__chat__' || !target) switchTab(null);
    else {
      const exists = window.__state._fileTabs.some(t => t.id === target);
      if (exists) switchTab(target);
      else switchTab(null);
    }
  } catch { switchTab(null); }
}

// 页面加载完成后恢复标签页 + 面板宽度
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(restoreFileTabs, 500);
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

// ─── App 命名空间绑定 ──────────────────────────────────────
{ const U = (window as any).App?.UI; if (U) {
  U.layout = layout;
  U.renderTabs = renderTabs;
} }
