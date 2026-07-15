// 面板管理 — 切换/缩放/状态渲染
// 从 dashboard-layout.ts 拆出

function _panelWidth(): number {
  const store = (window as any).__state?._uiStateStore;
  if (store?.panel?.width && store.panel.width > 50) return store.panel.width;
  try { return parseInt(localStorage.getItem('panel-width') || '', 10); } catch { return 0; }
}

function _syncPanelToStore(): void {
  const store = (window as any).__state?._uiStateStore;
  if (!store) return;
  const si = document.getElementById('si');
  store.panel.active = (window as any).__state?._activePanel || 'explorer';
  store.panel.closed = si?.classList.contains('closed') ?? false;
  // 只在面板打开时保存宽度（关闭时不覆盖，保留上一次打开的值）
  if (si && !si.classList.contains('closed') && si.offsetWidth > 50) {
    store.panel.width = si.offsetWidth;
  }
  if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

function togglePanel(name: string): void {
  const si = $('si'), pc = $('pc');
  if (!si || !pc) return;
  if ((window as any).__state._activePanel === name && !si.classList.contains('closed')) {
    si.classList.add('closed');
    si.style.width = '';
    document.querySelectorAll('.sbar .b[data-side]').forEach(b => (b as HTMLElement).classList.remove('on'));
    _syncPanelToStore();
    return;
  }
  (window as any).__state._activePanel = name;
  si.classList.remove('closed');
  const savedWidth = _panelWidth();
  si.style.width = (savedWidth > 50 ? savedWidth : 260) + 'px';
  document.querySelectorAll('.sbar .b[data-side]').forEach(b => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.side === name));
  renderPanel(name, pc);
  _syncPanelToStore();
}

/** 启动时恢复左侧面板（由 restoreSessionTabs 调用） */
function restorePanel(name: string): void {
  const pc = $('pc');
  if (!pc) return;
  const si = $('si');
  if (!si) return;

  // 从 store 读取面板状态（包含 closed/width）
  const store = (window as any).__state?._uiStateStore;
  const isClosed = store?.panel?.closed === true;
  const savedWidth = store?.panel?.width && store.panel.width > 50 ? store.panel.width : _panelWidth();

  (window as any).__state._activePanel = name;
  if (isClosed) {
    si.classList.add('closed');
    si.style.width = '';
  } else {
    si.classList.remove('closed');
    si.style.width = savedWidth + 'px';
  }
  document.querySelectorAll('.sbar .b[data-side]').forEach(b => (b as HTMLElement).classList.toggle('on', (b as HTMLElement).dataset.side === name));
  if (!isClosed) renderPanel(name, pc);
  _syncPanelToStore();
}

function initResizeHandle(): void {
  const handle = $('si-handle'), si = $('si');
  if (!handle || !si) return;
  handle.onmousedown = function (e: MouseEvent) {
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
  };
}

function renderPanel(name: string, pc?: HTMLElement | null): void {
  if (!pc) pc = $('pc');
  if (!pc) return;
  const paneFn = getPane(name);
  if (paneFn) { paneFn(pc); return; }
  pc.innerHTML = `<div class="sg-item dim">面板 "${E(name)}" 未注册</div>`;
}

function sinfoHTML(): string {
  const stD = (window as any).__state.D;
  if (!stD) return '<div class="sg" style="padding:12px;font-size:.7rem;color:var(--tm)">加载中...</div>';
  const ts = (stD.tools || ['read','write','edit','bash']).slice(0, 18);
  const act = (stD.activeTools || stD.tools || []).length;
  return `<div class="sg"><div class="sg-t">模型</div>
    <div class="sg-r" data-model="provider"><span class="l">提供商</span><span class="v">${E(stD.modelProvider||'N/A')}</span></div>
    <div class="sg-r" data-model="id"><span class="l">模型</span><span class="v" title="${E(stD.modelId||'')}">${E((stD.modelId||'').split('/').pop()||'N/A')}</span></div>
    <div class="sg-r"><span class="l">上下文</span><span class="v">${E(stD.modelContextWindow||'N/A')}</span></div>
    <div class="sg-r"><span class="l">输出上限</span><span class="v">${E(stD.modelMaxTokens||'N/A')}</span></div>
    <div class="sg-r"><span class="l">思考</span><span class="v p">${E(stD.thinkingLevel||'off')}</span></div></div>
    <div class="sg"><div class="sg-t">会话</div>
    <div class="sg-r"><span class="l">运行</span><span class="v">${F(stD.runtime||0)}</span></div>
    <div class="sg-r"><span class="l">消息</span><span class="v">${stD.messagesCount||0}</span></div>
    <div class="sg-r"><span class="l">状态</span><span class="v p">${stD.isIdle===false?'响应中':'空闲'}</span></div></div>
    <div class="sg"><div class="sg-t">工具 (${act})</div>
    ${ts.map((t: string)=>'<span class="sg-tag">'+E(t)+'</span>').join('')}${ts.length<act?'<span class="sg-tag" style="opacity:.5">+'
    +(act-ts.length)+'</span>':''}</div>
    <div class="sg"><div class="sg-t">存储</div><div class="sg-p">${E(stD.dataDir||'data/')}</div></div>`;
}

function refreshSinfo(): void {
  const si = $('si');
  if (si) si.innerHTML = sinfoHTML();
  const modelEls = si?.querySelectorAll('.sg-r[data-model]');
  if (modelEls) modelEls.forEach(el => { (el as HTMLElement).style.cursor = 'pointer'; (el as HTMLElement).onclick = (window as any).showModelPicker as any; });
}

// ─── window 别名 ──────────────────────────────────
window.togglePanel = togglePanel;
window.renderPanel = renderPanel;
window.sinfoHTML = sinfoHTML;
(window as any).refreshSinfo = refreshSinfo;

// ─── App 绑定 ──────────────────────────────────────
{ const U = (window as any).App?.UI; if (U) {
  U.togglePanel = togglePanel;
  U.renderPanel = renderPanel;
  U.sinfoHTML = sinfoHTML;
  U.refreshSinfo = refreshSinfo;
  U.restorePanel = restorePanel;
} }
