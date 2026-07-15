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
  _fileTabs: [],
  _activeFileTab: null,
  _sessionTabs: [],
};

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

// ═══════════════════════════════════════════════════════════════════
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

// 公开 API — 供 onclick 和 init 使用（向后兼容，后续移除）
window.$ = $; window.S = S; window.E = E; window.F = F;
window.sb = sb; window.toast = toast as any;
window.getD = getD; window.refresh = refresh;
window.winCtrl = winCtrl;
