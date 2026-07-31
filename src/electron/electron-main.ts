/**
 * My Code Agent — Electron 主进程
 * 便携式设计：所有数据存储在 exe 所在目录的 data/ 下
 * 通过子进程启动 pi 服务器，BrowserWindow 包装为桌面应用
 *
 * 崩溃恢复：pi-server 退出时自动重启，定期健康检查
 */
import { app, BrowserWindow, ipcMain, dialog, shell, type IpcMainInvokeEvent } from "electron";
import { spawn, execSync, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { registerDesktopIpcHandlers, TrustedDesktopRoots } from "./desktop-ipc.js";

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
delete process.env.MY_CODE_AGENT_E2E_RESULT_FILE;
delete process.env.MY_CODE_AGENT_E2E_DATA_DIR;
const DATA_DIR = E2E_DATA_DIR || path.join(RUNTIME_ROOT, "data");
const PI_CONFIG_DIR = path.join(DATA_DIR, "pi");
const SESSIONS_DIR = path.join(PI_CONFIG_DIR, "sessions");
const AUTH_FILE = path.join(PI_CONFIG_DIR, "auth.json");
const DESKTOP_SECURITY_TOKEN = process.env.MY_CODE_AGENT_DESKTOP_TOKEN || randomBytes(32).toString("base64url");
delete process.env.MY_CODE_AGENT_DESKTOP_TOKEN;
const trustedDesktopRoots = new TrustedDesktopRoots();

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

// ─── Pi 服务器进程 ────────────────────────────────────────────────
let serverProcess: ChildProcess | null = null;
let serverPort = 0;
let mainWindow: BrowserWindow | null = null;
let restartCount = 0;
const MAX_RESTART_COUNT = 5;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let e2eProbeStarted = false;
const e2eDiagnostics: string[] = [];

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

async function collectRendererE2EResult(win: BrowserWindow): Promise<Record<string, unknown>> {
  return win.webContents.executeJavaScript(`(async () => {
    const api = window.electronAPI;
    const preloadMethods = api ? Object.keys(api).sort() : [];
    const token = api?.getDesktopSessionToken ? await api.getDesktopSessionToken() : '';
    const response = await fetch('/api/dashboard', {
      cache: 'no-store',
      headers: token ? { 'X-My-Code-Agent-Token': token } : {},
    });
    const popup = window.open('https://example.com', '_blank');
    return {
      appRendered: Boolean(document.querySelector('#app')?.childElementCount),
      apiStatus: response.status,
      desktopTokenPresent: typeof token === 'string' && token.length > 0,
      nodeRequireType: typeof globalThis.require,
      inlineHandlerCount: document.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]').length,
      popupOpened: popup !== null,
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
    const renderer = await collectRendererE2EResult(win);
    const unauthorizedApiStatus = await requestStatus(`http://127.0.0.1:${serverPort}/api/dashboard`);
    writeE2EResult({
      ok: true,
      packaged: app.isPackaged,
      pageUrl: win.webContents.getURL(),
      pageTitle: win.webContents.getTitle(),
      renderer,
      unauthorizedApiStatus,
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

    ensureDir(DATA_DIR);
    ensureDir(PI_CONFIG_DIR);
    ensureDir(SESSIONS_DIR);

    if (!fs.existsSync(AUTH_FILE)) {
      fs.writeFileSync(AUTH_FILE, JSON.stringify({}, null, 2));
    }

    const script = getServerScript();
    const env = {
      ...process.env,
      PI_DESKTOP_DATA: DATA_DIR,
      PI_DESKTOP_CONFIG: PI_CONFIG_DIR,
      PI_DESKTOP_SESSIONS: SESSIONS_DIR,
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

    serverProcess.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(`[pi-server] ${text}`);

      const portMatch = output.match(/SERVER_PORT:(\d+)/);
      if (portMatch) {
        const port = parseInt(portMatch[1], 10);
        serverPort = port;
        resolve(port);
      }
    });

    serverProcess.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[pi-server:err] ${chunk.toString()}`);
    });

    serverProcess.on("exit", (code) => {
      console.log(`Pi server exited with code ${code}`);
      serverProcess = null;
      serverPort = 0;

      // 崩溃自动重启（非正常退出 && 未超过最大重启次数）
      if (code !== 0 && code !== null && restartCount < MAX_RESTART_COUNT) {
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
      } else if (code !== 0 && code !== null) {
        console.error(`❌ Pi server crashed and reached max restart count (${MAX_RESTART_COUNT}).`);
      }
    });

    serverProcess.on("error", (err) => {
      reject(err);
    });

    setTimeout(() => {
      if (!serverPort) {
        reject(new Error("Pi server startup timeout\n" + output));
      }
    }, 30000);
  });
}

function stopPiServer() {
  stopHealthCheck();
  if (serverProcess) {
    const pid = serverProcess.pid;
    if (process.platform === "win32") {
      try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" }); } catch {}
    } else {
      serverProcess.kill("SIGTERM");
      setTimeout(() => { try { serverProcess?.kill("SIGKILL"); } catch {} }, 2000);
    }
    serverProcess = null;
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
  if (!process.env.VITE_DEV_PORT && !serverPort) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
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
  hardenWindow(mainWindow);

  const vitePort = process.env.VITE_DEV_PORT;
  if (vitePort) {
    mainWindow.loadURL(`http://127.0.0.1:${vitePort}`);
  } else {
    mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
  }

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
    if (mainWindow) void runPackagedE2EProbe(mainWindow);
    console.log("📄 Page loaded:", mainWindow?.webContents.getTitle());
  });

  mainWindow.webContents.on("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, url: string) => {
    if (E2E_MODE) e2eDiagnostics.push(`did-fail-load ${errorCode} ${errorDescription} ${url}`);
    console.error(`❌ Window load failed: ${errorDescription} (code: ${errorCode}) url: ${url}`);
  });

  mainWindow.webContents.on("console-message" as any, (_event: Electron.Event, level: number, message: string, line: number, sourceId: number) => {
    if (E2E_MODE) e2eDiagnostics.push(`console[${level}] ${sourceId}:${line} ${message}`);
    if (message.includes("404") || message.includes("Failed") || message.includes("Error")) {
      console.warn(`[page:${sourceId}:${line}] ${message}`);
    }
  });

  mainWindow.webContents.on("preload-error" as any, (_event: Electron.Event, preloadPath: string, error: Error) => {
    if (E2E_MODE) e2eDiagnostics.push(`preload-error ${preloadPath}: ${error.stack || error.message}`);
  });

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

function getDesktopSessionToken(event: unknown): string {
  const ipcEvent = event as IpcMainInvokeEvent;
  const sender = ipcEvent.sender;
  const senderUrl = ipcEvent.senderFrame?.url || sender?.getURL?.() || "";
  if (!mainWindow || sender !== mainWindow.webContents || !isAllowedAppUrl(senderUrl)) {
    throw new Error("Desktop session token request is not from the trusted app window");
  }
  return DESKTOP_SECURITY_TOKEN;
}

registerDesktopIpcHandlers({
  ipcMain,
  getMainWindow: () => mainWindow,
  createWindow,
  showOpenDialog: (options) => dialog.showOpenDialog({ properties: options.properties }),
  showItemInFolder: (filePath) => shell.showItemInFolder(filePath),
  trashItem: (filePath) => shell.trashItem(filePath),
  spawnTerminal: spawnCliTerminal,
  getDesktopSessionToken,
  trustedRoots: trustedDesktopRoots,
});

app.whenReady().then(async () => {
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
      createWindow();
    } catch (err) {
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
