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

let attachedTabStore: TabStoreAPI | null = null;

function requireTabStore(): TabStoreAPI {
  if (!attachedTabStore) throw new Error('TabStore is not attached');
  return attachedTabStore;
}

function currentTabsState(): TabsState {
  if (!attachedTabStore) return { items: [], activeId: null };
  const state = attachedTabStore.getState();
  return {
    items: state.items.map((tab: AppTab) => ({ ...tab })),
    activeId: state.activeId ?? null,
  };
}

const existingApp = (window as any).App || {};
const existingConstants = existingApp.Constants || {};
const existingUI = existingApp.UI || {};
const existingChat = existingApp.Chat || {};
const existingFile = existingApp.File || {};
const existingSession = existingApp.Session || {};
const existingSettings = existingApp.Settings || {};
const existingTabs = existingApp.Tabs || {};
Object.assign(existingApp, {
  Constants: Object.assign(existingConstants, { WS_KEY: 'workspace_path' }) as Record<string, string>,
  UI: Object.assign(existingUI, {}) as Record<string, Function>,
  Chat: Object.assign(existingChat, {}) as Record<string, Function>,
  File: Object.assign(existingFile, {}) as Record<string, Function>,
  Session: Object.assign(existingSession, {}) as Record<string, Function>,
  Settings: Object.assign(existingSettings, {}) as Record<string, Function>,
  Tabs: Object.assign(existingTabs, {
    _attachStore(store: TabStoreAPI): void { attachedTabStore = store; },
    getState(): TabsState { return currentTabsState(); },
    getTabs(): AppTab[] { return currentTabsState().items; },
    getActiveTab(): AppTab | null {
      const state = currentTabsState();
      return state.items.find(tab => tab.id === state.activeId) || null;
    },
    getTab(id: string): AppTab | undefined {
      return currentTabsState().items.find(tab => tab.id === id);
    },
    getFileTabIds(): string[] {
      return attachedTabStore?.getFileTabIds() ?? [];
    },
    getSessionTabIds(): string[] {
      return attachedTabStore?.getSessionTabIds() ?? [];
    },
    getActiveFileTabId(): string | null {
      return attachedTabStore?.getActiveFileTabId() ?? null;
    },
    getActiveSessionTabId(): string | null {
      return attachedTabStore?.getActiveSessionTabId() ?? null;
    },
    clearActiveTab(): void {
      attachedTabStore?.activateTab(null);
    },
    restoreTabs(items: AppTab[], activeId: string | null): void {
      requireTabStore().restoreTabs(items, activeId);
    },
    openTab(tab: Omit<AppTab, 'order'>): AppTab {
      return requireTabStore().openTab(tab);
    },
    activateTab(id: string | null): void {
      requireTabStore().activateTab(id);
    },
    closeTab(id: string): AppTab | undefined {
      return requireTabStore().closeTab(id);
    },
    replaceTab(id: string, updates: Partial<AppTab>): AppTab | undefined {
      return requireTabStore().replaceTab(id, updates);
    },
    moveTab(from: number, to: number): void {
      requireTabStore().moveTab(from, to);
    },
    reset(): void {
      attachedTabStore?.reset();
    },
    registerTabBehavior(kind: TabKind, behavior: TabBehavior): void {
      requireTabStore().registerTabBehavior(kind, behavior);
    },
    getTabBehavior(kind: TabKind): TabBehavior | undefined {
      return attachedTabStore?.getTabBehavior(kind);
    },
    activate(id: string, options?: SessionActivationOptions) {
      const tabs = attachedTabStore;
      const tab = tabs?.getTab?.(id);
      if (tab) {
        const handler = tabs?.getTabBehavior?.(tab.kind);
        if (handler?.activate) { handler.activate(tab, options); return; }
      }
      // 降级：TabStore 无此 tab（初始化阶段 / legacy 调用）
      if (!tab) {
        // session/chat tab 未在 TabStore 中 → 走 switchSession 加载
        if (id.startsWith('draft:') || /^[a-f0-9-]{30,}$/i.test(id)) {
          App.SessionActivation.switchSession(id, options);
          return;
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
      const tabs = attachedTabStore;
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
      const tabs = attachedTabStore;
      const tab = tabs?.getTab?.(id);
      if (tab) {
        const handler = tabs?.getTabBehavior?.(tab.kind);
        if (handler?.contextMenu) { handler.contextMenu(e, tab); return; }
      }
      if (tab && tab.kind !== 'file') return;
      (window as any).tabContextMenu?.(e, id);
    },
  }),
});
(window as any).App = existingApp;

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
  if (!e) return;
  if (id === 'ms' && typeof App.Chat?.scrollToLatest === 'function') {
    App.Chat.scrollToLatest({ force: false });
    return;
  }
  e.scrollTop = e.scrollHeight;
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
  clearTimeout((t as any)._removeT);
  (t as any)._t = setTimeout(() => {
    t.className = 'toast-el' + (type ? ' ' + type : '') + ' out';
    (t as any)._removeT = setTimeout(() => {
      if (t?.parentNode && t.classList.contains('out')) t.remove();
    }, 300);
  }, 3000);
}

// ═══════════════════════════════════════════════════════════════════
//  Dashboard Data Fetch
// ═══════════════════════════════════════════════════════════════════

let _bootstrapPromise: Promise<void> | null = null;
let _dashboardRefreshInFlight: Promise<void> | null = null;
let _dashboardRefreshQueued = false;

export function bootstrapApi(): Promise<void> {
  if (!_bootstrapPromise) {
    _bootstrapPromise = (async () => {
      const api = window.electronAPI;
      if (!api?.getDesktopSessionToken) throw new Error('Electron preload API is unavailable');
      const token = await api.getDesktopSessionToken();
      if (!token) throw new Error('Desktop session token is unavailable');
      const response = await fetch('/api/bootstrap', {
        credentials: 'include',
        cache: 'no-store',
        headers: { 'X-My-Code-Agent-Token': token },
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Desktop API bootstrap failed: ${response.status}${body ? ` ${body}` : ''}`);
      }
    })();
    _bootstrapPromise = _bootstrapPromise.catch((error) => {
      _bootstrapPromise = null;
      throw error;
    });
  }
  return _bootstrapPromise;
}

async function getD(): Promise<void> {
  if (_dashboardRefreshInFlight) {
    _dashboardRefreshQueued = true;
    return _dashboardRefreshInFlight;
  }

  _dashboardRefreshInFlight = (async () => {
    do {
      _dashboardRefreshQueued = false;
      try {
        await bootstrapApi();
        const r = await fetch('/api/dashboard', { credentials: 'include' });
        const data = await r.json() as DashboardData;
        App.ChatState.setDashboard(data);
        // Sync model name to the input bar without replacing the mounted side pane.
        const fn = (window as any).App?.Chat?.updateModelName;
        if (fn) fn(); else { const mn = $('fi-model-name'); if (mn && App.ChatState.getDashboard()?.modelId) mn.textContent = App.ChatState.getDashboard()!.modelId; }
      } catch { /* ignore */ }
    } while (_dashboardRefreshQueued);
  })().finally(() => {
    _dashboardRefreshInFlight = null;
  });

  return _dashboardRefreshInFlight;
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

type CommandConfirmChoice = 'once' | 'session' | 'workspace' | 'deny';
let _activeCommandConfirmResolve: ((choice: CommandConfirmChoice) => void) | null = null;
let _activeCommandConfirmHost: HTMLElement | null = null;

function commandSuggestionLabel(suggestion: any): string {
  if (!suggestion || typeof suggestion !== 'object') return '';
  if (suggestion.type === 'addWorkingDirectory' && suggestion.directory) return String(suggestion.directory);
  if (suggestion.type === 'addPathRule') {
    if (suggestion.rule?.ruleContent) return String(suggestion.rule.ruleContent);
    if (suggestion.directory) return String(suggestion.directory);
  }
  if (suggestion.type === 'addReadRule') {
    if (suggestion.rule?.ruleContent) return String(suggestion.rule.ruleContent);
    if (suggestion.directory) return String(suggestion.directory);
  }
  if (suggestion.type === 'addToolRule') {
    if (suggestion.rule?.ruleContent) return String(suggestion.rule.ruleContent);
    if (suggestion.toolName) return `Tool(${String(suggestion.toolName)})`;
  }
  return '';
}

function hasReusablePermissionSuggestion(suggestions: any[]): boolean {
  return suggestions.some((suggestion) => (
    suggestion?.type === 'addPathRule' ||
    suggestion?.type === 'addReadRule' ||
    suggestion?.type === 'addToolRule'
  ));
}

function commandConfirmBoxHTML(input: { command: string; reason: string; permissionSuggestions?: any[] }, suggestionLabels: string[], allowWorkspace: boolean, inline = false): string {
  return `
      <div class="command-confirm-box${inline ? ' command-confirm-inline' : ''}" role="dialog" ${inline ? '' : 'aria-modal="true" '}aria-labelledby="command-confirm-title">
        <div class="command-confirm-head">
          <div id="command-confirm-title" class="command-confirm-title">确认执行命令</div>
          <div class="command-confirm-reason">${E(input.reason || '该命令需要确认')}</div>
        </div>
        <div class="command-confirm-body">
          <div>
            <div class="command-confirm-label">命令</div>
            <pre class="command-confirm-code">${E(input.command || '')}</pre>
          </div>
          <div class="command-confirm-scope">
            <div class="command-confirm-label">本会话授权</div>
            ${suggestionLabels.length
              ? `<ul>${suggestionLabels.map((label) => `<li>${E(label)}</li>`).join('')}</ul>`
              : `<div class="command-confirm-empty-scope">本次命令没有可持久化的目录或规则授权。</div>`}
          </div>
        </div>
        <div class="command-confirm-actions">
          <button type="button" class="command-confirm-btn danger" data-choice="deny">拒绝</button>
          <button type="button" class="command-confirm-btn" data-choice="once">仅本次允许</button>
          ${allowWorkspace ? '<button type="button" class="command-confirm-btn" data-choice="workspace">本项目允许</button>' : ''}
          <button type="button" class="command-confirm-btn primary" data-choice="session">本会话允许</button>
        </div>
      </div>`;
}

function clearActiveCommandConfirm(choice?: CommandConfirmChoice): void {
  const resolve = _activeCommandConfirmResolve;
  const host = _activeCommandConfirmHost;
  _activeCommandConfirmResolve = null;
  _activeCommandConfirmHost = null;
  if (host) {
    host.classList.remove('on');
    host.innerHTML = '';
  }
  if (choice && resolve) resolve(choice);
}

function commandConfirmInlineHost(): HTMLElement | null {
  const slot = $('command-confirm-slot') as HTMLElement | null;
  if (slot) return slot;
  const fi = $('fi') as HTMLElement | null;
  const box = $('fi-box') as HTMLElement | null;
  if (!fi || !box) return null;
  const created = document.createElement('div');
  created.id = 'command-confirm-slot';
  created.className = 'command-confirm-slot';
  created.setAttribute('aria-live', 'polite');
  fi.insertBefore(created, box);
  return created;
}

function confirmCommandAsync(input: { command: string; reason: string; permissionSuggestions?: any[] }): Promise<CommandConfirmChoice> {
  return new Promise((resolve) => {
    const suggestions = Array.isArray(input.permissionSuggestions) ? input.permissionSuggestions : [];
    const suggestionLabels = suggestions.map(commandSuggestionLabel).filter(Boolean);
    const allowWorkspace = hasReusablePermissionSuggestion(suggestions);
    clearActiveCommandConfirm('deny');
    const inlineHost = commandConfirmInlineHost();
    if (inlineHost) {
      _activeCommandConfirmResolve = resolve;
      _activeCommandConfirmHost = inlineHost;
      inlineHost.innerHTML = commandConfirmBoxHTML(input, suggestionLabels, allowWorkspace, true);
      inlineHost.classList.add('on');
      inlineHost.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((button) => {
        const choice = button.dataset.choice as CommandConfirmChoice;
        button.addEventListener('click', () => clearActiveCommandConfirm(choice));
      });
      const defaultButton = inlineHost.querySelector<HTMLButtonElement>('[data-choice="session"]');
      setTimeout(() => defaultButton?.focus(), 0);
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay command-confirm-overlay';
    overlay.innerHTML = commandConfirmBoxHTML(input, suggestionLabels, allowWorkspace);
    document.body.appendChild(overlay);
    const close = (choice: CommandConfirmChoice) => { overlay.remove(); resolve(choice); };
    overlay.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((button) => {
      const choice = button.dataset.choice as CommandConfirmChoice;
      button.addEventListener('click', () => close(choice));
    });
    const defaultButton = overlay.querySelector<HTMLButtonElement>('[data-choice="session"]');
    setTimeout(() => defaultButton?.focus(), 0);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close('deny'); });
  });
}

/** 在 viewport 内安全定位右键菜单，自动翻转防止溢出 */
type PermissionConfirmInput = {
  source?: string;
  operation?: string;
  toolName?: string;
  toolOperations?: string[];
  riskLevel?: string;
  workspaceBounded?: boolean;
  permissionRequired?: boolean;
  root?: string;
  path?: string;
  relativePath?: string;
  reason?: string;
  permissionSuggestions?: any[];
};

function permissionOperationLabel(operation?: string): string {
  if (operation === 'tool') return 'Tool';
  if (operation === 'read') return '读取';
  if (operation === 'write') return '写入';
  if (operation === 'create') return '创建';
  if (operation === 'remove') return '删除';
  return operation || '访问';
}

function permissionConfirmBoxHTML(input: PermissionConfirmInput, suggestionLabels: string[], allowWorkspace: boolean, inline = false): string {
  const details = [
    input.toolName ? `Tool: ${input.toolName}` : '',
    input.toolOperations?.length ? `Ops: ${input.toolOperations.join(', ')}` : '',
    input.riskLevel ? `Risk: ${input.riskLevel}` : '',
    typeof input.permissionRequired === 'boolean' ? `Prompt: ${input.permissionRequired ? 'required' : 'tracked'}` : '',
    typeof input.workspaceBounded === 'boolean' ? `Scope: ${input.workspaceBounded ? 'workspace' : 'external'}` : '',
    input.source ? `来源: ${input.source}` : '',
    input.operation ? `操作: ${permissionOperationLabel(input.operation)}` : '',
    input.root ? `Root: ${input.root}` : '',
    input.relativePath ? `相对路径: ${input.relativePath}` : '',
  ].filter(Boolean).join('\n');

  return `
      <div class="command-confirm-box${inline ? ' command-confirm-inline' : ''}" role="dialog" ${inline ? '' : 'aria-modal="true" '}aria-labelledby="permission-confirm-title">
        <div class="command-confirm-head">
          <div id="permission-confirm-title" class="command-confirm-title">确认路径访问</div>
          <div class="command-confirm-reason">${E(input.reason || '该路径访问需要确认')}</div>
        </div>
        <div class="command-confirm-body">
          <div>
            <div class="command-confirm-label">路径</div>
            <pre class="command-confirm-code">${E(input.path || input.toolName || '')}</pre>
          </div>
          ${details ? `<div><div class="command-confirm-label">详情</div><pre class="command-confirm-code">${E(details)}</pre></div>` : ''}
          <div class="command-confirm-scope">
            <div class="command-confirm-label">本会话授权</div>
            ${suggestionLabels.length
              ? `<ul>${suggestionLabels.map((label) => `<li>${E(label)}</li>`).join('')}</ul>`
              : `<div class="command-confirm-empty-scope">本次路径访问没有可持久化的目录或规则授权。</div>`}
          </div>
        </div>
        <div class="command-confirm-actions">
          <button type="button" class="command-confirm-btn danger" data-choice="deny">拒绝</button>
          <button type="button" class="command-confirm-btn" data-choice="once">仅本次允许</button>
          ${allowWorkspace ? '<button type="button" class="command-confirm-btn" data-choice="workspace">本项目允许</button>' : ''}
          <button type="button" class="command-confirm-btn primary" data-choice="session">本会话允许</button>
        </div>
      </div>`;
}

function confirmPermissionAsync(input: PermissionConfirmInput): Promise<CommandConfirmChoice> {
  return new Promise((resolve) => {
    const suggestions = Array.isArray(input.permissionSuggestions) ? input.permissionSuggestions : [];
    const suggestionLabels = suggestions.map(commandSuggestionLabel).filter(Boolean);
    const allowWorkspace = hasReusablePermissionSuggestion(suggestions);
    clearActiveCommandConfirm('deny');
    const inlineHost = commandConfirmInlineHost();
    if (inlineHost) {
      _activeCommandConfirmResolve = resolve;
      _activeCommandConfirmHost = inlineHost;
      inlineHost.innerHTML = permissionConfirmBoxHTML(input, suggestionLabels, allowWorkspace, true);
      inlineHost.classList.add('on');
      inlineHost.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((button) => {
        const choice = button.dataset.choice as CommandConfirmChoice;
        button.addEventListener('click', () => clearActiveCommandConfirm(choice));
      });
      const defaultButton = inlineHost.querySelector<HTMLButtonElement>('[data-choice="session"]');
      setTimeout(() => defaultButton?.focus(), 0);
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay command-confirm-overlay';
    overlay.innerHTML = permissionConfirmBoxHTML(input, suggestionLabels, allowWorkspace);
    document.body.appendChild(overlay);
    const close = (choice: CommandConfirmChoice) => { overlay.remove(); resolve(choice); };
    overlay.querySelectorAll<HTMLButtonElement>('[data-choice]').forEach((button) => {
      const choice = button.dataset.choice as CommandConfirmChoice;
      button.addEventListener('click', () => close(choice));
    });
    const defaultButton = overlay.querySelector<HTMLButtonElement>('[data-choice="session"]');
    setTimeout(() => defaultButton?.focus(), 0);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close('deny'); });
  });
}

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
const App: AppNamespace = window.App;
App.UI.$ = $;
App.UI.S = S;
App.UI.E = E;
App.UI.F = F;
App.UI.sb = sb;
App.UI.toast = toast;
App.UI.bootstrapApi = bootstrapApi;
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
window.bootstrapApi = bootstrapApi;
window.getD = getD; window.refresh = refresh;
window.winCtrl = winCtrl;
window.placeContextMenu = placeContextMenu;
window.mark = mark;
window.logTiming = logTiming;
