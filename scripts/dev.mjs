/**
 * My Code Agent — 开发启动脚本
 *
 * 新架构（三者独立进程，可各自重启）:
 * 1. Vite dev server (port 5173) — 前端 HMR
 * 2. pi-server (port 3099) — API 后端
 * 3. Electron — 加载 Vite 页面
 *
 * 前端文件变化 → Vite HMR 即时更新，无需重启
 * server.ts 变化 → 仅重启 pi-server 进程
 * electron-main.ts 变化 → 仅重启 Electron
 */
import { spawn, execSync } from "child_process";
import { createServer } from "net";
import { watch } from "chokidar";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { compilePreload } from "./compile-preload.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ELECTRON_SRC = path.resolve(ROOT, "src");
const PID_FILE = path.resolve(ROOT, "data", "pi", ".dev.pid");

const DEV_PORT = 3099;
const VITE_PORT = 5173;

// ─── 端口检测 & 释放 ─────────────────────────────────────────
function isPortInUse(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => { srv.close(); resolve(false); });
    srv.listen(port, "127.0.0.1");
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killPortProcess(port) {
  try {
    const out = execSync(`netstat -ano | findstr "LISTENING" | findstr ":${port} "`, { encoding: "utf8", stdio: "pipe" });
    for (const line of out.trim().split("\n")) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== "0") { try { execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" }); } catch {} }
    }
  } catch {}
}

async function waitForPortFree(port, attempts = 12) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!(await isPortInUse(port))) return true;
    await delay(150);
  }
  return false;
}

// ─── 清理残留进程 ─────────────────────────────────────────────
function cleanupOldProcesses() {
  // 强制杀掉上次的 Electron / Vite / pi-server
  try { execSync(`taskkill /F /IM electron.exe`, { stdio: "ignore" }); } catch {}
  // 用端口反查 PID 杀掉残留
  for (const p of [DEV_PORT, VITE_PORT]) killPortProcess(p);
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function registerPid(pid) {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(pid));
  } catch { /* ignore */ }
}

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// ─── 编译 Electron ────────────────────────────────────────────
function buildElectron() {
  console.log("🔨 Compiling electron main...");
  try {
    execSync("npx tsc -p tsconfig.electron.json", { cwd: ROOT, stdio: "pipe" });
    compilePreload();
    console.log("✅ Electron compiled");
  } catch (err) {
    console.error("❌ Compile failed:", err.stderr?.toString() || err.message);
  }
}

// ─── 进程管理 ─────────────────────────────────────────────────
let serverProcess = null;
let electronProcess = null;
let viteProcess = null;
let serverStartPromise = null;
let serverRestartTimer = null;
let pendingServerRestartFile = null;
let frontendCompileTimer = null;
let intentionalElectronStop = false;

async function startVite() {
  if (viteProcess) return;
  console.log("📦 Starting Vite dev server...");
  viteProcess = spawn("npx", ["vite", "--host", "127.0.0.1"], {
    cwd: ROOT, stdio: "inherit", shell: true,
  });
  viteProcess.on("exit", (code) => {
    viteProcess = null;
    if (code !== 0) console.log(`Vite exited with code ${code}`);
  });
}

function startServer() {
  if (serverStartPromise) return serverStartPromise;
  serverStartPromise = startServerInner().finally(() => { serverStartPromise = null; });
  return serverStartPromise;
}

async function startServerInner() {
  if (serverProcess) {
    stopServer();
    await waitForPortFree(DEV_PORT);
  }
  if (await isPortInUse(DEV_PORT)) {
    killPortProcess(DEV_PORT);
    await waitForPortFree(DEV_PORT);
  }

  return new Promise((resolve, reject) => {
    if (serverProcess) {
      stopServer();
      setTimeout(() => resolve(startServer()), 500);
      return;
    }
    console.log("⚙️  Starting pi-server...");
    const started = Date.now();
    serverProcess = spawn("npx", ["tsx", "src/server/server.ts"], {
      cwd: ROOT, stdio: ["pipe", "pipe", "inherit"], shell: true,
      env: { ...process.env, PI_DEV_PORT: String(DEV_PORT) },
    });
    let resolved = false;
    serverProcess.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk); // 转发输出到控制台
      if (!resolved && chunk.toString().includes("SERVER_PORT:")) {
        resolved = true;
        const elapsed = Date.now() - started;
        console.log(`⏱️  pi-server ready in ${elapsed}ms`);
        resolve();
      }
    });
    serverProcess.on("exit", (code) => {
      serverProcess = null;
      if (code !== 0 && !resolved) {
        console.log(`pi-server exited with code ${code} — restarting in 1s...`);
        setTimeout(() => resolve(startServerInner()), 1000);
      }
    });
    serverProcess.on("error", reject);
    // 30 秒超时
    setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 30000);
  });
}

