/**
 * My Code Agent — 清理孤儿进程
 * 杀掉所有与本项目相关的残留进程
 */
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { unlinkSync, existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

console.log("🧹 清理残留进程...");

// 按已知端口杀掉进程（Vite :5173、pi-server :3099 / :2333）
const PORTS = [5173, 3099, 2333];
for (const port of PORTS) {
  try {
    const result = execSync(
      `netstat -ano | findstr "LISTENING" | findstr ":${port} "`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    );
    const pids = [...result.matchAll(/(\d+)\s*$/gm)].map(m => m[1].trim());
    for (const pid of new Set(pids)) {
      try { execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" }); console.log(`  ✓ 已杀死 port ${port} (PID ${pid})`); } catch {}
    }
  } catch { /* port not in use */ }
}

// 按命令行特征杀掉本项目相关进程
const PATTERNS = [
  { name: "server", cmd: "tsx.*server.ts" },
  { name: "Vite", cmd: "vite" },
  { name: "esbuild", cmd: "esbuild" },
  { name: "tsx watch", cmd: "tsx.*watch" },
  { name: "electron", cmd: "electron" },
];

for (const { name, cmd } of PATTERNS) {
  try {
    const result = execSync(
      `wmic process where "name='node.exe' and commandline like '%${cmd}%'" get processid 2>nul`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
    );
    const pids = result.split(/\s+/).filter(s => /^\d+$/.test(s));
    for (const pid of pids) {
      try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" }); console.log(`  ✓ 已杀死 ${name} (PID ${pid})`); } catch {}
    }
  } catch { /* not found */ }
}

// Kill Electron GUI process
try { execSync(`taskkill /F /IM electron.exe 2>nul`, { stdio: "ignore" }); } catch {}

// Clean PID file
const pidFile = resolve(ROOT, "data", "pi", ".dev.pid");
if (existsSync(pidFile)) {
  try { unlinkSync(pidFile); } catch {}
}

console.log("✅ 清理完成");
