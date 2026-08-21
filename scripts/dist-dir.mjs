import { spawn } from "node:child_process";
import { once } from "node:events";

const HARD_LIMIT_MB = Number(process.env.MY_CODE_AGENT_TEST_MEMORY_MB || 2048);
const WARN_LIMIT_MB = Math.floor(HARD_LIMIT_MB * 0.8);

function processTreeRssMb(pid) {
  if (process.platform !== "win32") {
    return new Promise((resolve) => {
      const probe = spawn("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      probe.stdout.on("data", (chunk) => { output += chunk; });
      probe.once("close", () => resolve(Number(output.trim()) / 1024 || 0));
      probe.once("error", () => resolve(0));
    });
  }

  const script = "try { $root=" + Number(pid) + "; $all=@{}; Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId]=[int]$_.ParentProcessId }; $ids=@($root); for($i=0;$i -lt $ids.Count;$i++){ foreach($p in $all.GetEnumerator()){ if($p.Value -eq $ids[$i] -and $ids -notcontains $p.Key){ $ids += $p.Key } } }; $sum=0; foreach($id in $ids){ $proc=Get-Process -Id $id -ErrorAction SilentlyContinue; if($proc){ $sum += $proc.WorkingSet64 } }; [math]::Round($sum/1MB,0) } catch { $proc=Get-Process -Id " + Number(pid) + " -ErrorAction SilentlyContinue; if($proc){ [math]::Round($proc.WorkingSet64/1MB,0) } else { 0 } }";
  return new Promise((resolve) => {
    const probe = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    probe.stdout.on("data", (chunk) => { output += chunk; });
    probe.once("close", () => resolve(Number(output.trim()) || 0));
    probe.once("error", () => resolve(0));
  });
}

function stopProcessTree(child) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => {});
    return;
  }
  child.kill("SIGTERM");
}

async function run(label, command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
    shell: process.platform === "win32",
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --max-old-space-size=${HARD_LIMIT_MB}`.trim() },
  });
  let warned = false;
  let stopped = false;
  const monitor = setInterval(async () => {
    const usage = await processTreeRssMb(child.pid);
    if (!usage) return;
    if (!warned && usage >= WARN_LIMIT_MB) {
      warned = true;
      console.error(`[dist-dir] memory warning: ${label} RSS=${usage}MB / ${HARD_LIMIT_MB}MB`);
    }
    if (!stopped && usage >= HARD_LIMIT_MB) {
      stopped = true;
      console.error(`[dist-dir] memory limit exceeded: ${label} RSS=${usage}MB / ${HARD_LIMIT_MB}MB`);
      stopProcessTree(child);
    }
  }, 250);
  const [code, signal] = await once(child, "close");
  clearInterval(monitor);
  if (stopped) throw new Error(`${label} exceeded the ${HARD_LIMIT_MB}MB memory limit`);
  if (code !== 0) throw new Error(`${label} failed with exit code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
}

console.log(`[dist-dir] memory limit ${HARD_LIMIT_MB}MB (warning ${WARN_LIMIT_MB}MB)`);
await run("build", process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"]);
await run("electron-builder", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder", ["--win", "dir"]);
