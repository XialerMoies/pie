import type { WindowContext, WorkspaceStatus } from "./window-manager.js";

interface DashboardWindow {
  webContents: {
    getURL(): string;
    send(channel: "workspace-status", status: WorkspaceStatus): void;
  };
  isDestroyed(): boolean;
  show(): void;
  loadURL(url: string): Promise<unknown>;
}

interface WorkspaceStatusLoad {
  ready: boolean;
  status: WorkspaceStatus;
}

interface ElectronDashboardNavigatorOptions {
  dashboardUrl: string;
  vitePort: number;
  isE2EMode: boolean;
  isInitialContext(context: WindowContext): boolean;
  recordContext(context: WindowContext): void;
  recordTiming(context: WindowContext, event: "shell-visible" | "server-ready" | "workbench-loaded"): void;
  logError(message: string, error: unknown): void;
}

export function createElectronDashboardNavigator(options: ElectronDashboardNavigatorOptions) {
  const workspaceStatusLoads = new WeakMap<DashboardWindow, WorkspaceStatusLoad>();

  function dashboardWindow(context: WindowContext): DashboardWindow {
    return context.window as unknown as DashboardWindow;
  }

  function dashboardStatusUrl(status: WorkspaceStatus): string {
    const params = new URLSearchParams();
    if (status.state === "idle") {
      params.set("empty-workspace", "1");
    } else {
      params.set("workspace-state", status.state);
      params.set("workspace", status.workspace);
      if (status.state === "failed") params.set("message", status.message);
    }
    return `${options.dashboardUrl}?${params.toString()}`;
  }

  function showWindowStatus(context: WindowContext, status: WorkspaceStatus): void {
    const win = dashboardWindow(context);
    if (win.isDestroyed()) return;
    options.recordContext(context);
    if (!options.isE2EMode) win.show();

    const current = workspaceStatusLoads.get(win);
    if (current && (!current.ready || win.webContents.getURL().startsWith(options.dashboardUrl))) {
      current.status = status;
      if (current.ready) win.webContents.send("workspace-status", status);
      return;
    }

    const load: WorkspaceStatusLoad = { ready: false, status };
    workspaceStatusLoads.set(win, load);
    void win.loadURL(dashboardStatusUrl(status)).then(() => {
      if (win.isDestroyed() || workspaceStatusLoads.get(win) !== load) return;
      load.ready = true;
      if (options.isE2EMode) win.show();
      options.recordTiming(context, "shell-visible");
      win.webContents.send("workspace-status", load.status);
    }).catch((error) => {
      options.logError(`Window ${context.id} dashboard status navigation failed`, error);
    });
  }

  async function loadApplication(context: WindowContext): Promise<void> {
    const win = dashboardWindow(context);
    if (win.isDestroyed()) return;
    options.recordTiming(context, "server-ready");
    const vitePort = options.isInitialContext(context) ? options.vitePort : 0;
    const target = vitePort > 0 ? `http://127.0.0.1:${vitePort}` : context.server.origin;
    if (!target) return;
    workspaceStatusLoads.delete(win);
    win.show();
    await win.loadURL(target);
    options.recordTiming(context, "workbench-loaded");
  }

  return { showWindowStatus, loadApplication };
}
