import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { firstTimingAtOrAfter } from "./helpers/electron-e2e-result.mjs";
import { inspectPackagedE2EPoll } from "./helpers/packaged-electron-poll.mjs";
import { validateFailureArtifact, writeFailureArtifact } from "./helpers/failure-artifact.mjs";
import {
  hasChildExited,
  resolveEmptyShellBudget,
  resolveExitBudget,
  requestWindowsProcessTreeStop,
  resolveWorkbenchBudget,
  terminateWindowsProcessTree,
  waitForChildTermination,
} from "./helpers/packaged-electron-process.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const executable = resolve(ROOT, "release", "win-unpacked", "MyCodeAgent.exe");
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout="));
const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : 120_000;
const workbenchBudgetMs = resolveWorkbenchBudget();
const emptyShellBudgetMs = resolveEmptyShellBudget();
const exitBudgetMs = resolveExitBudget();

assert.ok(process.platform === "win32", "packaged Electron E2E currently targets Windows");
assert.ok(existsSync(executable), `packaged executable is missing: ${executable}`);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeout must be a positive number");

const tempRoot = mkdtempSync(join(ROOT, ".tmp-packaged-e2e-"));
const dataDir = join(tempRoot, "data");
const electronUserDataDir = join(tempRoot, "electron-user-data");
const resultFile = join(tempRoot, "result.json");
const failureArtifactDir = resolve(process.env.MY_CODE_AGENT_FAILURE_ARTIFACT_DIR || join(tempRoot, "failure-artifact"));
const settledGolden = JSON.parse(readFileSync(resolve(ROOT, "test", "fixtures", "golden", "packaged-electron-settled-v1.json"), "utf8"));
const children = new Set();
let output = "";
let passed = false;
let secondLaunchChild = null;
const memoryLimitMb = Number(process.env.MY_CODE_AGENT_TEST_MEMORY_MB || 2048);
const expectFailureArtifact = process.env.MY_CODE_AGENT_E2E_EXPECT_FAILURE_ARTIFACT === "1";
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
  return hasChildExited(child);
}

function stopProcessTree(child) {
  if (!child?.pid || hasExited(child)) return;
  requestWindowsProcessTreeStop(child);
}

function waitForExit(child, waitMs = 15_000) {
  return waitForChildTermination(child, { waitMs, pollMs: 100 });
}

function assertCleanExit(child, label) {
  assert.ok(
    child.exitCode === 0 || (process.platform === "win32" && child.exitCode === null),
    `${label} exited with code ${child.exitCode ?? "unknown"}`,
  );
}

