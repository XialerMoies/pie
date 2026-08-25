import { spawnSync } from "node:child_process";

export function resolvePositiveBudget(value, fallback) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("E2E budget must be a positive number");
  return parsed;
}

export function resolveWorkbenchBudget(env = process.env) {
  return resolvePositiveBudget(env.MY_CODE_AGENT_E2E_WORKBENCH_BUDGET_MS, env.CI ? 10_000 : 3_000);
}

export function resolveEmptyShellBudget(env = process.env) {
  return resolvePositiveBudget(env.MY_CODE_AGENT_E2E_EMPTY_SHELL_BUDGET_MS, env.CI ? 5_000 : 300);
}

export function resolveExitBudget(env = process.env) {
  return resolvePositiveBudget(env.MY_CODE_AGENT_E2E_EXIT_BUDGET_MS, env.CI ? 60_000 : 30_000);
}

export function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

export function isWindowsPidRunning(pid, spawnSyncImpl = spawnSync) {
  const normalizedPid = Number(pid);
  const probe = spawnSyncImpl("tasklist", ["/FI", `PID eq ${normalizedPid}`, "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return !probe.error && new RegExp(`,"${normalizedPid}",`).test(String(probe.stdout || ""));
}

export function requestWindowsProcessTreeStop(child, spawnSyncImpl = spawnSync) {
  if (!child?.pid || hasChildExited(child)) return { requested: false, status: 0, stderr: "" };
  const result = spawnSyncImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return {
    requested: true,
    status: result.status,
    signal: result.signal,
    stderr: String(result.stderr || "").trim().slice(0, 500),
  };
}

export function waitForChildTermination(child, options = {}) {
  const waitMs = options.waitMs ?? 15_000;
  const pollMs = options.pollMs ?? 100;
  const isPidRunning = options.isPidRunning ?? isWindowsPidRunning;
  if (!child?.pid || hasChildExited(child) || !isPidRunning(child.pid)) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const started = Date.now();
    let timer;
    const finish = (error) => {
      clearTimeout(timer);
      child.off?.("exit", onExit);
      if (error) rejectExit(error);
      else resolveExit();
    };
    const onExit = () => finish();
    const poll = () => {
      if (hasChildExited(child) || !isPidRunning(child.pid)) {
        finish();
        return;
      }
      if (Date.now() - started >= waitMs) {
        finish(new Error(`packaged app PID ${child.pid} did not terminate within ${waitMs}ms`));
        return;
      }
      timer = setTimeout(poll, pollMs);
    };
    child.once?.("exit", onExit);
    timer = setTimeout(poll, Math.min(pollMs, waitMs));
  });
}

export async function terminateWindowsProcessTree(child, options = {}) {
  if (!child?.pid || hasChildExited(child)) return;
  const stop = requestWindowsProcessTreeStop(child, options.spawnSyncImpl);
  try {
    await waitForChildTermination(child, options);
  } catch (error) {
    const suffix = stop.requested
      ? `; taskkill status=${stop.status ?? "null"}${stop.signal ? ` signal=${stop.signal}` : ""}${stop.stderr ? ` stderr=${stop.stderr}` : ""}`
      : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${suffix}`);
  }
}
