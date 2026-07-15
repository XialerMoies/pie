/**
 * Agent layer — 在 PI 框架之上叠自定义层
 *
 * 封装 createAgentSession() 为 AgentRuntime，支持：
 * - 自定义 Tool 注入
 * - 自定义 system prompt
 * - workspace 切换时重建 session
 *
 * 原则：只封装，不 fork。PI 的 agent-loop 不改。
 */
import { AgentRuntime, type RuntimeConfig } from "./runtime"

export type { AgentRuntime, RuntimeConfig }

/**
 * Initialize the agent runtime with custom configuration.
 */
export async function initAgent(config: RuntimeConfig): Promise<AgentRuntime> {
  return AgentRuntime.create(config)
}
