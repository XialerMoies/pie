/**
 * My Code Agent — Electron 主进程
 * One main process owns multiple workspace windows and their server bindings.
 * Persistent data uses a configurable root; only its pointer stays in OS user data.
 *
 * Each bound window owns one server child and AgentRuntime.
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { randomUUID } from "crypto";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import {
  resolveDesktopProcessPaths,
  validateSecondLaunchDataRoot,
} from "./desktop-bootstrap.js";
import {
  createLegacyLaunchWaiterRegistry,
  parseDesktopLaunchRequest,
  type DesktopLaunchRequest,
} from "./desktop-launch.js";
import {
  isAllowedDesktopIpcUrl,
  registerDesktopIpcHandlers,
  resolveDesktopIpcContext,
  TrustedDesktopRoots,
  type DesktopIpcContext,
  type WorkspaceOpenResult,
} from "./desktop-ipc.js";
import {
  createExternalServerBinding,
  createNoneServerBinding,
  createOwnedServerBinding,
  type ServerBinding,
} from "./server-binding.js";
import { resumeQuitAfterDisposal } from "./quit-coordinator.js";
import { buildCliTerminalLaunch, launchCliTerminal } from "./cli-terminal.js";
import {
  WindowManager,
  type WindowContext,
  type WorkspaceOpenAction as ManagerWorkspaceOpenAction,
} from "./window-manager.js";
import { windowPartitionForInstance } from "./window-partition.js";
import { resolveDataLayout } from "../data/data-layout.js";
import { readDataRootPointer } from "../data/data-root-config.js";
import { resolveStartupPaths } from "../server/startup-paths.js";
import { createDesktopSessionToken } from "../server/security.js";
import { requestJson } from "./electron-http-client.js";
import { createElectronDashboardNavigator } from "./electron-dashboard-navigator.js";
import { createElectronE2ERuntime } from "./electron-e2e-runtime.js";
import { createSecondInstanceCoordinator } from "./electron-launch-coordinator.js";
import { createElectronPackagedE2EProbe } from "./electron-packaged-e2e-probe.js";

function initializeElectron(): void {
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 便携路径 ──────────────────────────────────────────────────────
const APP_ROOT = app.getAppPath();
const RUNTIME_ROOT = app.isPackaged ? path.dirname(process.execPath) : APP_ROOT;
const BOOTSTRAP_OS_USER_DATA = app.getPath("userData");
const ownsSingleInstanceLock = app.requestSingleInstanceLock();
if (!ownsSingleInstanceLock) {
  app.quit();
  return;
}

const E2E_RESULT_FILE = process.env.NODE_ENV === "test" && process.env.MY_CODE_AGENT_E2E_RESULT_FILE
  ? path.resolve(process.env.MY_CODE_AGENT_E2E_RESULT_FILE)
  : null;
const E2E_DATA_DIR = E2E_RESULT_FILE && process.env.MY_CODE_AGENT_E2E_DATA_DIR
  ? path.resolve(process.env.MY_CODE_AGENT_E2E_DATA_DIR)
  : null;
const E2E_MODE = app.isPackaged && !!E2E_RESULT_FILE;
delete process.env.MY_CODE_AGENT_E2E_RESULT_FILE;
delete process.env.MY_CODE_AGENT_E2E_DATA_DIR;
const BOOTSTRAP_PATHS = resolveDesktopProcessPaths({
  osUserData: BOOTSTRAP_OS_USER_DATA,
  runtimeRoot: RUNTIME_ROOT,
  configuredDataRoot: E2E_DATA_DIR || undefined,
});
const CONFIGURED_DATA_ROOT = E2E_DATA_DIR || readDataRootPointer(
  BOOTSTRAP_PATHS.dataRootPointerFile,
  BOOTSTRAP_PATHS.dataRoot,
);
const STARTUP = resolveStartupPaths({
  appRoot: APP_ROOT,
  argv: process.argv.slice(1),
  env: { ...process.env, PI_DATA_ROOT: process.env.PI_DATA_ROOT || CONFIGURED_DATA_ROOT },
});
const DESKTOP_PATHS = resolveDesktopProcessPaths({
  osUserData: BOOTSTRAP_OS_USER_DATA,
  runtimeRoot: RUNTIME_ROOT,
  configuredDataRoot: STARTUP.dataRoot,
});
const DATA_ROOT_POINTER_FILE = DESKTOP_PATHS.dataRootPointerFile;
const DATA_DIR = DESKTOP_PATHS.dataRoot;
const PI_CONFIG_DIR = DESKTOP_PATHS.userRoot;
const SESSIONS_DIR = STARTUP.layout.sessionsDir;
const DESKTOP_SECURITY_TOKEN = (process.env.NODE_ENV === "test" || process.env.VITE_DEV_PORT)
  && process.env.MY_CODE_AGENT_DESKTOP_TOKEN
  ? process.env.MY_CODE_AGENT_DESKTOP_TOKEN
  : createDesktopSessionToken();
delete process.env.MY_CODE_AGENT_DESKTOP_TOKEN;
const VITE_RENDERER_ORIGIN = process.env.VITE_DEV_PORT
  ? `http://127.0.0.1:${Number(process.env.VITE_DEV_PORT)}`
  : undefined;
const DASHBOARD_URL = VITE_RENDERER_ORIGIN
  ? `${VITE_RENDERER_ORIGIN}/dashboard.html`
  : pathToFileURL(path.join(APP_ROOT, "dist", "frontend", "dashboard.html")).href;
const electronBootStartedAt = Date.now();

// Packaged E2E runs in restricted Windows environments where Chromium's GPU
// process and default user cache may be unavailable. Keep this test-only.
fs.mkdirSync(DESKTOP_PATHS.electronUserData, { recursive: true });
fs.mkdirSync(DESKTOP_PATHS.electronCache, { recursive: true });
app.setPath("userData", DESKTOP_PATHS.electronUserData);
app.setPath("cache", DESKTOP_PATHS.electronCache);

const legacyLaunchWaiters = createLegacyLaunchWaiterRegistry();

if (E2E_MODE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function isAllowedAppUrl(rawUrl: string, context?: WindowContext): boolean {
  if (!context) return false;
  return isAllowedDesktopIpcUrl(rawUrl, context as unknown as DesktopIpcContext, {
    dashboardUrl: DASHBOARD_URL,
    viteOrigin: VITE_RENDERER_ORIGIN,
  });
}

function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    let context: WindowContext | undefined;
    try { context = windowManager.contextForSender(win.webContents.id); } catch {}
    if (!isAllowedAppUrl(url, context)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

// ─── Pi 服务器进程 ────────────────────────────────────────────────
let initialContext: WindowContext | null = null;
let initialServerBinding: ServerBinding = createNoneServerBinding();
let allowAppQuit = false;
const e2eRuntime = createElectronE2ERuntime({
  enabled: E2E_MODE,
  electronPid: process.pid,
  resultFile: E2E_RESULT_FILE,
  appRoot: APP_ROOT,
  runtimeRoot: RUNTIME_ROOT,
  dataRoot: DATA_DIR,
  e2eDataRoot: E2E_DATA_DIR,
  desktopSecurityToken: DESKTOP_SECURITY_TOKEN,
  ensureDir,
});

const dashboardNavigator = createElectronDashboardNavigator({
  dashboardUrl: DASHBOARD_URL,
  vitePort: Number(process.env.VITE_DEV_PORT || 0),
  isE2EMode: E2E_MODE,
  isInitialContext: (context) => context === initialContext,
  recordContext: (context) => e2eRuntime.recordContext(context),
  recordTiming: (context, event) => e2eRuntime.recordTiming(context, event),
  logError: (message, error) => console.error(`${message}:`, error),
});

const secondLaunchCoordinator = createSecondInstanceCoordinator({
  electronPid: process.pid,
  e2eEnabled: E2E_MODE,
  validate: (request) => {
    e2eRuntime.stage(`second-instance ${JSON.stringify(request)}`);
    validateSecondLaunchDataRoot(DESKTOP_PATHS.dataRoot, request.dataRoot);
  },
  processRequest: async (request) => {
    if (!request.workspace) {
      createEmptyManagedWindow();
      return;
    }
    const existing = windowManager.contextForWorkspace(request.workspace);
    if (existing?.lifecycle === "active") {
      if (!existing.window.isDestroyed()) existing.window.focus();
      return;
    }
    const context = createEmptyManagedWindow();
    await windowManager.openWorkspace(context, request.workspace);
  },
  resolveWaiter: (instanceId) => legacyLaunchWaiters.resolve(instanceId),
  rejectWaiter: (instanceId, error) => legacyLaunchWaiters.reject(instanceId, error),
  showOverflowNotice: () => {
    dialog.showErrorBox("Cannot open My Code Agent", "The pending window request queue is full.");
  },
  showError: (message) => dialog.showErrorBox("Cannot open My Code Agent", message),
  logError: (message) => console.error(message),
});

app.on("second-instance", (_event, commandLine, workingDirectory) => {
  secondLaunchCoordinator.accept(parseDesktopLaunchRequest(commandLine, workingDirectory));
});

function getAppIconPath(): string | undefined {
  const candidates = [
    path.join(APP_ROOT, "build", "icon.ico"),
    path.join(RUNTIME_ROOT, "build", "icon.ico"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function createWindowOwnedServer(input: {
  workspace: string;
  dataRoot: string;
  layout: typeof STARTUP.layout;
  instanceId: string;
  token: string;
  context?: WindowContext;
}) {
  return createOwnedServerBinding({
    workspace: input.workspace,
    dataRoot: input.dataRoot,
    layout: input.layout,
    instanceId: input.instanceId,
    token: input.token,
    appRoot: APP_ROOT,
    runtimeRoot: RUNTIME_ROOT,
    isPackaged: app.isPackaged,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PI_DEV_PORT: "0",
      PI_DESKTOP_DATA_ROOT_POINTER: DATA_ROOT_POINTER_FILE,
      PI_WORKSPACE: input.workspace,
      PI_DATA_ROOT: input.dataRoot,
      PI_INSTANCE_ID: input.instanceId,
    },
    onUnexpectedExit: ({ code, signal, error }) => {
      const detail = error?.message || `exit code ${code ?? "unknown"}, signal ${signal ?? "none"}`;
      console.error(`Pi server for ${input.workspace} exited unexpectedly: ${detail}`);
    },
  });
}

function createInitialServerBinding(): ServerBinding {
  const vitePort = Number(process.env.VITE_DEV_PORT || 0);
  if (vitePort > 0) {
    const apiPort = Number(process.env.PI_DEV_PORT || vitePort);
    return createExternalServerBinding({
      port: apiPort,
      token: DESKTOP_SECURITY_TOKEN,
      origin: `http://127.0.0.1:${apiPort}`,
    });
  }
  return createWindowOwnedServer({
    workspace: STARTUP.workspace,
    dataRoot: STARTUP.dataRoot,
    layout: STARTUP.layout,
    instanceId: STARTUP.instanceId,
    token: DESKTOP_SECURITY_TOKEN,
  });
}

initialServerBinding = createInitialServerBinding();

// OwnedServerBinding keeps the direct dev path: spawn(process.execPath, ["--import", "tsx", script], ...).
function startPiServer(): Promise<number> {
  return windowManager.startInitialServer();
}

function stopPiServer(): Promise<void> {
  return windowManager.disposeAll();
}

function reloadWindow(_port: number): Promise<void> {
  return initialContext ? dashboardNavigator.loadApplication(initialContext) : Promise.resolve();
}

const windowManager = new WindowManager({
  dataRoot: STARTUP.dataRoot,
  createWindow: createManagedBrowserWindow,
  createInstanceId: () => `instance-${randomUUID()}`,
  createToken: createDesktopSessionToken,
  createTrustedRoots: () => {
    const roots = new TrustedDesktopRoots();
    roots.addRoot(APP_ROOT);
    roots.addRoot(RUNTIME_ROOT);
    return roots;
  },
  createNoneServerBinding,
  resolveDataLayout,
  createOwnedServerBinding: (input) => createWindowOwnedServer(input),
  switchExternalWorkspace: async (context, workspace) => {
    const result = await requestJson(context.server, "/api/workspace/switch", "POST", { workspace });
    if (result.status < 200 || result.status >= 300) {
      const body = result.body && typeof result.body === "object" && "error" in result.body
        ? String((result.body as { error: unknown }).error)
        : JSON.stringify(result.body);
      throw new Error(`External workspace switch failed (${result.status}): ${body}`);
    }
  },
  showWindowStatus: dashboardNavigator.showWindowStatus,
  onServerReady: dashboardNavigator.loadApplication,
  onError: (error, context) => {
    console.error(`Window ${context.id} server lifecycle failed:`, error);
  },
});
windowManager.adoptInitialServerBinding(initialServerBinding);

const packagedE2EProbe = createElectronPackagedE2EProbe({
  enabled: E2E_MODE,
  packaged: app.isPackaged,
  electronPid: process.pid,
  startup: STARTUP,
  dataRoot: DATA_DIR,
  e2eDataRoot: E2E_DATA_DIR,
  initialContext: () => initialContext,
  initialServerBinding: () => initialServerBinding,
  createEmptyManagedWindow,
  windowManager,
  e2eRuntime,
  secondLaunchRecords: () => secondLaunchCoordinator.records,
  ensureDir,
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  getAllWindows: () => BrowserWindow.getAllWindows(),
  quit: () => app.quit(),
});

function createEmptyManagedWindow(): WindowContext {
  const context = windowManager.createEmptyWindow();
  e2eRuntime.recordContext(context);
  return context;
}

// ─── 窗口创建 ──────────────────────────────────────────────────────

function createManagedBrowserWindow(instanceId: string): BrowserWindow {
  console.log(`[startup] electron-create-window wall=${Date.now()} total=${Date.now() - electronBootStartedAt}ms`);
  e2eRuntime.stage(`createWindow:start serverPort=${initialServerBinding.port} vitePort=${process.env.VITE_DEV_PORT || ""}`);

  const windowIcon = getAppIconPath();
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 600,
    minHeight: 400,
    title: "My Code Agent",
    ...(windowIcon ? { icon: windowIcon } : {}),
    backgroundColor: "#06080F",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(APP_ROOT, "dist-electron", "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: windowPartitionForInstance(instanceId),
    },
    show: false,
    autoHideMenuBar: true,
  });
  e2eRuntime.markWindowCreated(win);
  e2eRuntime.stage("createWindow:browser-window-created");
  hardenWindow(win);
  e2eRuntime.stage(`createWindow:loadURL ${win.webContents.getURL() || "pending"}`);

  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  console.log(`[startup] electron-ready wall=${Date.now()} total=${Date.now() - electronBootStartedAt}ms`);
  console.log("✅ Window ready");

  win.webContents.on("did-finish-load", () => {
    e2eRuntime.stage(`webContents:did-finish-load ${win.webContents.getURL() || ""}`);
    if (initialContext?.window === win) void packagedE2EProbe.run(win);
    console.log("📄 Page loaded:", win.webContents.getTitle());
  });

  win.webContents.on("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, url: string) => {
    e2eRuntime.stage(`webContents:did-fail-load ${errorCode} ${errorDescription} ${url}`);
    console.error(`❌ Window load failed: ${errorDescription} (code: ${errorCode}) url: ${url}`);
  });

  win.webContents.on("console-message", (details) => {
    e2eRuntime.captureDiagnostic(`console[${details.level}] ${details.sourceId}:${details.lineNumber} ${details.message}`);
    if (details.message.includes("[startup]") || details.message.includes("404") || details.message.includes("Failed") || details.message.includes("Error")) {
      console.warn(`[page:${details.sourceId}:${details.lineNumber}] ${details.message}`);
    }
  });

  win.webContents.on("preload-error" as any, (_event: Electron.Event, preloadPath: string, error: Error) => {
    e2eRuntime.stage(`webContents:preload-error ${preloadPath}`);
    e2eRuntime.captureDiagnostic(`preload-error-detail ${preloadPath}: ${error.stack || error.message}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    e2eRuntime.stage(`webContents:render-process-gone ${details.reason} ${details.exitCode}`);
  });
  win.webContents.on("unresponsive", () => e2eRuntime.stage("webContents:unresponsive"));

  win.once("focus", () => console.log("🔲 Window focused"));

  return win;
}

function createWindow(): WindowContext {
  if (initialContext?.lifecycle === "active" && !initialContext.window.isDestroyed()) {
    initialContext.window.focus();
    e2eRuntime.stage("createWindow:reused");
    return initialContext;
  }
  initialContext = windowManager.createInitialWindow({
    instanceId: STARTUP.instanceId,
    workspace: STARTUP.workspace,
    layout: STARTUP.layout,
    token: DESKTOP_SECURITY_TOKEN,
    server: initialServerBinding,
  });
  e2eRuntime.recordContext(initialContext);
  return initialContext;
}



// ─── IPC 窗口控制 ────────────────────────────────────────────────

// ─── IPC 文件菜单 ──────────────────────────────────────────────────
function spawnCliTerminal(context: DesktopIpcContext): boolean {
  if (!context.workspace) return false;
  const launch = buildCliTerminalLaunch({
    platform: process.platform,
    appRoot: APP_ROOT,
    workspace: context.workspace,
    dataRoot: DATA_DIR,
    electronExecutable: process.execPath,
    isPackaged: app.isPackaged,
    env: process.env,
  });
  return launchCliTerminal(launch);
}

function resolveDesktopContext(event: unknown): DesktopIpcContext {
  return resolveDesktopIpcContext(event, {
    contextForSender: (senderId) => windowManager.contextForSender(senderId) as unknown as DesktopIpcContext,
    dashboardUrl: DASHBOARD_URL,
    viteOrigin: VITE_RENDERER_ORIGIN,
  });
}

async function selectDialogPath(
  context: DesktopIpcContext,
  property: "openFile" | "openDirectory",
): Promise<string | null> {
  const result = await dialog.showOpenDialog(context.window as BrowserWindow, {
    properties: [property],
  });
  return result.canceled ? null : result.filePaths[0] || null;
}

function mapWorkspaceOpenAction(action: ManagerWorkspaceOpenAction): WorkspaceOpenResult["action"] {
  return action === "bound" ? "binding" : action === "switched" ? "switching" : action;
}

async function openWorkspaceFolder(context: DesktopIpcContext): Promise<WorkspaceOpenResult | null> {
  const selected = await selectDialogPath(context, "openDirectory");
  if (!selected) return null;
  const action = await windowManager.openWorkspace(context as unknown as WindowContext, selected);
  return { ok: true, workspace: selected, action: mapWorkspaceOpenAction(action) };
}

if (ownsSingleInstanceLock) {
  registerDesktopIpcHandlers({
    ipcMain,
    resolveContext: resolveDesktopContext,
    createEmptyWindow: () => {
      const context = createEmptyManagedWindow();
      return { ok: true as const, instanceId: context.instanceId };
    },
    openWorkspaceFolder,
    retryWorkspace: async (context) => {
      await windowManager.retryWorkspace(context as unknown as WindowContext);
    },
    selectFolder: (context) => selectDialogPath(context, "openDirectory"),
    selectFile: (context) => selectDialogPath(context, "openFile"),
    showItemInFolder: (_context, filePath) => shell.showItemInFolder(filePath),
    trashItem: (_context, filePath) => shell.trashItem(filePath),
    spawnTerminal: spawnCliTerminal,
  });
}

const earlyServerReady = process.env.VITE_DEV_PORT ? null : startPiServer();
void earlyServerReady?.catch(() => undefined);

app.whenReady().then(async () => {
  if (!ownsSingleInstanceLock) return;
  e2eRuntime.stage("app:when-ready");
  ensureDir(DATA_DIR);
  ensureDir(PI_CONFIG_DIR);
  ensureDir(SESSIONS_DIR);

  const isDev = process.env.VITE_DEV_PORT;
  if (isDev) {
    console.log(`📡 Dev mode: loading from Vite at http://127.0.0.1:${isDev}`);
    const context = createWindow();
    if (context.server.kind === "external") await dashboardNavigator.loadApplication(context);
  } else {
    const serverReady = earlyServerReady ?? startPiServer();
    e2eRuntime.stage("app:before-create-window");
    const context = createWindow();
    e2eRuntime.stage("app:after-create-window");
    try {
      const port = await serverReady;
      console.log(`✅ Pi server started on port ${port}`);
      await reloadWindow(port);
    } catch (err) {
      if (windowManager.reportWorkspaceFailure(context, err)) {
        dialog.showErrorBox("无法启动 My Code Agent", err instanceof Error ? err.message : String(err));
        console.error("❌ Failed to start:", err);
        if (!context.window.isDestroyed()) context.window.focus();
      }
    }
  }

  await secondLaunchCoordinator.markReady();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createEmptyManagedWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (!ownsSingleInstanceLock) return;
  if (process.platform === "darwin") {
    void stopPiServer().catch((error) => {
      console.error("Failed to stop Pi server while closing windows:", error);
    });
  } else {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (!ownsSingleInstanceLock) return;
  if (allowAppQuit) return;
  event.preventDefault();
  void resumeQuitAfterDisposal({
    dispose: stopPiServer,
    resumeQuit: () => {
      allowAppQuit = true;
      app.quit();
    },
    reportFailure: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[electron] Shutdown failed; application remains open: ${message}`);
    },
  });
});
}

initializeElectron();
