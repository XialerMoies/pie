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
import { randomBytes } from "crypto";
import { watch } from "chokidar";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { compilePreload } from "./compile-preload.mjs";
import {
  createElectronRebuildScheduler,
  createIntentionalProcessStops,
  handleElectronChildError,
  runElectronBuild,
} from "./dev-electron-reload.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ELECTRON_SRC = path.resolve(ROOT, "src");
const PID_FILE = path.resolve(ROOT, "data", "pi", ".dev.pid");
const devStartupStartedAt = Date.now();

function logStartupStage(stage, startedAt = devStartupStartedAt) {
  const now = Date.now();
  console.log(`[startup] dev-${stage} wall=${now} elapsed=${now - devStartupStartedAt}ms duration=${now - startedAt}ms`);
}

const DEV_PORT = 3099;
const VITE_PORT = 5173;
const DESKTOP_SECURITY_TOKEN = process.env.MY_CODE_AGENT_DESKTOP_TOKEN || randomBytes(32).toString("base64url");
const DEV_APP_ORIGIN = `http://127.0.0.1:${VITE_PORT}`;

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

async function waitForPortReady(port, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await isPortInUse(port)) return true;
    await delay(100);
  }
  throw new Error(`Timed out waiting for port ${port}`);
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

function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" }); } catch {}
}

function readRegisteredPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
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
  killProcessTree(readRegisteredPid());
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
  return runElectronBuild({
    compileMain: () => execSync("npx tsc -p tsconfig.electron.json", { cwd: ROOT, stdio: "pipe" }),
    compileBundles: compilePreload,
    onSuccess: () => console.log("✅ Electron compiled"),
    onError: (err) => console.error("❌ Compile failed:", err.stderr?.toString() || err.message),
  });
}

// ─── 进程管理 ─────────────────────────────────────────────────
let serverProcess = null;
let electronProcess = null;
let viteProcess = null;
let serverStartPromise = null;
let serverRestartTimer = null;
let pendingServerRestartFile = null;
let frontendCompileTimer = null;
const intentionalElectronStops = createIntentionalProcessStops();

function isNonRetryableServerStartupError(errorOutput) {
  return /WorkspaceLockConflictError|workspace_locked/.test(errorOutput);
}

function createServerStartupError(code) {
  return new Error(`pi-server exited before ready (${code})`);
}

function createDevServerEnv() {
  const env = {
    ...process.env,
    VITE_DEV_PORT: String(VITE_PORT),
    PI_DEV_PORT: String(DEV_PORT),
    MY_CODE_AGENT_DESKTOP_TOKEN: DESKTOP_SECURITY_TOKEN,
    MY_CODE_AGENT_ALLOWED_ORIGINS: DEV_APP_ORIGIN,
  };
  if (process.platform === "win32") {
    const tempDir = path.resolve(ROOT, "node_modules", ".cache", "my-code-agent-dev");
    fs.mkdirSync(tempDir, { recursive: true });
    env.TEMP = tempDir;
    env.TMP = tempDir;
    env.TMPDIR = tempDir;
    const preload = path.resolve(ROOT, "scripts", "tsx-windows-sandbox.cjs");
    env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
  }
  return env;
}

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
  await waitForPortReady(VITE_PORT);
}

function startServer(onSpawn = () => {}) {
  if (serverStartPromise) return serverStartPromise;
  serverStartPromise = startServerInner(onSpawn).finally(() => { serverStartPromise = null; });
  return serverStartPromise;
}

