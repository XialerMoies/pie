import type { AgentSession, ModelRegistry } from "@xiamol/pi-coding-agent"
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@xiamol/pi-coding-agent"

import type { AgentRuntime } from "../agent/index.js"
import { resolveSystemPrompt } from "../agent/prompts.js"
import { agentToolToPiTool, toolRegistry } from "../agent/tools/index.js"
import {
  READ_ONLY_SUBAGENT_TOOLS,
  type SubagentModelRef,
  type SubagentProfile,
} from "./subagent-supervisor.js"

export const SUBAGENT_PROFILE_PROMPTS: Readonly<Record<SubagentProfile, string>> = {
  general: "Complete the delegated task directly and report only substantiated results.",
  explorer: "Explore the requested code and behavior. Trace relevant definitions, callers, and tests before reporting.",
  reviewer: "Review the requested implementation. Prioritize correctness, regressions, security, and missing tests.",
  planner: "Produce an implementation plan grounded in the current codebase, with dependencies, risks, and verification steps.",
}

export interface EmbeddedSubagentTask {
  profile?: SubagentProfile
  prompt: string
  agentId?: string
  agent?: import("../agent/types.js").SubagentDefinition
  focusPaths?: string[]
  deliverable?: string
}

export interface EmbeddedSubagentSessionInput {
  batchId: string
  taskId: string
  workspace: string
  task: EmbeddedSubagentTask
  model?: SubagentModelRef
  tools: readonly string[]
  limits: {
    timeoutSeconds: number
    maxTurns: number
    maxToolCalls: number
  }
}

type RuntimeForSubagents = Pick<
  AgentRuntime,
  "modelRuntime" | "modelRegistry" | "config" | "session" | "syncModelProvidersForSubagent"
>
type ResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0]

export interface EmbeddedSubagentFactoryDependencies {
  runtime: RuntimeForSubagents
  resolvePrompt?: () => string
  createResourceLoader?: (options: ResourceLoaderOptions) => InstanceType<typeof DefaultResourceLoader>
  createSession?: typeof createAgentSession
}

const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_SUBAGENT_TOOLS)

const READ_ONLY_CONSTRAINTS = `You are a read-only subagent. Do not modify files, execute shell commands, write memory, or delegate more agents.
Use only the tools exposed by the host. Treat focus paths as guidance, not as permission to leave the workspace.
Your final response must be a JSON object with exactly these top-level fields: summary (string), findings (array), evidence (array).`

export function createEmbeddedSubagentSessionFactory(dependencies: EmbeddedSubagentFactoryDependencies) {
  const {
    runtime,
    resolvePrompt = resolveSystemPrompt,
    createResourceLoader = (options) => new DefaultResourceLoader(options),
    createSession = createAgentSession,
  } = dependencies
  const parentSystemPrompt = resolvePrompt()

  return async (input: EmbeddedSubagentSessionInput): Promise<AgentSession> => {
    const profile = normalizeProfile(input.task.profile)
    const systemPrompt = [
      parentSystemPrompt,
      READ_ONLY_CONSTRAINTS,
      SUBAGENT_PROFILE_PROMPTS[profile],
      input.task.agent?.prompt,
    ].filter(Boolean).join("\n\n")

    const settingsManager = SettingsManager.inMemory()
    const resourceLoader = createResourceLoader({
      cwd: input.workspace,
      agentDir: runtime.config.agentDir,
      settingsManager,
      systemPrompt,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    })
    await resourceLoader.reload()

    const configuredTools = input.task.agent?.tools ?? input.tools
    const inputToolSet = new Set(input.tools)
    const tools = configuredTools.filter((name) => READ_ONLY_TOOL_SET.has(name) && inputToolSet.has(name))
    const customTools = tools
      .map((name) => {
        const tool = toolRegistry.get(name)
        if (!tool || !tool.isReadOnly) {
          throw new Error(`Read-only subagent tool is unavailable: ${name}`)
        }
        return agentToolToPiTool(tool, input.workspace, undefined, {
          desktopApiToken: runtime.config.desktopApiToken,
        })
      })

    await runtime.syncModelProvidersForSubagent()
    const model = resolveModel(runtime.modelRegistry, runtime.session.model, input.model)
    const { session } = await createSession({
      cwd: input.workspace,
      agentDir: runtime.config.agentDir,
      modelRuntime: runtime.modelRuntime,
      model,
      thinkingLevel: "off",
      tools,
      customTools,
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(input.workspace),
    })
    return session
  }
}

function normalizeProfile(profile?: string): SubagentProfile {
  if (!profile) return "general"
  if (profile in SUBAGENT_PROFILE_PROMPTS) return profile as SubagentProfile
  throw new Error(`Unknown subagent profile: ${profile}`)
}

function resolveModel(
  registry: ModelRegistry,
  inheritedModel: AgentSession["model"],
  override?: SubagentModelRef,
): NonNullable<AgentSession["model"]> {
  if (override) {
    const model = registry.find(override.provider, override.id)
    if (!model) throw new Error(`Unknown subagent model: ${override.provider}/${override.id}`)
    return model
  }
  if (!inheritedModel) throw new Error("The parent agent has no active model")
  return inheritedModel
}
