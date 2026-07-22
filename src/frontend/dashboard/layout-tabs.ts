// Tab 标签页管理 — 切换/打开/关闭/拖拽排序/右键菜单
// 从 dashboard-layout.ts 拆出

const FILE_TABS_KEY = 'file-tabs';
const LAST_ACTIVE_KEY = 'last-active-tab';

function _syncTabsToStore(): void {
  // TabStore._syncToState 已处理 items/activeId → UiStateStore
  // last-active-tab 仅当活跃 tab 是 file 时写入，切到 session/chat/null 时清除
  const ts = (window as any).__tabs;
  const activeFileId = ts?.getActiveFileTabId?.();
  try {
    if (activeFileId) localStorage.setItem('last-active-tab', activeFileId);
    else localStorage.removeItem('last-active-tab');
  } catch {}
  if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

/** App.Tabs.activate 的降级入口 */
function switchTab(fileId: string | null): void {
  if (fileId === null) {
    const tabs = (window as any).__tabs; if (tabs) tabs.activateTab(null);
    renderTabs(); _syncTabsToStore();
    return;
  }
  // 优先走 handler
  const ts = (window as any).__tabs;
  const tab = ts?.getTab?.(fileId);
  if (tab?.kind === 'file') {
    const handler = ts?.getTabBehavior?.('file');
    if (handler?.activate) { handler.activate(tab); return; }
  }
  // 降级：从 TabStore 读 content
  if (ts) ts.activateTab(fileId);
  const ft = ts?.getTab?.(fileId);
  const editorEl = $('fc-editor');
  if (editorEl) {
    const m = (window as any).__monaco;
    if (m && ft) {
      if (!editorEl.dataset.monacoReady) { editorEl.innerHTML = ''; m.create(editorEl); editorEl.dataset.monacoReady = '1'; }
      m.setValue(ft.content || ''); m.setLang(ft.id);
    }
  }
  renderTabs(); _syncTabsToStore();
}

function _saveFileTabs(): void {
  _syncTabsToStore();
}

function openFileTab(id: string, content: string, lang?: string, renderer?: 'text' | 'image' | 'video'): void {
  const label = id.split('/').pop() || id;
  const tabs = (window as any).__tabs;
  // 写入 TabStore（含 content/lang 缓存）
  if (tabs) {
    const existing = tabs.getTab(id);
    if (existing) tabs.replaceTab(id, { content, lang: lang || '', renderer });
    else tabs.openTab({ kind: 'file', id, title: label, path: id, content, lang: lang || '', renderer });
  }
  _saveFileTabs();
  (window as any).App?.Tabs?.activate(id);
}

/** App.Tabs.close 的降级入口 */
function closeFileTab(id: string): void {
  const ts = (window as any).__tabs;
  const tab = ts?.getTab?.(id);
  if (tab?.kind === 'file') {
    const handler = ts?.getTabBehavior?.('file');
    if (handler?.close) { handler.close(tab); return; }
  }
  // 降级（_fileTabs 已投影自 TabStore，只需关 TabStore + Monaco）
  const monaco = (window as any).__monaco; if (monaco?.tsCloseFile) monaco.tsCloseFile(id);
  if (ts) ts.closeTab(id);
  if (typeof _saveFileTabs === 'function') _saveFileTabs();
  if (typeof renderTabs === 'function') renderTabs();
}

// ─── 标签栏拖拽排序 ────────────────────────────

/** 通用拖拽排序：container 是标签容器，scrollSelector 是滚动区域选择器，
 *  getTabs 返回当前标签数组，setTabs 写入新顺序，render 触发布局重绘 */
function setupDragReorder(
  container: HTMLElement,
  scrollSelector: string,
  getTabs: () => unknown[],
  setTabs: (tabs: unknown[]) => void,
  render: () => void,
): void {
  const scroll = container.querySelector(scrollSelector) as HTMLElement | null;
  if (!scroll) return;
  let dragIdx = -1;
  function clearIndicators() { scroll.querySelectorAll('.tb-drop').forEach(e => e.classList.remove('tb-drop')); }
  scroll.addEventListener('dragstart', (e: DragEvent) => {
    const el = e.target instanceof Element ? e.target : (e.target as Node).parentElement;
    const item = (el as HTMLElement)?.closest?.('.tb-item') as HTMLElement | null;
    if (!item) return; dragIdx = parseInt(item.dataset.tabIndex || '-1');
    e.dataTransfer?.setData('text/tab-index', String(dragIdx));
    e.dataTransfer!.effectAllowed = 'move';
    item.style.opacity = '0.3';
  });
  scroll.addEventListener('dragend', () => { clearIndicators(); scroll.querySelectorAll('.tb-item').forEach(el => (el as HTMLElement).style.opacity = ''); dragIdx = -1; });
  scroll.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault(); clearIndicators();
    const items = scroll.querySelectorAll('.tb-item');
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      const midX = r.left + r.width / 2;
      if (e.clientX < midX) { items[i].classList.add('tb-drop'); return; }
    }
    items[items.length - 1]?.classList.add('tb-drop');
  });
  scroll.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault(); clearIndicators();
    const srcIdx = parseInt(e.dataTransfer?.getData('text/tab-index') || '-1');
    if (srcIdx < 0) return;
    const items = scroll.querySelectorAll('.tb-item');
    let dstIdx = items.length - 1;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { dstIdx = i; break; }
    }
    const tabs = getTabs();
    if (srcIdx === dstIdx || srcIdx >= tabs.length) return;
    const moved = tabs[srcIdx];
    const newTabs = tabs.filter((_, i) => i !== srcIdx);
    newTabs.splice(dstIdx > srcIdx ? dstIdx - 1 : dstIdx, 0, moved);
    setTabs(newTabs);
    render();
  });
}

