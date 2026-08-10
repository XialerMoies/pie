import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { firstTimingAtOrAfter } from "./helpers/electron-e2e-result.mjs";

test("timing lookup selects the first matching event in a bounded lifecycle sequence", () => {
  const result = {
    timings: [
      { contextId: "context-b", event: "shell-visible", at: 900 },
      { contextId: "context-b", event: "workbench-loaded", at: 950 },
      { contextId: "context-b", event: "window-created", at: 1_000 },
      { contextId: "context-b", event: "shell-visible", at: 1_124 },
      { contextId: "context-b", event: "workbench-loaded", at: 2_622 },
      { contextId: "context-a", event: "shell-visible", at: 2_700 },
      { contextId: "context-b", event: "shell-visible", at: 3_879 },
      { contextId: "context-b", event: "workbench-loaded", at: 4_200 },
    ],
  };

  assert.deepEqual(firstTimingAtOrAfter(result, {
    contextId: "context-b",
    event: "shell-visible",
    at: 1_000,
  }), { contextId: "context-b", event: "shell-visible", at: 1_124 });
  assert.deepEqual(firstTimingAtOrAfter(result, {
    contextId: "context-b",
    event: "workbench-loaded",
    at: 1_000,
  }), { contextId: "context-b", event: "workbench-loaded", at: 2_622 });
});

test("packaged probe captures the real reopen outcome instead of declaring lock status", () => {
  const source = readFileSync(new URL("../src/electron/electron-main.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /workspaceLocked:\s*false/);
  assert.match(source, /let reopenAction:[^;]+null/);
  assert.match(source, /let reopenError:[^;]+null/);
  assert.match(source, /catch \(error\) \{[\s\S]{0,160}sanitizeE2EReopenError\(error\)/);
});
