import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createRuntimeSubagentHost } from "../src/server/subagent-delegation.ts";

const serverSource = readFileSync(resolve("src/server/server.ts"), "utf8");

describe("subagent server wiring", () => {
  it("assembles and rotates real runtime host dependencies by workspace", async () => {
    const events = [];
    const supervisors = [];
    const runtime = {
      currentWorkspace: "C:/workspace-a",
      modelRegistry: { find() { return undefined; } },
      authStorage: {},
      config: { agentDir: "C:/agent" },
      session: { model: { provider: "main", id: "main" } },
    };
    const request = {
      tasks: [{ profile: "explorer", prompt: "inspect" }],
      maxConcurrent: 2,
      timeoutSeconds: 60,
      maxTurns: 10,
      maxToolCalls: 20,
    };

    const host = createRuntimeSubagentHost({
      runtime,
      createSessionFactory(dependencies, workspace) {
        assert.strictEqual(dependencies.runtime, runtime);
        events.push(`factory:${workspace}`);
        const sessionFactory = async () => ({ kind: "embedded-session" });
        sessionFactory.workspace = workspace;
        return sessionFactory;
      },
      createSupervisor(options, workspace) {
        events.push(`supervisor:${workspace}`);
        assert.equal(options.sessionFactory.workspace, workspace);
        const calls = { starts: [], dispose: 0 };
        const supervisor = {
          startBatch(batch) {
            calls.starts.push(batch);
            const batchId = `batch-${workspace.at(-1)}`;
            return {
              batchId,
              taskIds: [],
              result: Promise.resolve({
                batchId,
                status: "completed",
                tasks: [],
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 },
              }),
            };
          },
          async abortBatch() { return true; },
          releaseBatch() { return true; },
          async dispose() {
            calls.dispose += 1;
            events.push(`dispose:${workspace}`);
          },
        };
        supervisors.push({ workspace, calls });
        return supervisor;
      },
    });

    await host.delegateTasks(request);
    runtime.currentWorkspace = "C:/workspace-b";
    await host.delegateTasks(request);
    await host.dispose();

    assert.deepEqual(events, [
      "factory:C:/workspace-a",
      "supervisor:C:/workspace-a",
      "factory:C:/workspace-b",
      "supervisor:C:/workspace-b",
      "dispose:C:/workspace-a",
      "dispose:C:/workspace-b",
    ]);
    assert.equal(supervisors[0].calls.starts[0].workspace, "C:/workspace-a");
    assert.equal(supervisors[0].calls.dispose, 1);
    assert.equal(supervisors[1].calls.starts[0].workspace, "C:/workspace-b");
    assert.equal(supervisors[1].calls.dispose, 1);
  });

  it("binds fail-closed runtime callbacks after runtime initialization", () => {
    assert.match(serverSource, /createSubagentDelegationBridge/);
    assert.match(serverSource, /createRuntimeSubagentHost/);
    assert.match(serverSource, /validateSubagentModel:\s*subagentBridge\.runtimeConfig\.validateSubagentModel/);
    assert.match(serverSource, /delegateTasks:\s*subagentBridge\.runtimeConfig\.delegateTasks/);
    assert.match(serverSource, /subagentBridge\.bind\(subagentHost\)/);

    const runtimeReady = serverSource.indexOf("runtime = await initAgent(");
    const hostReady = serverSource.indexOf("subagentBridge.bind(subagentHost)");
    assert.ok(runtimeReady >= 0 && hostReady > runtimeReady, "host must bind only after runtime initialization");
  });

  it("bridges subagent events through a per-batch sink without weakening main-session filtering", () => {
    assert.match(serverSource, /createSubagentEventSink/);
    assert.match(serverSource, /createEventSink:\s*\(\)\s*=>\s*createSubagentEventSink\(\{\s*runtime,\s*chatStream\s*\}\)/s);
    assert.match(
      serverSource,
      /if \(sourceSession && runtime\.session !== sourceSession\) return;/,
      "child session events must not enter the main runtime event handler",
    );
  });

  it("awaits subagent disposal before disposing the main runtime", () => {
    const releaseStart = serverSource.indexOf("const releaseInstanceResources");
    const hostDispose = serverSource.indexOf("await subagentHost.dispose()", releaseStart);
    const runtimeDispose = serverSource.indexOf("runtime.dispose()", releaseStart);

    assert.ok(hostDispose > releaseStart, "resource release must dispose the subagent host");
    assert.ok(runtimeDispose > hostDispose, "subagents must finish disposal before the main runtime is disposed");
  });
});
