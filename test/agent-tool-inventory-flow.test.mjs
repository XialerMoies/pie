import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { resolveAgentProfile } from "../src/agent/agent-profile.ts"
import { buildAgentToolInventory } from "../src/agent/agent-tool-inventory.ts"
import { CapabilityComponentManager } from "../src/agent/capability-components.ts"
import { MEMORY_COMPONENT_PACKAGE_MANIFEST } from "../src/agent/component-package.ts"
import { agentToolInventoryTool } from "../src/agent/tools/agent-tool-inventory.ts"
import { structuredToolResult } from "../src/agent/types.ts"

function fixture(name) {
  return {
    name,
    description: `${name} fixture`,
    parameters: { type: "object", properties: {} },
    isReadOnly: true,
    resultFormat: "structured",
    execute: async () => structuredToolResult("ok", null),
  }
}

describe("Agent tool inventory", () => {
  it("distinguishes usable tools from an installed but disabled memory component", async () => {
    const manager = new CapabilityComponentManager()
    manager.register(MEMORY_COMPONENT_PACKAGE_MANIFEST.component, { trusted: true, enabled: true, health: "healthy" })
    const tools = [fixture("list_agent_tools"), fixture("read_memory"), fixture("write_memory"), fixture("list_memory"), fixture("delete_memory"), fixture("set_memory_enabled")]
    manager.disable("tool.memory")

    const inventory = buildAgentToolInventory(resolveAgentProfile("standard"), tools, [], manager)
    assert.ok(inventory.available.some((tool) => tool.name === "list_agent_tools"))
    assert.deepEqual(
      inventory.unavailable.filter((tool) => tool.componentId === "tool.memory").map((tool) => tool.name),
      ["delete_memory", "list_memory", "read_memory", "set_memory_enabled", "write_memory"],
    )
    assert.ok(inventory.unavailable.filter((tool) => tool.componentId === "tool.memory").every((tool) => tool.reasons.includes("component_disabled")))

    const result = await agentToolInventoryTool.execute({}, {
      cwd: process.cwd(),
      sessionId: "inventory-test",
      getAgentToolInventory: () => inventory,
    })
    assert.match(result.text, /当前会话可执行 1 个 Agent 工具/)
    assert.match(result.text, /list_agent_tools/)
    assert.match(result.text, /记忆管理（disabled）/)
    assert.match(result.text, /read_memory（组件已停用）/)
  })

  it("reports tools excluded only by the active capability profile separately from component shutdown", () => {
    const manager = new CapabilityComponentManager()
    manager.register(MEMORY_COMPONENT_PACKAGE_MANIFEST.component, { trusted: true, enabled: true, health: "healthy" })
    const inventory = buildAgentToolInventory(resolveAgentProfile("minimal"), [fixture("list_agent_tools"), fixture("read_memory")], [], manager)
    const memory = inventory.unavailable.find((tool) => tool.name === "read_memory")
    assert.equal(memory?.componentStatus, "active")
    assert.deepEqual(memory?.reasons, ["profile_hidden"])
  })

  it("includes the current session MCP tools instead of reconstructing them from a model declaration", () => {
    const manager = new CapabilityComponentManager()
    const inventory = buildAgentToolInventory(
      resolveAgentProfile("standard"),
      [fixture("list_agent_tools")],
      [],
      manager,
      [fixture("mcp__image_mcp__summarize_image")],
    )
    const mcpTool = inventory.available.find((tool) => tool.name === "mcp__image_mcp__summarize_image")
    assert.equal(mcpTool?.source, "mcp")
  })
})
