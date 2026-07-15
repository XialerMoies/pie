// ExplorerService — API 调用 + 状态管理（服务层）
/// <reference path="../../dashboard.d.ts" />

const WS_KEY = (window as any).App?.Constants?.WS_KEY || 'workspace_path';

export class ExplorerService {
  static _filterEnabled = true;
  static _lastRefreshKey = '';

  static setFilterEnabled(v: boolean): void {
    this._filterEnabled = v;
    localStorage.setItem('explorer-filter', v ? '1' : '0');
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
    return localStorage.getItem(WS_KEY) || '';
  }

  /** 设置工作区路径 */
  static setWorkspacePath(p: string): void {
    localStorage.setItem(WS_KEY, p);
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
}

function setExplorerStatus(text: string, kind: 'loading' | 'ready' | 'error' = 'ready'): void {
  void text;
  void kind;
}

// 从 localStorage 恢复筛选状态
try { const v = localStorage.getItem('explorer-filter'); if (v === '0') ExplorerService._filterEnabled = false; } catch {}

// 暴露到全局（供 inline onclick 使用）
(window as any).ExplorerService = ExplorerService;

// 当前 explorer 的 Tree 实例引用（SSE 刷新时不重建）
let _explorerTree: Tree | null = null;
ExplorerService._setTree = (t: Tree | null) => { _explorerTree = t; };
ExplorerService._getTree = (): Tree | null => _explorerTree;

/** 软刷新：重新加载根目录，保留展开状态 */
ExplorerService.refreshTree = async function () {
  if (!_explorerTree) return;
  const ws = ExplorerService.getWorkspacePath();
  if (!ws) return;
  // 正在编辑中时跳过刷新（否则会销毁输入框）
  if ((_explorerTree as any)._editingNode) return;
  try {
    const d = await ExplorerService.fetchDir(ws, '');
    const items = ExplorerService.toTreeNodes(d.items);
    const refreshKey = JSON.stringify(items.map(item => `${item.isDir ? 'd' : 'f'}:${item.id}:${item.label}`));
    if (refreshKey === ExplorerService._lastRefreshKey) {
      setExplorerStatus(`目录已同步 · ${items.length} 项未变化`, 'ready');
      return;
    }
    ExplorerService._lastRefreshKey = refreshKey;
    _explorerTree.setData(items);
    setExplorerStatus(`目录已刷新 · ${items.length} 项`, 'ready');
  } catch {
    setExplorerStatus('目录刷新失败', 'error');
  }
};

// ─── 文件变更自动刷新（SSE）────────────────────────────────
(() => {
  try {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'refresh') {
          ExplorerService.refreshTree();
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* SSE connection lost, will auto-reconnect */ };
  } catch { /* SSE not available */ }
})();
