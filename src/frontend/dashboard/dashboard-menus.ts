// ═══════════════════════════════════════════════════════════════════
//  文件菜单 (顶部栏下拉)
// ═══════════════════════════════════════════════════════════════════

function toggleFileMenu(ev: MouseEvent, trigger?: HTMLElement): void {
  const existing = $('file-menu');
  if (existing) { existing.remove(); return; }
  const anchor = trigger || ev.currentTarget as HTMLElement | null;
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.id = 'file-menu';
  menu.style.cssText = `position:fixed;top:${rect.bottom+2}px;left:${rect.left}px;z-index:900;background:var(--bs);border:1px solid var(--bd);border-radius:8px;padding:4px;min-width:160px;box-shadow:0 8px 32px rgba(0,0,0,.4)`;
  menu.innerHTML = `
    <div class="fm-item" data-file-action="newWindow">新建窗口</div>
    <div class="fm-item" data-file-action="openFile">打开文件</div>
    <div class="fm-item" data-file-action="openFolder">打开文件夹</div>
    <div class="fm-sep"></div>
    <div class="fm-item" data-file-action="save">保存 <span style="color:var(--tm);font-size:10px;float:right">Ctrl+S</span></div>
    <div class="fm-item" data-file-action="saveAll">全部保存</div>
    <div class="fm-item" data-file-action="toggleAutoSave">${App.Preferences.getBoolean('auto-save') ? '✓ ' : ''}自动保存</div>
    <div class="fm-sep"></div>
    <div class="fm-item" data-file-action="closeWindow">关闭窗口</div>
  `;
  menu.addEventListener('click', (event: MouseEvent) => {
    const eventTarget = event.target as Element | null;
    const item = typeof eventTarget?.closest === 'function'
      ? eventTarget.closest<HTMLElement>('[data-file-action]')
      : null;
    if (!item || !menu.contains(item)) return;
    const action = item.dataset.fileAction;
    if (!action) return;
    fileAction(action);
    closeFM();
  });
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
  App.ChatStream.close();
  App.ChatState.setBusy(false);
  App.Chat?.resetMsgKeys?.();
  App.ChatState.clearMessages();
  const tabs = App.Tabs;
  if (tabs) {
    // TabStore 自己清空兼容投影，避免新 workspace 恢复旧标签。
    tabs.reset();
  }
  App.State.resetWorkspace(workspace);
  App.Chat?.clearAttachments?.();
  const msgsEl = $('ms');
  if (msgsEl) { msgsEl.innerHTML = (window as any).msgs ? (window as any).msgs() : ''; msgsEl.scrollTop = 0; }
  App.ChatTimeline?.sync();
  const ci = $('ci') as HTMLTextAreaElement | null;
  if (ci) { ci.disabled = false; ci.value = ''; ci.style.height = 'auto'; }
  const cs = $('cs') as HTMLButtonElement | null;
  if (cs) { cs.disabled = false; cs.title = '发送消息'; cs.innerHTML = S('iup', 16); }
  const m = (window as any).__monaco;
  if (m?.dispose) m.dispose();
  App.Tabs?.activateTab(null);
  (window as any).renderSessionTabs?.();
}

function workspacePathKey(path: string): string {
  const trimmed = path.trim();
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
    return trimmed.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  }
  return trimmed.replace(/\/+$/, '');
}

async function workspaceSwitchError(response: Response): Promise<string> {
  const body = await response.text().catch(() => '');
  if (!body) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
    const message = typeof parsed.error === 'string' && parsed.error ? parsed.error : `HTTP ${response.status}`;
    const code = typeof parsed.code === 'string' && parsed.code ? ` (${parsed.code})` : '';
    return `${message}${code}`;
  } catch {
    return body;
  }
}

function fileAction(action: string): void {
  const api = (window as any).electronAPI as ElectronAPI | undefined;
  if (action === 'newWindow' && api) api.newWindow();
  else if (action === 'openFile' && api) api.openFile().then((p: string | null) => { if (p) toast('已选择: ' + p); });
  else if (action === 'openFolder' && api) api.openFolder().then(async (p: string | null) => {
    if (p) {
      const oldPath = App.State.getWorkspacePath();
      if (oldPath && workspacePathKey(p) === workspacePathKey(oldPath)) return;
      try {
        const r = await fetch('/api/workspace/switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: p }) });
        if (!r.ok) throw new Error(await workspaceSwitchError(r));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        toast(`切换工作区失败: ${p} - ${detail}`, 'error');
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
    const v = App.Preferences.getBoolean('auto-save');
    App.Preferences.setBoolean('auto-save', !v);
    toast('自动保存: ' + (v ? '关' : '开'));
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
