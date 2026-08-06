/**
 * My Code Agent — Electron 主进程
 * Each process owns one workspace, one server, and one runtime.
 * Persistent data uses a configurable root; only its pointer stays in OS user data.
 *
 * 崩溃恢复：pi-server 退出时自动重启，定期健康检查
 */
import { app, BrowserWindow, ipcMain, dialog, shell, type IpcMainInvokeEvent } from "electron";
import { spawn, execSync, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { registerDesktopIpcHandlers, TrustedDesktopRoots } from "./desktop-ipc.js";
import { readDataRootPointer } from "../data/data-root-config.js";
import { resolveStartupPaths } from "../server/startup-paths.js";
import { createDesktopSessionToken } from "../server/security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 便携路径 ──────────────────────────────────────────────────────
const APP_ROOT = app.getAppPath();
const RUNTIME_ROOT = app.isPackaged ? path.dirname(process.execPath) : APP_ROOT;
const E2E_RESULT_FILE = process.env.NODE_ENV === "test" && process.env.MY_CODE_AGENT_E2E_RESULT_FILE
  ? path.resolve(process.env.MY_CODE_AGENT_E2E_RESULT_FILE)
  : null;
const E2E_DATA_DIR = E2E_RESULT_FILE && process.env.MY_CODE_AGENT_E2E_DATA_DIR
  ? path.resolve(process.env.MY_CODE_AGENT_E2E_DATA_DIR)
  : null;
const E2E_MODE = app.isPackaged && !!E2E_RESULT_FILE;
const DATA_ROOT_POINTER_FILE = path.join(app.getPath("userData"), "data-root.json");
delete process.env.MY_CODE_AGENT_E2E_RESULT_FILE;
delete process.env.MY_CODE_AGENT_E2E_DATA_DIR;
const DEFAULT_DATA_ROOT = E2E_DATA_DIR || path.join(RUNTIME_ROOT, "data");
const CONFIGURED_DATA_ROOT = E2E_DATA_DIR || readDataRootPointer(DATA_ROOT_POINTER_FILE, DEFAULT_DATA_ROOT);
const STARTUP = resolveStartupPaths({
  appRoot: APP_ROOT,
  argv: process.argv.slice(1),
  env: { ...process.env, PI_DATA_ROOT: process.env.PI_DATA_ROOT || CONFIGURED_DATA_ROOT },
});
const DATA_DIR = STARTUP.dataRoot;
const PI_CONFIG_DIR = STARTUP.layout.userRoot;
const SESSIONS_DIR = STARTUP.layout.sessionsDir;
const AUTH_FILE = STARTUP.layout.authFile;
const DESKTOP_SECURITY_TOKEN = process.env.NODE_ENV === "test" && process.env.MY_CODE_AGENT_DESKTOP_TOKEN
  ? process.env.MY_CODE_AGENT_DESKTOP_TOKEN
  : createDesktopSessionToken();
delete process.env.MY_CODE_AGENT_DESKTOP_TOKEN;
const trustedDesktopRoots = new TrustedDesktopRoots();

// Packaged E2E runs in restricted Windows environments where Chromium's GPU
// process and default user cache may be unavailable. Keep this test-only.
app.setPath("userData", path.join(STARTUP.layout.instanceRoot, "electron-user-data"));
app.setPath("cache", STARTUP.layout.cacheDir);

if (E2E_MODE) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("in-process-gpu");
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function addPersistedWorkspaceRoots(): void {
  trustedDesktopRoots.addPersistedWorkspaceRoots(path.join(PI_CONFIG_DIR, "ui-state.json"));
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

function isAllowedAppUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:") return false;
    if (!isLoopbackHost(parsed.hostname)) return false;
    const vitePort = process.env.VITE_DEV_PORT;
    return parsed.port === String(serverPort) || (!!vitePort && parsed.port === String(vitePort));
  } catch {
    return false;
  }
}

function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedAppUrl(url)) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

trustedDesktopRoots.addRoot(APP_ROOT);
trustedDesktopRoots.addRoot(RUNTIME_ROOT);
trustedDesktopRoots.addRoot(DATA_DIR);
trustedDesktopRoots.addRoot(STARTUP.workspace);
trustedDesktopRoots.addRoot(STARTUP.layout.workspaceRoot);
trustedDesktopRoots.addRoot(STARTUP.layout.instanceRoot);

