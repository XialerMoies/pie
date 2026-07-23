// ═══════════════════════════════════════════════════════════════════
//  State — 全局状态（通过 window.__state 访问）
// ═══════════════════════════════════════════════════════════════════

window.__state = {
  D: null,
  M: [],
  IL: false,
  CS: null,
  CT: 'chat',
  _activePanel: 'explorer',
  _sessionTabs: [],
};

// _activeFileTab 改为从 TabStore 投影的 getter，写入变为 no-op
Object.defineProperty(window.__state, '_activeFileTab', {
  get() {
    const ts = (window as any).__tabs;
    return ts ? ts.getActiveFileTabId() : null;
  },
  set(v) { /* 投影自 TabStore，直接写入已弃用 */ },
});

// _fileTabs 改为从 TabStore 投影的 getter（含 content/lang 缓存），写入投射到 TabStore
Object.defineProperty(window.__state, '_fileTabs', {
  get() {
    const ts = (window as any).__tabs;
    if (!ts) return [];
    return ts.getTabs().filter((t: any) => t.kind === 'file').map((t: any) => ({
      id: t.id, label: t.title, content: t.content || '', lang: t.lang || '',
    }));
  },
  set(v) { /* 投影自 TabStore，直接写入已弃用 */ },
});

// ═══════════════════════════════════════════════════════════════════
//  App 命名空间 — 收敛全局函数
// ═══════════════════════════════════════════════════════════════════
// 目标：所有 window.xxx  函数归到 App.* 下。
// 当前：window 别名保留用于 onclick 向后兼容。
// 迁移完成后删除 window 别名，更新 onclick 为 App.xxx.yyy。
//
//   App.UI        — layout, panel, tabs, topbar
//   App.Chat      — message render, SSE, model picker
//   App.File      — file menu, save, CLI launch
//   App.Session   — session CRUD
//   App.Settings  — settings modal, API keys, model list
// ═══════════════════════════════════════════════════════════════════

(window as any).App = {
  Constants: { WS_KEY: 'workspace_path' } as Record<string, string>,
  UI: {} as Record<string, Function>,
  Chat: {} as Record<string, Function>,
  File: {} as Record<string, Function>,
  Session: {} as Record<string, Function>,
  Settings: {} as Record<string, Function>,
  Tabs: {
    activate(id: string) {
      const tabs = (window as any).__tabs;
      const tab = tabs?.getTab?.(id);
      if (tab) {
        const handler = tabs?.getTabBehavior?.(tab.kind);
        if (handler?.activate) { handler.activate(tab); return; }
      }
      // 降级：TabStore 无此 tab（初始化阶段 / legacy 调用）
      if (!tab) {
        // session/chat tab 未在 TabStore 中 → 走 switchSession 加载
        if (id.startsWith('draft:') || /^[a-f0-9-]{30,}$/i.test(id)) {
          if (typeof (window as any).switchSession === 'function') {
            (window as any).switchSession(id);
            return;
          }
        }
        if (tabs) tabs.activateTab(id);
        const ft = tabs?.getTab?.(id);
        const editorEl = document.getElementById('fc-editor');
        if (editorEl && ft) {
          const m = (window as any).__monaco;
          if (m) {
            if (!editorEl.dataset.monacoReady) { editorEl.innerHTML = ''; m.create(editorEl); editorEl.dataset.monacoReady = '1'; }
            m.setValue(ft.content || ''); m.setLang(ft.id);
          }
        }
        if (typeof renderTabs === 'function') renderTabs();
      }
    },
    close(id: string) {
      const tabs = (window as any).__tabs;
      const tab = tabs?.getTab?.(id);
      if (tab) {
        const handler = tabs?.getTabBehavior?.(tab.kind);
        if (handler?.close) { handler.close(tab); return; }
      }
      // 降级：TabStore 无此 tab → 直接关 TabStore + Monaco
      if (!tab) {
        const monaco = (window as any).__monaco; if (monaco?.tsCloseFile) monaco.tsCloseFile(id);
        if (tabs) tabs.closeTab(id);
        if (typeof renderTabs === 'function') renderTabs();
      }
    },
    contextMenu(e: MouseEvent, id: string) {
      const tabs = (window as any).__tabs;
      const tab = tabs?.getTab?.(id);
      if (tab) {
        const handler = tabs?.getTabBehavior?.(tab.kind);
        if (handler?.contextMenu) { handler.contextMenu(e, tab); return; }
      }
      if (tab && tab.kind !== 'file') return;
      (window as any).tabContextMenu?.(e, id);
    },
  },
};

// ═══════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════

/** getElementById shorthand */
function $(i: string): HTMLElement | null { return document.getElementById(i); }

/** SVG icon from <symbol> */
function S(n: string, z: number = 16): string {
  return `<svg width="${z}" height="${z}" viewBox="0 0 24 24"><use href="#${n}"/></svg>`;
}

/** escape HTML entities */
function E(s: unknown): string {
  const d = document.createElement('div');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}

/** format uptime seconds → Chinese */
function F(s: number): string {
  if (s < 60) return Math.floor(s) + '秒';
  if (s < 3600) return Math.floor(s / 60) + '分' + Math.floor(s % 60) + '秒';
  return Math.floor(s / 3600) + '时' + Math.floor((s % 3600) / 60) + '分';
}

