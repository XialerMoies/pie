// ExplorerService — API 调用 + 状态管理（服务层）
/// <reference path="../../dashboard.d.ts" />

export class ExplorerService {
  static _filterEnabled = true;
  static _lastRefreshKey = '';
  static _pendingDeletedPaths = new Set<string>();
  static _eventsStarted = false;
  static _eventSource: EventSource | null = null;
  static _eventsReady: Promise<void> | null = null;
  static _eventReadyTimer: ReturnType<typeof setTimeout> | null = null;
  static _eventGeneration = 0;
  static _eventCleanup: (() => void) | null = null;
  static startEvents(): Promise<void> { return Promise.resolve(); }
  static stopEvents(): void {}

  static _makeRefreshKey(items: TreeNode[], workspacePath?: string): string {
    const ws = workspacePath ?? ExplorerService.getWorkspacePath();
    return JSON.stringify({
      ws,
      filter: ExplorerService._filterEnabled,
      items: items.map(item => `${item.isDir ? 'd' : 'f'}:${item.id}:${item.label}`),
    });
  }

  static setFilterEnabled(v: boolean): void {
    this._filterEnabled = v;
    App.Preferences.setBoolean('explorer-filter', v);
  }
  static getFilterEnabled(): boolean { return this._filterEnabled; }