// ─── Pi 服务器进程 ────────────────────────────────────────────────
let serverProcess: ChildProcess | null = null;
let serverPort = 0;
let mainWindow: BrowserWindow | null = null;
let restartCount = 0;
let serverStopping = false;
const MAX_RESTART_COUNT = 5;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let e2eProbeStarted = false;
const e2eDiagnostics: string[] = [];

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
  options: { includeToken?: boolean; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolveRequest, reject) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const request = http.request(`http://127.0.0.1:${serverPort}${pathname}`, {
      method,
      headers: {
        ...(options.includeToken === false ? {} : { "X-My-Code-Agent-Token": DESKTOP_SECURITY_TOKEN }),
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
    const workspace = path.join(e2eRoot, "workspace");
    const siblingWorkspace = path.join(e2eRoot, "workspace-sibling");
    const externalRoot = path.join(path.dirname(e2eRoot), "external");
    ensureDir(workspace);
    ensureDir(siblingWorkspace);
    ensureDir(externalRoot);
    fs.writeFileSync(path.join(e2eRoot, "read.txt"), "packaged-read", "utf-8");
    fs.writeFileSync(path.join(workspace, "read.txt"), "workspace-read", "utf-8");
    fs.writeFileSync(path.join(externalRoot, "read.txt"), "external-read", "utf-8");
    fs.writeFileSync(path.join(externalRoot, ".env"), "SECRET=e2e", "utf-8");
    fs.writeFileSync(path.join(externalRoot, "ipc.txt"), "ipc-outside", "utf-8");
    fs.writeFileSync(path.join(siblingWorkspace, "read.txt"), "sibling-read", "utf-8");

    const renderer = await collectRendererE2EResult(win, path.join(externalRoot, "ipc.txt"));
    const textIconStatus = await requestStatus(`http://127.0.0.1:${serverPort}/icons/file_type_text.svg`);
    const unauthorizedApiStatus = await requestStatus(`http://127.0.0.1:${serverPort}/api/dashboard`);
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
    const workspaceSwitch = await requestJson("/api/workspace/switch", "POST", { workspace });
    const workspaceRead = await requestJson(
      `/api/file/read?root=${encodeURIComponent(workspace)}&path=read.txt`,
    );
    const pathTraversal = await requestJson(
      `/api/file/read?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent("../read.txt")}`,
    );
    const siblingTraversal = await requestJson(
      `/api/file/read?root=${encodeURIComponent(workspace)}&path=${encodeURIComponent("../workspace-sibling/read.txt")}`,
    );
    writeE2EResult({
      ok: true,
      packaged: app.isPackaged,
      pageUrl: win.webContents.getURL(),
      pageTitle: win.webContents.getTitle(),
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
      workspaceSwitchStatus: workspaceSwitch.status,
      workspaceReadStatus: workspaceRead.status,
      pathTraversalStatus: pathTraversal.status,
      siblingTraversalStatus: siblingTraversal.status,
      windowCount: BrowserWindow.getAllWindows().length,
    });
  } catch (error) {
    writeE2EResult({
      ok: false,
      error: error instanceof Error ? error.stack || error.message : String(error),
      diagnostics: e2eDiagnostics,
    });
  } finally {
    stopPiServer();
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

function getServerScript(): string {
  if (app.isPackaged) {
    return path.join(APP_ROOT, "dist", "server", "server.js");
  }
  return path.join(APP_ROOT, "src", "server", "server.ts");
}

function startPiServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    if (serverProcess) {
      resolve(serverPort);
      return;
    }
    serverStopping = false;

    ensureDir(DATA_DIR);
    ensureDir(PI_CONFIG_DIR);
    ensureDir(SESSIONS_DIR);
    ensureDir(STARTUP.layout.workspaceRoot);
    ensureDir(STARTUP.layout.instanceRoot);
    ensureDir(STARTUP.layout.cacheDir);

    try {
      fs.writeFileSync(AUTH_FILE, JSON.stringify({}, null, 2), { encoding: "utf8", flag: "wx" });
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const script = getServerScript();
    const env = {
      ...process.env,
      PI_DESKTOP_DATA: DATA_DIR,
      PI_DESKTOP_CONFIG: PI_CONFIG_DIR,
      PI_DESKTOP_SESSIONS: SESSIONS_DIR,
      PI_DESKTOP_DATA_ROOT_POINTER: DATA_ROOT_POINTER_FILE,
      PI_WORKSPACE: STARTUP.workspace,
      PI_DATA_ROOT: STARTUP.dataRoot,
      PI_INSTANCE_ID: STARTUP.instanceId,
      PI_USER_CONFIG: STARTUP.layout.userRoot,
      PI_WORKSPACE_DATA: STARTUP.layout.workspaceRoot,
      PI_INSTANCE_DATA: STARTUP.layout.instanceRoot,
      MY_CODE_AGENT_DESKTOP_TOKEN: DESKTOP_SECURITY_TOKEN,
    };

    const isWin = process.platform === "win32";
    if (app.isPackaged) {
      serverProcess = spawn(process.execPath, [script], {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
        cwd: RUNTIME_ROOT,
        shell: false,
      });
    } else {
      serverProcess = spawn(
        isWin ? "cmd" : "npx",
        isWin ? ["/c", "npx", "tsx", script] : ["tsx", script],
        { env, stdio: ["pipe", "pipe", "pipe"], cwd: APP_ROOT, shell: isWin },
      );
    }

    let output = "";
    let errorOutput = "";
    const startupTimer = setTimeout(() => {
      if (!serverPort) reject(new Error("Pi server startup timeout\n" + output + errorOutput));
    }, 30000);

    serverProcess.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(`[pi-server] ${text}`);

      const portMatch = output.match(/SERVER_PORT:(\d+)/);
      if (portMatch) {
        clearTimeout(startupTimer);
        const port = parseInt(portMatch[1], 10);
        serverPort = port;
        resolve(port);
      }
    });

    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      errorOutput += text;
      process.stderr.write(`[pi-server:err] ${text}`);
    });

    serverProcess.on("exit", (code) => {
      clearTimeout(startupTimer);
      const wasReady = serverPort > 0;
      console.log(`Pi server exited with code ${code}`);
      serverProcess = null;
      serverPort = 0;

      if (!wasReady) {
        reject(new Error(`Pi server exited before ready (${code})\n${output}${errorOutput}`));
        return;
      }

      // 崩溃自动重启（非正常退出 && 未超过最大重启次数）
      if (!serverStopping && code !== 0 && code !== null && restartCount < MAX_RESTART_COUNT) {
        restartCount++;
        console.log(`🔄 正在重启 pi-server (第 ${restartCount}/${MAX_RESTART_COUNT} 次)...`);
        startHealthCheck(); // 重启后重新建立健康检查
        startPiServer()
          .then((port) => {
            console.log(`✅ Pi server restarted on port ${port}`);
            reloadWindow(port);
          })
          .catch((err) => {
            console.error(`❌ Pi server restart failed:`, err);
          });
      } else if (!serverStopping && code !== 0 && code !== null) {
        console.error(`❌ Pi server crashed and reached max restart count (${MAX_RESTART_COUNT}).`);
      }
    });

    serverProcess.on("error", (err) => {
      clearTimeout(startupTimer);
      reject(err);
    });
  });
}

