// Tab 标签页管理 — 切换/打开/关闭/拖拽排序/右键菜单
// 从 dashboard-layout.ts 拆出

let _monacoLoadPromise: Promise<void> | null = null;

async function loadMonaco(): Promise<void> {
  if ((window as any).__monaco) return;
  mark("monaco-import-start");
  if (!_monacoLoadPromise) {
    _monacoLoadPromise = import("../editor/monaco-setup").then(() => {
      mark("monaco-import-end");
      return undefined;
    }).catch((err) => {
      _monacoLoadPromise = null;
      throw err;
    });
  } else {
    // 已经在加载中，但还没标记结束 → 等 promise 结束时标记
    _monacoLoadPromise.then(() => mark("monaco-import-end"));
  }
  await _monacoLoadPromise;
}

function _syncTabsToStore(): void {
  // TabStore._syncToState 已处理 items/activeId → UiStateStore
  if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

/** App.Tabs.activate 的降级入口 */
function switchTab(fileId: string | null): void {
  if (fileId === null) {
    const tabs = App.Tabs; if (tabs) tabs.activateTab(null);
    renderTabs(); _syncTabsToStore();
    return;
  }
  // 优先走 handler
  const ts = App.Tabs;
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
  const tabs = App.Tabs;
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
  const ts = App.Tabs;
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
      const tabs = App.Tabs;
      return tabs?.getTabs?.() ?? [];
    },
    (tabs) => {
      // 按拖拽后的顺序重排 TabStore
      const ts = App.Tabs;
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
  const tabs = App.Tabs.getTabs().filter(tab => tab.kind === 'file');
  const idx = tabs.findIndex(tab => tab.id === id);
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
    item.addEventListener('click', () => { menu.remove(); a.action(); });
    menu.appendChild(item);
  }
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function tabMoreMenu(e: MouseEvent): void {
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
  const ts = App.Tabs;
  const allTabs: AppTab[] = ts?.getTabs?.() ?? [];
  const maxH = Math.min(allTabs.length * 28 + 70, 450);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu ctx-tabs-menu';
  placeContextMenu(menu, e.clientX, e.clientY + 4, { maxHeight: maxH });

  const T = (window as any).App?.Tabs;
  const actions: { label: string; fn: () => void }[] = [
    { label: '关闭全部标签页', fn: () => { for (let i = allTabs.length - 1; i >= 0; i--) T?.close(allTabs[i].id); } },
  ];
  for (const a of actions) {
    const item = document.createElement('div'); item.className = 'ctx-item'; item.textContent = a.label;
    item.addEventListener('click', () => { menu.remove(); a.fn(); }); menu.appendChild(item);
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
      const title = tab.kind !== 'file'
        ? ((window as any).sessionTabLabel?.(tab.id) || tab.title)
        : tab.title;
      item.innerHTML = `<span class="ctx-tab-icon">${icon}</span><span class="ctx-tab-label">${E(title)}</span><span class="ctx-tab-close">✕</span>`;
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
async function _fileActivate(tab: AppTab): Promise<void> {
  mark("file-activate-start");
  // 激活任意标签都让在途的会话请求过期——统一竞态防护：点文件应取消挂起的会话加载
  if (typeof (window as any).invalidateSessionActivation === 'function') (window as any).invalidateSessionActivation();
  const ts = App.Tabs;
  if (ts) ts.activateTab(tab.id);
  // 先渲染标签栏（不依赖 Monaco）——Monaco 慢加载/加载失败也不能阻塞标签切换与显示。
  // 否则首次点击文件时标签栏空白，直到 Monaco 就绪才出现（体验断档）。
  if (typeof (window as any).renderTabs === 'function') (window as any).renderTabs();
  const editorEl = $('fc-editor');
  if (!editorEl) return;

  // 图片/视频 — 销毁 Monaco，显示媒体元素
  if (tab.renderer === 'image' || tab.renderer === 'video') {
    const m = (window as any).__monaco;
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

  // 文本 — Monaco 编辑器（懒加载）
  const fc = $('file-content');
  if (fc) fc.style.display = '';
  mark("monaco-load-start");
  if (!(window as any).__monaco) {
    await loadMonaco()
  }
  mark("monaco-load-end");
  const m = (window as any).__monaco;
  if (m) {
    mark("editor-create-start");
    if (!editorEl.dataset.monacoReady) {
      editorEl.innerHTML = '';
      m.create(editorEl);
      editorEl.dataset.monacoReady = '1';
    }
    mark("editor-create-end");
    m.setValue(tab.content || '');
    m.setLang(tab.id);
  }
  mark("file-activate-end");
  renderTabs();
  _syncTabsToStore();
  // 打印性能摘要
  logTiming();
  try {
    performance.measure("file-activate-total", "file-activate-start", "file-activate-end");
    performance.measure("monaco-load", "monaco-load-start", "monaco-load-end");
    performance.measure("editor-create", "editor-create-start", "editor-create-end");
    console.log("[perf] 文件打开耗时分解:");
    ["file-activate-total", "monaco-load", "editor-create"].forEach(name => {
      const m = performance.getEntriesByName(name, "measure")[0];
      if (m) console.log(`  ${name}: ${m.duration.toFixed(0)}ms`);
    });
    performance.clearMeasures("file-activate-total", "monaco-load", "editor-create");
  } catch {}
}

function _fileClose(tab: AppTab): void {
  const monaco = (window as any).__monaco;
  if (monaco?.tsCloseFile) monaco.tsCloseFile(tab.id);
  // 清理 ProblemsStore 中此文件的问题，避免残留
  const pstore = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
  if (pstore) pstore.clearFile(tab.id);
  // TabStore 处理移除 + 自动切换 activeId（_fileTabs 已投影自 TabStore，无需手动 splice）
  const ts = App.Tabs;
  if (!ts) return;
  const wasActive = ts.getActiveTab?.()?.id === tab.id;
  ts.closeTab(tab.id);
  _syncTabsToStore();
  renderTabs();
  // 关闭的是当前激活标签时，自动激活下一个标签并加载其内容。
  // closeTab 只改 activeId，不会加载编辑器内容——需再次走 activate handler
  // （文件→加载 Monaco 内容 / 会话→加载消息），否则主区停在已关闭标签的内容上。
  if (wasActive) {
    const next = ts.getActiveTab?.();
    if (next) {
      const handler = ts.getTabBehavior?.(next.kind);
      if (handler?.activate) handler.activate(next);
    }
  }
}

// ─── TabBehavior 注册 ──────────────────────────────
{ const tabs = App.Tabs;
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
