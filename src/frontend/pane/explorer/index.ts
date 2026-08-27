// Explorer pane — 文件资源管理器面板（仅 DOM 渲染 + Tree 绑定）
/// <reference path="../../dashboard.d.ts" />

interface ExplorerPaneDependencies {
  views: AppExplorerViews;
  tabs: AppTabs;
}

const explorerPaneApp = (window as any).App;
const explorerPaneDependencies: ExplorerPaneDependencies = {
  views: explorerPaneApp.ExplorerViews,
  tabs: explorerPaneApp.Tabs,
};
const explorerPaneViews = explorerPaneDependencies.views;
const explorerPaneTabs = explorerPaneDependencies.tabs;

function explorerRender(container: HTMLElement): void {
  explorerPaneViews.dispose();
  bindExplorerActions(container);
  const ws = ExplorerService.getWorkspacePath();
  if (!ws) {
    container.innerHTML = explorerPaneViews.renderEmpty();
    return;
  }

  container.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0';
  container.innerHTML = explorerPaneViews.renderPanel();

  // 阻止浏览器的默认右键菜单
  container.addEventListener('contextmenu', e => e.preventDefault());

  const treeContainer = document.getElementById('exp-tree-cont');
  if (!treeContainer) return;
  initTree(treeContainer);
}

function bindExplorerActions(container: HTMLElement): void {
  if (container.dataset.explorerActions === '1') return;
  container.dataset.explorerActions = '1';
  container.addEventListener('click', (event: MouseEvent) => {
    const eventTarget = event.target as Element | null;
    const target = typeof eventTarget?.closest === 'function'
      ? eventTarget.closest<HTMLElement>('[data-explorer-action]')
      : null;
    if (!target || !container.contains(target)) return;
    if (target.dataset.explorerAction === 'select-workspace') {
      void ExplorerService.applyWorkspace();
    } else if (target.dataset.explorerAction === 'toggle-filter') {
      toggleExplorerFilter();
    }
  });
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
      cb(ExplorerService.reconcilePendingDeletes(node.id, ExplorerService.toTreeNodes(d.items)));
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
          // 先从树上移除节点，再后台刷新（不等 HTTP 往返）
          ExplorerService.markDeleted(n.id);
          const tr = ExplorerService._getTree();
          tr?.removeNode(n.id);
          void ExplorerService.refreshTree();
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
        const rootItems = ExplorerService.reconcilePendingDeletes('', ExplorerService.toTreeNodes(d.items));
        tr.setData(rootItems);
        (ExplorerService as any)._lastRefreshKey = ExplorerService._makeRefreshKey(rootItems, ws());
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

  const _pendingFetches = new Map<string, Promise<string>>();
  tree.onSelect = async (node) => {
    const path = node.id;
    console.log("[explorer] onSelect:", path, node.isDir);
    if (!ws()) { console.log("[explorer] no workspace"); return; }
    const ext = '.' + (path.split('.').pop() || '').toLowerCase();
    const imageExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);
    const videoExt = new Set(['.mp4', '.webm']);
    const unsupportedVideoExt = new Set(['.avi', '.mov', '.mkv', '.wmv', '.flv']);
    if (imageExt.has(ext)) { explorerPaneApp.UI.openFileTab(path, '', ext, 'image'); return; }
    if (videoExt.has(ext)) { explorerPaneApp.UI.openFileTab(path, '', ext, 'video'); return; }
    if (unsupportedVideoExt.has(ext)) { toast(`${ext} 格式不支持浏览器预览，建议用外部播放器打开`, 'info'); explorerPaneApp.UI.openFileTab(path, `[二进制文件，不支持预览: ${ext}]`, ext, 'text'); return; }

    // 文本文件
    const tabs = explorerPaneTabs;
    const existingTab = tabs?.getTab?.(path);

    // 已打开且有内容 → 只激活，不重新读
    if (existingTab && existingTab.content && existingTab.content !== "加载中...") {
      console.log("[explorer] tab already open, activate:", path);
      explorerPaneApp.UI?.mark?.("file-click");
      explorerPaneTabs.activate(path);
      return;
    }

    // 正在读取中 → 复用 pending Promise，不重复 fetch
    if (_pendingFetches.has(path)) {
      console.log("[explorer] reuse pending fetch:", path);
      const content = await _pendingFetches.get(path)!;
      explorerPaneApp.UI.openFileTab(path, content, path.split('.').pop() || '');
      return;
    }

    // 新文件 → 先开 tab 显示 loading，后台读取
    const lang = path.split('.').pop() || '';
    explorerPaneApp.UI.openFileTab(path, "加载中...", lang);
    explorerPaneApp.UI?.mark?.("file-click");
    explorerPaneApp.UI?.mark?.("file-read-start");

    const fetchPromise = (async (): Promise<string> => {
      try {
        const r = await fetch(`/api/file/read?root=${encodeURIComponent(ws())}&path=${encodeURIComponent(path)}`);
        const d = await r.json();
        if (!r.ok) { toast(d.error || '读取失败', 'error'); return ""; }
        explorerPaneApp.UI?.mark?.("file-read-end");
        return d.content || "";
      } catch (e: unknown) {
        console.error("[explorer] read failed:", e);
        toast('读取失败', 'error');
        return "";
      }
    })();

    _pendingFetches.set(path, fetchPromise);
    const content = await fetchPromise;
    _pendingFetches.delete(path);

    if (content) {
      console.log("[explorer] calling openFileTab:", path);
      explorerPaneApp.UI?.mark?.("openFileTab-start");
      explorerPaneApp.UI.openFileTab(path, content, lang);
      explorerPaneApp.UI?.mark?.("openFileTab-end");
    }
  };

  ExplorerService.fetchDir(ws(), '')
    .then(d => {
      const items = ExplorerService.reconcilePendingDeletes('', ExplorerService.toTreeNodes(d.items));
      tree.setData(items);
      (ExplorerService as any)._lastRefreshKey = ExplorerService._makeRefreshKey(items, ws());
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
  const btn = document.querySelector('.sg-more') as HTMLElement | null;
  if (!btn) return;
  const on = ExplorerService.getFilterEnabled();
  explorerPaneViews.showFilterMenu(btn, on, (enabled) => {
    ExplorerService.setFilterEnabled(enabled);
    ExplorerService.refreshTree();
  });
}

registerPane('explorer', explorerRender);
