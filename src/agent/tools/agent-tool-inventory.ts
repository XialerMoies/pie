import {
  defineAgentTool,
  structuredToolError,
  structuredToolResult,
  type AgentTool,
} from "../types.js"

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    component_disabled: "组件已停用",
    component_untrusted: "组件未信任",
    component_unhealthy: "组件异常",
    component_uninstalled: "组件未安装",
    profile_hidden: "当前能力模式隐藏",
    runtime_unavailable: "运行时不可用",
  }
  return labels[reason] || reason
}

/** Read-only host inventory; it never enables, disables, or invokes another tool. */
export const agentToolInventoryTool: AgentTool = defineAgentTool({
  name: "list_agent_tools",
  description: "查询当前 Agent 工具目录。返回当前会话可执行的工具、已安装但被停用或异常的组件，以及因能力模式未投影的工具。需要回答实时可用性或工具缺失原因时使用；若无法调用，只能依据当前工具声明回答，不能推断组件状态。",
  parameters: { type: "object", properties: {} },
  isReadOnly: true,
  isConcurrencySafe: true,
  operations: ["read"],
  riskLevel: "low",
  needsPermission: false,
  workspaceBounded: false,
  resultFormat: "structured",
  execute: async (_args, ctx) => {
    const inventory = ctx.getAgentToolInventory?.()
    if (!inventory) return structuredToolError("宿主未提供 Agent 工具目录。", "agent_tool_inventory_unavailable")
    const stopped = inventory.components.filter((component) => component.status !== "active")
    const hidden = inventory.unavailable.filter((tool) => tool.reasons.includes("profile_hidden"))
    const text = [
      `当前会话可执行 ${inventory.available.length} 个 Agent 工具：${inventory.available.map((tool) => tool.name).join("、")}。`,
      stopped.length ? `已安装但未启用/异常的组件 ${stopped.length} 个：${stopped.map((component) => `${component.name}（${component.status}）`).join("、")}。` : "没有已安装但未启用/异常的 Agent 工具组件。",
      inventory.unavailable.length ? `当前不可用的工具：${inventory.unavailable.map((tool) => `${tool.name}（${tool.reasons.map(reasonLabel).join("、")}）`).join("、")}。` : "没有已登记但当前不可用的 Agent 工具。",
      hidden.length ? `另有 ${hidden.length} 个工具未被当前能力模式投影。` : "当前能力模式没有额外隐藏的已启用工具。",
    ].join("\n")
    return structuredToolResult(text, inventory)
  },
})