function stopServer() {
  if (serverProcess) {
    try { execSync(`taskkill /F /T /PID ${serverProcess.pid}`, { stdio: "ignore" }); } catch {}
    serverProcess = null;
  }
}

function startElectron() {
  if (electronProcess) {
    // 先关闭所有旧 Electron 窗口
    intentionalElectronStop = true;
    try { execSync("taskkill /F /IM electron.exe", { stdio: "ignore" }); } catch {}
    electronProcess = null;
  }
  console.log("⚡ Starting Electron...");
  // 开发模式从 Vite 加载，保留 HMR；确保 Electron 不被当作 Node 进程启动。
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn("npx", ["electron", "."], {
    cwd: ROOT, stdio: "inherit", shell: true,
    env: { ...electronEnv, NODE_ENV: "development", VITE_DEV_PORT: String(VITE_PORT) },
  });
  electronProcess = child;
  registerPid(electronProcess.pid);
  child.on("exit", (code) => {
    if (electronProcess === child) electronProcess = null;
    if (intentionalElectronStop) {
      intentionalElectronStop = false;
      return;
    }
    if (code !== 0 && code !== null) {
      setTimeout(startElectron, 1000);
    }
  });
}

// ─── 文件监听 ─────────────────────────────────────────────────
function setupWatcher() {
  const serverWatcher = watch([
    path.join(ELECTRON_SRC, "server", "server.ts"),
    path.join(ELECTRON_SRC, "frontend", "dashboard.html"),
  ], { ignoreInitial: true });

  serverWatcher.on("change", (f) => {
    pendingServerRestartFile = f;
    if (serverRestartTimer) clearTimeout(serverRestartTimer);
    serverRestartTimer = setTimeout(async () => {
      const file = pendingServerRestartFile;
      pendingServerRestartFile = null;
      serverRestartTimer = null;
      console.log(`📝 ${path.relative(ROOT, file)} changed — restarting pi-server`);
      await startServer();
    }, 150);
  });

  const electronWatcher = watch([
    path.join(ELECTRON_SRC, "electron", "electron-main.ts"),
    path.join(ELECTRON_SRC, "electron", "preload.ts"),
  ], { ignoreInitial: true });

  electronWatcher.on("change", (f) => {
    console.log(`📝 ${path.relative(ROOT, f)} changed — rebuilding & restarting Electron`);
    buildElectron();
    setTimeout(startElectron, 300);
  });

  const frontendRoot = path.join(ELECTRON_SRC, "frontend");
  const frontendWatcher = watch(frontendRoot, {
    ignoreInitial: true,
    ignored: (file) => file.includes(`${path.sep}gen${path.sep}`) || file.endsWith(".d.ts"),
  });
  const compileFrontend = (file) => {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) return;
    if (frontendCompileTimer) clearTimeout(frontendCompileTimer);
    frontendCompileTimer = setTimeout(() => {
      frontendCompileTimer = null;
      try {
        execSync("node scripts/compile-frontend-ts.mjs", { cwd: ROOT, stdio: "pipe" });
        console.log(`📝 ${path.relative(ROOT, file)} changed — frontend recompiled`);
      } catch (err) {
        console.error("❌ Frontend compile failed:", err.stderr?.toString() || err.message);
      }
    }, 80);
  };
  frontendWatcher.on("add", compileFrontend);
  frontendWatcher.on("change", compileFrontend);
}

// ─── 入口 ─────────────────────────────────────────────────────
async function main() {
  cleanupOldProcesses();

  // 1. 编译 Electron
  buildElectron();

  // 2. 编译 TS→JS（Vite dev server 需要 .js 文件）
  console.log("🔁 Compiling frontend TS→JS...");
  try {
    execSync("node scripts/compile-frontend-ts.mjs", { cwd: ROOT, stdio: "pipe" });
  } catch { console.log("⚠️  Frontend TS compile had issues"); }

  // 3. 等待端口可用
  if (await isPortInUse(DEV_PORT)) {
    console.log(`⚠️  Port ${DEV_PORT} in use, waiting 2s...`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // 3. 启动 Vite dev server
  await startVite();

  // 5. 启动 pi-server（等待实际就绪）
  await startServer();

  // 6. 启动 Electron
  startElectron();

  // 7. 文件监听
  setupWatcher();
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

function cleanup() {
  try { execSync(`taskkill /F /T /PID ${electronProcess?.pid}`, { stdio: "ignore" }); } catch {}
  try { execSync(`taskkill /F /T /PID ${serverProcess?.pid}`, { stdio: "ignore" }); } catch {}
  try { execSync(`taskkill /F /T /PID ${viteProcess?.pid}`, { stdio: "ignore" }); } catch {}
  electronProcess = null;
  serverProcess = null;
  viteProcess = null;
  removePid();
}
