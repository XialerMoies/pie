import { spawn } from "node:child_process";
import { once } from "node:events";

const HARD_LIMIT_MB = Number(process.env.MY_CODE_AGENT_TEST_MEMORY_MB || 2048);
const WARN_LIMIT_MB = Math.floor(HARD_LIMIT_MB * 0.8);
const TEST_FILES = [
  "test/routes.test.mjs",
  "test/path-guard.test.mjs",
  "test/server-security.test.mjs",
  "test/desktop-ipc.test.mjs",
  "test/multi-instance-security.test.mjs",
  "test/multi-instance-launch.test.mjs",
  "test/server-permission-service.test.mjs",
  "test/root-registry.test.mjs",
  "test/sessions.test.mjs",
  "test/workspace-session.test.mjs",
  "test/workspace-authorization.test.mjs",
  "test/server-startup-paths.test.mjs",
  "test/session-data-layout.test.mjs",
  "test/typescript-route.test.mjs",
  "test/chat-sse.test.mjs",
  "test/chat-stream-replay.test.mjs",
  "test/chat-event-flow-contract.test.mjs",
  "test/deterministic-event-script-flow.test.mjs",
  "test/agent-fault-matrix-flow.test.mjs",
  "test/agent-terminal-guard-flow.test.mjs",
  "test/agent-event-persistence-flow.test.mjs",
  "test/attachments.test.mjs",
  "test/tool-trace.test.mjs",
  "test/tool-outcome-live-flow.test.mjs",
  "test/agent-fault-matrix.test.mjs",
];
const SERIAL_FILES = ["test/multi-instance-e2e.mjs", "test/workspace-lock.test.mjs"];

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
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}

async function runFile(file, concurrency) {
  const args = ["scripts/tsx-test.mjs", "--test", `--test-concurrency=${concurrency}`, file];
  console.log(`[test-routes] ${file}`);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --max-old-space-size=${HARD_LIMIT_MB}`.trim(),
    },
  });
  let warned = false;
  let stopped = false;
  const monitor = setInterval(async () => {
    const usage = await processTreeRssMb(child.pid);
    if (!usage) return;
    if (!warned && usage >= WARN_LIMIT_MB) {
      warned = true;
      console.error(`[test-routes] memory warning: ${file} RSS=${usage.toFixed(0)}MB / ${HARD_LIMIT_MB}MB`);
    }
    if (!stopped && usage >= HARD_LIMIT_MB) {
      stopped = true;
      console.error(`[test-routes] memory limit exceeded: ${file} RSS=${usage.toFixed(0)}MB / ${HARD_LIMIT_MB}MB`);
      stopProcessTree(child);
    }
  }, 250);
  const [code, signal] = await once(child, "close");
  clearInterval(monitor);
  if (stopped) throw new Error(`${file} exceeded the ${HARD_LIMIT_MB}MB memory limit`);
  if (code !== 0) throw new Error(`${file} failed with exit code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
}

console.log(`[test-routes] isolated file mode; memory limit ${HARD_LIMIT_MB}MB (warning ${WARN_LIMIT_MB}MB)`);
for (const file of TEST_FILES) await runFile(file, 4);
for (const file of SERIAL_FILES) await runFile(file, 1);
console.log(`[test-routes] all ${TEST_FILES.length + SERIAL_FILES.length} files passed`);
