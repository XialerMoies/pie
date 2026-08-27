import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildToolContextExtra } from "../src/agent/runtime.ts";
import {
  createSubagentDelegationBridge,
  createSubagentDelegationHost,
} from "../src/server/subagent-delegation.ts";

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  toolCalls: 0,
};

function batchResult(batchId = "batch-1") {
  return {
    batchId,
    status: "completed",
    tasks: [],
    usage: { ...EMPTY_USAGE },
  };
}

function delegationRequest(overrides = {}) {
  return {
    tasks: [{
      profile: "reviewer",
      prompt: "Review the server lifecycle",
      focusPaths: ["src/server"],
      deliverable: "Return concrete findings",
      model: { provider: "review", id: "review-model" },
    }],
    maxConcurrent: 3,
    timeoutSeconds: 120,
    maxTurns: 12,
    maxToolCalls: 40,
    ...overrides,
  };
}

function createSupervisorHarness({ batchId = "batch-1", result = Promise.resolve(batchResult(batchId)) } = {}) {
  const calls = {
    starts: [],
    aborts: [],
    releases: [],
    dispose: 0,
  };
  const supervisor = {
    startBatch(options) {
      calls.starts.push(options);
      return { batchId, taskIds: ["task-1"], result };
    },
    async abortBatch(id) {
      calls.aborts.push(id);
      return true;
    },
    releaseBatch(id) {
      calls.releases.push(id);
      return true;
    },
    async dispose() {
      calls.dispose += 1;
    },
  };
  return { supervisor, calls };
}

