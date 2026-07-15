// Explorer pane — 文件资源管理器面板（仅 DOM 渲染 + Tree 绑定）
/// <reference path="../../dashboard.d.ts" />

function explorerRender(container: HTMLElement): void {
  const ws = ExplorerService.getWorkspacePath();
  if (!ws) {
    container.innerHTML = [
      `<div class="sg-t">资源管理器</div>`,
      `<div style="padding:12px;font-size:.72rem;color:var(--tm);text-align:center">`,
      `  <p style="margin-bottom:10px">尚未选择工作区</p>`,
      `  <button class="sa-btn" onclick="ExplorerService.applyWorkspace()">选择文件夹</button>`,
      `</div>`,
    ].join('');
    return;
  }

  container.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0';
  const showAll = !ExplorerService.getFilterEnabled();
  container.innerHTML = [
    `<div class="sg-t" style="display:flex;align-items:center;justify-content:space-between">资源管理器<button class="sg-more" onclick="toggleExplorerFilter()" title="显示选项">···</button></div>`,
    `<div id="exp-tree-cont" style="flex:1;min-height:0"></div>`,
  ].join('');

  // 阻止浏览器的默认右键菜单
  container.addEventListener('contextmenu', e => e.preventDefault());

  const treeContainer = document.getElementById('exp-tree-cont');
  if (!treeContainer) return;
  initTree(treeContainer);
}

function getTree(): Tree { return (ExplorerService as any)._getTree(); }
function ws(): string { return ExplorerService.getWorkspacePath(); }

async function doNewFile(parentId: string, name: string): Promise<void> {
  try {
    const relPath = parentId ? parentId + '/' + name : name;
    await ExplorerService.fileOp('new', ws(), relPath);
    ExplorerService.refreshTree();
    toast('已创建: ' + name, 'success');
  } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); toast('创建失败: ' + msg, 'error'); }
}
async function doNewFolder(parentId: string, name: string): Promise<void> {
  try {
    const relPath = (parentId ? parentId + '/' : '') + name + '/';
    await ExplorerService.fileOp('new', ws(), relPath);
    ExplorerService.refreshTree();
    toast('已创建: ' + name, 'success');
  } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); toast('创建失败: ' + msg, 'error'); }
}