function setupTabDrag(el: HTMLElement): void {
  setupDragReorder(
    el, '.tb-scroll',
    () => {
      // 使用 TabStore 获取当前全部 tabs 列表
      const tabs = (window as any).__tabs;
      return tabs?.getTabs?.() ?? [];
    },
    (tabs) => {
      // 按拖拽后的顺序重排 TabStore
      const ts = (window as any).__tabs;
      if (!ts) return;
      const items = tabs as any[];
      // 逐一比对顺序，调用 moveTab
      for (let i = 0; i < items.length; i++) {
        const cur = ts.getTabs()[i];
        if (cur?.id !== items[i]?.id) {
          const fromIdx = ts.getTabs().findIndex((t: any) => t.id === items[i]?.id);
          if (fromIdx >= 0) ts.moveTab(fromIdx, i);
        }
      }
    },
    () => renderTabs(),
  );
}

// ─── 标签栏右键菜单 ────────────────────────────────
function tabContextMenu(e: MouseEvent, id: string): void {
  e.preventDefault();
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
  const tabs = (window as any).__state._fileTabs;
  const idx = tabs.findIndex((t: any) => t.id === id);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  placeContextMenu(menu, e.clientX, e.clientY);
  const T = (window as any).App?.Tabs;
  const items: { label: string; action: () => void }[] = [
    { label: '关闭', action: () => T?.close(id) },
    { label: '关闭其他', action: () => { for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].id !== id) T?.close(tabs[i].id); } },
    { label: '关闭右侧', action: () => { for (let i = tabs.length - 1; i > idx; i--) T?.close(tabs[i].id); } },
    { label: '关闭所有', action: () => { for (let i = tabs.length - 1; i >= 0; i--) T?.close(tabs[i].id); } },
    { label: '-', action: () => {} },
    { label: '复制路径', action: () => { navigator.clipboard.writeText(id).then(() => toast('已复制路径')).catch(() => toast('复制失败', 'error')); } },
  ];
  for (const a of items) {
    if (a.label === '-') { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const item = document.createElement('div');
    item.className = 'ctx-item'; item.textContent = a.label;
    item.onclick = () => { menu.remove(); a.action(); };
    menu.appendChild(item);
  }
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function tabMoreMenu(e: MouseEvent): void {
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
  const ts = (window as any).__tabs;
  const allTabs: AppTab[] = ts?.getTabs?.() ?? [];
  const maxH = Math.min(allTabs.length * 28 + 70, 450);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  placeContextMenu(menu, e.clientX, e.clientY + 4, { maxHeight: maxH });

  const T = (window as any).App?.Tabs;
  const actions: { label: string; fn: () => void }[] = [
    { label: '关闭全部标签页', fn: () => { for (let i = allTabs.length - 1; i >= 0; i--) T?.close(allTabs[i].id); } },
  ];
  for (const a of actions) {
    const item = document.createElement('div'); item.className = 'ctx-item'; item.textContent = a.label;
    item.onclick = () => { menu.remove(); a.fn(); }; menu.appendChild(item);
  }
  if (allTabs.length > 0) {
    const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep);
    const activeTab = ts?.getActiveTab?.();
    const activeId = activeTab?.id ?? null;
    for (const tab of allTabs) {
      const item = document.createElement('div'); item.className = 'ctx-tab-item';
      const isActive = tab.id === activeId;
      if (isActive) item.style.color = 'var(--am)';
      const icon = tab.kind === 'file'
        ? ExplorerService.iconFor(tab.title, false)
        : S('ic', 14);
      item.innerHTML = `<span class="ctx-tab-icon">${icon}</span><span class="ctx-tab-label">${E(tab.title)}</span><span class="ctx-tab-close">✕</span>`;
      item.querySelector('.ctx-tab-close')!.addEventListener('click', (ce) => { ce.stopPropagation(); menu.remove(); T?.close(tab.id); });
      item.addEventListener('click', () => { menu.remove(); T?.activate(tab.id); });
      menu.appendChild(item);
    }
  }
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ─── window 别名（函数声明自动暴露到 window，显式赋值只保留公共 API）───
(window as any).openFileTab = openFileTab;
(window as any).tabContextMenu = tabContextMenu;
(window as any).tabMoreMenu = tabMoreMenu;

// ─── File handler ────────────────────────────
function _fileActivate(tab: AppTab): void {
  const ts = (window as any).__tabs;
  if (ts) ts.activateTab(tab.id);
  const editorEl = $('fc-editor');
  if (!editorEl) return;
  const m = (window as any).__monaco;

  // 图片/视频 — 销毁 Monaco，显示媒体元素
  if (tab.renderer === 'image' || tab.renderer === 'video') {
    if (m && editorEl.dataset.monacoReady) { m.dispose(); editorEl.dataset.monacoReady = ''; }
    const ws = ExplorerService.getWorkspacePath();
    const url = `/api/file/raw?root=${encodeURIComponent(ws)}&path=${encodeURIComponent(tab.id)}`;
    if (tab.renderer === 'image') {
      editorEl.innerHTML = `<div class="fc-media"><img src="${E(url)}" alt="${E(tab.title)}"></div>`;
    } else {
      editorEl.innerHTML = `<div class="fc-media"><video src="${E(url)}" controls autoplay></video></div>`;
    }
    renderTabs();
    _syncTabsToStore();
    return;
  }

  // 文本 — Monaco 编辑器
  if (m) {
    if (!editorEl.dataset.monacoReady) {
      editorEl.innerHTML = '';
      m.create(editorEl);
      editorEl.dataset.monacoReady = '1';
    }
    m.setValue(tab.content || '');
    m.setLang(tab.id);
  }
  renderTabs();
  _syncTabsToStore();
}

function _fileClose(tab: AppTab): void {
  const monaco = (window as any).__monaco;
  if (monaco?.tsCloseFile) monaco.tsCloseFile(tab.id);
  // TabStore 处理移除 + 自动切换 activeId（_fileTabs 已投影自 TabStore，无需手动 splice）
  const ts = (window as any).__tabs;
  if (ts) ts.closeTab(tab.id);
  _syncTabsToStore();
  renderTabs();
}

// ─── TabBehavior 注册 ──────────────────────────────
{ const tabs = (window as any).__tabs;
  if (tabs?.registerTabBehavior) {
    tabs.registerTabBehavior('file', {
      activate(tab: AppTab) { _fileActivate(tab); },
      close(tab: AppTab) { _fileClose(tab); },
      contextMenu(e: MouseEvent, tab: AppTab) { tabContextMenu(e, tab.id); },
    });
  }
}

// ─── App 绑定 ──────────────────────────────────────
{ const U = (window as any).App?.UI; if (U) {
  U.openFileTab = openFileTab;
} }