  /** 获取目录内容 */
  static async fetchDir(root: string, path: string): Promise<{ items: ExplorerItem[]; rootDir: string; relativePath: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const filter = this._filterEnabled ? '1' : '0';
    const url = `/api/explorer?root=${encodeURIComponent(root)}${path ? `&path=${encodeURIComponent(path)}` : ''}&filter=${filter}`;
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      return res.json();
    } catch (e: unknown) {
      clearTimeout(timer);
      if (e instanceof DOMException && e.name === 'AbortError') throw new Error('TIMEOUT');
      throw e;
    }
  }

  /** 获取工作区路径 */
  static getWorkspacePath(): string {
    return App.State.getWorkspacePath();
  }

  /** 设置工作区路径 */
  static setWorkspacePath(p: string): void {
    App.State.setWorkspacePath(p);
  }

  /** 选择文件夹（Electron 原生 / 浏览器 fallback） */
  static async selectWorkspace(): Promise<string | null> {
    const api = (window as any).electronAPI as ElectronAPI | undefined;
    if (api?.openFolder) {
      return await api.openFolder();
    }
    // browser fallback: 用自定义弹窗替代 prompt()
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay'; ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
      ov.innerHTML = `<div style="background:var(--bs);border:1px solid var(--bd);border-radius:12px;padding:20px;min-width:360px;box-shadow:0 16px 64px rgba(0,0,0,.5)">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px;color:var(--tx)">选择工作区</div>
        <input id="dlg-ws" type="text" placeholder="请输入工作区路径" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--bd);background:var(--bc);color:var(--tx);font-size:13px;font-family:var(--fb);outline:none;box-sizing:border-box">
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button id="dlg-cancel" style="padding:6px 14px;border-radius:6px;border:1px solid var(--bd);background:0 0;color:var(--ts);cursor:pointer;font-size:12px">取消</button>
          <button id="dlg-ok" style="padding:6px 14px;border-radius:6px;border:none;background:var(--am);color:#0A0A0F;cursor:pointer;font-size:12px;font-weight:600">确定</button>
        </div></div>`;
      document.body.appendChild(ov);
      const inp = ov.querySelector('#dlg-ws') as HTMLInputElement; inp.focus();
      const cl = (v: string | null) => { ov.remove(); resolve(v); };
      ov.querySelector('#dlg-ok')!.addEventListener('click', () => cl(inp.value || null));
      ov.querySelector('#dlg-cancel')!.addEventListener('click', () => cl(null));
      ov.addEventListener('click', e => { if (e.target === ov) cl(null); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') cl(inp.value || null); if (e.key === 'Escape') cl(null); });
    });
  }

  /** 应用工作区选择（设置路径 + 重新渲染 panel） */
  static async applyWorkspace(): Promise<void> {
    const p = await ExplorerService.selectWorkspace();
    if (!p) return;
    ExplorerService.setWorkspacePath(p);
    toast('工作区: ' + p);
    const pc = $('pc');
    if (pc) renderPanel('explorer', pc);
  }

  /** 文件名 → icon HTML（vscode-icons SVG + fallback） */
  private static _iconMap: Record<string, string> | null = null;

  static iconFor(name: string, dir: boolean): string {
    if (dir) return `<img src="./icons/default_folder.svg" width="16" height="16" style="vertical-align:middle">`;
    if (!ExplorerService._iconMap) {
      ExplorerService._iconMap = {
        "ts":"typescript","tsx":"typescript","mts":"typescript","cts":"typescript",
        "js":"js","mjs":"js","cjs":"js","jsx":"reactjs",
        "json":"json","md":"markdown","mdx":"markdown",
        "html":"html","htm":"html","css":"css","scss":"sass","less":"less","styl":"stylus",
        "py":"python","rs":"rust","go":"go","rb":"ruby","php":"php",
        "java":"java","kt":"kotlin","swift":"swift",
        "c":"c","h":"cheader","cpp":"cpp","hpp":"cpp",
        "cs":"csharp","fs":"fsharp",
        "sh":"shell","bash":"shell","zsh":"shell","ps1":"powershell","bat":"bat",
        "yml":"yaml","yaml":"yaml","xml":"xml","svg":"svg",
        "vue":"vue","svelte":"svelte","astro":"astro","prisma":"prisma",
        "toml":"toml","env":"dotenv","log":"log","txt":"text",
        "sql":"sql","db":"sqlite","sqlite":"sqlite",
        "zip":"zip","rar":"zip","7z":"zip","gz":"archive",
        "pdf":"pdf","png":"image","jpg":"image","jpeg":"image","gif":"image","ico":"favicon","webp":"image",
        "mp4":"video","webm":"video","avi":"video","mov":"video","mkv":"video","wmv":"video","flv":"video",
        "ejs":"ejs","pug":"pug","coffee":"coffeescript",
        "cmake":"cmake","gradle":"gradle",
        "node":"node","npm":"npm","yarn":"yarn","nodejs":"node",
        "proto":"protobuf","graphql":"graphql","gql":"graphql","tf":"terraform",
        "zig":"zig","dart":"dartlang","ex":"elixir","exs":"elixir","erl":"erlang",
        "r":"r","pl":"perl","lua":"lua","nim":"nim","scala":"scala","hs":"haskell",
        "nginx":"nginx","angular":"angular",
        "dockerfile":"docker","dockerignore":"docker",
        "editorconfig":"editorconfig","prettierrc":"prettier",
        "eslintrc":"eslint","babelrc":"babel","stylelintrc":"stylelint",
        "gitignore":"git","gitattributes":"git","gitmodules":"git",
        "npmrc":"npm","yarnrc":"yarn",
        "browserslist":"browserslist","postcss":"postcss",
        "tailwind":"tailwind","webpack":"webpack","rollup":"rollup","vite":"vite",
        "jest":"jest","mocha":"mocha","cypress":"cypress","storybook":"storybook",
        "ansible":"ansible","helm":"helm",
      };
    }
    const lowerName = name.toLowerCase();
    // 特殊文件名匹配
    for (const [pat, icon] of Object.entries(ExplorerService._iconMap)) {
      if (lowerName === pat || lowerName.endsWith('.' + pat)) {
        const iconFile = `file_type_${icon}.svg`;
        return `<img src="./icons/${iconFile}" width="16" height="16" style="vertical-align:middle">`;
      }
    }
    return S('if', 16);
  }

    /** 文件操作 API */
  static async fileOp(op: 'new' | 'rename' | 'delete' | 'move', root: string, path: string, newPath?: string): Promise<void> {
    const r = await fetch(`/api/file/${op}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, path, newPath }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || '操作失败');
  }

/** API items[] → TreeNode[] */
  static toTreeNodes(items: ExplorerItem[]): TreeNode[] {
    return (items || []).map((it: ExplorerItem) => ({
      id: it.path,
      label: it.name,
      icon: ExplorerService.iconFor(it.name, it.isDir),
      isDir: it.isDir,
    }));
  }

  static markDeleted(path: string): void {
    const normalized = ExplorerService._normalizeTreePath(path);
    if (normalized) ExplorerService._pendingDeletedPaths.add(normalized);
  }

  static clearDeletedMark(path: string): void {
    const normalized = ExplorerService._normalizeTreePath(path);
    if (normalized) ExplorerService._pendingDeletedPaths.delete(normalized);
  }

  static reconcilePendingDeletes(parentPath: string, nodes: TreeNode[]): TreeNode[] {
    const parent = ExplorerService._normalizeTreePath(parentPath);
    const ids = new Set(nodes.map(node => ExplorerService._normalizeTreePath(node.id)));
    for (const deletedPath of Array.from(ExplorerService._pendingDeletedPaths)) {
      if (ExplorerService._parentPath(deletedPath) === parent && !ids.has(deletedPath)) {
        ExplorerService._pendingDeletedPaths.delete(deletedPath);
      }
    }
    return ExplorerService.filterPendingDeletedNodes(nodes);
  }

  static filterPendingDeletedNodes(nodes: TreeNode[]): TreeNode[] {
    return nodes
      .filter(node => !ExplorerService._isPendingDeleted(node.id))
      .map(node => node.children
        ? { ...node, children: ExplorerService.filterPendingDeletedNodes(node.children) }
        : node);
  }

  private static _isPendingDeleted(path: string): boolean {
    const normalized = ExplorerService._normalizeTreePath(path);
    for (const deletedPath of ExplorerService._pendingDeletedPaths) {
      if (normalized === deletedPath || normalized.startsWith(deletedPath + '/')) return true;
    }
    return false;
  }

  private static _parentPath(path: string): string {
    const normalized = ExplorerService._normalizeTreePath(path);
    const idx = normalized.lastIndexOf('/');
    return idx >= 0 ? normalized.slice(0, idx) : '';
  }

  private static _normalizeTreePath(path: string): string {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }
}

function setExplorerStatus(text: string, kind: 'loading' | 'ready' | 'error' = 'ready'): void {
  void text;
  void kind;
}

// 从统一偏好 facade 恢复筛选状态
if (!App.Preferences.getBoolean('explorer-filter', true)) ExplorerService._filterEnabled = false;

// 暴露到全局（供 inline onclick 使用）
(window as any).ExplorerService = ExplorerService;

// 当前 explorer 的 Tree 实例引用（SSE 刷新时不重建）
let _explorerTree: Tree | null = null;
ExplorerService._setTree = (t: Tree | null) => {
  _explorerTree = t;
  ExplorerService._lastRefreshKey = '';
};
ExplorerService._getTree = ((): Tree | null => _explorerTree) as typeof ExplorerService._getTree;

/** 软刷新：重新加载根目录，保留展开状态 */
ExplorerService.refreshTree = async function (): Promise<void> {
  if (!_explorerTree) return;
  const ws = ExplorerService.getWorkspacePath();
  if (!ws) return;
  // 正在编辑中时跳过刷新（否则会销毁输入框）
  if ((_explorerTree as any)._editingNode) return;
  try {
    const d = await ExplorerService.fetchDir(ws, '');
    const items = ExplorerService.reconcilePendingDeletes('', ExplorerService.toTreeNodes(d.items));
    const refreshKey = ExplorerService._makeRefreshKey(items, ws);
    if (refreshKey === ExplorerService._lastRefreshKey) {
      setExplorerStatus(`目录已刷新 · ${items.length} 项`, 'ready');
      return;
    }
    _explorerTree.clearChildCache?.();
    _explorerTree.setData(items);
    ExplorerService._lastRefreshKey = refreshKey;
    setExplorerStatus(`目录已刷新 · ${items.length} 项`, 'ready');
  } catch {
    setExplorerStatus('目录刷新失败', 'error');
  }
};

// ─── 文件变更自动刷新（SSE）────────────────────────────────
ExplorerService.startEvents = function (): Promise<void> {
  if (ExplorerService._eventsReady) return ExplorerService._eventsReady;
  ExplorerService._eventsStarted = true;
  const generation = ++ExplorerService._eventGeneration;
  const pending = new Promise<void>((resolve, reject) => {
    try {
      const es = new EventSource('/api/events');
      ExplorerService._eventSource = es;
      let ready = false;
      const isCurrent = () => ExplorerService._eventGeneration === generation
        && ExplorerService._eventSource === es;
      const finishReady = () => {
        if (ready || !isCurrent()) return;
        ready = true;
        if (ExplorerService._eventReadyTimer) clearTimeout(ExplorerService._eventReadyTimer);
        ExplorerService._eventReadyTimer = null;
        resolve();
      };
      ExplorerService._eventReadyTimer = setTimeout(() => {
        if (!isCurrent()) return;
        es.close();
        reject(new Error('Permission event channel timed out'));
      }, 5000);
      const handleOpen = () => finishReady();
      const handleMessage = (e: MessageEvent) => {
      if (!isCurrent()) return;
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'permission_confirm') {
          if (!d.id) return;
          const input = {
            source: d.source || '',
            operation: d.operation || '',
            toolName: d.toolName || '',
            toolOperations: Array.isArray(d.toolOperations) ? d.toolOperations : [],
            riskLevel: d.riskLevel || '',
            workspaceBounded: typeof d.workspaceBounded === 'boolean' ? d.workspaceBounded : undefined,
            permissionRequired: typeof d.permissionRequired === 'boolean' ? d.permissionRequired : undefined,
            root: d.root || '',
            path: d.path || '',
            relativePath: d.relativePath || '',
            reason: d.reason || '路径访问需要确认',
            permissionSuggestions: d.permissionSuggestions || [],
          };
          void (async () => {
            const choice = typeof confirmPermissionAsync === 'function'
              ? await confirmPermissionAsync(input)
              : (await confirmAsync(`
                <div style="font-weight:700;margin-bottom:8px">确认路径访问</div>
                <div style="font-size:.76rem;color:var(--ts);margin-bottom:10px">${E(input.reason || '路径访问需要确认')}</div>
                <pre style="margin:0;max-width:560px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,.18);border:1px solid var(--bd);border-radius:7px;padding:10px;font-family:var(--fm);font-size:.74rem;color:var(--tx)">${E(input.path || '')}</pre>
              `) ? 'session' : 'deny');
            await fetch('/api/permissions/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: d.id,
                allow: choice !== 'deny',
                scope: choice === 'session' ? 'session' : 'once',
              }),
            }).catch(() => undefined);
            void (window as any).refreshPermissionsPanel?.();
          })();
          return;
        }
        if (d.type === 'refresh') {
          ExplorerService.refreshTree();
        }
      } catch { /* ignore */ }
      };
      const handleError = () => {
        if (isCurrent() && !ready) reject(new Error('Permission event channel failed'));
      };
      es.addEventListener('open', handleOpen);
      es.addEventListener('message', handleMessage);
      es.addEventListener('error', handleError);
      ExplorerService._eventCleanup = () => {
        es.removeEventListener('open', handleOpen);
        es.removeEventListener('message', handleMessage);
        es.removeEventListener('error', handleError);
        es.close();
      };
    } catch (error) {
      reject(error);
    }
  });
  ExplorerService._eventsReady = pending.catch((error) => {
    if (ExplorerService._eventGeneration !== generation) throw error;
    if (ExplorerService._eventReadyTimer) clearTimeout(ExplorerService._eventReadyTimer);
    ExplorerService._eventReadyTimer = null;
    ExplorerService._eventsStarted = false;
    ExplorerService._eventCleanup?.();
    ExplorerService._eventCleanup = null;
    ExplorerService._eventSource = null;
    ExplorerService._eventsReady = null;
    throw error;
  });
  return ExplorerService._eventsReady;
};

ExplorerService.stopEvents = function (): void {
  ExplorerService._eventGeneration++;
  if (ExplorerService._eventReadyTimer) clearTimeout(ExplorerService._eventReadyTimer);
  ExplorerService._eventReadyTimer = null;
  ExplorerService._eventCleanup?.();
  ExplorerService._eventCleanup = null;
  ExplorerService._eventSource = null;
  ExplorerService._eventsStarted = false;
  ExplorerService._eventsReady = null;
};
