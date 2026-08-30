import type { AgentRuntime } from "../agent/index.js"
import type { ProviderModel, ProviderModelRegistry } from "../model-provider/runtime-types.js"
import {
  createPiSubagentResourceLoader,
  createPiSubagentSession,
  createPiSubagentSessionManager,
  createPiSubagentSettingsManager,
} from "../agent-engine/pi-subagent.js"
import { resolveSystemPrompt } from "../agent/prompts.js"
import { toolRegistry } from "../agent/tools/index.js"
import { presentNativeTool } from "../agent/tool-presentation.js"
import { ToolPool } from "../agent/tool-pool.js"
import { extensionToolRegistry } from "../agent/extension-tool-registry.js"
import { ensureFirstPartyExtensionContributions } from "../agent/first-party-extension-contributions.js"
import {
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
  "modelRouter" | "config" | "session" | "syncModelProvidersForSubagent"
>
export interface EmbeddedSubagentSession {
  messages?: unknown[]
  subscribe(listener: (event: { type?: string; message?: unknown }) => void): () => void
  prompt(prompt: string): Promise<unknown>
  abort(): Promise<unknown> | unknown
  dispose(): Promise<unknown> | unknown
}

export interface EmbeddedSubagentResourceLoaderOptions {
  cwd: string
  agentDir: string
  settingsManager?: unknown
  systemPrompt?: string
  noExtensions?: boolean
  noSkills?: boolean
  noPromptTemplates?: boolean
  noThemes?: boolean
  noContextFiles?: boolean
}

export interface EmbeddedSubagentResourceLoader {
  reload(): Promise<void>
}

export interface EmbeddedSubagentSessionCreateOptions {
  cwd: string
  agentDir: string
  modelRuntime?: unknown
  model?: unknown
  thinkingLevel?: string
  tools: readonly string[]
  customTools: readonly unknown[]
  resourceLoader: EmbeddedSubagentResourceLoader
  settingsManager?: unknown
  sessionManager?: unknown
}

export interface EmbeddedSubagentFactoryDependencies {
  runtime: RuntimeForSubagents
  resolvePrompt?: () => string
  createResourceLoader?: (options: EmbeddedSubagentResourceLoaderOptions) => EmbeddedSubagentResourceLoader
  createSession?: (options: EmbeddedSubagentSessionCreateOptions) => Promise<EmbeddedSubagentSession>
  createSessionManager?: (workspace: string) => unknown
  createSettingsManager?: () => unknown
}

const READ_ONLY_CONSTRAINTS = `You are a read-only subagent. Do not modify files, execute shell commands, write memory, or delegate more agents.
Use only the tools exposed by the host. Treat focus paths as guidance, not as permission to leave the workspace.
Your final response must be a JSON object with exactly these top-level fields: summary (string), findings (array), evidence (array).`

export function createEmbeddedSubagentSessionFactory(dependencies: EmbeddedSubagentFactoryDependencies) {
  const {
    runtime,
    resolvePrompt = resolveSystemPrompt,
    createResourceLoader = createPiSubagentResourceLoader,
    createSession = createPiSubagentSession,
    createSessionManager = createPiSubagentSessionManager,
    createSettingsManager = createPiSubagentSettingsManager,
  } = dependencies
  const parentSystemPrompt = resolvePrompt()

  return async (input: EmbeddedSubagentSessionInput): Promise<EmbeddedSubagentSession> => {
    const profile = normalizeProfile(input.task.profile)
    const systemPrompt = [
      parentSystemPrompt,
      READ_ONLY_CONSTRAINTS,
      SUBAGENT_PROFILE_PROMPTS[profile],
      input.task.agent?.prompt,
    ].filter(Boolean).join("\n\n")

    const settingsManager = createSettingsManager()
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
    const requestedTools = configuredTools.filter((name) => inputToolSet.has(name))
    ensureFirstPartyExtensionContributions()
    const selectedTools = new ToolPool().addNative(toolRegistry.getAll()).addExtensions(extensionToolRegistry.entries()).project({
      audience: "subagent",
      names: requestedTools,
      featureGates: "*",
    })
    const tools = selectedTools.map((tool) => tool.name)
    const customTools = selectedTools
      .map((tool) => {
        if (!tool.isReadOnly) throw new Error(`Read-only subagent tool is unavailable: ${tool.name}`)
        return presentNativeTool(tool, {
          workspace: input.workspace,
          extraCtx: {
            desktopApiToken: runtime.config.desktopApiToken,
          },
        })
      })

    await runtime.syncModelProvidersForSubagent()
    const model = resolveModel(runtime.modelRouter.modelRegistry, runtime.session.model, input.model)
    const created = await createSession({
      cwd: input.workspace,
      agentDir: runtime.config.agentDir,
      modelRuntime: runtime.modelRouter.providerRuntime,
      model,
      thinkingLevel: "off",
      tools,
      customTools,
      resourceLoader,
      settingsManager,
      sessionManager: createSessionManager(input.workspace),
    })
    return (created && typeof created === "object" && "session" in created
      ? (created as { session: EmbeddedSubagentSession }).session
      : created)
  }
}

function normalizeProfile(profile?: string): SubagentProfile {
  if (!profile) return "general"
  if (profile in SUBAGENT_PROFILE_PROMPTS) return profile as SubagentProfile
  throw new Error(`Unknown subagent profile: ${profile}`)
}

function resolveModel(
  registry: ProviderModelRegistry,
  inheritedModel: ProviderModel | undefined,
  override?: SubagentModelRef,
): ProviderModel {
  if (override) {
    const model = registry.find(override.provider, override.id)
    if (!model) throw new Error(`Unknown subagent model: ${override.provider}/${override.id}`)
    return model
  }
  if (!inheritedModel) throw new Error("The parent agent has no active model")
  return inheritedModel
}