function createRuntime() {
  const finds = [];
  const knownModel = { provider: "review", id: "review-model" };
  return {
    runtime: {
      currentWorkspace: "C:/actual-workspace",
      findModel(provider, id) {
        finds.push({ provider, id });
        return provider === knownModel.provider && id === knownModel.id ? knownModel : undefined;
      },
    },
    finds,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("subagent delegation host", () => {
  it("creates and binds a fresh event sink at each batch start", async () => {
    const { runtime } = createRuntime();
    const harness = createSupervisorHarness();
    const sinks = [];
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: harness.supervisor,
      createSupervisor: () => harness.supervisor,
      createEventSink() {
        const sink = () => {};
        sinks.push(sink);
        return sink;
      },
    });

    await host.delegateTasks(delegationRequest());
    await host.delegateTasks(delegationRequest());

    assert.equal(sinks.length, 2);
    assert.strictEqual(harness.calls.starts[0].onEvent, sinks[0]);
    assert.strictEqual(harness.calls.starts[1].onEvent, sinks[1]);
  });

  it("validates models with the current runtime registry and adapts requests using runtime.currentWorkspace", async () => {
    const { runtime, finds } = createRuntime();
    const first = createSupervisorHarness();
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: first.supervisor,
      createSupervisor: () => {
        throw new Error("unexpected workspace rotation");
      },
    });
    const request = delegationRequest();

    assert.equal(await host.validateSubagentModel({ provider: "review", id: "review-model" }), true);
    assert.equal(await host.validateSubagentModel({ provider: "missing", id: "model" }), false);
    const result = await host.delegateTasks(request, undefined, "delegate-call-1");

    assert.deepEqual(finds, [
      { provider: "review", id: "review-model" },
      { provider: "missing", id: "model" },
    ]);
    assert.deepEqual(first.calls.starts, [{
      workspace: "C:/actual-workspace",
      tasks: request.tasks,
      maxConcurrent: 3,
      timeoutSeconds: 120,
      maxTurns: 12,
      maxToolCalls: 40,
      parentToolCallId: "delegate-call-1",
    }]);
    assert.deepEqual(result, batchResult());
    assert.deepEqual(first.calls.releases, ["batch-1"]);
  });

  it("cooperatively aborts a batch when the parent signal is already aborted", async () => {
    const { runtime } = createRuntime();
    const harness = createSupervisorHarness();
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: harness.supervisor,
      createSupervisor: () => harness.supervisor,
    });
    const controller = new AbortController();
    controller.abort();

    await host.delegateTasks(delegationRequest(), controller.signal);

    assert.deepEqual(harness.calls.aborts, ["batch-1"]);
    assert.deepEqual(harness.calls.releases, ["batch-1"]);
  });

  it("cooperatively aborts a running batch and removes the abort listener afterward", async () => {
    const { runtime } = createRuntime();
    let resolveResult;
    const pendingResult = new Promise((resolve) => { resolveResult = resolve; });
    const harness = createSupervisorHarness({ result: pendingResult });
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: harness.supervisor,
      createSupervisor: () => harness.supervisor,
    });
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => { added += 1; return originalAdd(...args); };
    controller.signal.removeEventListener = (...args) => { removed += 1; return originalRemove(...args); };

    const delegated = host.delegateTasks(delegationRequest(), controller.signal);
    await Promise.resolve();
    controller.abort();
    await Promise.resolve();
    assert.deepEqual(harness.calls.aborts, ["batch-1"]);

    resolveResult(batchResult());
    await delegated;
    assert.equal(added, 1);
    assert.equal(removed, 1);
    assert.deepEqual(harness.calls.releases, ["batch-1"]);
  });

  it("releases a settled batch even when awaiting its result rejects", async () => {
    const { runtime } = createRuntime();
    const harness = createSupervisorHarness({ result: Promise.reject(new Error("batch failed")) });
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: harness.supervisor,
      createSupervisor: () => harness.supervisor,
    });

    await assert.rejects(host.delegateTasks(delegationRequest()), /batch failed/);
    assert.deepEqual(harness.calls.releases, ["batch-1"]);
  });

  it("rotates and disposes the supervisor when runtime.currentWorkspace changes", async () => {
    const { runtime } = createRuntime();
    const first = createSupervisorHarness({ batchId: "batch-a", result: Promise.resolve(batchResult("batch-a")) });
    const second = createSupervisorHarness({ batchId: "batch-b", result: Promise.resolve(batchResult("batch-b")) });
    const createdFor = [];
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: first.supervisor,
      createSupervisor(workspace) {
        createdFor.push(workspace);
        return second.supervisor;
      },
    });

    await host.delegateTasks(delegationRequest());
    runtime.currentWorkspace = "C:/next-workspace";
    await host.delegateTasks(delegationRequest());

    assert.equal(first.calls.dispose, 1);
    assert.deepEqual(createdFor, ["C:/next-workspace"]);
    assert.equal(second.calls.starts[0].workspace, "C:/next-workspace");
  });

  it("uses one workspace snapshot while rotating supervisors", async () => {
    const { runtime } = createRuntime();
    let finishDispose;
    const disposePending = new Promise((resolve) => { finishDispose = resolve; });
    const first = createSupervisorHarness();
    first.supervisor.dispose = async () => {
      first.calls.dispose += 1;
      await disposePending;
    };
    const second = createSupervisorHarness({ batchId: "batch-b", result: Promise.resolve(batchResult("batch-b")) });
    const createdFor = [];
    const runtimeWorkspaceAtCreation = [];
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: first.supervisor,
      createSupervisor(workspace) {
        createdFor.push(workspace);
        runtimeWorkspaceAtCreation.push(runtime.currentWorkspace);
        return second.supervisor;
      },
    });

    runtime.currentWorkspace = "C:/workspace-b";
    const delegated = host.delegateTasks(delegationRequest());
    await Promise.resolve();
    runtime.currentWorkspace = "C:/workspace-c";
    finishDispose();
    await delegated;

    assert.deepEqual(createdFor, ["C:/workspace-b"]);
    assert.deepEqual(runtimeWorkspaceAtCreation, ["C:/workspace-b"]);
    assert.equal(second.calls.starts[0].workspace, "C:/workspace-b");
  });

  it("coalesces concurrent rotations to the same new workspace and disposes the shared supervisor", async () => {
    const { runtime } = createRuntime();
    const oldDispose = deferred();
    const initial = createSupervisorHarness();
    initial.supervisor.dispose = async () => {
      initial.calls.dispose += 1;
      await oldDispose.promise;
    };
    const created = [];
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: initial.supervisor,
      createSupervisor(workspace) {
        const next = createSupervisorHarness({
          batchId: `batch-${created.length + 1}`,
          result: Promise.resolve(batchResult(`batch-${created.length + 1}`)),
        });
        created.push({ workspace, ...next });
        return next.supervisor;
      },
    });

    runtime.currentWorkspace = "C:/shared-next";
    const first = host.delegateTasks(delegationRequest());
    const second = host.delegateTasks(delegationRequest());
    await Promise.resolve();
    oldDispose.resolve();
    await Promise.all([first, second]);
    await host.dispose();

    assert.equal(initial.calls.dispose, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].workspace, "C:/shared-next");
    assert.equal(created[0].calls.starts.length, 2);
    assert.equal(created[0].calls.dispose, 1);
  });

  it("serializes different workspace snapshots and releases every rotated supervisor", async () => {
    const { runtime } = createRuntime();
    const oldDispose = deferred();
    const initial = createSupervisorHarness();
    initial.supervisor.dispose = async () => {
      initial.calls.dispose += 1;
      await oldDispose.promise;
    };
    const created = [];
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: initial.supervisor,
      createSupervisor(workspace) {
        const index = created.length + 1;
        const next = createSupervisorHarness({
          batchId: `batch-${index}`,
          result: Promise.resolve(batchResult(`batch-${index}`)),
        });
        created.push({ workspace, ...next });
        return next.supervisor;
      },
    });

    runtime.currentWorkspace = "C:/workspace-b";
    const first = host.delegateTasks(delegationRequest());
    runtime.currentWorkspace = "C:/workspace-c";
    const second = host.delegateTasks(delegationRequest());
    await Promise.resolve();
    oldDispose.resolve();
    await Promise.all([first, second]);
    await host.dispose();

    assert.deepEqual(created.map((entry) => entry.workspace), ["C:/workspace-b", "C:/workspace-c"]);
    assert.equal(initial.calls.dispose, 1);
    assert.equal(created[0].calls.starts.length, 1);
    assert.equal(created[0].calls.starts[0].workspace, "C:/workspace-b");
    assert.equal(created[0].calls.dispose, 1);
    assert.equal(created[1].calls.starts.length, 1);
    assert.equal(created[1].calls.starts[0].workspace, "C:/workspace-c");
    assert.equal(created[1].calls.dispose, 1);
  });

  it("waits for an in-flight rotation during dispose and releases its candidate", async () => {
    const { runtime } = createRuntime();
    const oldDispose = deferred();
    const initial = createSupervisorHarness();
    initial.supervisor.dispose = async () => {
      initial.calls.dispose += 1;
      await oldDispose.promise;
    };
    const candidate = createSupervisorHarness();
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: initial.supervisor,
      createSupervisor: () => candidate.supervisor,
    });

    runtime.currentWorkspace = "C:/workspace-b";
    const delegated = host.delegateTasks(delegationRequest());
    const firstDispose = host.dispose();
    const secondDispose = host.dispose();
    oldDispose.resolve();

    await Promise.all([firstDispose, secondDispose]);
    await assert.rejects(delegated, /disposed/i);
    assert.strictEqual(firstDispose, secondDispose);
    assert.equal(initial.calls.dispose, 1);
    assert.equal(candidate.calls.dispose, 1);
  });

  it("disposes the active supervisor exactly once", async () => {
    const { runtime } = createRuntime();
    const harness = createSupervisorHarness();
    const host = createSubagentDelegationHost({
      runtime,
      supervisor: harness.supervisor,
      createSupervisor: () => harness.supervisor,
    });

    const first = host.dispose();
    const second = host.dispose();
    await Promise.all([first, second]);

    assert.strictEqual(first, second);
    assert.equal(harness.calls.dispose, 1);
    await assert.rejects(host.delegateTasks(delegationRequest()), /disposed/i);
  });
});

