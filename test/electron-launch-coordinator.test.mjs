import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const moduleUrl = new URL("../src/electron/electron-launch-coordinator.ts", import.meta.url);
const mainUrl = new URL("../src/electron/electron-main.ts", import.meta.url);

function createCoordinator(overrides = {}) {
  return import(moduleUrl.href).then(({ createSecondInstanceCoordinator }) => createSecondInstanceCoordinator({
    maxPending: 3,
    electronPid: 1234,
    e2eEnabled: true,
    now: () => 1000,
    validate: () => {},
    processRequest: async () => {},
    resolveWaiter: () => {},
    rejectWaiter: () => {},
    showOverflowNotice: () => {},
    showError: () => {},
    logError: () => {},
    ...overrides,
  }));
}

test("second-instance coordinator owns queue state outside electron-main", () => {
  assert.equal(existsSync(moduleUrl), true, "electron-launch-coordinator.ts should exist");

  const mainSource = readFileSync(mainUrl, "utf8");
  const coordinatorSource = readFileSync(moduleUrl, "utf8");
  assert.match(mainSource, /from "\.\/electron-launch-coordinator\.js"/);
  assert.match(coordinatorSource, /export\s+function\s+createSecondInstanceCoordinator\s*\(/);
  for (const name of [
    "pendingSecondLaunches",
    "secondLaunchHandlingReady",
    "pendingSecondLaunchOverflowNoticeShown",
    "drainingSecondLaunches",
    "e2eSecondLaunches",
  ]) {
    assert.doesNotMatch(mainSource, new RegExp(`(?:const|let)\\s+${name}\\b`));
  }
  for (const name of ["drainPendingSecondLaunches", "handleSecondLaunchRequest", "processSecondLaunchRequest"]) {
    assert.doesNotMatch(mainSource, new RegExp(`function\\s+${name}\\s*\\(`));
  }
});

test("queues requests before readiness and drains them in FIFO order", async () => {
  const processed = [];
  const coordinator = await createCoordinator({
    processRequest: async (request) => processed.push(request.instanceId),
  });

  coordinator.accept({ instanceId: "first" });
  coordinator.accept({ instanceId: "second" });
  assert.deepEqual(processed, []);

  await coordinator.markReady();
  assert.deepEqual(processed, ["first", "second"]);
});

test("serializes a request arriving while the queue is draining", async () => {
  const processed = [];
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  const coordinator = await createCoordinator({
    processRequest: async (request) => {
      processed.push(`${request.instanceId}:start`);
      if (request.instanceId === "first") await firstStarted;
      processed.push(`${request.instanceId}:end`);
    },
  });

  coordinator.accept({ instanceId: "first" });
  const draining = coordinator.markReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
  coordinator.accept({ instanceId: "second" });
  assert.deepEqual(processed, ["first:start"]);

  releaseFirst();
  await draining;
  assert.deepEqual(processed, ["first:start", "first:end", "second:start", "second:end"]);
});

test("rejects overflow once and resets the notice after draining", async () => {
  const rejected = [];
  const notices = [];
  const coordinator = await createCoordinator({
    maxPending: 1,
    rejectWaiter: (instanceId, error) => rejected.push([instanceId, error.message]),
    showOverflowNotice: () => notices.push("overflow"),
  });

  coordinator.accept({ instanceId: "queued" });
  coordinator.accept({ instanceId: "overflow-a" });
  coordinator.accept({ instanceId: "overflow-b" });
  assert.deepEqual(rejected, [
    ["overflow-a", "The pending window request queue is full."],
    ["overflow-b", "The pending window request queue is full."],
  ]);
  assert.deepEqual(notices, ["overflow"]);

  await coordinator.markReady();
  const secondCoordinator = await createCoordinator({
    maxPending: 1,
    showOverflowNotice: () => notices.push("overflow"),
  });
  secondCoordinator.accept({ instanceId: "next-overflow" });
  secondCoordinator.accept({ instanceId: "next-overflow-2" });
  assert.deepEqual(notices, ["overflow", "overflow"]);
});

test("rejects invalid requests and reports processing failures", async () => {
  const rejected = [];
  const errors = [];
  const logs = [];
  const coordinator = await createCoordinator({
    validate: (request) => {
      if (request.instanceId === "invalid") throw new Error("invalid data root");
    },
    processRequest: async () => { throw new Error("open failed"); },
    rejectWaiter: (instanceId, error) => rejected.push([instanceId, error.message]),
    showError: (message) => errors.push(message),
    logError: (message) => logs.push(message),
  });

  coordinator.accept({ instanceId: "invalid" });
  await coordinator.markReady();
  coordinator.accept({ instanceId: "processing-failure" });
  await coordinator.drain();

  assert.deepEqual(rejected, [
    ["invalid", "invalid data root"],
    ["processing-failure", "open failed"],
  ]);
  assert.deepEqual(errors, ["invalid data root", "open failed"]);
  assert.deepEqual(logs, ["invalid data root", "Failed to process second launch: open failed"]);
});

test("resolves handled waiters and records E2E handoffs only when enabled", async () => {
  const resolved = [];
  const coordinator = await createCoordinator({
    resolveWaiter: (instanceId) => resolved.push(instanceId),
  });

  coordinator.accept({ instanceId: "handled", workspace: "C:\\project" });
  await coordinator.markReady();

  assert.deepEqual(resolved, ["handled"]);
  assert.deepEqual(coordinator.records, [{
    electronPid: 1234,
    request: { instanceId: "handled", workspace: "C:\\project" },
    handledAt: 1000,
  }]);
});