/** scroll element to bottom */
function sb(id: string): void {
  const e = $(id);
  if (e) e.scrollTop = e.scrollHeight;
}

/** toast notification — type: 'info' | 'error' | 'success' */
function toast(msg: string, type?: 'info' | 'error' | 'success'): void {
  let t = $('toast-el') as HTMLDivElement | null;
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast-el';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'toast-el' + (type ? ' ' + type : '');
  clearTimeout((t as any)._t);
  (t as any)._t = setTimeout(() => { t.className = 'toast-el' + (type ? ' ' + type : '') + ' out'; }, 3000);
}

// ═══════════════════════════════════════════════════════════════════
//  Dashboard Data Fetch
// ═══════════════════════════════════════════════════════════════════

async function getD(): Promise<void> {
  try {
    const r = await fetch('/api/dashboard');
    window.__state.D = await r.json();
    // Sync model name to input bar
    const fn = (window as any).App?.Chat?.updateModelName;
    if (fn) fn(); else { const mn = $('fi-model-name'); if (mn && window.__state.D?.modelId) mn.textContent = window.__state.D.modelId; }
  } catch { /* ignore */ }
}

async function refresh(): Promise<void> {
  await getD();
}

/** 非阻塞确认弹窗（替代 window.confirm，避免 Electron 焦点假死） */
function confirmAsync(msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--bs);border:1px solid var(--bd);border-radius:12px;padding:24px;min-width:300px;box-shadow:0 16px 64px rgba(0,0,0,.5)">
        <div style="font-size:.85rem;color:var(--tx);margin-bottom:16px;line-height:1.5">${msg}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="confirm-cancel" style="padding:6px 18px;border-radius:6px;border:1px solid var(--bd);background:0 0;color:var(--ts);font-size:.78rem;font-family:var(--fb);cursor:pointer;white-space:nowrap">取消</button>
          <button id="confirm-ok" style="padding:6px 18px;border-radius:6px;border:none;background:var(--am);color:#0A0A0F;font-size:.78rem;font-family:var(--fb);font-weight:600;cursor:pointer;white-space:nowrap">确定</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = (val: boolean) => { overlay.remove(); resolve(val); };
    overlay.querySelector('#confirm-ok')!.addEventListener('click', () => close(true));
    overlay.querySelector('#confirm-cancel')!.addEventListener('click', () => close(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
  });
}

/** 在 viewport 内安全定位右键菜单，自动翻转防止溢出 */
function placeContextMenu(menu: HTMLElement, x: number, y: number, opts?: { margin?: number; maxHeight?: number }): void {
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const m = opts?.margin ?? 8;
  let left = x, top = y;
  if (left + r.width > window.innerWidth - m) left = window.innerWidth - r.width - m;
  if (top + r.height > window.innerHeight - m) top = window.innerHeight - r.height - m;
  menu.style.left = Math.max(m, left) + 'px';
  menu.style.top = Math.max(m, top) + 'px';
  if (opts?.maxHeight) {
    menu.style.maxHeight = String(opts.maxHeight) + 'px';
    menu.style.overflowY = 'auto';
  }
}

// ═══════════════════════════════════════════════════════════════════

/** 启动耗时埋点 */
const _marks = {}
function mark(name) { _marks[name] = performance.now() }
function logTiming() {
  const entries = Object.entries(_marks).sort((a, b) => a[1] - b[1])
  if (entries.length === 0) return
  const base = entries[0][1]
  const lines = entries.map(([n, t]) => "  +" + ((t - base).toFixed(0).padStart(5)) + "ms  " + n)
  console.log("[timing] 前端启动\n" + lines.join("\n"))
}

//  窗口控制 (Electron IPC)
// ═══════════════════════════════════════════════════════════════════

function winCtrl(action: string): void {
  const api = (window as any).electronAPI as ElectronAPI | undefined;
  if (!api) return;
  if (action === 'minimize') api.minimize();
  else if (action === 'maximize') api.maximize();
  else if (action === 'close') api.close();
}

// ─── Pane registry ─────────────────────────────────────────
const _panes: Record<string, (container: HTMLElement) => void> = {};
function registerPane(name: string, render: (container: HTMLElement) => void): void {
  _panes[name] = render;
  console.log(`[pane] registered: "${name}"`);
}
function getPane(name: string): ((container: HTMLElement) => void) | undefined {
  return _panes[name];
}

// ─── App 命名空间绑定 ──────────────────────────────────────
const App = (window as any).App;
App.UI.$ = $;
App.UI.S = S;
App.UI.E = E;
App.UI.F = F;
App.UI.sb = sb;
App.UI.toast = toast;
App.UI.getD = getD;
App.UI.refresh = refresh;
App.UI.winCtrl = winCtrl;
App.UI.registerPane = registerPane;
App.UI.getPane = getPane;
App.UI.placeContextMenu = placeContextMenu;
App.Tabs = App.Tabs || {};

// 公开 API — 供 onclick 和 init 使用（向后兼容，后续移除）
window.$ = $; window.S = S; window.E = E; window.F = F;
window.sb = sb; window.toast = toast as any;
window.getD = getD; window.refresh = refresh;
window.winCtrl = winCtrl;
window.placeContextMenu = placeContextMenu;
window.mark = mark;
window.logTiming = logTiming;
