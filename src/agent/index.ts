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
import { AgentRuntime, type RuntimeConfig } from "./runtime.js"
import { PiAgentEngineAdapter, type AgentEngine } from "../agent-engine/index.js"

export type { AgentRuntime, RuntimeConfig, AgentEngine }

/**
 * Initialize the agent runtime with custom configuration.
 */
export async function initAgent(config: RuntimeConfig): Promise<AgentRuntime> {
  return AgentRuntime.create(config)
}

/** Initialize the stable host-facing engine while PI remains behind the adapter. */
export async function initEngine(config: RuntimeConfig): Promise<AgentEngine> {
  const runtime = await AgentRuntime.create(config)
  return new PiAgentEngineAdapter(runtime)
}

/** Internal PI host for services that still manage providers and subagents. */
export async function initAgentHost(config: RuntimeConfig): Promise<{
  engine: AgentEngine
  runtime: AgentRuntime
}> {
  const runtime = await AgentRuntime.create(config)
  return { engine: new PiAgentEngineAdapter(runtime), runtime }
}