function initTree(container: HTMLElement): void {
  const tree = new Tree(container, { indent: 14 });
  (ExplorerService as any)._setTree(tree);

  tree.onExpand = async (node, cb) => {
    try {
      const d = await ExplorerService.fetchDir(ws(), node.id);
      cb(ExplorerService.toTreeNodes(d.items));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Access denied') || msg.includes('403')) toast('无权限访问: ' + node.id, 'error');
      else if (msg.includes('not found') || msg.includes('404')) toast('路径不存在: ' + node.id, 'error');
      else if (msg.includes('timeout') || msg.includes('TIMEOUT')) toast('加载超时: ' + node.id, 'error');
      else toast('加载失败: ' + msg, 'error');
      cb([]);
    }
  };

  // 右键菜单：选中行
  tree.contextMenu = [
    {
      label: '复制路径',
      action: (n) => { navigator.clipboard.writeText(n.id).then(() => toast('已复制路径')).catch(() => toast('复制失败', 'error')); },
    },
    {
      label: '打开所在位置',
      action: async (n) => {
        const api = (window as any).electronAPI as ElectronAPI | undefined;
        if (!api?.showItemInFolder) { toast('仅在桌面版可用', 'error'); return; }
        try {
          await api.showItemInFolder(ws().replace(/\\/g, '/') + '/' + n.id);
        } catch { toast('打开失败', 'error'); }
      },
    },
    { label: '-', action: () => {} }, // separator
    {
      label: '新建文件',
      action: (n) => { if (n.isDir) tree.inlineCreate(n.id, false, (name) => doNewFile(n.id, name)); },
      disabled: (n) => !n.isDir,
    },
    {
      label: '新建文件夹',
      action: (n) => { if (n.isDir) tree.inlineCreate(n.id, true, (name) => doNewFolder(n.id, name)); },
      disabled: (n) => !n.isDir,
    },
    {
      label: '重命名',
      action: (n) => {
        const parent = n.id.includes('/') ? n.id.slice(0, n.id.lastIndexOf('/')) : '';
        tree.inlineRename(n.id, async (newName) => {
          try {
            await ExplorerService.fileOp('rename', ws(), n.id, parent ? parent + '/' + newName : newName);
            ExplorerService.refreshTree();
            toast('已重命名', 'success');
          } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); toast('重命名失败: ' + msg, 'error'); }
        });
      },
    },
    {
      label: '删除',
      action: async (n) => {
        const api = (window as any).electronAPI as ElectronAPI | undefined;
        try {
          if (api?.trashItem) {
            await api.trashItem(ws() + '\\' + n.id);
          } else {
            await ExplorerService.fileOp('delete', ws(), n.id);
          }
          ExplorerService.refreshTree();
          toast('已删除', 'success');
        } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); toast('删除失败: ' + msg, 'error'); }
      },
    },
  ];

  // 空白区域右键
  tree.blankContextMenu = [
    { label: '新建文件', action: () => tree.inlineCreate('', false, (name) => doNewFile('', name)) },
    { label: '新建文件夹', action: () => tree.inlineCreate('', true, (name) => doNewFolder('', name)) },
  ];

  // 拖放：树内移动
  tree.onDragMove = async (srcId, dstId) => {
    const name = srcId.split('/').pop() || '';
    const newPath = dstId ? dstId + '/' + name : name;
    try {
      await ExplorerService.fileOp('move' as any, ws(), srcId, newPath);
      const tr = (ExplorerService as any)._getTree() as any;
      if (tr) {
        const srcParent = srcId.includes('/') ? srcId.slice(0, srcId.lastIndexOf('/')) : '';
        const dstParent = dstId || '';
        if (srcParent) tr._childCache?.delete(srcParent);
        if (dstParent && dstParent !== srcParent) tr._childCache?.delete(dstParent);
        // 刷新根目录
        const d = await ExplorerService.fetchDir(ws(), '');
        const rootItems = ExplorerService.toTreeNodes(d.items);
        tr.setData(rootItems);
        (ExplorerService as any)._lastRefreshKey = JSON.stringify(rootItems.map(item => `${item.isDir ? 'd' : 'f'}:${item.id}:${item.label}`));
        // 展开受影响的两个目录
        for (const pid of [srcParent, dstParent].filter(Boolean)) {
          tr._expanded?.add(pid);
          tr._onExpand?.(tr._findNodeById(pid), (children) => {
            tr._childCache?.set(pid, children || []);
            if (tr._expanded?.has(pid)) tr.render();
          });
        }
      }
      toast('已移动', 'success');
    } catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); toast('移动失败: ' + msg, 'error'); }
  };

  tree.onSelect = async (node) => {
    console.log("[explorer] onSelect:", node.id, node.isDir);
    if (!ws()) { console.log("[explorer] no workspace"); return; }
    try {
      const r = await fetch(`/api/file/read?root=${encodeURIComponent(ws())}&path=${encodeURIComponent(node.id)}`);
      const d = await r.json();
      if (!r.ok) { toast(d.error || '读取失败', 'error'); return; }
      const content = d.encoding === 'base64' ? '[二进制文件，无法预览]' : d.content;
      const lang = d.path?.split('.').pop() || '';
      console.log("[explorer] calling openFileTab:", node.id);
      openFileTab(node.id, content, lang);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[explorer] read failed:", e);
      toast('读取失败: ' + msg, 'error');
    }
  };

  ExplorerService.fetchDir(ws(), '')
    .then(d => {
      const items = ExplorerService.toTreeNodes(d.items);
      tree.setData(items);
      (ExplorerService as any)._lastRefreshKey = JSON.stringify(items.map(item => `${item.isDir ? 'd' : 'f'}:${item.id}:${item.label}`));
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Access denied') || msg.includes('403')) container.innerHTML += '<div class="sg-item dim" style="color:var(--rs)">无权限访问工作区</div>';
      else if (msg.includes('not found') || msg.includes('404')) container.innerHTML += '<div class="sg-item dim">工作区路径不存在</div>';
      else container.innerHTML += '<div class="sg-item dim">加载失败</div>';
    });
}

// ─── 筛选切换 ──────────────────────────────────────────
function toggleExplorerFilter(): void {
  document.querySelectorAll('.ctx-menu').forEach(el => el.remove());
  const btn = document.querySelector('.sg-more') as HTMLElement | null;
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const on = ExplorerService.getFilterEnabled();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.style.position = 'fixed';
  menu.style.left = (rect.right + 4) + 'px';
  menu.style.top = (rect.bottom + 8) + 'px';

  const items: { label: string; checked: boolean; fn: () => void }[] = [
    { label: '显示被过滤的文件', checked: !on, fn: () => { ExplorerService.setFilterEnabled(false); ExplorerService.refreshTree(); } },
    { label: '隐藏被过滤的文件', checked: on, fn: () => { ExplorerService.setFilterEnabled(true); ExplorerService.refreshTree(); } },
  ];
  for (const a of items) {
    const item = document.createElement('div'); item.className = 'ctx-item';
    item.style.display = 'flex'; item.style.alignItems = 'center'; item.style.gap = '8px';
    item.innerHTML = `<span style="width:14px;text-align:center;flex-shrink:0">${a.checked ? '✓' : ''}</span><span>${a.label}</span>`;
    item.onclick = () => { menu.remove(); a.fn(); };
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}
(window as any).toggleExplorerFilter = toggleExplorerFilter;

registerPane('explorer', explorerRender);