describe("subagent delegation runtime bridge", () => {
  it("fails closed until a host is bound and forwards the same capabilities afterward", async () => {
    const bridge = createSubagentDelegationBridge();
    const request = delegationRequest();
    const expected = batchResult("bound-batch");
    const calls = [];
    const host = {
      validateSubagentModel(model) {
        calls.push(["validate", model]);
        return true;
      },
      delegateTasks(nextRequest, signal) {
        calls.push(["delegate", nextRequest, signal]);
        return Promise.resolve(expected);
      },
      dispose() {},
    };

    assert.equal(await bridge.runtimeConfig.validateSubagentModel({ provider: "review", id: "review-model" }), false);
    await assert.rejects(
      bridge.runtimeConfig.delegateTasks(request),
      /delegation host is not ready/i,
    );

    bridge.bind(host);
    const controller = new AbortController();
    assert.equal(await bridge.runtimeConfig.validateSubagentModel({ provider: "review", id: "review-model" }), true);
    assert.deepEqual(await bridge.runtimeConfig.delegateTasks(request, controller.signal), expected);
    assert.strictEqual(calls[1][2], controller.signal);
  });

  it("passes host capabilities through RuntimeConfig into the tool context", () => {
    const validateSubagentModel = async () => true;
    const getSubagentDefinitions = () => [{ id: "reviewer", name: "Reviewer", description: "", prompt: "Review", tools: ["search"] }];
    const getSubagentLimits = () => ({ maxTasks: 12, maxConcurrent: 5 });
    const delegateTasks = async () => batchResult();

    const extra = buildToolContextExtra({
      agentDir: "/agent",
      cwd: "/repo",
      sessionsDir: "/sessions",
      authFile: "/auth.json",
      modelsFile: "/models.json",
      validateSubagentModel,
      getSubagentDefinitions,
      getSubagentLimits,
      delegateTasks,
    });

    assert.strictEqual(extra.validateSubagentModel, validateSubagentModel);
    assert.strictEqual(extra.getSubagentDefinitions, getSubagentDefinitions);
    assert.strictEqual(extra.getSubagentLimits, getSubagentLimits);
    assert.strictEqual(extra.delegateTasks, delegateTasks);
  });
});
