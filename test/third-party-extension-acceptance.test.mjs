import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CapabilityComponentManager } from "../src/agent/capability-components.ts"
import { ExtensionLifecycle } from "../src/agent/extension-lifecycle.ts"
import { createExtensionApi } from "../src/agent/extension-api.ts"
import { HOST_EXECUTION_CHAIN } from "../src/agent/execution-boundary.ts"
import { agentToolToPIToolDefinition } from "../src/agent/tool-registry.ts"

const packageManifest = {
  schemaVersion: 1,
  packageId: "example.third-party.lookup",
  packageVersion: "1.0.0",
  component: {
    schemaVersion: 1,
    id: "example.third-party.lookup",
    version: "1.0.0",
    kind: "optional",
    capability: "agent-tool",
    source: "user",
    productClass: "third-party",
    hostSurface: "agent",
  },
  entry: "dist/index.js",
  source: {
    kind: "registry",
    origin: "https://registry.example.test/example.third-party.lookup-1.0.0.tgz",
    digest: "a".repeat(64),
  },
  signature: { algorithm: "sha256", value: "a".repeat(64), keyId: "example-registry" },
  compatibility: { host: "^1.0.0", contract: "1", engine: "^1.0.0" },
  permissions: { network: false, filesystem: ["read"], subprocess: false, secrets: [] },
  resources: { maxMemoryMb: 64, maxCpuMs: 1_000, maxNetworkRequests: 2, maxFileBytes: 8_192 },
  isolation: { mode: "worker", installRoot: "extensions/example.third-party.lookup", allowedEntry: "dist/index.js" },
}

describe("third-party optional extension acceptance", () => {
  it("requires trust, releases all contributions, and stays removed after restart", async () => {
    const manager = new CapabilityComponentManager()
    const lifecycle = new ExtensionLifecycle(manager)
    const registrations = { tools: new Map(), settings: new Map(), ui: new Map(), events: new Map() }
    const disposal = []
    let observedDefinition

    const register = (collection, kind, definition) => {
      collection.set(definition.id, definition)
      return {
        dispose() {
          collection.delete(definition.id)
          disposal.push(kind)
        },
      }
    }
    const hooks = {
      activate: ({ registerResource }) => {
        const api = createExtensionApi("example.third-party.lookup", {
          registerTool(definition) {
            observedDefinition = definition
            return register(registrations.tools, "tool", definition)
          },
          registerSetting(definition) { return register(registrations.settings, "setting", definition) },
          registerUi(definition) { return register(registrations.ui, "ui", definition) },
          on(event, listener) { return register(registrations.events, "event", { id: event, listener }) },
        })
        const tool = api.tools.register({ id: "lookup", description: "Lookup a local fact", inputSchema: {}, execute: (_input, signal) => ({ aborted: signal.aborted }) })
        const setting = api.settings.register({ id: "limit", type: "number", label: "Result limit", read: () => 10 })
        const ui = api.ui.register({ id: "results", kind: "pane", mount() {} })
        const event = api.events.on("workspace.changed", () => {})
        registerResource({ id: "tool.lookup", dispose: tool.dispose })
        registerResource({ id: "setting.limit", dispose: setting.dispose })
        registerResource({ id: "ui.results", dispose: ui.dispose })
        registerResource({ id: "event.workspace-changed", dispose: event.dispose })
      },
      dispose: () => disposal.push("hook"),
    }

    const installed = await lifecycle.installPackage(packageManifest, hooks, {
      compatibility: { hostVersion: "1.2.0", contractVersion: "1.0.0", engineVersion: "1.1.0" },
    })
    assert.equal(installed.phase, "installed")
    assert.equal(manager.require("example.third-party.lookup").status, "untrusted")
    assert.equal(registrations.tools.size, 0)

    await lifecycle.trust("example.third-party.lookup")
    await lifecycle.validate("example.third-party.lookup")
    await lifecycle.enable("example.third-party.lookup")
    const active = await lifecycle.activate("example.third-party.lookup")
    assert.equal(active.phase, "active")
    assert.deepEqual([...registrations.tools.keys()], ["example.third-party.lookup.lookup"])
    assert.equal(active.resourceCount, 4)

    const traces = []
    let authorized = 0
    let boundary
    const wrapped = agentToolToPIToolDefinition({
      name: observedDefinition.id,
      description: observedDefinition.description,
      parameters: observedDefinition.inputSchema,
      resultFormat: "structured",
      needsPermission: true,
      operations: ["read"],
      riskLevel: "low",
      execute: async (input, context) => {
        boundary = context.executionBoundary
        const result = await observedDefinition.execute(input, context.signal)
        return { text: JSON.stringify(result), data: result, outcome: { status: "success" } }
      },
    }, "/workspace", (trace) => traces.push(trace), {
      authorizeTool: async () => {
        authorized += 1
        return { allow: true, reason: "test host approval" }
      },
    })
    const controller = new AbortController()
    const result = await wrapped.execute("lookup-call", {}, controller.signal)
    assert.equal(authorized, 1)
    assert.deepEqual(boundary.stages, HOST_EXECUTION_CHAIN)
    assert.match(result.content[0].text, /aborted/)
    assert.deepEqual(traces.map((trace) => trace.type), ["tool_execution_start", "tool_execution_end"])

    const disabled = await lifecycle.dispose("example.third-party.lookup")
    assert.equal(disabled.phase, "disposed")
    assert.equal(manager.require("example.third-party.lookup").status, "disabled")
    assert.deepEqual(disposal, ["hook", "event", "ui", "setting", "tool"])
    assert.equal(registrations.tools.size + registrations.settings.size + registrations.ui.size + registrations.events.size, 0)

    const removed = await lifecycle.uninstall("example.third-party.lookup")
    assert.equal(removed.phase, "uninstalled")
    assert.equal(manager.get("example.third-party.lookup"), undefined)

    const root = mkdtempSync(join(tmpdir(), "third-party-extension-"))
    try {
      const stateFile = join(root, "component-state.json")
      await manager.save(stateFile)
      const restarted = new CapabilityComponentManager()
      await restarted.restore(stateFile)
      assert.equal(restarted.get("example.third-party.lookup"), undefined)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
