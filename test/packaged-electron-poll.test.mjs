import assert from "node:assert/strict";
import test from "node:test";

import * as packagedPoll from "./helpers/packaged-electron-poll.mjs";

const awaiting = {
  state: "awaiting-second-launch",
  electronPid: 4123,
  launch: {
    workspace: "C:\\private\\workspace",
    dataRoot: "C:\\private\\data",
    instanceId: "second-launch",
  },
};

test("polling an intermediate result reports the first Electron crash", () => {
  assert.equal(typeof packagedPoll.inspectPackagedE2EPoll, "function");
  assert.deepEqual(packagedPoll.inspectPackagedE2EPoll({
    result: awaiting,
    childExited: true,
    childExitCode: 1,
    now: 1_100,
    deadline: 2_000,
    secondLaunchStarted: false,
  }), {
    kind: "process-exit",
    diagnostics: {
      state: "awaiting-second-launch",
      electronPid: 4123,
      childExitCode: 1,
    },
  });
});

test("polling an intermediate result stays pending until the second launch resolves", () => {
  assert.equal(packagedPoll.inspectPackagedE2EPoll({
    result: awaiting,
    childExited: false,
    childExitCode: null,
    now: 1_100,
    deadline: 2_000,
    secondLaunchStarted: true,
  }), null);
});

test("polling a final result resolves before the first Electron child exits", () => {
  const result = { ok: true, packaged: true };
  assert.deepEqual(packagedPoll.inspectPackagedE2EPoll({
    result,
    childExited: false,
    childExitCode: null,
    now: 1_100,
    deadline: 2_000,
    secondLaunchStarted: true,
  }), {
    kind: "result",
    result,
  });
});

test("polling an intermediate result reports timeout diagnostics", () => {
  assert.equal(typeof packagedPoll.inspectPackagedE2EPoll, "function");
  assert.deepEqual(packagedPoll.inspectPackagedE2EPoll({
    result: awaiting,
    childExited: false,
    childExitCode: null,
    now: 2_000,
    deadline: 2_000,
    secondLaunchStarted: false,
  }), {
    kind: "timeout",
    diagnostics: {
      state: "awaiting-second-launch",
      electronPid: 4123,
      childExitCode: null,
      secondLaunchStarted: false,
    },
  });
});
