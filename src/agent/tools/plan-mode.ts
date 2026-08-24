import {
  defineAgentTool,
  structuredToolError,
  structuredToolResult,
  type AgentTool,
} from "../types.js"

export const enterPlanModeTool: AgentTool = defineAgentTool({
  name: "enter_plan_mode",
  description: "进入独立规划状态。规划状态不改变执行权限；进入后只允许只读探索，写操作继续由宿主阻止。",
  parameters: {
    type: "object",
    properties: { reason: { type: "string", description: "进入规划状态的简短原因。" } },
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  operations: ["write"],
  riskLevel: "low",
  needsPermission: false,
  workspaceBounded: false,
  resultFormat: "structured",
  execute: async ({ reason }, ctx) => {
    if (!ctx.enterPlanMode) return structuredToolError("宿主未提供规划状态控制器。", "plan_state_unavailable")
    const state = await ctx.enterPlanMode(String(reason || "agent_requested_plan"))
    return structuredToolResult("已进入规划状态。", { state, operation: "enter_plan_mode" })
  },
})

export const exitPlanModeTool: AgentTool = defineAgentTool({
  name: "exit_plan_mode",
  description: "提交当前方案并请求用户批准退出规划状态。只有用户明确批准后，状态才会变为 committed。",
  parameters: {
    type: "object",
    properties: { summary: { type: "string", description: "供用户评审的方案摘要。" } },
    required: ["summary"],
  },
  isReadOnly: true,
  isConcurrencySafe: false,
  operations: ["write"],
  riskLevel: "low",
  needsPermission: false,
  workspaceBounded: false,
  resultFormat: "structured",
  execute: async ({ summary }, ctx) => {
    const text = String(summary || "").trim()
    if (!text) return structuredToolError("方案摘要不能为空。", "plan_summary_required")
    if (!ctx.requestPlanExit) return structuredToolError("宿主未提供规划退出审批。", "plan_state_unavailable")
    const result = await ctx.requestPlanExit(text)
    return result.approved
      ? structuredToolResult("用户已批准方案，可以进入执行状态。", { state: result.state, approved: true, operation: "exit_plan_mode" })
      : structuredToolResult("用户未批准退出规划状态，继续保持规划状态。", { state: result.state, approved: false, operation: "exit_plan_mode" })
  },
})
