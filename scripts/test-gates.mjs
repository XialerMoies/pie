#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { buildTestManifest } from "./test-manifest.mjs";
import { validateTestExceptions } from "./test-exceptions.mjs";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const defaultConcurrency = Number(process.env.MY_CODE_AGENT_GATE_CONCURRENCY || 1);
const resourceBudgetMb = Number(process.env.MY_CODE_AGENT_GATE_BUDGET_MB || 3584);
const profiles = {
  light: { memoryMb: 2048 },
  test: { memoryMb: Number(process.env.MY_CODE_AGENT_TEST_MEMORY_MB || 2048) },
  build: { memoryMb: Number(process.env.MY_CODE_AGENT_BUILD_MEMORY_MB || 3584) },
  electron: { memoryMb: Number(process.env.MY_CODE_AGENT_TEST_MEMORY_MB || 2048) },
  live: { memoryMb: Number(process.env.MY_CODE_AGENT_LIVE_MEMORY_MB || 2048) },
};

export const GATES = [
  { name: "governance", deps: [], profile: "light", command: process.execPath, args: ["scripts/test-exceptions.mjs", "--check"] },
  { name: "manifest", deps: ["governance"], profile: "light", command: process.execPath, args: ["scripts/test-manifest.mjs", "--check"] },
  { name: "report", deps: ["manifest"], profile: "light", command: process.execPath, args: ["scripts/test-report.mjs", "--check"] },
  { name: "typecheck", deps: ["manifest"], profile: "build", command: npmCommand, args: ["run", "typecheck"] },
  { name: "unit", deps: ["report"], profile: "test", command: npmCommand, args: ["run", "test:unit"] },
  { name: "routes", deps: ["report"], profile: "test", command: npmCommand, args: ["run", "test:routes"] },
  { name: "frontend", deps: ["report"], profile: "test", command: npmCommand, args: ["run", "test:frontend"] },
  { name: "css-vars", deps: ["frontend"], profile: "light", command: process.execPath, args: ["test/css-vars.mjs"] },
  { name: "replay", deps: ["routes"], profile: "test", command: process.execPath, args: ["scripts/tsx-test.mjs", "--test", "--test-concurrency=1", "test/agent-session-replay-first-flow.test.mjs"] },
  { name: "coverage", deps: ["unit", "routes", "frontend"], profile: "test", command: process.execPath, args: ["scripts/test-coverage.mjs"] },
  { name: "build", deps: ["typecheck", "unit", "routes", "frontend", "css-vars", "replay", "coverage"], profile: "build", command: npmCommand, args: ["run", "build"] },
  { name: "build-flow", deps: ["build"], profile: "test", command: npmCommand, args: ["run", "test:build"] },
  { name: "electron", deps: ["build-flow"], profile: "electron", command: npmCommand, args: ["run", "test:electron:e2e"] },
  { name: "live", deps: ["report"], profile: "live", optional: true, retry: "observe", command: npmCommand, args: ["run", "test:provider:live"] },
];

export function shouldRetry(gate, lane = process.env.MY_CODE_AGENT_GATE_LANE || "blocking", attempt = 1) {
  return lane === "observe" && gate.retry === "observe" && attempt === 1;
}

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
  const script = "try { $root=" + Number(pid) + "; $all=@{}; Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId]=[int]$_.ParentProcessId }; $ids=@($root); for($i=0;$i -lt $ids.Count;$i++){ foreach($p in $all.GetEnumerator()){ if($p.Value -eq $ids[$i] -and $ids -notcontains $p.Key){ $ids += $p.Key } } }; $sum=0; foreach($id in $ids){ $proc=Get-Process -Id $id -ErrorAction SilentlyContinue; if($proc){ $sum += $proc.WorkingSet64 } }; [math]::Round($sum/1MB,0) } catch { 0 }";
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
  } else {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000).unref();
  }
}