function stopPiServer() {
  stopHealthCheck();
  if (serverStopping) return;
  serverStopping = true;
  if (serverProcess) {
    const child = serverProcess;
    const pid = serverProcess.pid;
    try { child.stdin?.write("PI_SERVER_SHUTDOWN\n"); } catch {}
    try { child.stdin?.end(); } catch {}
    setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" }); } catch {}
      } else {
        try { child.kill("SIGKILL"); } catch {}
      }
    }, 2000).unref();
    serverPort = 0;
  }
}

// ─── 健康检查 ──────────────────────────────────────────────────────

function startHealthCheck(): void {
  stopHealthCheck();
  healthCheckTimer = setInterval(() => {
    if (!serverPort) return;
    const req = http.get(`http://127.0.0.1:${serverPort}/api/dashboard`, {
      headers: { "X-My-Code-Agent-Token": DESKTOP_SECURITY_TOKEN },
    }, (res) => {
      if (res.statusCode !== 200) {
        console.warn(`⚠️  Health check returned status ${res.statusCode}`);
      }
    });
    req.on("error", () => {
      console.warn("⚠️  Health check failed — server may be down");
      // 如果 serverProcess 还存在但健康检查失败，尝试清理重启
      if (serverProcess) {
        console.log("🔄  Health check failed, attempting restart...");
        stopPiServer();
        restartCount = 0; // 重置计数器，让 exit handler 触发
        // 手动触发 restart (exit handler 会处理)
      }
    });
    req.setTimeout(5000, () => {
      req.destroy();
      console.warn("⚠️  Health check timed out");
    });
  }, 30000); // 每 30 秒检查一次
}

