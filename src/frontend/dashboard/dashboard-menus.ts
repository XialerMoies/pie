// ═══════════════════════════════════════════════════════════════════
//  文件菜单 (顶部栏下拉)
// ═══════════════════════════════════════════════════════════════════

interface DashboardMenuDependencies {
  preferences: AppPreferences;
}

const dashboardMenuApp = (window as any).App;
const dashboardMenuDependencies: DashboardMenuDependencies = {
  preferences: dashboardMenuApp.Preferences,
};
const { preferences: dashboardMenuPreferences } = dashboardMenuDependencies;

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
    <div class="fm-item" data-file-action="toggleAutoSave">${dashboardMenuPreferences.getBoolean('auto-save') ? '✓ ' : ''}自动保存</div>
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

function fileAction(action: string): void {
  const api = (window as any).electronAPI as ElectronAPI | undefined;
  if (action === 'newWindow' && api) {
    void api.newWindow().then((result) => {
      if (result?.ok) toast('已打开新窗口', 'success');
    }).catch((error) => toast(`新窗口启动失败: ${(error as Error).message}`, 'error'));
  }
  else if (action === 'openFile' && api) {
    void api.selectFile()
      .then((p: string | null) => { if (p) toast('已选择: ' + p); })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        toast(`选择文件失败: ${detail}`, 'error');
      });
  }
  else if (action === 'openFolder' && api) {
    void api.openWorkspaceFolder().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      toast(`打开工作区失败: ${detail}`, 'error');
    });
  }
  else if (action === 'save' && api) { /* handled by Monaco Ctrl+S */ }
  else if (action === 'saveAll' && api) { /* handled by Monaco */ }
  else if (action === 'toggleAutoSave') {
    const v = dashboardMenuPreferences.getBoolean('auto-save');
    dashboardMenuPreferences.setBoolean('auto-save', !v);
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
window.launchCli = launchCli;

// ─── App 命名空间绑定 ──────────────────────────────────────
const AppFile = (window as any).App?.File;
if (AppFile) {
  AppFile.toggleFileMenu = toggleFileMenu;
  AppFile.closeFM = closeFM;
  AppFile.fileAction = fileAction;
  AppFile.launchCli = launchCli;
}
