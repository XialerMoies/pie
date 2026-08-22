import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildTestManifest } from "../scripts/test-manifest.mjs";

import * as e2eDiagnostics from "../src/electron/e2e-diagnostics.ts";

test("E2E failure diagnostics preserve classification and snapshot without sensitive details", () => {
  const failure = e2eDiagnostics.createElectronE2EFailureDiagnostic({
    error: Object.assign(
      new Error("Timed out at C:\\repo\\project-a with token=raw-token"),
      { code: "E2E_TIMEOUT", stack: "Error: raw stack C:\\app\\electron-main.ts" },
    ),
    diagnostics: [
      "authorization: Bearer raw-token",
      "preload-error-detail C:\\app\\preload.js: raw-token",
    ],
    snapshot: {
      electronPid: 4123,
      windows: [{
        contextId: "context-a",
        webContentsId: 17,
        workspace: "C:\\repo\\project-a",
        instanceId: "instance-a",
        instanceRoot: "C:\\temp\\instances\\a",
        serverKind: "owned",
        serverPid: 5101,
        port: 43101,
        tokenFingerprint: "0123456789abcdef",
        loadedAt: null,
      }],
      timings: [{ contextId: "context-a", event: "window-created", at: 950 }],
    },
    secrets: ["raw-token"],
    roots: [
      { value: "C:\\repo\\project-a", label: "<workspace-root>" },
      { value: "C:\\app", label: "<app-root>" },
      { value: "C:\\temp", label: "<temp-root>" },
    ],
  });

  assert.equal(failure.error.code, "e2e_timeout");
  assert.equal(failure.windows.length, 1);
  assert.equal(failure.timings.length, 1);
  assert.equal(failure.windows[0].workspace, "<workspace-root>");
  assert.equal(failure.windows[0].instanceRoot, "<temp-root>\\instances\\a");
  assert.equal("stack" in failure.error, false);
  assert.doesNotMatch(JSON.stringify(failure), /raw-token|C:\\repo|C:\\app|Error: raw stack/i);
  assert.match(failure.error.message, /<workspace-root>/);
  assert.match(failure.diagnostics[0], /authorization: \[REDACTED\]/i);
});

test("E2E failure diagnostics redact token-shaped values and arbitrary absolute paths", () => {
  const tokenFailure = e2eDiagnostics.createElectronE2EFailureDiagnostic({
    error: new Error("Failed reading D:\\unlisted\\private\\file.txt with access_token=secret-value"),
    diagnostics: [
      "console /Users/alice/private/app.ts: token=another-secret",
      "request Authorization: Bearer bearer-secret",
    ],
    snapshot: {
      electronPid: 4123,
      windows: [],
      timings: [],
    },
  });

  assert.doesNotMatch(JSON.stringify(tokenFailure), /secret-value|another-secret|bearer-secret/i);
  assert.doesNotMatch(JSON.stringify(tokenFailure), /D:\\unlisted|Users\\alice|\/Users\/alice/i);

  const pathFailure = e2eDiagnostics.createElectronE2EFailureDiagnostic({
    error: new Error('quoted drive "C:\\Program Files\\My Code Agent\\private config.json"; failed'),
    diagnostics: [
      "unquoted drive C:\\Program Files\\My Code Agent\\secret-file.txt; retry disabled",
      'quoted UNC "\\\\build-server\\private share\\release secrets.txt"; failed',
      "unquoted UNC \\\\build-server\\private share\\deploy-key.pem; retry disabled",
      'quoted POSIX "/Users/alice/Private Files/session token.txt"; failed',
      "unquoted POSIX /Users/alice/Private Files/account.json; retry disabled",
    ],
    snapshot: {
      electronPid: 4123,
      windows: [],
      timings: [],
    },
  });

  const serialized = JSON.stringify(pathFailure);
  assert.doesNotMatch(serialized, /Program Files|My Code Agent|private config\.json|secret-file\.txt/i);
  assert.doesNotMatch(serialized, /build-server|private share|release secrets\.txt|deploy-key\.pem/i);
  assert.doesNotMatch(serialized, /Users[\\/]alice|Private Files|session token\.txt|account\.json/i);
});

test("packaged harness observes focus and validates process exit instead of trusting actions", () => {
  const source = readFileSync(new URL("../src/electron/electron-packaged-e2e-probe.ts", import.meta.url), "utf8");
  const harness = readFileSync(new URL("./packaged-electron.e2e.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(source, /focusedContextId:\s*duplicateAction/);
  assert.match(source, /getFocusedWindow\(\)|\.isFocused\(\)/);
  assert.match(source, /\.on\("focus"/);
  assert.match(source, /focusedWindow\s*=\s*options\.getFocusedWindow\(\)/);
  assert.match(harness, /assert\.equal\(child\.exitCode, 0\)/);
});

test("packaged E2E has no unvalidated phase protocol", () => {
  const source = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");
  const harness = readFileSync(new URL("./packaged-electron.e2e.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const unitScript = packageJson.scripts["test:unit"];
  const manifest = buildTestManifest();

  assert.doesNotMatch(source, /E2E_PHASE|MY_CODE_AGENT_E2E_PHASE/);
  assert.doesNotMatch(harness, /MY_CODE_AGENT_E2E_PHASE/);
  assert.strictEqual(unitScript, "node scripts/test-suite.mjs unit");
  assert.ok(manifest.suites.unit.includes("test/packaged-electron-poll.test.mjs"));
  assert.ok(manifest.suites.unit.includes("test/packaged-electron-review.test.mjs"));
});