function stopHealthCheck(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function reloadWindow(port: number): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const vitePort = process.env.VITE_DEV_PORT;
    if (vitePort) {
      mainWindow.loadURL(`http://127.0.0.1:${vitePort}`);
    } else {
      mainWindow.loadURL(`http://127.0.0.1:${port}`);
    }
  }
}

// ─── 窗口创建 ──────────────────────────────────────────────────────

function createWindow() {
  e2eStage(`createWindow:start serverPort=${serverPort} vitePort=${process.env.VITE_DEV_PORT || ""}`);
  if (!process.env.VITE_DEV_PORT && !serverPort) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    e2eStage("createWindow:reused");
    return;
  }

  const windowIcon = getAppIconPath();
  mainWindow = new BrowserWindow({
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
    },
    show: false,
    autoHideMenuBar: true,
  });
  e2eStage("createWindow:browser-window-created");
  hardenWindow(mainWindow);

  const vitePort = process.env.VITE_DEV_PORT;
  if (vitePort) {
    mainWindow.loadURL(`http://127.0.0.1:${vitePort}`);
  } else {
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  }
  e2eStage(`createWindow:loadURL ${mainWindow.webContents.getURL() || "pending"}`);

  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  // ready-to-show 未触发时的兜底：5 秒后强制显示
  const showTimer = setTimeout(() => {
    if (!E2E_MODE && mainWindow && !mainWindow.isVisible()) {
      console.log("⏰ Force-showing window (ready-to-show timeout)");
      mainWindow.show();
    }
  }, 5000);

  mainWindow.once("ready-to-show", () => {
    clearTimeout(showTimer);
    if (!E2E_MODE) mainWindow?.show();
    console.log("✅ Window ready");
  });

  mainWindow.webContents.on("did-finish-load", () => {
    e2eStage(`webContents:did-finish-load ${mainWindow?.webContents.getURL() || ""}`);
    if (mainWindow) void runPackagedE2EProbe(mainWindow);
    console.log("📄 Page loaded:", mainWindow?.webContents.getTitle());
  });

  mainWindow.webContents.on("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, url: string) => {
    e2eStage(`webContents:did-fail-load ${errorCode} ${errorDescription} ${url}`);
    console.error(`❌ Window load failed: ${errorDescription} (code: ${errorCode}) url: ${url}`);
  });

  mainWindow.webContents.on("console-message", (details) => {
    if (E2E_MODE) e2eDiagnostics.push(`console[${details.level}] ${details.sourceId}:${details.lineNumber} ${details.message}`);
    if (details.message.includes("404") || details.message.includes("Failed") || details.message.includes("Error")) {
      console.warn(`[page:${details.sourceId}:${details.lineNumber}] ${details.message}`);
    }
  });

  mainWindow.webContents.on("preload-error" as any, (_event: Electron.Event, preloadPath: string, error: Error) => {
    e2eStage(`webContents:preload-error ${preloadPath}`);
    if (E2E_MODE) e2eDiagnostics.push(`preload-error-detail ${preloadPath}: ${error.stack || error.message}`);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    e2eStage(`webContents:render-process-gone ${details.reason} ${details.exitCode}`);
  });
  mainWindow.webContents.on("unresponsive", () => e2eStage("webContents:unresponsive"));

  mainWindow.once("focus", () => console.log("🔲 Window focused"));

  mainWindow.on("closed", () => {
    clearTimeout(showTimer);
    mainWindow = null;
  });
}

// ─── IPC 窗口控制 ────────────────────────────────────────────────