async function terminateChild(child) {
  await terminateWindowsProcessTree(child, { waitMs: 15_000 });
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

function assertPackagedReplayProviderResult(result) {
  const replay = result.replayProvider;
  assert.ok(replay && typeof replay === "object", "packaged replay provider result is missing");
  assert.deepEqual(replay.order, ["replay-thought", "replay-tool", "replay-text"]);
  assert.equal(replay.withinDeadline, true, "replay provider did not reach terminal DOM state");
  assert.equal(replay.rootStable, true);
  assert.equal(replay.removedExisting, 0);
  assert.equal(replay.reconnectStatus, 200);
  assert.equal(replay.reconnectMatches, true);
  assert.equal(replay.refreshMatches, true);
  assert.deepEqual(replay.refreshSnapshot, replay.liveSnapshot);
  assert.equal(replay.draftCleared, true);
  assert.equal(replay.sessionSwitchMatches, true);
  assert.equal(typeof replay.terminalAt, "number");

  const profileCatalog = result.profileCatalog;
  assert.ok(profileCatalog && typeof profileCatalog === "object", "packaged profile catalog result is missing");
  assert.equal(profileCatalog.status, 200);
  assert.ok(Array.isArray(profileCatalog.body?.catalogs));
  assert.deepEqual(profileCatalog.body.catalogs.map((catalog) => catalog.id), ["fact-verification", "minimal", "standard"]);
  assert.ok(profileCatalog.body.catalogs.every((catalog) => catalog.health === "ready" && typeof catalog.fingerprint === "string"));
  assert.ok(profileCatalog.body.catalogs.every((catalog) => catalog.featureGates === "*" || Array.isArray(catalog.featureGates)));
  assert.ok(profileCatalog.body.catalogs.every((catalog) => catalog.tools.every((tool) => tool.source === "native" && tool.audiences.includes("main"))));
  assert.deepEqual(profileCatalog.body.catalogs.find((catalog) => catalog.id === "fact-verification")?.featureGates, ["memory", "skills"]);
}

function assertPackagedCancellationResult(result) {
  const cancellation = result.cancellation;
  assert.ok(cancellation && typeof cancellation === "object", "packaged cancellation result is missing");
  assert.equal(cancellation.toolMounted, true);
  assert.equal(cancellation.busyAfterAbort, false);
  assert.equal(cancellation.stopHidden, true);
  assert.equal(cancellation.lateTerminalVisible, false);
  assert.equal(cancellation.domStableAfterAbort, true);
}

function settledSnapshot(result) {
  return {
    version: 1,
    chatEventFlow: {
      blockIds: result.chatEventFlow?.blockIds,
      assistantRootStable: result.chatEventFlow?.assistantRootStable,
      refreshMatches: result.chatEventFlow?.refreshMatches,
    },
    replayProvider: {
      blockIds: result.replayProvider?.order,
      rootStable: result.replayProvider?.rootStable,
      refreshMatches: result.replayProvider?.refreshMatches,
      sessionSwitchMatches: result.replayProvider?.sessionSwitchMatches,
    },
    cancellation: {
      busyAfterAbort: result.cancellation?.busyAfterAbort,
      stopHidden: result.cancellation?.stopHidden,
      lateTerminalVisible: result.cancellation?.lateTerminalVisible,
      domStableAfterAbort: result.cancellation?.domStableAfterAbort,
    },
    concurrency: {
      requestCount: result.concurrency?.requestCount,
      nodeOrder: result.concurrency?.nodeOrder,
      stableNodeIdentity: result.concurrency?.stableNodeIdentity,
      removedExisting: result.concurrency?.mutationSummary?.removedExisting,
      loading: Boolean(result.concurrency?.loadingStates?.sessionListLoading || result.concurrency?.loadingStates?.settingsLoading || result.concurrency?.loadingStates?.workspaceLoading),
    },
  };
}

function writeAndReplayArtifact(result, fallbackFailure) {
  const probe = result?.artifactProbe || result?.failureEvidence || {};
  const screenshot = typeof probe.screenshotBase64 === "string" ? Buffer.from(probe.screenshotBase64, "base64") : Buffer.alloc(0);
  const artifact = writeFailureArtifact(failureArtifactDir, {
    failure: probe.failure || result?.error || { code: "packaged_e2e_failure", message: fallbackFailure?.message || "Packaged Electron E2E failed" },
    testConfig: {
      workspace: ".",
      platform: process.platform,
      nodeVersion: process.version,
      provider: "keyless-replay",
      memoryLimitMb,
      executable: "release/win-unpacked/MyCodeAgent.exe",
      failureMode: expectFailureArtifact ? "artifact-probe" : "artifact-probe",
    },
    eventTrace: probe.eventTrace || [],
    requestCorrelation: probe.requestCorrelation || {},
    session: probe.session || [],
    domAria: probe.domAria || {},
    consoleNetwork: probe.consoleNetwork || { diagnostics: result?.diagnostics || [], output },
    process: {
      electronPid: result?.electronPid || child?.pid || null,
      peakRssMb,
      memoryLimitMb,
      memoryExceeded,
      serverPids: (result?.windows || []).map((window) => window.serverPid).filter(Number.isInteger),
    },
    screenshot,
    replay: { driver: "packaged-electron", invocation: "npm run test:artifact:replay -- <artifact-dir>" },
  });
  validateFailureArtifact(artifact);
  const replay = spawnSync(process.execPath, [resolve(ROOT, "scripts", "replay-failure-artifact.mjs"), artifact, "--validate-only"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(replay.status, 0, replay.stderr || replay.stdout);
  return artifact;
}

function assertSingleProcessMultiWindowResult(result) {
  assert.equal(result.ok, true, `packaged probe failed: ${JSON.stringify(result, null, 2)}`);
  assertExistingSecurityProbe(result);
  assertPackagedChatEventFlow(result);
  assertPackagedConcurrencyResult(result);
  assertPackagedReplayProviderResult(result);
  assertPackagedCancellationResult(result);
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
  assert.ok(
    result.acceptance.timing.shellVisibleMs < emptyShellBudgetMs,
    `empty shell took ${result.acceptance.timing.shellVisibleMs}ms (budget ${emptyShellBudgetMs}ms)`,
  );
  assert.ok(
    result.acceptance.timing.workbenchLoadedMs < workbenchBudgetMs,
    `project workbench took ${result.acceptance.timing.workbenchLoadedMs}ms (budget ${workbenchBudgetMs}ms)`,
  );

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
let observedResult = null;
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
      MY_CODE_AGENT_E2E_REPLAY: "1",
      MY_CODE_AGENT_E2E_CONCURRENCY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  startMemoryMonitor();

  const result = await waitForResult(child);
  observedResult = result;
  if (memoryExceeded) throw new Error(`packaged Electron exceeded ${memoryLimitMb}MB RSS (peak ${peakRssMb}MB)`);
  if (expectFailureArtifact) {
    assert.equal(result.ok, false, "fault injection must enter the packaged Electron failure path");
    assert.equal(result.error?.code, "e2e_artifact_probe");
    writeAndReplayArtifact(result);
    await waitForExit(child, exitBudgetMs);
    children.delete(child);
    assertCleanExit(child, "packaged app");
    passed = true;
    console.log("packaged Electron failure artifact E2E passed", JSON.stringify({ peakRssMb, memoryLimitMb }));
  } else {
    const measured = assertSingleProcessMultiWindowResult(result);
    assert.deepEqual(settledSnapshot(result), settledGolden, "packaged settled-state golden drift");
    writeAndReplayArtifact(result);
    assert.equal(result.electronPid, child.pid, "result must identify the first executable's Electron main process");
    assert.ok(secondLaunchChild, "the harness did not launch a second executable");
    await waitForExit(secondLaunchChild, 15_000);
    assertCleanExit(secondLaunchChild, "second packaged app");
    assert.notEqual(secondLaunchChild.pid, result.electronPid);
    children.delete(secondLaunchChild);
    await waitForExit(child, exitBudgetMs);
    children.delete(child);
    assertCleanExit(child, "packaged app");
    passed = true;
    console.log("packaged Electron single-process multi-window E2E passed", JSON.stringify(measured));
  }
} catch (error) {
  failure = error;
  try {
    writeAndReplayArtifact(observedResult, error);
  } catch (artifactError) {
    failure = new AggregateError([error, artifactError], "packaged Electron E2E failed and its failure artifact could not be written");
  }
} finally {
  const cleanupErrors = [];
  const cleanupResults = await Promise.allSettled([...children].map((runningChild) => terminateChild(runningChild)));
  for (const result of cleanupResults) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
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
    console.error(`packaged Electron E2E artifacts retained at ${failureArtifactDir}`);
  } else {
    await removeTempRoot();
  }
}

if (failure) throw failure;
