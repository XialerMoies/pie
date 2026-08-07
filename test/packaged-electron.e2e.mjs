import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const executable = resolve(ROOT, "release", "win-unpacked", "MyCodeAgent.exe");
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout="));
const timeoutMs = timeoutArg ? Number(timeoutArg.slice("--timeout=".length)) : 60_000;

assert.ok(process.platform === "win32", "packaged Electron E2E currently targets Windows");
assert.ok(existsSync(executable), `packaged executable is missing: ${executable}`);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "timeout must be a positive number");

const tempRoot = mkdtempSync(join(ROOT, ".tmp-packaged-e2e-"));
const dataDir = join(tempRoot, "data");
const resultFiles = {
  first: join(tempRoot, "result-first.json"),
  second: join(tempRoot, "result-second.json"),
};
const outputs = new Map();
const children = new Set();
let passed = false;

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function stopProcessTree(child) {
  if (!child) return;
  if (child.pid && !hasExited(child)) {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
  }
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
  if (!hasExited(child)) {
    throw new Error(`packaged app ${child.pid || "unknown"} reported exit without an exit code or signal`);
  }
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

function assertEquivalentPath(actual, expected) {
  const normalize = (value) => {
    const resolved = resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  assert.strictEqual(normalize(actual), normalize(expected));
}

function waitForResult(child, resultFile, output) {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(resultFile)) {
        try {
          const result = JSON.parse(readFileSync(resultFile, "utf8"));
          clearInterval(timer);
          resolveResult(result);
        } catch {}
        return;
      }
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`packaged app exited before reporting E2E results (${child.exitCode})\n${output()}`));
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for packaged Electron E2E result\n${output()}`));
      }
    }, 100);
  });
}

async function runRound(phase, resultFile) {
  let output = "";
  // This host cannot launch Chromium's sandboxed renderer; production keeps sandbox: true.
  const child = spawn(executable, ["--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu", "--no-sandbox"], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      NODE_ENV: "test",
      MY_CODE_AGENT_E2E_RESULT_FILE: resultFile,
      MY_CODE_AGENT_E2E_DATA_DIR: dataDir,
      MY_CODE_AGENT_E2E_PHASE: phase,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
  outputs.set(phase, () => output);

  try {
    const result = await waitForResult(child, resultFile, () => output);
    await waitForExit(child);
    if (!hasExited(child)) throw new Error(`packaged app ${child.pid || "unknown"} exit was not confirmed`);
    children.delete(child);
    return result;
  } catch (error) {
    try {
      await terminateChild(child);
    } catch (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        `packaged ${phase} round failed and child termination was not confirmed\n${output}`,
      );
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
}

function assertExistingProbeResult(result, label) {
  assert.equal(result.ok, true, `${label} probe failed: ${JSON.stringify(result, null, 2)}`);
  assert.equal(result.packaged, true);
  assert.match(result.pageUrl, /^http:\/\/127\.0\.0\.1:\d+\/?$/);
  assert.equal(result.pageTitle, "Pi Desktop");
  assert.equal(result.renderer?.appRendered, true);
  assert.equal(result.renderer?.apiStatus, 200);
  assert.equal(result.renderer?.desktopTokenPresent, true);
  assert.equal(result.renderer?.nodeRequireType, "undefined");
  assert.equal(result.renderer?.inlineHandlerCount, 0);
  assert.equal(result.renderer?.popupOpened, false);
  assert.equal(result.renderer?.externalNavigationBlocked, true);
  assert.equal(result.renderer?.webviewAttached, false);
  assert.equal(result.renderer?.revealOutsideRejected, true);
  assert.equal(result.renderer?.trashOutsideRejected, true);
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
  assert.equal(result.workspaceSwitchStatus, 200);
  assert.equal(result.workspaceReadStatus, 200);
  assert.equal(result.pathTraversalStatus, 403);
  assert.equal(result.siblingTraversalStatus, 403);
  assert.equal(result.windowCount, 1);
  assert.deepEqual(result.renderer?.preloadMethods, [
    "close",
    "getDesktopSessionToken",
    "maximize",
    "minimize",
    "newWindow",
    "openFile",
    "openFolder",
    "showItemInFolder",
    "spawnTerminal",
    "trashItem",
  ]);
  assert.equal(result.STARTUP?.instanceId?.startsWith("instance-"), true, `${label} startup instanceId missing`);
  assert.equal(result.persistedPreferences?.status, 200, `${label} persisted preferences request failed`);
  return result;
}

let failure;
try {
  const first = assertExistingProbeResult(
    await runRound("first", resultFiles.first),
    "first",
  );
  const second = assertExistingProbeResult(
    await runRound("second", resultFiles.second),
    "second",
  );
  const probeWorkspace = resolve(dataDir, "workspace");
  const expectedPreferences = { "editor-theme": "vs", "explorer-filter": "0" };
  assert.equal(first.workspaceSwitchStatus, 200);
  assert.equal(first.preferencePatch?.status, 200);
  assert.deepEqual(first.preferencePatch?.body?.preferences, expectedPreferences);
  assertEquivalentPath(second.STARTUP.workspace, probeWorkspace);
  assert.deepEqual(second.persistedPreferences.body?.preferences, expectedPreferences);
  assert.notStrictEqual(first.STARTUP.instanceId, second.STARTUP.instanceId);
  passed = true;
  console.log("packaged Electron E2E passed", JSON.stringify({ first, second }));
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const child of [...children]) {
    try {
      await terminateChild(child);
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
  if (process.platform === "win32") {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!passed) {
    for (const [phase, getOutput] of outputs) {
      writeFileSync(join(tempRoot, `electron-output-${phase}.log`), getOutput(), "utf8");
    }
    console.error(`packaged Electron E2E artifacts retained at ${tempRoot}`);
  } else {
    await removeTempRoot();
  }
}

if (failure) throw failure;