function runGate(gate) {
  const profile = profiles[gate.profile];
  const startedAt = Date.now();
  const env = {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --max-old-space-size=${profile.memoryMb}`.trim(),
  };
  console.log(`[test-gates] start ${gate.name} deps=[${gate.deps.join(",") || "-"}] profile=${gate.profile} limit=${profile.memoryMb}MB`);
  const child = spawn(gate.command, gate.args, { cwd: process.cwd(), env, stdio: "inherit", shell: gate.command.endsWith(".cmd"), windowsHide: true });
  let peak = 0;
  let exceeded = false;
  let firstExceededAtMs;
  const monitor = setInterval(async () => {
    const usage = await processTreeRssMb(child.pid);
    peak = Math.max(peak, usage);
    if (!exceeded && usage >= profile.memoryMb) {
      exceeded = true;
      firstExceededAtMs = Date.now() - startedAt;
      console.error(`[test-gates] LIMIT ${gate.name} RSS=${usage.toFixed(0)}MB/${profile.memoryMb}MB`);
      stopProcessTree(child);
    }
  }, 250);
  return once(child, "close").then(async ([code, signal]) => {
    clearInterval(monitor);
    const durationMs = Date.now() - startedAt;
    const residualRssMb = await processTreeRssMb(child.pid);
    const result = { name: gate.name, code: code ?? 1, signal, durationMs, peakRssMb: Math.round(peak), residualRssMb: Math.round(residualRssMb), memoryLimitMb: profile.memoryMb, exceeded, firstExceededAtMs };
    console.log(`[test-gates] finish ${gate.name} status=${signal ? `signal:${signal}` : `exit:${result.code}`} peak=${result.peakRssMb}MB residual=${result.residualRssMb}MB duration=${(durationMs / 1000).toFixed(1)}s`);
    return result;
  });
}

export function validateGateDag(gates = GATES) {
  const names = new Set(gates.map((gate) => gate.name));
  const errors = [];
  for (const gate of gates) {
    if (!profiles[gate.profile]) errors.push(`${gate.name}: unknown profile ${gate.profile}`);
    for (const dep of gate.deps) if (!names.has(dep)) errors.push(`${gate.name}: unknown dependency ${dep}`);
    if (gate.deps.includes(gate.name)) errors.push(`${gate.name}: self dependency`);
  }
  const visiting = new Set();
  const visited = new Set();
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  function visit(name) {
    if (visiting.has(name)) { errors.push(`cycle involving ${name}`); return; }
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dep of byName.get(name)?.deps ?? []) if (byName.has(dep)) visit(dep);
    visiting.delete(name); visited.add(name);
  }
  for (const gate of gates) visit(gate.name);
  return [...new Set(errors)];
}

export async function runGates({ gates = GATES, selected = null, concurrency = defaultConcurrency, lane = process.env.MY_CODE_AGENT_GATE_LANE || "blocking" } = {}) {
  const dagErrors = validateGateDag(gates);
  if (dagErrors.length) throw new Error(dagErrors.join("\n"));
  const governanceErrors = validateTestExceptions();
  if (governanceErrors.length) throw new Error(governanceErrors.join("\n"));
  const requested = selected ? new Set(selected) : null;
  const byName = new Map(gates.map((gate) => [gate.name, gate]));
  const wanted = new Set();
  function include(name) {
    if (wanted.has(name) || !byName.has(name)) return;
    wanted.add(name);
    for (const dep of byName.get(name).deps) include(dep);
  }
  if (requested) for (const name of requested) include(name);
  const active = gates.filter((gate) => {
    if (requested) return wanted.has(gate.name) && (!gate.optional || requested.has(gate.name) || process.env.PROVIDER_MATRIX_FILE?.trim());
    return !gate.optional || process.env.PROVIDER_MATRIX_FILE?.trim();
  });
  const results = new Map();
  const running = new Map();
  let usedMemory = 0;
  while (results.size < active.length) {
    const ready = active.filter((gate) => !results.has(gate.name) && !running.has(gate.name) && gate.deps.every((dep) => results.get(dep)?.code === 0));
    for (const gate of ready) {
      const memoryMb = profiles[gate.profile].memoryMb;
      if (running.size >= Math.max(1, concurrency) || usedMemory + memoryMb > resourceBudgetMb) continue;
      usedMemory += memoryMb;
      const promise = runGate(gate).then(async (result) => {
        if ((result.code !== 0 || result.signal || result.exceeded) && shouldRetry(gate, lane, 1)) {
          console.error(`[test-gates] observation retry ${gate.name} (blocking lane never retries)`);
          const retryResult = await runGate(gate);
          retryResult.retryCount = 1;
          return retryResult;
        }
        result.retryCount = 0;
        return result;
      }).then((result) => { results.set(gate.name, result); running.delete(gate.name); usedMemory -= memoryMb; return result; });
      running.set(gate.name, promise);
    }
    if (running.size) await Promise.race(running.values());
    else {
      const blocked = active.filter((gate) => !results.has(gate.name));
      const failedDep = blocked.find((gate) => gate.deps.some((dep) => results.get(dep)?.code !== 0));
      if (failedDep) {
        console.error(`[test-gates] blocked at ${failedDep.name} because a dependency failed`);
        for (const gate of blocked) results.set(gate.name, { name: gate.name, code: 1, blocked: true, reason: "dependency_failed", peakRssMb: 0, memoryLimitMb: profiles[gate.profile].memoryMb });
        break;
      }
      throw new Error("gate DAG made no progress");
    }
  }
  return [...results.values()];
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/test-gates.mjs")) {
  const selected = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const results = await runGates({ selected: selected.length ? selected : null });
  if (results.some((result) => result.code !== 0 || result.signal || result.exceeded)) process.exitCode = 1;
  else console.log(`[test-gates] all ${results.length} gates passed`);
}
