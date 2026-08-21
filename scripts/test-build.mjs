import { spawn } from "node:child_process";
import { once } from "node:events";

const HARD_LIMIT_MB = Number(process.env.MY_CODE_AGENT_TEST_MEMORY_MB || 2048);
const WARN_LIMIT_MB = Math.floor(HARD_LIMIT_MB * 0.8);

const steps = [
  ["build frontend", "scripts/build-frontend.mjs", []],
  ["smoke", "test/smoke.mjs", []],
  ["dist flow", "scripts/tsx-test.mjs", ["--test", "--test-concurrency=1", "test/dist-chat-event-flow.test.mjs", "test/dist-agent-event-flow.test.mjs"]],
];

function processTreeRssMb(pid) {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const script = "try { $root=" + Number(pid) + "; $all=@{}; Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId]=[int]$_.ParentProcessId }; $ids=@($root); for($i=0;$i -lt $ids.Count;$i++){ foreach($p in $all.GetEnumerator()){ if($p.Value -eq $ids[$i] -and $ids -notcontains $p.Key){ $ids += $p.Key } } }; $sum=0; foreach($id in $ids){ $proc=Get-Process -Id $id -ErrorAction SilentlyContinue; if($proc){ $sum += $proc.WorkingSet64 } }; [math]::Round($sum/1MB,0) } catch { $proc=Get-Process -Id " + Number(pid) + " -ErrorAction SilentlyContinue; if($proc){ [math]::Round($proc.WorkingSet64/1MB,0) } else { 0 } }";
      const probe = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let output = "";
      probe.stdout.on("data", (chunk) => { output += chunk; });
      probe.once("close", () => resolve(Number(output.trim()) || 0));
      probe.once("error", () => resolve(0));
      return;
    }
    const probe = spawn("ps", ["-o", "rss=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    probe.stdout.on("data", (chunk) => { output += chunk; });
    probe.once("close", () => resolve(Number(output.trim()) / 1024 || 0));
    probe.once("error", () => resolve(0));
  });
}

function stopProcessTree(child) {
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    killer.once("error", () => {});
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 2000).unref();
}

async function runStep(label, script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: "inherit",
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
      console.error(`[test-build] memory warning: ${label} RSS=${usage.toFixed(0)}MB / ${HARD_LIMIT_MB}MB`);
    }
    if (!stopped && usage >= HARD_LIMIT_MB) {
      stopped = true;
      console.error(`[test-build] memory limit exceeded: ${label} RSS=${usage.toFixed(0)}MB / ${HARD_LIMIT_MB}MB`);
      stopProcessTree(child);
    }
  }, 250);
  const [code, signal] = await once(child, "close");
  clearInterval(monitor);
  if (stopped) throw new Error(`${label} exceeded the ${HARD_LIMIT_MB}MB memory limit`);
  if (code !== 0) throw new Error(`${label} failed with exit code ${code ?? "null"}${signal ? ` (${signal})` : ""}`);
}

console.log(`[test-build] memory limit ${HARD_LIMIT_MB}MB (warning ${WARN_LIMIT_MB}MB)`);
for (const [label, script, args] of steps) {
  console.log(`[test-build] ${label}`);
  await runStep(label, script, args);
}
