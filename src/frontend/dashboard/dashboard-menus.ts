// ═══════════════════════════════════════════════════════════════════
//  文件菜单 (顶部栏下拉)
// ═══════════════════════════════════════════════════════════════════

function toggleFileMenu(ev: MouseEvent): void {
  const existing = $('file-menu');
  if (existing) { existing.remove(); return; }
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'file-menu';
  menu.style.cssText = `position:fixed;top:${rect.bottom+2}px;left:${rect.left}px;z-index:900;background:var(--bs);border:1px solid var(--bd);border-radius:8px;padding:4px;min-width:160px;box-shadow:0 8px 32px rgba(0,0,0,.4)`;
  menu.innerHTML = `
    <div class="fm-item" onclick="fileAction('newWindow');closeFM()">新建窗口</div>
    <div class="fm-item" onclick="fileAction('openFile');closeFM()">打开文件</div>
    <div class="fm-item" onclick="fileAction('openFolder');closeFM()">打开文件夹</div>
    <div class="fm-sep"></div>
    <div class="fm-item" onclick="fileAction('save');closeFM()">保存 <span style="color:var(--tm);font-size:10px;float:right">Ctrl+S</span></div>
    <div class="fm-item" onclick="fileAction('saveAll');closeFM()">全部保存</div>
    <div class="fm-item" onclick="fileAction('toggleAutoSave');closeFM()">${localStorage.getItem('auto-save') === '1' ? '✓ ' : ''}自动保存</div>
    <div class="fm-sep"></div>
    <div class="fm-item" onclick="fileAction('closeWindow');closeFM()">关闭窗口</div>
  `;
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeFMOutside as any, true), 0);
}

function closeFM(): void {
  const el = $('file-menu');
  if (el) el.remove();
  document.removeEventListener('click', closeFMOutside as any, true);
}

function closeFMOutside(ev: MouseEvent): void {
  if (!(ev.target as HTMLElement).closest('#file-menu') && !(ev.target as HTMLElement).closest('.top-tab')) closeFM();
}

function resetWorkspaceState(workspace: string): void {
  const st = window.__state;
  const oldCS = st.CS;
  if (oldCS) { oldCS.onmessage = null; oldCS.onerror = null; oldCS.close(); st.CS = null; }
  st.IL = false;
  App.Chat?.resetMsgKeys?.();
  st.M = [];
  delete (st as any)._sessionTabLabels;
  const tabs = (window as any).__tabs;
  if (tabs) {
    tabs.reset();
    // 清除 st.tabs 防止 TabStore 下一次 _init() 从陈旧 st.tabs 恢复数据
    delete (st as any).tabs;
  }
  localStorage.setItem(App.Constants.WS_KEY, workspace);
  try { localStorage.removeItem('file-tabs'); localStorage.removeItem('last-session-id'); localStorage.removeItem('active-session-tab'); localStorage.removeItem('session-tabs'); localStorage.removeItem('session-tab-labels'); localStorage.removeItem('chat-tab-open'); } catch {}
  // 重置 UiStateStore：清空旧工作区状态，设新 workspacePath
  const uis = (window as any).__uiStateStore;
  if (uis) {
    const newState = {
      schemaVersion: 2,
      workspacePath: workspace,
      activeView: { type: "chat" } as const,
      tabs: { sessions: [], files: [], chatOpen: true, labels: {} },
      panel: { active: "explorer", closed: false, width: 260 },
      recent: { sessions: {} },
    };
    // 直接替换内部状态
    Object.assign(uis._state, newState);
    uis.saveNow();
  }
  App.Chat?.clearAttachments?.();
  const msgsEl = $('ms');
  if (msgsEl) { msgsEl.innerHTML = (window as any).msgs ? (window as any).msgs() : ''; msgsEl.scrollTop = 0; }
  const ci = $('ci') as HTMLTextAreaElement | null;
  if (ci) { ci.disabled = false; ci.value = ''; ci.style.height = 'auto'; }
  const cs = $('cs') as HTMLButtonElement | null;
  if (cs) { cs.disabled = false; cs.title = '发送消息'; cs.innerHTML = S('iup', 16); }
  const m = (window as any).__monaco;
  if (m?.dispose) m.dispose();
  (window as any).__tabs?.activateTab(null);
  (window as any).renderSessionTabs?.();
}

function fileAction(action: string): void {
  const api = (window as any).electronAPI as ElectronAPI | undefined;
  if (action === 'newWindow' && api) api.newWindow();
  else if (action === 'openFile' && api) api.openFile().then((p: string | null) => { if (p) toast('已选择: ' + p); });
  else if (action === 'openFolder' && api) api.openFolder().then(async (p: string | null) => {
    if (p) {
      const oldPath = localStorage.getItem(App.Constants.WS_KEY);
      if (p === oldPath) return; // 同路径不重复切换
      try {
        const r = await fetch('/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: p }) });
        if (!r.ok) throw new Error('workspace switch failed');
      } catch {
        toast('切换工作区失败', 'error');
        return;
      }
      resetWorkspaceState(p);
      toast('工作区: ' + p);
      // 重新渲染 Explorer
      const pc = $('pc');
      if (pc) renderPanel('explorer', pc);
      // 重新加载会话列表 + 刷新 Git
      loadSessions();
      const appNamespace = (window as any).App;
      if (appNamespace?.Git?.refreshGit) setTimeout(() => appNamespace.Git.refreshGit(), 300);
    }
  });
  else if (action === 'save' && api) { /* handled by Monaco Ctrl+S */ }
  else if (action === 'saveAll' && api) { /* handled by Monaco */ }
  else if (action === 'toggleAutoSave') {
    const v = localStorage.getItem('auto-save');
    if (v === '1') localStorage.removeItem('auto-save');
    else localStorage.setItem('auto-save', '1');
    toast('自动保存: ' + (v === '1' ? '关' : '开'));
  }
  else if (action === 'closeWindow' && api) api.close();
}

// ═══════════════════════════════════════════════════════════════════
//  CLI 启动
// ═══════════════════════════════════════════════════════════════════

function launchCli(): void {
  const api = (window as any).electronAPI as ElectronAPI | undefined;
  if (api && api.spawnTerminal) { api.spawnTerminal(); toast('已打开 CLI 终端窗口'); }
  else toast('请先启动 Electron 桌面应用');
}

// 公开 API
window.toggleFileMenu = toggleFileMenu;
window.closeFM = closeFM;
window.fileAction = fileAction as any;
window.resetWorkspaceState = resetWorkspaceState as any;
window.launchCli = launchCli;

// ─── App 命名空间绑定 ──────────────────────────────────────
const AppFile = (window as any).App?.File;
if (AppFile) {
  AppFile.toggleFileMenu = toggleFileMenu;
  AppFile.closeFM = closeFM;
  AppFile.fileAction = fileAction;
  AppFile.resetWorkspaceState = resetWorkspaceState;
  AppFile.launchCli = launchCli;
}
