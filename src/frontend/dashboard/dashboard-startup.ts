App.Events.subscribe('dashboard.changed', () => { void getD(); });
App.Events.subscribe('resync', () => { void getD(); });

const EMPTY_WORKSPACE_MODE = /(?:^|[?&])empty-workspace=1(?:&|$)/.test(
  String((window as any).location?.search || ''),
);
const WORKSPACE_STATUS = readWorkspaceStatusFromUrl();
const WORKSPACE_STATUS_MODE = WORKSPACE_STATUS !== null;
(window as any).__emptyWorkspaceMode = EMPTY_WORKSPACE_MODE;
(window as any).__workspaceStatusMode = WORKSPACE_STATUS_MODE;

function readWorkspaceStatusFromUrl(): WorkspaceStatus | null {
  const search = String((window as any).location?.search || '');
  if (typeof URLSearchParams !== 'undefined') {
    const params = new URLSearchParams(search);
    return workspaceStatusFromValues(
      params.get('workspace-state'),
      params.get('workspace'),
      params.get('message'),
    );
  }
  const value = (name: string): string | null => {
    const match = new RegExp(`(?:^|[?&])${name}=([^&]*)`).exec(search);
    if (!match) return null;
    try {
      return decodeURIComponent(match[1].replace(/\+/g, ' '));
    } catch {
      return match[1];
    }
  };
  return workspaceStatusFromValues(value('workspace-state'), value('workspace'), value('message'));
}

function workspaceStatusFromValues(
  state: string | null,
  workspace: string | null,
  message: string | null,
): WorkspaceStatus | null {
  if ((state !== 'starting' && state !== 'failed') || !workspace) return null;
  if (state === 'failed') {
    return {
      state,
      workspace,
      message: message || '服务器未能启动。',
    };
  }
  return { state, workspace };
}

function workspaceStatusLabel(workspace: string): string {
  const normalized = workspace.replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).at(-1) || workspace;
}

function renderWorkspaceStatus(status: WorkspaceStatus): void {
  if (typeof document.getElementById !== 'function') return;
  const overlay = document.getElementById('workspace-status-overlay');
  if (!overlay) return;
  const panels = [...overlay.querySelectorAll<HTMLElement>('[data-workspace-status]')];
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.workspaceStatus !== status.state;
  });
  if (status.state === 'idle') {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  const workspace = overlay.querySelector<HTMLElement>('[data-workspace-status-workspace]');
  if (workspace) workspace.textContent = `正在准备 ${workspaceStatusLabel(status.workspace)}...`;
  const message = overlay.querySelector<HTMLElement>('[data-workspace-status-message]');
  if (message && status.state === 'failed') message.textContent = status.message;
}

function bindWorkspaceStatus(): () => void {
  if (typeof document.getElementById !== 'function') return () => undefined;
  const api = window.electronAPI;
  const overlay = document.getElementById('workspace-status-overlay');
  if (!api?.onWorkspaceStatus || !overlay) return () => undefined;
  let retryPending = false;
  let currentStatus = WORKSPACE_STATUS;
  const retryButton = overlay.querySelector<HTMLButtonElement>('[data-workspace-status-action="retry"]');
  const onStatus = (status: WorkspaceStatus): void => {
    currentStatus = status;
    renderWorkspaceStatus(status);
  };
  const onClick = (event: Event): void => {
    const target = event.target as Element | null;
    const action = target?.closest<HTMLElement>('[data-workspace-status-action]')?.dataset.workspaceStatusAction;
    if (action === 'open-folder') {
      void api.openWorkspaceFolder().catch(() => undefined);
      return;
    }
    if (action !== 'retry' || retryPending || !retryButton) return;
    const failed = currentStatus?.state === 'failed' ? currentStatus : null;
    if (!failed) return;
    retryPending = true;
    retryButton.disabled = true;
    retryButton.setAttribute('aria-busy', 'true');
    void api.retryWorkspace()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        onStatus({ state: 'failed', workspace: failed.workspace, message });
      })
      .finally(() => {
        retryPending = false;
        retryButton.disabled = false;
        retryButton.removeAttribute('aria-busy');
      });
  };
  overlay.addEventListener('click', onClick);
  const unsubscribe = api.onWorkspaceStatus(onStatus);
  if (currentStatus) renderWorkspaceStatus(currentStatus);
  return () => {
    overlay.removeEventListener('click', onClick);
    unsubscribe();
  };
}

bindWorkspaceStatus();

function applyHydratedTheme(): void {
  const theme = App.Preferences.get('editor-theme', 'vs-dark');
  document.documentElement.classList.toggle('theme-light', theme === 'vs');
}

const PREFERENCE_HYDRATION_STARTUP_TIMEOUT_MS = 5000;

async function hydratePreferencesForStartup(): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      App.Preferences.hydrate(),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, PREFERENCE_HYDRATION_STARTUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

let preferenceStartupComplete = false;

function waitForDashboardContentPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function dashboardStartupNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function applyLateHydratedPreferences(): void {
  applyExplorerPreferences();
  applyHydratedTheme();
  App.Chat?.loadModeState?.();
  App.Chat?.refreshReadingSettings?.();
  window.__monaco?.updateSettings?.();
}

App.Preferences.onHydrated?.(() => {
  if (!preferenceStartupComplete) return;
  applyLateHydratedPreferences();
});

async function startDashboard(): Promise<void> {
  const t0 = dashboardStartupNow();
  let tBootstrap = t0, tHydrate = t0, tLayout = t0;
  if (!EMPTY_WORKSPACE_MODE && !WORKSPACE_STATUS_MODE) {
    await bootstrapApi();
    tBootstrap = dashboardStartupNow();
    try {
      await hydratePreferencesForStartup();
    } catch (error) {
      console.warn("[dashboard-startup] preference hydration failed", error);
    } finally {
      tHydrate = dashboardStartupNow();
    }
  }
  applyExplorerPreferences();
  applyHydratedTheme();
  document.documentElement.classList.remove("preferences-loading");
  layout();
  tLayout = dashboardStartupNow();
  preferenceStartupComplete = true;

  if (EMPTY_WORKSPACE_MODE || WORKSPACE_STATUS_MODE) {
    console.info(`[startup] empty-workspace-ready total=${(tLayout - t0).toFixed(0)}ms`);
    return;
  }

  void (async () => {
    try {
      await App.Events.start();
    } catch (error) {
      console.warn("[dashboard-startup] event channel unavailable", error);
    }
    const tEvents = dashboardStartupNow();
    await Promise.all([
      Promise.resolve(getD()),
      Promise.resolve(App.Session.whenReady?.()),
      Promise.resolve(App.Session.loadSessions()),
    ]);
    const tData = dashboardStartupNow();
    await waitForDashboardContentPaint();
    const tPaint = dashboardStartupNow();
    console.info(
      `[startup] content-ready wall=${Date.now()}`
      + ` total=${(tPaint - t0).toFixed(0)}ms`
      + ` bootstrap=${(tBootstrap - t0).toFixed(0)}ms`
      + ` preferences=${(tHydrate - tBootstrap).toFixed(0)}ms`
      + ` layout=${(tLayout - tHydrate).toFixed(0)}ms`
      + ` events=${(tEvents - tLayout).toFixed(0)}ms`
      + ` content=${(tData - tEvents).toFixed(0)}ms`
      + ` paint=${(tPaint - tData).toFixed(0)}ms`,
    );
  })();
}

void startDashboard().catch((error) => {
  document.documentElement.classList.remove("preferences-loading");
  console.error("[dashboard-startup] bootstrap failed", error);
  toast("Desktop authentication failed. Restart the application.", "error");
});
