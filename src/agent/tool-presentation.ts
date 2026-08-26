/**
 * Model-facing tool presentation boundary.
 *
 * Presentation selects the protocol exposed to the model. Permission checks,
 * command safety, cancellation, tracing, and persistence remain host-owned.
 */
import { agentToolToPIToolDefinition } from "./tool-registry.js"
import type { AgentTool, ToolExecutionExtraContext, ToolTraceEmitter } from "./types.js"
import type { RequiredComponentLease } from "./capability-component-replacement.js"

export type ToolPresentationMode = "native"
export type NativeToolDefinition = ReturnType<typeof agentToolToPIToolDefinition>

export interface ToolPresentationRequest {
  workspace?: string
  emitTrace?: ToolTraceEmitter
  extraCtx?: ToolExecutionExtraContext
}

export interface ToolPresentation {
  readonly mode: ToolPresentationMode
  present(tools: readonly AgentTool[], request?: ToolPresentationRequest): readonly NativeToolDefinition[]
}

/** One native PI tool definition per host AgentTool. */
export const nativeToolPresentation: ToolPresentation = Object.freeze({
  mode: "native" as const,
  present(tools: readonly AgentTool[], request: ToolPresentationRequest = {}) {
    return tools.map((tool) => agentToolToPIToolDefinition(tool, request.workspace, request.emitTrace, request.extraCtx))
  },
})

export function resolveToolPresentation(mode: ToolPresentationMode | undefined): ToolPresentation {
  if (mode === undefined || mode === "native") return nativeToolPresentation
  throw new Error(`Unsupported tool presentation: ${String(mode)}`)
}

/** Resolve the implementation pinned to this session's required-component generation. */
export function resolveSessionToolPresentation(mode: ToolPresentationMode | undefined, lease?: RequiredComponentLease): ToolPresentation {
  const expected = resolveToolPresentation(mode)
  if (!lease) return expected
  const binding = lease.resolveBinding<ToolPresentation>("tool-presentation")
  const implementation = binding.implementation
  if (!implementation || implementation.mode !== expected.mode || typeof implementation.present !== "function") {
    throw new Error(`Invalid tool presentation provider: ${binding.componentId}`)
  }
  return implementation
}

/**
 * Apply a session-pinned presentation without delegating execution ownership.
 * Native providers may change model-facing metadata, but the host keeps the
 * canonical execute wrapper that owns permission, safety, trace and abort.
 */
export function presentSessionTools(
  tools: readonly AgentTool[],
  request: ToolPresentationRequest = {},
  mode: ToolPresentationMode | undefined = "native",
  lease?: RequiredComponentLease,
): readonly NativeToolDefinition[] {
  const presentation = resolveSessionToolPresentation(mode, lease)
  const hostDefinitions = nativeToolPresentation.present(tools, request)
  if (presentation === nativeToolPresentation) return hostDefinitions

  const presented = presentation.present(tools, request)
  const presentedByName = new Map<string, NativeToolDefinition>()
  for (const definition of presented) {
    if (!definition?.name || presentedByName.has(definition.name)) {
      throw new Error("Tool presentation provider returned an invalid or duplicate tool identity")
    }
    presentedByName.set(definition.name, definition)
  }
  if (presentedByName.size !== hostDefinitions.length) {
    throw new Error("Tool presentation provider changed the native tool set")
  }
  return hostDefinitions.map((hostDefinition) => {
    const definition = presentedByName.get(hostDefinition.name)
    if (!definition) throw new Error(`Tool presentation provider omitted native tool: ${hostDefinition.name}`)
    if (JSON.stringify(definition.parameters) !== JSON.stringify(hostDefinition.parameters)) {
      throw new Error(`Tool presentation provider changed the native schema: ${hostDefinition.name}`)
    }
    return Object.freeze({ ...definition, name: hostDefinition.name, parameters: hostDefinition.parameters, execute: hostDefinition.execute })
  })
}

export function presentNativeTool(tool: AgentTool, request: ToolPresentationRequest = {}): NativeToolDefinition {
  return nativeToolPresentation.present([tool], request)[0]
}
