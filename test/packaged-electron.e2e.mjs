import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { firstTimingAtOrAfter } from "./helpers/electron-e2e-result.mjs";
import { inspectPackagedE2EPoll } from "./helpers/packaged-electron-poll.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const executable = resolve(ROOT, "release", "win-unpacked", "MyCodeAgent.exe");
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout="));
const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : 120_000;

assert.ok(process.platform === "win32", "packaged Electron E2E currently targets Windows");
assert.ok(existsSync(executable), `packaged executable is missing: ${executable}`);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeout must be a positive number");

const tempRoot = mkdtempSync(join(ROOT, ".tmp-packaged-e2e-"));
const dataDir = join(tempRoot, "data");
const electronUserDataDir = join(tempRoot, "electron-user-data");
const resultFile = join(tempRoot, "result.json");
const children = new Set();
let output = "";
let passed = false;
let secondLaunchChild = null;
const memoryLimitMb = Number(process.env.MY_CODE_AGENT_TEST_MEMORY_MB || 2048);
let peakRssMb = 0;
let memoryExceeded = false;
let memoryMonitor = null;

function processTreeRssMb(pid) {
  if (process.platform !== "win32") return Promise.resolve(0);
  const script = "try { $root=" + Number(pid) + "; $all=@{}; Get-CimInstance Win32_Process | ForEach-Object { $all[[int]$_.ProcessId]=[int]$_.ParentProcessId }; $ids=@($root); for($i=0;$i -lt $ids.Count;$i++){ foreach($p in $all.GetEnumerator()){ if($p.Value -eq $ids[$i] -and $ids -notcontains $p.Key){ $ids += $p.Key } } }; $sum=0; foreach($id in $ids){ $proc=Get-Process -Id $id -ErrorAction SilentlyContinue; if($proc){ $sum += $proc.WorkingSet64 } }; [math]::Round($sum/1MB,0) } catch { 0 }";
  return new Promise((resolveRss) => {
    const probe = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let text = "";
    probe.stdout.on("data", (chunk) => { text += chunk; });
    probe.once("close", () => resolveRss(Number(text.trim()) || 0));
    probe.once("error", () => resolveRss(0));
  });
}

function startMemoryMonitor() {
  memoryMonitor = setInterval(async () => {
    const roots = [...children].filter((child) => child?.pid && !hasExited(child));
    const usage = (await Promise.all(roots.map((child) => processTreeRssMb(child.pid)))).reduce((sum, value) => sum + value, 0);
    peakRssMb = Math.max(peakRssMb, usage);
    if (!memoryExceeded && usage >= memoryLimitMb) {
      memoryExceeded = true;
      console.error(`packaged Electron memory limit exceeded: RSS=${usage}MB / ${memoryLimitMb}MB`);
      for (const child of roots) stopProcessTree(child);
    }
  }, 250);
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopProcessTree(child) {
  if (!child?.pid || hasExited(child)) return;
  const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
}

function waitForExit(child, waitMs = 15_000) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      rejectExit(new Error(`packaged app did not exit within ${waitMs}ms`));
    }, waitMs);
    child.once("exit", onExit);
  });
}