// ─── IPC 文件菜单 ──────────────────────────────────────────────────
function spawnCliTerminal(): boolean {
  if (process.platform === "win32") {
    execSync(`start cmd /k "npx tsx src/server/main.ts --cli"`, { cwd: APP_ROOT, stdio: "ignore" });
  } else if (process.platform === "darwin") {
    const escaped = APP_ROOT.replace(/'/g, `'\\''`);
    execSync(`osascript -e 'tell application "Terminal" to do script "cd '\\''${escaped}'\\'' && exec npx tsx src/server/main.ts --cli"'`, { cwd: APP_ROOT, stdio: "ignore" });
  } else {
    execSync(`x-terminal-emulator -e "npx tsx src/server/main.ts --cli"`, { cwd: APP_ROOT, stdio: "ignore" });
  }
  return true;
}

function validateDesktopIpcSender(event: unknown): void {
  const ipcEvent = event as IpcMainInvokeEvent;
  const sender = ipcEvent.sender;
  const senderUrl = ipcEvent.senderFrame?.url || sender?.getURL?.() || "";
  if (!mainWindow || sender !== mainWindow.webContents || !isAllowedAppUrl(senderUrl)) {
    throw new Error("Desktop IPC request is not from the trusted app window");
  }
}

function getDesktopSessionToken(): string {
  return DESKTOP_SECURITY_TOKEN;
}

function launchWindowForWorkspace(
  workspace: string,
  instanceId = `instance-${randomUUID()}`,
): Promise<{ ok: true; workspace: string; instanceId: string }> {
  if (!path.isAbsolute(workspace) || !fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error("Project workspace must be an existing absolute directory");
  }

  const appArgs = app.isPackaged ? [] : [APP_ROOT];
  const args = [
    ...appArgs,
    "--workspace", path.resolve(workspace),
    "--data-root", STARTUP.dataRoot,
    "--instance-id", instanceId,
  ];
  const env = { ...process.env };
  for (const key of [
    "VITE_DEV_PORT",
    "PI_DEV_PORT",
    "SERVER_PORT",
    "PI_WORKSPACE",
    "PI_DATA_ROOT",
    "PI_DESKTOP_DATA",
    "PI_INSTANCE_ID",
    "PI_USER_CONFIG",
    "PI_WORKSPACE_DATA",
    "PI_INSTANCE_DATA",
    "MY_CODE_AGENT_DESKTOP_TOKEN",
  ]) delete env[key];

  const child = spawn(process.execPath, args, {
    cwd: RUNTIME_ROOT,
    env,
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: false,
  });
  return new Promise((resolveLaunch, rejectLaunch) => {
    child.once("error", rejectLaunch);
    child.once("spawn", () => {
      child.unref();
      resolveLaunch({ ok: true, workspace: path.resolve(workspace), instanceId });
    });
  });
}

function launchEmptyWindow(): Promise<{ ok: true; instanceId: string }> {
  const instanceId = `instance-${randomUUID()}`;
  const instanceRoot = path.join(STARTUP.dataRoot, "instances", instanceId);
  const workspace = path.join(STARTUP.dataRoot, "instances", instanceId, "empty-workspace");
  ensureDir(workspace);

  return launchWindowForWorkspace(workspace, instanceId)
    .then(() => ({ ok: true as const, instanceId }))
    .catch((error) => {
      try { fs.rmSync(instanceRoot, { recursive: true, force: true }); } catch {}
      throw error;
    });
}

registerDesktopIpcHandlers({
  ipcMain,
  getMainWindow: () => mainWindow,
  showOpenDialog: (options) => dialog.showOpenDialog({ properties: options.properties }),
  launchEmptyWindow,
  showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
  trashItem: (filePath) => shell.trashItem(filePath),
  spawnTerminal: spawnCliTerminal,
  getDesktopSessionToken,
  validateSender: validateDesktopIpcSender,
  trustedRoots: trustedDesktopRoots,
});

app.whenReady().then(async () => {
  e2eStage("app:when-ready");
  ensureDir(DATA_DIR);
  ensureDir(PI_CONFIG_DIR);
  ensureDir(SESSIONS_DIR);
  addPersistedWorkspaceRoots();

  const isDev = process.env.VITE_DEV_PORT;
  if (isDev) {
    console.log(`📡 Dev mode: loading from Vite at http://127.0.0.1:${isDev}`);
    createWindow();
  } else {
    try {
      const port = await startPiServer();
      console.log(`✅ Pi server started on port ${port}`);
      startHealthCheck();
      e2eStage("app:before-create-window");
      createWindow();
      e2eStage("app:after-create-window");
    } catch (err) {
      dialog.showErrorBox("无法启动 My Code Agent", err instanceof Error ? err.message : String(err));
      console.error("❌ Failed to start:", err);
      app.quit();
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopPiServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopPiServer();
});
