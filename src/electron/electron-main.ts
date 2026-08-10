/**
 * My Code Agent — Electron 主进程
 * One main process owns multiple workspace windows and their server bindings.
 * Persistent data uses a configurable root; only its pointer stays in OS user data.
 *
 * Each bound window owns one server child and AgentRuntime.
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { randomUUID } from "crypto";
import * as http from "http";
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
  type WorkspaceStatus,
  type WorkspaceOpenAction as ManagerWorkspaceOpenAction,
} from "./window-manager.js";
import { windowPartitionForInstance } from "./window-partition.js";
import { resolveDataLayout } from "../data/data-layout.js";
import { readDataRootPointer } from "../data/data-root-config.js";
import { resolveStartupPaths } from "../server/startup-paths.js";
import { createDesktopSessionToken } from "../server/security.js";
import {
  createElectronE2EDiagnostics,
  createElectronE2EFailureDiagnostic,
  sanitizeE2EReopenError,
  type ElectronE2EReopenErrorDiagnostic,
} from "./e2e-diagnostics.js";

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

const pendingSecondLaunches: DesktopLaunchRequest[] = [];
const MAX_PENDING_SECOND_LAUNCHES = 32;
let secondLaunchHandlingReady = false;
let pendingSecondLaunchOverflowNoticeShown = false;
const legacyLaunchWaiters = createLegacyLaunchWaiterRegistry();
let drainingSecondLaunches: Promise<void> | null = null;
const e2eSecondLaunches: Array<{ electronPid: number; request: DesktopLaunchRequest; handledAt: number }> = [];

function showPendingSecondLaunchNotice(): void {
  dialog.showErrorBox("Cannot open My Code Agent", "The pending window request queue is full.");
}

function drainPendingSecondLaunches(): void {
  if (drainingSecondLaunches) return;
  drainingSecondLaunches = (async () => {
    while (pendingSecondLaunches.length > 0) {
      const request = pendingSecondLaunches.shift();
      if (request) await processSecondLaunchRequest(request);
    }
    pendingSecondLaunchOverflowNoticeShown = false;
  })().finally(() => {
    drainingSecondLaunches = null;
    if (pendingSecondLaunches.length > 0) drainPendingSecondLaunches();
  });
}

function handleSecondLaunchRequest(request: DesktopLaunchRequest): void {
  try {
    if (E2E_MODE) e2eStage(`second-instance ${JSON.stringify(request)}`);
    validateSecondLaunchDataRoot(DESKTOP_PATHS.dataRoot, request.dataRoot);
    if (pendingSecondLaunches.length >= MAX_PENDING_SECOND_LAUNCHES) {
      const message = "The pending window request queue is full.";
      console.error(message);
      if (request.instanceId) legacyLaunchWaiters.reject(request.instanceId, new Error(message));
      if (!pendingSecondLaunchOverflowNoticeShown) {
        pendingSecondLaunchOverflowNoticeShown = true;
        showPendingSecondLaunchNotice();
      }
      return;
    }
    pendingSecondLaunches.push(request);
    if (secondLaunchHandlingReady) drainPendingSecondLaunches();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (request.instanceId) legacyLaunchWaiters.reject(request.instanceId, new Error(message));
    console.error(message);
    dialog.showErrorBox("Cannot open My Code Agent", message);
  }
}

async function processSecondLaunchRequest(request: DesktopLaunchRequest): Promise<void> {
  try {
    if (!request.workspace) {
      createEmptyManagedWindow();
    } else {
      const existing = windowManager.contextForWorkspace(request.workspace);
      if (existing?.lifecycle === "active") {
        if (!existing.window.isDestroyed()) existing.window.focus();
      } else {
        const context = createEmptyManagedWindow();
        await windowManager.openWorkspace(context, request.workspace);
      }
    }
    if (E2E_MODE) {
      e2eSecondLaunches.push({ electronPid: process.pid, request, handledAt: Date.now() });
    }
    if (request.instanceId) legacyLaunchWaiters.resolve(request.instanceId);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (request.instanceId) legacyLaunchWaiters.reject(request.instanceId, failure);
    console.error("Failed to process second launch:", failure);
    dialog.showErrorBox("Cannot open My Code Agent", failure.message);
  }
}

app.on("second-instance", (_event, commandLine, workingDirectory) => {
  handleSecondLaunchRequest(parseDesktopLaunchRequest(commandLine, workingDirectory));
});

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
let mainWindow: BrowserWindow | null = null;
let initialContext: WindowContext | null = null;
let initialServerBinding: ServerBinding = createNoneServerBinding();
let allowAppQuit = false;
let e2eProbeStarted = false;
const e2eDiagnostics: string[] = [];
const e2eRecorder = E2E_MODE
  ? createElectronE2EDiagnostics({ electronPid: process.pid })
  : null;
const e2eWindowCreatedAt = new WeakMap<BrowserWindow, number>();
const e2eRecordedContexts = new Set<string>();
const e2eTrackedContexts = new Set<WindowContext>();

function e2eFailureSnapshot() {
  const contexts = [...e2eTrackedContexts].filter((context) => (
    context.lifecycle !== "closed" && !context.window.isDestroyed()
  ));
  return e2eRecorder?.snapshot(contexts) || {
    electronPid: process.pid,
    windows: [],
    timings: [],
  };
}

function e2eFailureRedactions() {
  const roots: Array<{ value: string; label: string }> = [];
  const addRoot = (value: string | null | undefined, label: string) => {
    if (!value) return;
    roots.push({ value, label });
    if (value.includes("\\")) roots.push({ value: value.replaceAll("\\", "/"), label });
  };
  addRoot(APP_ROOT, "<app-root>");
  addRoot(RUNTIME_ROOT, "<runtime-root>");
  addRoot(DATA_DIR, "<data-root>");
  addRoot(E2E_DATA_DIR, "<e2e-data-root>");
  addRoot(E2E_RESULT_FILE ? path.dirname(E2E_RESULT_FILE) : null, "<temp-root>");
  for (const context of e2eTrackedContexts) {
    addRoot(context.workspace, "<workspace-root>");
    if (context.layout) {
      for (const value of Object.values(context.layout)) addRoot(value, "<private-root>");
    }
  }
  return {
    secrets: [
      DESKTOP_SECURITY_TOKEN,
      ...[...e2eTrackedContexts].map((context) => context.server.token),
    ].filter(Boolean),
    roots,
  };
}

function recordE2EContext(context: WindowContext): void {
  if (!e2eRecorder || e2eRecordedContexts.has(context.id)) return;
  e2eRecordedContexts.add(context.id);
  e2eTrackedContexts.add(context);
  e2eRecorder.record(
    context,
    "window-created",
    e2eWindowCreatedAt.get(context.window as BrowserWindow) || Date.now(),
  );
}

function recordE2ETiming(
  context: WindowContext,
  event: "shell-visible" | "server-ready" | "workbench-loaded",
): number | null {
  if (!e2eRecorder) return null;
  recordE2EContext(context);
  return e2eRecorder.record(context, event);
}

function latestE2ETiming(context: WindowContext, event: "window-created" | "shell-visible" | "server-ready" | "workbench-loaded"): number | null {
  if (!e2eRecorder) return null;
  return [...e2eRecorder.snapshot([]).timings].reverse().find((timing) => (
    timing.contextId === context.id && timing.event === event
  ))?.at || null;
}

function e2eStage(message: string): void {
  if (!E2E_MODE) return;
  e2eDiagnostics.push(message);
  console.log(`[e2e] ${message}`);
}

function requestStatus(url: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolveStatus(response.statusCode || 0);
    });
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("E2E HTTP request timed out")));
  });
}

function requestJson(
  pathname: string,
  method = "GET",
  payload?: unknown,
  options: {
    includeToken?: boolean;
    headers?: Record<string, string>;
    timeoutMs?: number;
    binding?: ServerBinding;
  } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolveRequest, reject) => {
    const binding = options.binding || initialServerBinding;
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const request = http.request(`http://127.0.0.1:${binding.port}${pathname}`, {
      method,
      headers: {
        ...(options.includeToken === false ? {} : { "X-My-Code-Agent-Token": binding.token }),
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        ...options.headers,
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolveRequest({ status: response.statusCode || 0, body: parsed });
      });
    });
    request.once("error", reject);
    request.setTimeout(options.timeoutMs ?? 10_000, () => request.destroy(new Error(`E2E HTTP request timed out: ${pathname}`)));
    if (body) request.write(body);
    request.end();
  });
}

async function waitForRendererReady(win: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 30_000;
  let snapshot: unknown = null;
  while (Date.now() < deadline) {
    snapshot = await win.webContents.executeJavaScript(
      `({
        readyState: document.readyState,
        pageUrl: location.href,
        electronApiType: typeof window.electronAPI,
        appChildCount: document.querySelector('#app')?.childElementCount ?? -1,
        bodyText: document.body?.innerText?.slice(0, 300) || '',
        bootstrapApiType: typeof window.bootstrapApi,
        layoutType: typeof window.layout,
        appStateType: typeof window.App?.State,
        scripts: Array.from(document.scripts).map((script) => script.src || '[inline]'),
      })`,
      true,
    );
    const state = snapshot as { electronApiType?: string; appChildCount?: number };
    if (state.electronApiType === "object" && Number(state.appChildCount) > 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Renderer did not finish dashboard bootstrap within 30 seconds: ${JSON.stringify(snapshot)}`);
}

async function runRendererCookieIsolationProbe(
  first: BrowserWindow,
  second: BrowserWindow,
): Promise<{ firstDashboardStatus: number; secondDashboardStatus: number }> {
  const bootstrap = (win: BrowserWindow) => win.webContents.executeJavaScript(`(async () => {
    if (typeof window.bootstrapApi !== "function") throw new Error("Renderer bootstrap API is unavailable");
    await window.bootstrapApi();
  })()`, true);
  await bootstrap(first);
  await bootstrap(second);
  const dashboard = (win: BrowserWindow) => win.webContents.executeJavaScript(`(async () => {
    const response = await fetch("/api/dashboard", { credentials: "include", cache: "no-store" });
    return response.status;
  })()`, true);
  const [firstDashboardStatus, secondDashboardStatus] = await Promise.all([
    dashboard(first),
    dashboard(second),
  ]);
  return { firstDashboardStatus, secondDashboardStatus };
}

async function collectRendererE2EResult(win: BrowserWindow, outsidePath: string): Promise<Record<string, unknown>> {
  return win.webContents.executeJavaScript(`(async () => {
    const api = window.electronAPI;
    const preloadMethods = api ? Object.keys(api).sort() : [];
    const token = api?.getDesktopSessionToken ? await api.getDesktopSessionToken() : '';
    const response = await fetch('/api/dashboard', {
      cache: 'no-store',
      headers: token ? { 'X-My-Code-Agent-Token': token } : {},
    });
    const popup = window.open('https://example.com', '_blank');
    const initialUrl = location.href;
    location.href = 'https://example.com/blocked-navigation';
    await new Promise((resolve) => setTimeout(resolve, 100));
    const webview = document.createElement('webview');
    webview.src = 'https://example.com/blocked-webview';
    document.body.appendChild(webview);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let webviewAttached = false;
    try {
      webviewAttached = typeof webview.getWebContentsId === 'function' && webview.getWebContentsId() > 0;
    } catch {}
    webview.remove();
    const outsidePath = ${JSON.stringify(outsidePath)};
    let revealOutsideRejected = false;
    let trashOutsideRejected = false;
    try { await api.showItemInFolder(outsidePath); } catch { revealOutsideRejected = true; }
    try { await api.trashItem(outsidePath); } catch { trashOutsideRejected = true; }
    return {
      appRendered: Boolean(document.querySelector('#app')?.childElementCount),
      apiStatus: response.status,
      desktopTokenPresent: typeof token === 'string' && token.length > 0,
      nodeRequireType: typeof globalThis.require,
      inlineHandlerCount: document.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]').length,
      popupOpened: popup !== null,
      externalNavigationBlocked: location.href === initialUrl,
      webviewAttached,
      revealOutsideRejected,
      trashOutsideRejected,
      preloadMethods,
    };
  })()`, true);
}

function writeE2EResult(result: Record<string, unknown>): void {
  if (!E2E_RESULT_FILE) return;
  ensureDir(path.dirname(E2E_RESULT_FILE));
  fs.writeFileSync(E2E_RESULT_FILE, JSON.stringify(result, null, 2), "utf-8");
}

async function runPackagedE2EProbe(win: BrowserWindow): Promise<void> {
  if (!E2E_MODE || e2eProbeStarted) return;
  e2eProbeStarted = true;
  try {
    await waitForRendererReady(win);
    const e2eRoot = E2E_DATA_DIR || DATA_DIR;
    const projectA = path.join(e2eRoot, "project-a");
    const projectB = path.join(e2eRoot, "project-b");
    const siblingWorkspace = path.join(e2eRoot, "project-a-sibling");
    const externalRoot = path.join(path.dirname(e2eRoot), "external");
    ensureDir(projectA);
    ensureDir(projectB);
    ensureDir(siblingWorkspace);
    ensureDir(externalRoot);
    fs.writeFileSync(path.join(e2eRoot, "read.txt"), "packaged-read", "utf-8");
    fs.writeFileSync(path.join(projectA, "read.txt"), "workspace-read", "utf-8");
    fs.writeFileSync(path.join(projectB, "read.txt"), "workspace-b-read", "utf-8");
    fs.writeFileSync(path.join(externalRoot, "read.txt"), "external-read", "utf-8");
    fs.writeFileSync(path.join(externalRoot, ".env"), "SECRET=e2e", "utf-8");
    fs.writeFileSync(path.join(externalRoot, "ipc.txt"), "ipc-outside", "utf-8");
    fs.writeFileSync(path.join(siblingWorkspace, "read.txt"), "sibling-read", "utf-8");

    const renderer = await collectRendererE2EResult(win, path.join(externalRoot, "ipc.txt"));
    const textIconStatus = await requestStatus(`${initialServerBinding.origin}/icons/file_type_text.svg`);
    const unauthorizedApiStatus = await requestStatus(`${initialServerBinding.origin}/api/dashboard`);
    const wrongTokenApi = await requestJson("/api/dashboard", "GET", undefined, {
      headers: { "X-My-Code-Agent-Token": "forged-token" },
    });
    const hostileOriginApi = await requestJson("/api/dashboard", "GET", undefined, {
      headers: { Origin: "https://evil.example" },
    });
    const crossSiteApi = await requestJson("/api/dashboard", "GET", undefined, {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    const unauthorizedMutationPath = path.join(e2eRoot, "unauthorized-write.txt");
    const unauthorizedMutation = await requestJson("/api/file/write", "POST", {
      root: e2eRoot,
      path: "unauthorized-write.txt",
      content: "must-not-exist",
    }, { includeToken: false });

    const fileRead = await requestJson(
      `/api/file/read?root=${encodeURIComponent(e2eRoot)}&path=read.txt`,
    );
    const fileWrite = await requestJson("/api/file/write", "POST", {
      root: e2eRoot,
      path: "write.txt",
      content: "packaged-write",
    });
    const externalRead = await requestJson(
      `/api/file/read?root=${encodeURIComponent(externalRoot)}&path=read.txt`,
    );
    let sensitiveExternalReadBlocked = false;
    try {
      const sensitiveExternalRead = await requestJson(
        `/api/file/read?root=${encodeURIComponent(externalRoot)}&path=${encodeURIComponent(".env")}`,
        "GET",
        undefined,
        { timeoutMs: 1_000 },
      );
      sensitiveExternalReadBlocked = sensitiveExternalRead.status !== 200;
    } catch (error) {
      sensitiveExternalReadBlocked = error instanceof Error && error.message.includes("timed out");
    }
    const persistedPreferences = await requestJson("/api/preferences");

    const contextA = initialContext;
    if (!contextA) throw new Error("Initial Electron context is unavailable");
    const projectASelectedAt = Date.now();
    await windowManager.openWorkspace(contextA, projectA);
    const workspaceRead = await requestJson(
      `/api/file/read?root=${encodeURIComponent(projectA)}&path=read.txt`,
      "GET",
      undefined,
      { binding: contextA.server },
    );
    const pathTraversal = await requestJson(
      `/api/file/read?root=${encodeURIComponent(projectA)}&path=${encodeURIComponent("../read.txt")}`,
      "GET",
      undefined,
      { binding: contextA.server },
    );
    const siblingTraversal = await requestJson(
      `/api/file/read?root=${encodeURIComponent(projectA)}&path=${encodeURIComponent("../project-a-sibling/read.txt")}`,
      "GET",
      undefined,
      { binding: contextA.server },
    );

    const contextB = createEmptyManagedWindow();
    await waitForE2ECondition("empty B shell to become visible", () => (
      latestE2ETiming(contextB, "shell-visible") !== null
    ));
    const shellCreatedAt = latestE2ETiming(contextB, "window-created");
    const shellVisibleAt = latestE2ETiming(contextB, "shell-visible");
    if (shellCreatedAt === null || shellVisibleAt === null) {
      throw new Error("Empty B shell timing was not recorded");
    }

    const serverChildCountBefore = countE2EOwnedServerChildren();
    const projectAWindow = contextA.window as BrowserWindow;
    if (E2E_MODE && !projectAWindow.isVisible()) projectAWindow.show();
    let focusObserved = false;
    const observeFocus = () => { focusObserved = true; };
    projectAWindow.on("focus", observeFocus);
    let duplicateAction: ManagerWorkspaceOpenAction;
    try {
      duplicateAction = await windowManager.openWorkspace(contextB, projectA);
      await waitForE2ECondition("existing project A window focus", () => (
        focusObserved
          || projectAWindow.isFocused()
          || BrowserWindow.getFocusedWindow() === projectAWindow
      ));
    } finally {
      projectAWindow.off("focus", observeFocus);
    }
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const focusedContextId = focusedWindow === projectAWindow && projectAWindow.isFocused()
      ? contextA.id
      : null;
    const duplicateWorkspace = {
      focusedContextId,
      action: duplicateAction,
      attemptedContextId: contextB.id,
      emptyContextId: contextB.id,
      serverKindAfter: contextB.server.kind,
      workspaceAfter: contextB.workspace,
      windowCount: BrowserWindow.getAllWindows().length,
      serverChildCountBefore,
      serverChildCountAfter: countE2EOwnedServerChildren(),
    };

    const workspaceSelectedAt = Date.now();
    const projectBAction = await windowManager.openWorkspace(contextB, projectB);
    const projectBLoadedAt = latestE2ETiming(contextB, "workbench-loaded");
    if (projectBLoadedAt === null) throw new Error("Project B workbench timing was not recorded");
    const rendererCookieIsolation = await runRendererCookieIsolationProbe(
      contextA.window as BrowserWindow,
      contextB.window as BrowserWindow,
    );

    const projectALoadedAtBefore = latestE2ETiming(contextA, "workbench-loaded");
    const projectBLoadedAtBeforeCrash = projectBLoadedAt;
    const crashedChild = contextB.server.process;
    const serverPidBefore = crashedChild?.pid || null;
    if (!crashedChild?.pid || !crashedChild.kill()) {
      throw new Error("Could not crash project B server child");
    }
    await waitForE2ECondition("project B server recovery", () => (
      !!contextB.server.process?.pid
        && contextB.server.process.pid !== serverPidBefore
        && contextB.server.port > 0
        && (latestE2ETiming(contextB, "workbench-loaded") || 0) > projectBLoadedAtBeforeCrash
    ));
    const serverPidAfter = contextB.server.process?.pid || null;
    const projectALoadedAtAfter = latestE2ETiming(contextA, "workbench-loaded");
    const projectADashboardAfterCrash = await requestJson(
      "/api/dashboard",
      "GET",
      undefined,
      { binding: contextA.server },
    );

    const closingChild = contextB.server.process;
    (contextB.window as BrowserWindow).close();
    const reopenedB = createEmptyManagedWindow();
    let reopenAction: ManagerWorkspaceOpenAction | null = null;
    let reopenError: ElectronE2EReopenErrorDiagnostic | null = null;
    try {
      reopenAction = await windowManager.openWorkspace(reopenedB, projectB);
    } catch (error) {
      reopenError = sanitizeE2EReopenError(error);
    }
    await waitForE2ECondition("closed B context disposal", () => (
      contextB.lifecycle === "closed"
        && contextB.server.process === null
    ));
    const closedServerExited = contextB.lifecycle === "closed" && contextB.server.process === null;
    const projectADashboardAfterClose = await requestJson(
      "/api/dashboard",
      "GET",
      undefined,
      { binding: contextA.server },
    );

    writeE2EResult({
      state: "awaiting-second-launch",
      electronPid: process.pid,
      launch: {
        workspace: projectA,
        dataRoot: DATA_DIR,
        instanceId: "e2e-second-executable-launch",
      },
    });
    await waitForE2ECondition("second executable single-instance handoff", () => (
      e2eSecondLaunches.some((launch) => launch.request.instanceId === "e2e-second-executable-launch")
    ));
    const secondLaunch = e2eSecondLaunches.find((launch) => (
      launch.request.instanceId === "e2e-second-executable-launch"
    ));
    if (!secondLaunch) throw new Error("Second executable handoff diagnostic is missing");

    const diagnostics = e2eRecorder!.snapshot([contextA, reopenedB]);
    writeE2EResult({
      ok: true,
      packaged: app.isPackaged,
      STARTUP,
      ...diagnostics,
      renderer,
      textIconStatus,
      unauthorizedApiStatus,
      wrongTokenApiStatus: wrongTokenApi.status,
      hostileOriginApiStatus: hostileOriginApi.status,
      crossSiteApiStatus: crossSiteApi.status,
      unauthorizedMutationStatus: unauthorizedMutation.status,
      unauthorizedMutationCreated: fs.existsSync(unauthorizedMutationPath),
      fileReadStatus: fileRead.status,
      fileWriteStatus: fileWrite.status,
      externalReadStatus: externalRead.status,
      sensitiveExternalReadBlocked,
      persistedPreferences,
      workspaceReadStatus: workspaceRead.status,
      pathTraversalStatus: pathTraversal.status,
      siblingTraversalStatus: siblingTraversal.status,
      acceptance: {
        workspaceA: projectA,
        workspaceB: projectB,
        projectASelectedAt,
        projectBAction,
        duplicateWorkspace,
        crashIsolation: {
          serverPidBefore,
          serverPidAfter,
          projectALoadedAtBefore,
          projectALoadedAtAfter,
          projectADashboardStatus: projectADashboardAfterCrash.status,
        },
        closeReopen: {
          closedServerPid: closingChild?.pid || null,
          closedServerExited,
          projectADashboardStatus: projectADashboardAfterClose.status,
          reopenAction,
          reopenError,
          windowCount: BrowserWindow.getAllWindows().length,
        },
        rendererCookieIsolation,
        secondLaunch: {
          electronPid: secondLaunch.electronPid,
          handledAt: secondLaunch.handledAt,
          windowCount: BrowserWindow.getAllWindows().length,
        },
        timing: {
          shellContextId: contextB.id,
          workspaceContextId: contextB.id,
          workspaceSelectedAt,
          shellVisibleMs: shellVisibleAt - shellCreatedAt,
          workbenchLoadedMs: projectBLoadedAt - workspaceSelectedAt,
        },
      },
    });
  } catch (error) {
    const snapshot = e2eFailureSnapshot();
    const redactions = e2eFailureRedactions();
    const failureDiagnostic = createElectronE2EFailureDiagnostic({
      error,
      diagnostics: e2eDiagnostics,
      snapshot,
      ...redactions,
    });
    writeE2EResult({
      ok: false,
      ...failureDiagnostic,
      secondLaunches: e2eSecondLaunches.map((launch) => ({
        electronPid: launch.electronPid,
        handledAt: launch.handledAt,
        instanceId: launch.request.instanceId || null,
        hasWorkspace: !!launch.request.workspace,
      })),
      windowCount: BrowserWindow.getAllWindows().length,
    });
  } finally {
    app.quit();
  }
}

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

async function waitForE2ECondition(
  description: string,
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for E2E condition: ${description}`);
}

function countE2EOwnedServerChildren(): number {
  return [...e2eTrackedContexts].filter((context) => (
    context.lifecycle === "active"
      && context.server.kind === "owned"
      && context.server.process?.pid
  )).length;
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
  if (initialServerBinding.kind === "none") {
    return Promise.reject(new Error("No initial Pi server binding is configured"));
  }
  return initialServerBinding.start();
}

function stopPiServer(): Promise<void> {
  return initialContext ? windowManager.disposeAll() : initialServerBinding.stop();
}

function reloadWindow(_port: number): Promise<void> {
  return initialContext ? loadContextApplication(initialContext) : Promise.resolve();
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
    const result = await requestJson("/api/workspace/switch", "POST", { workspace }, {
      binding: context.server,
    });
    if (result.status < 200 || result.status >= 300) {
      const body = result.body && typeof result.body === "object" && "error" in result.body
        ? String((result.body as { error: unknown }).error)
        : JSON.stringify(result.body);
      throw new Error(`External workspace switch failed (${result.status}): ${body}`);
    }
  },
  showWindowStatus: showContextDashboard,
  onServerReady: loadContextApplication,
  onError: (error, context) => {
    console.error(`Window ${context.id} server lifecycle failed:`, error);
  },
});

function createEmptyManagedWindow(): WindowContext {
  const context = windowManager.createEmptyWindow();
  recordE2EContext(context);
  return context;
}

// ─── 窗口创建 ──────────────────────────────────────────────────────

function createManagedBrowserWindow(instanceId: string): BrowserWindow {
  console.log(`[startup] electron-create-window wall=${Date.now()} total=${Date.now() - electronBootStartedAt}ms`);
  e2eStage(`createWindow:start serverPort=${initialServerBinding.port} vitePort=${process.env.VITE_DEV_PORT || ""}`);

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
  e2eWindowCreatedAt.set(win, Date.now());
  e2eStage("createWindow:browser-window-created");
  hardenWindow(win);
  e2eStage(`createWindow:loadURL ${win.webContents.getURL() || "pending"}`);

  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools({ mode: "detach" });
  }

  console.log(`[startup] electron-ready wall=${Date.now()} total=${Date.now() - electronBootStartedAt}ms`);
  console.log("✅ Window ready");

  win.webContents.on("did-finish-load", () => {
    e2eStage(`webContents:did-finish-load ${win.webContents.getURL() || ""}`);
    if (initialContext?.window === win) void runPackagedE2EProbe(win);
    console.log("📄 Page loaded:", win.webContents.getTitle());
  });

  win.webContents.on("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, url: string) => {
    e2eStage(`webContents:did-fail-load ${errorCode} ${errorDescription} ${url}`);
    console.error(`❌ Window load failed: ${errorDescription} (code: ${errorCode}) url: ${url}`);
  });

  win.webContents.on("console-message", (details) => {
    if (E2E_MODE) e2eDiagnostics.push(`console[${details.level}] ${details.sourceId}:${details.lineNumber} ${details.message}`);
    if (details.message.includes("[startup]") || details.message.includes("404") || details.message.includes("Failed") || details.message.includes("Error")) {
      console.warn(`[page:${details.sourceId}:${details.lineNumber}] ${details.message}`);
    }
  });

  win.webContents.on("preload-error" as any, (_event: Electron.Event, preloadPath: string, error: Error) => {
    e2eStage(`webContents:preload-error ${preloadPath}`);
    if (E2E_MODE) e2eDiagnostics.push(`preload-error-detail ${preloadPath}: ${error.stack || error.message}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    e2eStage(`webContents:render-process-gone ${details.reason} ${details.exitCode}`);
  });
  win.webContents.on("unresponsive", () => e2eStage("webContents:unresponsive"));

  win.once("focus", () => console.log("🔲 Window focused"));

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

function createWindow(): WindowContext {
  if (initialContext?.lifecycle === "active" && !initialContext.window.isDestroyed()) {
    initialContext.window.focus();
    e2eStage("createWindow:reused");
    return initialContext;
  }
  initialContext = windowManager.createInitialWindow({
    instanceId: STARTUP.instanceId,
    workspace: STARTUP.workspace,
    layout: STARTUP.layout,
    token: DESKTOP_SECURITY_TOKEN,
    server: initialServerBinding,
  });
  recordE2EContext(initialContext);
  mainWindow = initialContext.window as BrowserWindow;
  return initialContext;
}

interface WorkspaceStatusLoad {
  ready: boolean;
  status: WorkspaceStatus;
}

const workspaceStatusLoads = new WeakMap<BrowserWindow, WorkspaceStatusLoad>();

function dashboardStatusUrl(status: WorkspaceStatus): string {
  const params = new URLSearchParams();
  if (status.state === "idle") {
    params.set("empty-workspace", "1");
  } else {
    params.set("workspace-state", status.state);
    params.set("workspace", status.workspace);
    if (status.state === "failed") params.set("message", status.message);
  }
  return `${DASHBOARD_URL}?${params.toString()}`;
}

function showContextDashboard(context: WindowContext, status: WorkspaceStatus): void {
  if (context.window.isDestroyed()) return;
  const win = context.window as BrowserWindow;
  recordE2EContext(context);
  if (!E2E_MODE) win.show();

  const current = workspaceStatusLoads.get(win);
  if (current && (!current.ready || win.webContents.getURL().startsWith(DASHBOARD_URL))) {
    current.status = status;
    if (current.ready) win.webContents.send("workspace-status", status);
    return;
  }

  const load: WorkspaceStatusLoad = { ready: false, status };
  workspaceStatusLoads.set(win, load);
  void win.loadURL(dashboardStatusUrl(status)).then(() => {
    if (win.isDestroyed() || workspaceStatusLoads.get(win) !== load) return;
    load.ready = true;
    if (E2E_MODE) win.show();
    recordE2ETiming(context, "shell-visible");
    win.webContents.send("workspace-status", load.status);
  }).catch((error) => {
    console.error(`Window ${context.id} dashboard status navigation failed:`, error);
  });
}

async function loadContextApplication(context: WindowContext): Promise<void> {
  if (context.window.isDestroyed()) return;
  recordE2ETiming(context, "server-ready");
  const vitePort = context === initialContext ? Number(process.env.VITE_DEV_PORT || 0) : 0;
  const target = vitePort > 0 ? `http://127.0.0.1:${vitePort}` : context.server.origin;
  if (!target) return;
  const win = context.window as BrowserWindow;
  workspaceStatusLoads.delete(win);
  win.show();
  await win.loadURL(target);
  recordE2ETiming(context, "workbench-loaded");
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
  e2eStage("app:when-ready");
  ensureDir(DATA_DIR);
  ensureDir(PI_CONFIG_DIR);
  ensureDir(SESSIONS_DIR);

  const isDev = process.env.VITE_DEV_PORT;
  if (isDev) {
    console.log(`📡 Dev mode: loading from Vite at http://127.0.0.1:${isDev}`);
    const context = createWindow();
    if (context.server.kind === "external") await loadContextApplication(context);
  } else {
    const serverReady = earlyServerReady ?? startPiServer();
    e2eStage("app:before-create-window");
    const context = createWindow();
    e2eStage("app:after-create-window");
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

  secondLaunchHandlingReady = true;
  drainPendingSecondLaunches();

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
