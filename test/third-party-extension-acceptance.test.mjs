import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CapabilityComponentManager } from "../src/agent/capability-components.ts"
import { ExtensionLifecycle } from "../src/agent/extension-lifecycle.ts"
import { createExtensionApi } from "../src/agent/extension-api.ts"
import { HOST_EXECUTION_CHAIN } from "../src/agent/execution-boundary.ts"
import { ExtensionToolRegistry } from "../src/agent/extension-tool-registry.ts"
import { ToolPool } from "../src/agent/tool-pool.ts"
import { nativeToolPresentation } from "../src/agent/tool-presentation.ts"
import { resolveAgentProfile } from "../src/agent/agent-profile.ts"

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

function deferred() {
  let resolve
  const promise = new Promise((next) => { resolve = next })
  return { promise, resolve }
}

describe("third-party optional extension acceptance", () => {
  it("requires trust, releases all contributions, and stays removed after restart", async () => {
    const manager = new CapabilityComponentManager()
    const lifecycle = new ExtensionLifecycle(manager)
    const extensionTools = new ExtensionToolRegistry(manager)
    const registrations = { tools: new Map(), settings: new Map(), ui: new Map(), events: new Map() }
    const disposal = []

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
            const registration = extensionTools.register("example.third-party.lookup", definition, { permissions: ["read"] })
            registrations.tools.set(definition.id, definition)
            return {
              dispose() {
                registration.dispose()
                registrations.tools.delete(definition.id)
                disposal.push("tool")
              },
            }
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
    assert.deepEqual(extensionTools.entries(), [])

    await lifecycle.trust("example.third-party.lookup")
    await lifecycle.validate("example.third-party.lookup")
    await lifecycle.enable("example.third-party.lookup")
    const active = await lifecycle.activate("example.third-party.lookup")
    assert.equal(active.phase, "active")
    assert.deepEqual([...registrations.tools.keys()], ["example.third-party.lookup.lookup"])
    assert.equal(active.resourceCount, 4)

    const pool = new ToolPool().addExtensions(extensionTools.entries())
    const standardProfile = resolveAgentProfile("standard")
    const minimalProfile = resolveAgentProfile("minimal")
    const standard = pool.project({ audience: "main", names: standardProfile.toolNames, featureGates: standardProfile.featureGates, componentManager: manager })
    assert.deepEqual(standard.map((tool) => tool.name), ["example.third-party.lookup.lookup"])
    assert.equal(standard[0].needsPermission, true, "an extension cannot opt itself out of host authorization")
    assert.equal(standard[0].workspaceBounded, true, "the host keeps extension contributions workspace-bounded")
    assert.deepEqual(standard[0].operations, ["read"])
    assert.deepEqual(
      pool.project({ audience: "main", names: minimalProfile.toolNames, featureGates: minimalProfile.featureGates, componentManager: manager, requireAllRequested: false }),
      [],
      "minimal's explicit profile allow-list must not inherit extension tools",
    )

    const traces = []
    let authorized = 0
    const [wrapped] = nativeToolPresentation.present(standard, {
      workspace: "/workspace",
      emitTrace: (trace) => traces.push(trace),
      extraCtx: {
        authorizeTool: async () => {
        authorized += 1
        return { allow: true, reason: "test host approval" }
      },
      },
    })
    const controller = new AbortController()
    const result = await wrapped.execute("lookup-call", {}, controller.signal)
    assert.equal(authorized, 1)
    assert.deepEqual(HOST_EXECUTION_CHAIN, ["permission", "security", "pathGuard", "trace", "abort", "terminal"])
    assert.match(result.content[0].text, /aborted/)
    assert.deepEqual(traces.map((trace) => trace.type), ["tool_execution_start", "tool_execution_end"])

    const disabled = await lifecycle.dispose("example.third-party.lookup")
    assert.equal(disabled.phase, "disposed")
    assert.equal(manager.require("example.third-party.lookup").status, "disabled")
    assert.deepEqual(disposal, ["hook", "event", "ui", "setting", "tool"])
    assert.equal(registrations.tools.size + registrations.settings.size + registrations.ui.size + registrations.events.size, 0)
    assert.deepEqual(extensionTools.entries(), [])
    assert.deepEqual(new ToolPool().addExtensions(extensionTools.entries()).project({ audience: "main", names: "*", featureGates: "*", componentManager: manager }), [])

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

  it("enforces host-owned timeout and concurrency limits for an activated tool", async () => {
    const manager = new CapabilityComponentManager()
    manager.register({
      id: "example.limited.tool",
      version: "1.0.0",
      kind: "optional",
      capability: "agent-tool",
      source: "workspace",
      agentConfig: { timeoutMs: 100, maxConcurrent: 1 },
      settings: [{ id: "result-limit", type: "number", label: "Result limit", defaultValue: 10 }],
    }, { trusted: true, enabled: true, health: "healthy" })
    const registry = new ExtensionToolRegistry(manager)
    const neverEnding = deferred()
    let running = 0
    let maximumRunning = 0
    let calls = 0
    let timeoutSignal
    let receivedSettings
    const api = createExtensionApi("example.limited.tool", {
      registerTool(definition) { return registry.register("example.limited.tool", definition, { permissions: ["read"], resolveSettings: () => ({ "result-limit": 7 }) }) },
      registerSetting() { return { dispose() {} } },
      registerUi() { return { dispose() {} } },
      on() { return { dispose() {} } },
    })
    const registration = api.tools.register({
      id: "probe",
      description: "Host-limited extension probe",
      inputSchema: { type: "object", properties: { mode: { type: "string" } } },
      async execute(input, signal, settings) {
        receivedSettings = settings
        calls += 1
        running += 1
        maximumRunning = Math.max(maximumRunning, running)
        try {
          if (input.mode === "ignore-abort") {
            timeoutSignal = signal
            await neverEnding.promise
          }
          return { mode: input.mode, aborted: signal.aborted }
        } finally {
          running -= 1
        }
      },
    })
    const tool = registry.entries()[0].tool
    assert.equal(tool.isConcurrencySafe, false)
    const [wrapped] = nativeToolPresentation.present([tool], {
      workspace: "/workspace",
      extraCtx: { authorizeTool: async () => ({ allow: true }) },
    })

    const timedOut = wrapped.execute("limited-timeout", { mode: "ignore-abort" })
    await assert.rejects(timedOut, /timed out after 100ms/)
    assert.equal(timeoutSignal?.aborted, true)
    assert.deepEqual(receivedSettings, { "result-limit": 7 })
    assert.equal(Object.isFrozen(receivedSettings), true)

    const queued = wrapped.execute("limited-queued", { mode: "queued" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(calls, 1, "a timed-out callback that ignores abort must keep its concurrency slot")
    neverEnding.resolve()
    const queuedResult = await queued
    assert.match(queuedResult.content[0].text, /queued/)
    assert.equal(maximumRunning, 1)

    manager.disable("example.limited.tool")
    await assert.rejects(() => wrapped.execute("limited-disabled", { mode: "ready" }), /unavailable/)
    registration.dispose()
  })
})
