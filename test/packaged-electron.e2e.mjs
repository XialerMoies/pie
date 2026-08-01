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
const resultFile = join(tempRoot, "result.json");
const dataDir = join(tempRoot, "data");
let output = "";
let child;
let passed = false;

function stopProcessTree() {
  if (!child) return;
  if (child.pid && child.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
  }
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

function waitForResult() {
  return new Promise((resolveResult, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(resultFile)) {
        clearInterval(timer);
        resolveResult(JSON.parse(readFileSync(resultFile, "utf8")));
        return;
      }
      if (child.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`packaged app exited before reporting E2E results (${child.exitCode})\n${output}`));
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for packaged Electron E2E result\n${output}`));
      }
    }, 100);
  });
}

try {
  child = spawn(executable, ["--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu"], {
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
  child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { output += chunk.toString(); });

  const result = await waitForResult();
  assert.equal(result.ok, true, `${JSON.stringify(result, null, 2)}\n${output}`);
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
  passed = true;
  console.log("packaged Electron E2E passed", JSON.stringify(result));
} finally {
  stopProcessTree();
  if (process.platform === "win32") {
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!passed && process.env.CI) {
    writeFileSync(join(tempRoot, "electron-output.log"), output, "utf8");
    console.error(`packaged Electron E2E artifacts retained at ${tempRoot}`);
  } else {
    await removeTempRoot();
  }
}
