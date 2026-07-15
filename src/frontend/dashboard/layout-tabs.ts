// Tab 标签页管理 — 切换/打开/关闭/拖拽排序/右键菜单
// 从 dashboard-layout.ts 拆出

const FILE_TABS_KEY = 'file-tabs';
const LAST_ACTIVE_KEY = 'last-active-tab';

function switchTab(fileId: string | null): void {
  (window as any).__state._activeFileTab = fileId;
  const ms = $('ms');
  const fc = $('file-content');
  const fi = $('fi');
  const mc = document.querySelector('.mc');
  if (fileId === null) {
    if (ms) ms.style.display = '';
    if (fc) fc.style.display = 'none';
    if (fi) fi.style.display = '';
    mc?.classList.remove('editing');
  } else {
    if (ms) ms.style.display = 'none';
    if (fc) fc.style.display = '';
    if (fi) fi.style.display = 'none';
    mc?.classList.add('editing');
    const tab = (window as any).__state._fileTabs.find((t: any) => t.id === fileId);
    const editorEl = $('fc-editor');
    if (editorEl && tab) {
      const m = (window as any).__monaco;
      if (m) {
        if (!editorEl.dataset.monacoReady) {
          editorEl.innerHTML = '';
          m.create(editorEl);
          editorEl.dataset.monacoReady = '1';
        }
        m.setValue(tab.content);
        m.setLang(tab.id);
      }
    }
  }
  renderTabs();
  try { localStorage.setItem(LAST_ACTIVE_KEY, fileId ?? '__chat__'); } catch {}
}

function _saveFileTabs(): void {
  try {
    localStorage.setItem(FILE_TABS_KEY, JSON.stringify(
      (window as any).__state._fileTabs.map((t: any) => ({ id: t.id, label: t.label, lang: t.lang }))
    ));
  } catch {}
}

function openFileTab(id: string, content: string, lang?: string): void {
  const label = id.split('/').pop() || id;
  const existing = (window as any).__state._fileTabs.findIndex((t: any) => t.id === id);
  if (existing !== -1) {
    (window as any).__state._fileTabs[existing].content = content;
    (window as any).__state._fileTabs[existing].lang = lang || '';
  } else {
    (window as any).__state._fileTabs.push({ id, label, content, lang: lang || '' });
  }
  _saveFileTabs();
  switchTab(id);
}

function closeFileTab(id: string): void {
  const idx = (window as any).__state._fileTabs.findIndex((t: any) => t.id === id);
  if (idx === -1) return;
  const monaco = (window as any).__monaco;
  if (monaco?.tsCloseFile) monaco.tsCloseFile(id);
  (window as any).__state._fileTabs.splice(idx, 1);
  _saveFileTabs();
  if ((window as any).__state._activeFileTab === id) {
    const tabs = (window as any).__state._fileTabs;
    switchTab(tabs.length > 0 ? tabs[Math.min(idx, tabs.length - 1)].id : null);
  } else {
    renderTabs();
  }
}

// ─── 标签栏拖拽排序 ────────────────────────────
function setupTabDrag(el: HTMLElement): void {
  const scroll = el.querySelector('.tb-scroll') as HTMLElement | null;
  if (!scroll) return;
  let dragIdx = -1;
  function clearIndicators() { scroll.querySelectorAll('.tb-drop').forEach(e => e.classList.remove('tb-drop')); }
  scroll.addEventListener('dragstart', (e: DragEvent) => {
    const item = (e.target as HTMLElement).closest('.tb-item') as HTMLElement | null;
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
    const tabs = (window as any).__state._fileTabs;
    if (srcIdx === dstIdx) return;
    const [moved] = tabs.splice(srcIdx, 1);
    tabs.splice(dstIdx > srcIdx ? dstIdx - 1 : dstIdx, 0, moved);
    renderTabs();
  });
}

// ─── 标签栏右键菜单 ────────────────────────────────
function tabContextMenu(e: MouseEvent, id: string): void {
  e.preventDefault();
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
  const tabs = (window as any).__state._fileTabs;
  const idx = tabs.findIndex((t: any) => t.id === id);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  const items: { label: string; action: () => void }[] = [
    { label: '关闭', action: () => closeFileTab(id) },
    { label: '关闭其他', action: () => { for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i].id !== id) closeFileTab(tabs[i].id); } },
    { label: '关闭右侧', action: () => { for (let i = tabs.length - 1; i > idx; i--) closeFileTab(tabs[i].id); } },
    { label: '关闭所有', action: () => { for (let i = tabs.length - 1; i >= 0; i--) closeFileTab(tabs[i].id); } },
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
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

function tabMoreMenu(e: MouseEvent): void {
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
  const tabs = (window as any).__state._fileTabs;
  const maxH = Math.min(tabs.length * 28 + 70, 450);
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  let x = e.clientX, y = e.clientY + 4;
  const mw = 200;
  if (x + mw > window.innerWidth) x = window.innerWidth - mw - 8;
  if (y + maxH > window.innerHeight) y = window.innerHeight - maxH - 4;
  menu.style.left = x + 'px'; menu.style.top = y + 'px'; menu.style.maxHeight = maxH + 'px'; menu.style.overflowY = 'auto';

  const actions: { label: string; fn: () => void }[] = [
    { label: '关闭全部标签页', fn: () => { for (let i = tabs.length - 1; i >= 0; i--) closeFileTab(tabs[i].id); } },
    { label: '关闭已保存标签页', fn: () => { for (let i = tabs.length - 1; i >= 0; i--) closeFileTab(tabs[i].id); } },
  ];
  for (const a of actions) {
    const item = document.createElement('div'); item.className = 'ctx-item'; item.textContent = a.label;
    item.onclick = () => { menu.remove(); a.fn(); }; menu.appendChild(item);
  }
  if (tabs.length > 0) {
    const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep);
    for (const ft of tabs) {
      const item = document.createElement('div'); item.className = 'ctx-tab-item';
      const active = ft.id === (window as any).__state._activeFileTab;
      if (active) item.style.color = 'var(--am)';
      item.innerHTML = `<span class="ctx-tab-icon">${ExplorerService.iconFor(ft.label, false)}</span><span class="ctx-tab-label">${E(ft.label)}</span><span class="ctx-tab-close">✕</span>`;
      item.querySelector('.ctx-tab-close')!.addEventListener('click', (ce) => { ce.stopPropagation(); menu.remove(); closeFileTab(ft.id); });
      item.addEventListener('click', () => { menu.remove(); switchTab(ft.id); });
      menu.appendChild(item);
    }
  }
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ─── window 别名 ──────────────────────────────────
(window as any).switchTab = switchTab;
(window as any).openFileTab = openFileTab;
(window as any).closeFileTab = closeFileTab;
(window as any).tabContextMenu = tabContextMenu;
(window as any).tabMoreMenu = tabMoreMenu;

// ─── App 绑定 ──────────────────────────────────────
{ const U = (window as any).App?.UI; if (U) {
  U.switchTab = switchTab;
  U.openFileTab = openFileTab;
  U.closeFileTab = closeFileTab;
} }