async function terminateChild(child) {
  stopProcessTree(child);
  await waitForExit(child, 10_000);
  children.delete(child);
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function removeTempRoot() {
  let lastError;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!error || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  console.warn(`could not remove packaged Electron E2E temp root; leaving it for cleanup: ${tempRoot}`, lastError);
}

function equivalentPath(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const normalize = (value) => {
    const absolute = resolve(value);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  return normalize(actual) === normalize(expected);
}

function waitForResult(child) {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      let result = null;
      if (existsSync(resultFile)) {
        try { result = JSON.parse(readFileSync(resultFile, "utf8")); } catch {}
      }
      const poll = inspectPackagedE2EPoll({
        result,
        childExited: hasExited(child),
        childExitCode: child.exitCode,
        now: Date.now(),
        deadline: started + timeoutMs,
        secondLaunchStarted: !!secondLaunchChild,
      });
      if (poll?.kind === "process-exit") {
        clearInterval(timer);
        reject(new Error(`packaged Electron E2E process exited before final result: ${JSON.stringify(poll.diagnostics)}`));
        return;
      }
      if (poll?.kind === "timeout") {
        clearInterval(timer);
        reject(new Error(`timed out waiting for packaged Electron E2E result: ${JSON.stringify(poll.diagnostics)}`));
        return;
      }
      if (poll?.kind === "result") {
        clearInterval(timer);
        resolveResult(poll.result);
        return;
      }
      if (result?.state === "awaiting-second-launch" && !secondLaunchChild) {
        const launch = result.launch;
        secondLaunchChild = spawn(executable, [
          `--user-data-dir=${electronUserDataDir}`,
          `--workspace=${launch.workspace}`,
          `--data-root=${launch.dataRoot}`,
          `--instance-id=${launch.instanceId}`,
        ], {
          cwd: ROOT,
          windowsHide: true,
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.add(secondLaunchChild);
        secondLaunchChild.stdout?.on("data", (chunk) => { output += `[second] ${chunk}`; });
        secondLaunchChild.stderr?.on("data", (chunk) => { output += `[second] ${chunk}`; });
      }
    }, 100);
  });
}

function assertNoRawTokenFields(value, path = "result") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, "token", `raw token field leaked at ${path}.${key}`);
    assertNoRawTokenFields(child, `${path}.${key}`);
  }
}

function assertExistingSecurityProbe(result) {
  assert.equal(result.packaged, true);
  assert.equal(result.renderer?.appRendered, true);
  assert.equal(result.renderer?.apiStatus, 200);
  assert.equal(result.renderer?.diagnosticsStatus, 200);
  assert.equal(result.renderer?.diagnosticsOk, true);
  assert.equal(result.renderer?.diagnosticsCorrelationShape, true);
  assert.equal(result.renderer?.diagnosticsHasSensitiveFields, false);
  assert.equal(result.renderer?.desktopTokenPresent, true);
  assert.equal(result.renderer?.nodeRequireType, "undefined");
  assert.equal(result.renderer?.inlineHandlerCount, 0);
  assert.equal(result.renderer?.popupOpened, false);
  assert.equal(result.renderer?.externalNavigationBlocked, true);
  assert.equal(result.renderer?.webviewAttached, false);
  assert.equal(result.renderer?.revealOutsideRejected, true);
  assert.equal(result.renderer?.trashOutsideRejected, true);
  assert.equal(result.acceptance?.rendererCookieIsolation?.firstDashboardStatus, 200);
  assert.equal(result.acceptance?.rendererCookieIsolation?.secondDashboardStatus, 200);
  assert.equal(result.textIconStatus, 200);
  assert.equal(result.unauthorizedApiStatus, 403);
  assert.equal(result.wrongTokenApiStatus, 403);
  assert.equal(result.hostileOriginApiStatus, 403);
  assert.equal(result.crossSiteApiStatus, 403);
  assert.equal(result.unauthorizedMutationStatus, 403);
  assert.equal(result.unauthorizedMutationCreated, false);
  assert.equal(result.fileReadStatus, 200);
  assert.equal(result.fileWriteStatus, 200);
  assert.equal(result.externalReadStatus, 200);
  assert.equal(result.sensitiveExternalReadBlocked, true);
  assert.equal(result.pathTraversalStatus, 403);
  assert.equal(result.siblingTraversalStatus, 403);
  assert.deepEqual(result.renderer?.preloadMethods, [
    "close",
    "getDesktopSessionToken",
    "maximize",
    "minimize",
    "newWindow",
    "onWorkspaceStatus",
    "openWorkspaceFolder",
    "retryWorkspace",
    "selectFile",
    "selectFolder",
    "showItemInFolder",
    "spawnTerminal",
    "trashItem",
  ]);
}

function assertPackagedChatEventFlow(result) {
  assert.deepEqual(result.chatEventFlow?.blockIds, [
    "packaged-thought-1",
    "packaged-tool",
    "packaged-thought-2",
    "packaged-text",
  ]);
  assert.deepEqual(result.chatEventFlow?.terminalBlockIds, result.chatEventFlow?.blockIds);
  assert.equal(result.chatEventFlow?.refreshMatches, true);
  assert.equal(result.chatEventFlow?.assistantRootStable, true);
  assert.equal(result.chatEventFlow?.fullRenders, 0);
  assert.equal(result.chatEventFlow?.scheduled, 0);
  assert.match(String(result.chatEventFlow?.visibleText || ""), /先分析/);
  assert.match(String(result.chatEventFlow?.visibleText || ""), /最终正文/);
}

