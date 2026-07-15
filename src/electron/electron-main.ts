/**
 * My Code Agent — Electron 主进程
 * 便携式设计：所有数据存储在 exe 所在目录的 data/ 下
 * 通过子进程启动 pi 服务器，BrowserWindow 包装为桌面应用
 *
 * 崩溃恢复：pi-server 退出时自动重启，定期健康检查
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { spawn, execSync, type ChildProcess } from "child_process";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── 便携路径 ──────────────────────────────────────────────────────
const APP_ROOT = app.getAppPath();
const DATA_DIR = path.join(APP_ROOT, "data");
const PI_CONFIG_DIR = path.join(DATA_DIR, "pi");
const SESSIONS_DIR = path.join(PI_CONFIG_DIR, "sessions");
const AUTH_FILE = path.join(PI_CONFIG_DIR, "auth.json");

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Pi 服务器进程 ────────────────────────────────────────────────
let serverProcess: ChildProcess | null = null;
let serverPort = 0;
let mainWindow: BrowserWindow | null = null;
let restartCount = 0;
const MAX_RESTART_COUNT = 5;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;

function getServerScript(): string {
  return path.join(APP_ROOT, "src", "server", "server.ts");
}

function getNodeExe(): string {
  const local = path.join(APP_ROOT, "node_modules", ".bin", "node");
  if (fs.existsSync(local)) return local;
  const npx = path.join(APP_ROOT, "node_modules", ".bin", "npx");
  if (fs.existsSync(npx)) return npx;
  return "npx";
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
    const nodeCmd = getNodeExe();
    const env = {
      ...process.env,
      PI_DESKTOP_DATA: DATA_DIR,
      PI_DESKTOP_CONFIG: PI_CONFIG_DIR,
      PI_DESKTOP_SESSIONS: SESSIONS_DIR,
    };

    const isWin = process.platform === "win32";
    serverProcess = spawn(
      isWin ? "cmd" : "npx",
      isWin ? ["/c", "npx", "tsx", script] : ["tsx", script],
      { env, stdio: ["pipe", "pipe", "pipe"], cwd: APP_ROOT, shell: isWin },
    );

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
    const req = http.get(`http://127.0.0.1:${serverPort}/api/dashboard`, (res) => {
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

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 600,
    minHeight: 400,
    title: "My Code Agent",
    backgroundColor: "#06080F",
    titleBarStyle: "hidden",
    webPreferences: {
      preload: path.join(APP_ROOT, "dist-electron", "electron", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
    autoHideMenuBar: true,
  });

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
    if (mainWindow && !mainWindow.isVisible()) {
      console.log("⏰ Force-showing window (ready-to-show timeout)");
      mainWindow.show();
    }
  }, 5000);

  mainWindow.once("ready-to-show", () => {
    clearTimeout(showTimer);
    mainWindow?.show();
    console.log("✅ Window ready");
  });

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("📄 Page loaded:", mainWindow?.webContents.getTitle());
  });

  mainWindow.webContents.on("did-fail-load", (_event: unknown, errorCode: number, errorDescription: string, url: string) => {
    console.error(`❌ Window load failed: ${errorDescription} (code: ${errorCode}) url: ${url}`);
  });

  mainWindow.webContents.on("console-message" as any, (_event: Electron.Event, level: number, message: string, line: number, sourceId: number) => {
    if (message.includes("404") || message.includes("Failed") || message.includes("Error")) {
      console.warn(`[page:${sourceId}:${line}] ${message}`);
    }
  });

  mainWindow.once("focus", () => console.log("🔲 Window focused"));

  mainWindow.on("closed", () => {
    clearTimeout(showTimer);
    mainWindow = null;
  });
}

// ─── IPC 窗口控制 ────────────────────────────────────────────────
ipcMain.on("window-minimize", () => mainWindow?.minimize());
ipcMain.on("window-maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on("window-close", () => mainWindow?.close());

// ─── IPC 文件菜单 ──────────────────────────────────────────────────
ipcMain.handle("dialog-open-file", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"] });
  return result.filePaths[0] || null;
});
ipcMain.handle("dialog-open-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.filePaths[0] || null;
});
ipcMain.on("window-new", () => {
  const win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 600, minHeight: 400,
    title: "My Code Agent", backgroundColor: "#06080F",
    titleBarStyle: "hidden", autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_ROOT, "dist-electron", "electron", "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
    show: false,
  });
  const vitePort = process.env.VITE_DEV_PORT;
  if (vitePort) win.loadURL(`http://127.0.0.1:${vitePort}`);
  else win.loadURL(`http://127.0.0.1:${serverPort}`);
  win.once("ready-to-show", () => win.show());
});

ipcMain.handle("show-item-in-folder", async (_, filePath: string) => {
  shell.showItemInFolder(filePath);
});
ipcMain.handle("trash-item", async (_, filePath: string) => {
  shell.trashItem(filePath);
});
ipcMain.handle("open-folder-dialog", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
ipcMain.handle("spawn-terminal", async () => {
  const cmd = `start cmd /k "npx tsx src/server/main.ts --cli"`;
  execSync(cmd, { cwd: APP_ROOT, stdio: "ignore" });
  return true;
});

app.whenReady().then(async () => {
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