async function startServerInner(onSpawn = () => {}) {
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
    serverProcess = spawn(process.execPath, [
      "--import",
      "tsx",
      path.resolve(ROOT, "src", "server", "server.ts"),
    ], {
      cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], shell: false,
      env: createDevServerEnv(),
    });
    onSpawn();
    let resolved = false;
    let output = "";
    let errorOutput = "";
    const startupTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      reject(createServerStartupError("timeout"));
    }, 30000);
    serverProcess.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk); // 转发输出到控制台
      if (!resolved && output.includes("SERVER_PORT:")) {
        resolved = true;
        clearTimeout(startupTimer);
        const elapsed = Date.now() - started;
        console.log(`⏱️  pi-server ready in ${elapsed}ms`);
        resolve();
      }
    });
    serverProcess.stderr?.on("data", (chunk) => {
      errorOutput += chunk.toString();
      process.stderr.write(chunk);
    });
    serverProcess.on("exit", (code) => {
      serverProcess = null;
      if (resolved) return;
      clearTimeout(startupTimer);
      if (isNonRetryableServerStartupError(errorOutput)) {
        resolved = true;
        reject(createServerStartupError(code));
      } else if (code !== 0) {
        console.log(`pi-server exited with code ${code} — restarting in 1s...`);
        setTimeout(() => {
          startServerInner(onSpawn).then(resolve, reject);
        }, 1000);
      } else {
        resolved = true;
        reject(createServerStartupError(code));
      }
    });
    serverProcess.on("error", (error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(startupTimer);
      reject(error);
    });
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
    intentionalElectronStops.mark(electronProcess);
    killProcessTree(electronProcess.pid);
    electronProcess = null;
  }
  console.log("⚡ Starting Electron...");
  // 开发模式从 Vite 加载，保留 HMR；确保 Electron 不被当作 Node 进程启动。
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn("npx", ["electron", "."], {
    cwd: ROOT, stdio: "inherit", shell: true,
    env: {
      ...electronEnv,
      NODE_ENV: "development",
      VITE_DEV_PORT: String(VITE_PORT),
      PI_DEV_PORT: String(DEV_PORT),
      MY_CODE_AGENT_DESKTOP_TOKEN: DESKTOP_SECURITY_TOKEN,
    },
  });
  electronProcess = child;
  registerPid(electronProcess.pid);
  child.on("error", (error) => {
    handleElectronChildError({
      child,
      currentChild: electronProcess,
      error,
      clearCurrent: () => { electronProcess = null; },
      reportError: (failure) => console.error("Electron failed to start:", failure),
      cleanup,
      exit: (code) => process.exit(code),
    });
  });
  child.on("exit", (code) => {
    if (electronProcess === child) electronProcess = null;
    if (intentionalElectronStops.consume(child)) return;
    cleanup();
    process.exit(code ?? 1);
  });
}

// ─── 文件监听 ─────────────────────────────────────────────────
function setupWatcher() {
  const serverWatcher = watch([
    path.join(ELECTRON_SRC, "server"),
    path.join(ELECTRON_SRC, "agent"),
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

  const electronRoot = path.join(ELECTRON_SRC, "electron");
  const electronWatcher = watch(electronRoot, {
    ignoreInitial: true,
    ignored: (file) => {
      if (file === electronRoot) return false;
      return !file.endsWith(".ts");
    },
  });
  const electronRebuild = createElectronRebuildScheduler({
    buildElectron,
    restartElectron: startElectron,
    onRebuild: (file) => {
      console.log(`📝 ${path.relative(ROOT, file)} changed — rebuilding & restarting Electron`);
    },
  });

  electronWatcher.on("change", (f) => {
    electronRebuild.schedule(f);
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
  logStartupStage("process-start");
  cleanupOldProcesses();

  // Start the server child before synchronous compilation so both can run in parallel.
  const serverStartedAt = Date.now();
  let markServerSpawned;
  const serverSpawned = new Promise((resolve) => { markServerSpawned = resolve; });
  const serverReady = startServer(markServerSpawned);
  let serverStartupError = null;
  void serverReady.catch((error) => { serverStartupError = error; });
  await Promise.race([serverSpawned, serverReady]);
  logStartupStage("server-spawned", serverStartedAt);

  // 1. 编译 Electron
  const electronCompileStartedAt = Date.now();
  if (!buildElectron()) throw new Error("Electron compilation failed");
  logStartupStage("electron-compiled", electronCompileStartedAt);

  // 2. 编译 TS→JS（Vite dev server 需要 .js 文件）
  console.log("🔁 Compiling frontend TS→JS...");
  const frontendCompileStartedAt = Date.now();
  try {
    execSync("node scripts/compile-frontend-ts.mjs", { cwd: ROOT, stdio: "pipe" });
  } catch { console.log("⚠️  Frontend TS compile had issues"); }
  logStartupStage("frontend-compiled", frontendCompileStartedAt);

  // 3. 等待端口可用
  if (await isPortInUse(DEV_PORT)) {
    console.log(`⚠️  Port ${DEV_PORT} in use, waiting 2s...`);
    await new Promise(r => setTimeout(r, 2000));
  }

  // 3. 启动 Vite dev server
  const viteStartedAt = Date.now();
  await startVite();
  logStartupStage("vite-ready", viteStartedAt);
  if (serverStartupError) throw serverStartupError;

  // 5. The server has been initializing during compilation; show Electron now.
  startElectron();
  logStartupStage("electron-spawned");

  await serverReady;
  logStartupStage("server-ready", serverStartedAt);

  // 7. 文件监听
  setupWatcher();
}

main().catch(err => {
  cleanup();
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
  killProcessTree(electronProcess?.pid);
  killProcessTree(serverProcess?.pid);
  killProcessTree(viteProcess?.pid);
  electronProcess = null;
  serverProcess = null;
  viteProcess = null;
  removePid();
}