function assertPackagedConcurrencyResult(result) {
  const concurrency = result.concurrency;
  assert.ok(concurrency && typeof concurrency === "object", "packaged concurrency result is missing");
  assert.equal(concurrency.requestCount, 7);
  assert.equal(concurrency.withinDeadline, true, "long tool stream did not reach terminal DOM state");
  assert.equal(concurrency.streamOverlappedIndependentRequests, true, "independent requests did not overlap the long tool");
  assert.deepEqual(concurrency.nodeOrder, ["e2e-thought", "e2e-tool", "e2e-text"]);
  assert.equal(concurrency.stableNodeIdentity, true);
  assert.equal(concurrency.mutationSummary?.rootReplaced, false);
  assert.equal(concurrency.mutationSummary?.removedExisting, 0);
  assert.equal(concurrency.chatPaneOpened, true);
  assert.equal(concurrency.settingsOpened, true);
  assert.equal(concurrency.loadingStates?.sessionListLoading, false);
  assert.equal(concurrency.loadingStates?.settingsLoading, false);
  assert.equal(concurrency.loadingStates?.workspaceLoading, false);
  for (const request of concurrency.requestRecords || []) {
    assert.equal(typeof request.completedMs, "number", `${request.name} did not complete`);
    assert.notEqual(request.status, 0, `${request.name} transport failed`);
  }
}

function assertSingleProcessMultiWindowResult(result) {
  assert.equal(result.ok, true, `packaged probe failed: ${JSON.stringify(result, null, 2)}`);
  assertExistingSecurityProbe(result);
  assertPackagedChatEventFlow(result);
  assertPackagedConcurrencyResult(result);
  assertNoRawTokenFields(result);

  assert.equal(Number.isInteger(result.electronPid), true);
  assert.equal(result.windows.length, 2);
  const projectA = result.windows.find((window) => equivalentPath(window.workspace, result.acceptance.workspaceA));
  const projectB = result.windows.find((window) => equivalentPath(window.workspace, result.acceptance.workspaceB));
  assert.ok(projectA, "project A diagnostic is missing");
  assert.ok(projectB, "project B diagnostic is missing");
  assert.equal(projectA.serverKind, "owned");
  assert.equal(projectB.serverKind, "owned");
  assert.notEqual(projectA.contextId, projectB.contextId);
  assert.notEqual(projectA.webContentsId, projectB.webContentsId);
  assert.notEqual(projectA.instanceId, projectB.instanceId);
  assert.notEqual(projectA.serverPid, projectB.serverPid);
  assert.notEqual(projectA.port, projectB.port);
  assert.notEqual(projectA.tokenFingerprint, projectB.tokenFingerprint);
  assert.match(projectA.tokenFingerprint, /^[a-f0-9]{16}$/);
  assert.match(projectB.tokenFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(equivalentPath(projectA.workspace, projectB.workspace), false);
  assert.equal(equivalentPath(projectA.instanceRoot, projectB.instanceRoot), false);

  const duplicate = result.acceptance.duplicateWorkspace;
  assert.equal(duplicate.focusedContextId, projectA.contextId);
  assert.equal(duplicate.emptyContextId, duplicate.attemptedContextId);
  assert.equal(duplicate.serverKindAfter, "none");
  assert.equal(duplicate.workspaceAfter, null);
  assert.equal(duplicate.windowCount, 2);
  assert.equal(duplicate.serverChildCountAfter, duplicate.serverChildCountBefore);

  const crash = result.acceptance.crashIsolation;
  assert.notEqual(crash.serverPidBefore, crash.serverPidAfter);
  assert.equal(crash.projectALoadedAtAfter, crash.projectALoadedAtBefore);
  assert.equal(crash.projectADashboardStatus, 200);

  const closeReopen = result.acceptance.closeReopen;
  assert.equal(closeReopen.closedServerExited, true);
  assert.equal(closeReopen.projectADashboardStatus, 200);
  assert.equal(closeReopen.windowCount, 2);
  assert.equal(closeReopen.reopenAction, "bound");
  assert.equal(closeReopen.reopenError, null);

  assert.equal(result.acceptance.secondLaunch.electronPid, result.electronPid);
  assert.equal(result.acceptance.secondLaunch.windowCount, 2);

  const shellCreated = firstTimingAtOrAfter(result, {
    contextId: result.acceptance.timing.shellContextId,
    event: "window-created",
    at: 0,
  });
  const shellVisible = firstTimingAtOrAfter(result, {
    contextId: result.acceptance.timing.shellContextId,
    event: "shell-visible",
    at: shellCreated?.at ?? 0,
  });
  const workbenchLoaded = firstTimingAtOrAfter(result, {
    contextId: result.acceptance.timing.workspaceContextId,
    event: "workbench-loaded",
    at: result.acceptance.timing.workspaceSelectedAt,
  });
  assert.ok(shellCreated && shellVisible && workbenchLoaded, "required timing events are missing");
  assert.equal(result.acceptance.timing.shellVisibleMs, shellVisible.at - shellCreated.at);
  assert.equal(result.acceptance.timing.workbenchLoadedMs, workbenchLoaded.at - result.acceptance.timing.workspaceSelectedAt);
  assert.ok(result.acceptance.timing.shellVisibleMs < 300, `empty shell took ${result.acceptance.timing.shellVisibleMs}ms`);
  assert.ok(result.acceptance.timing.workbenchLoadedMs < 3_000, `project workbench took ${result.acceptance.timing.workbenchLoadedMs}ms`);

  return {
    shellVisibleMs: result.acceptance.timing.shellVisibleMs,
    workbenchLoadedMs: result.acceptance.timing.workbenchLoadedMs,
    electronPid: result.electronPid,
    serverPids: [projectA.serverPid, projectB.serverPid],
    ports: [projectA.port, projectB.port],
    peakRssMb,
    memoryLimitMb,
  };
}

let child;
let failure;
try {
  child = spawn(executable, [
    `--user-data-dir=${electronUserDataDir}`,
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--in-process-gpu",
    "--no-sandbox",
  ], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "test",
      MY_CODE_AGENT_E2E_RESULT_FILE: resultFile,
      MY_CODE_AGENT_E2E_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  startMemoryMonitor();

  const result = await waitForResult(child);
  if (memoryExceeded) throw new Error(`packaged Electron exceeded ${memoryLimitMb}MB RSS (peak ${peakRssMb}MB)`);
  const measured = assertSingleProcessMultiWindowResult(result);
  assert.equal(result.electronPid, child.pid, "result must identify the first executable's Electron main process");
  assert.ok(secondLaunchChild, "the harness did not launch a second executable");
  await waitForExit(secondLaunchChild, 15_000);
  assert.equal(secondLaunchChild.exitCode, 0);
  assert.notEqual(secondLaunchChild.pid, result.electronPid);
  children.delete(secondLaunchChild);
  await waitForExit(child, 30_000);
  children.delete(child);
  assert.equal(child.exitCode, 0);
  passed = true;
  console.log("packaged Electron single-process multi-window E2E passed", JSON.stringify(measured));
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const runningChild of [...children]) {
    try {
      await terminateChild(runningChild);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    passed = false;
    const cleanupFailure = new AggregateError(cleanupErrors, "packaged Electron E2E left child processes running");
    failure = failure
      ? new AggregateError([failure, cleanupFailure], "packaged Electron E2E failed and cleanup was incomplete")
      : cleanupFailure;
  }
  if (process.platform === "win32") await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  if (memoryMonitor) clearInterval(memoryMonitor);
  memoryMonitor = null;
  if (!passed) {
    writeFileSync(join(tempRoot, "electron-output.log"), output, "utf8");
    console.error(`packaged Electron E2E artifacts retained at ${tempRoot}`);
  } else {
    await removeTempRoot();
  }
}

if (failure) throw failure;
