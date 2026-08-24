/**
 * Model-facing tool presentation boundary.
 *
 * Presentation selects the protocol exposed to the model. Permission checks,
 * command safety, cancellation, tracing, and persistence remain host-owned.
 */
import { agentToolToPIToolDefinition } from "./tool-registry.js"
import type { AgentTool, ToolExecutionExtraContext, ToolTraceEmitter } from "./types.js"

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

export function presentNativeTool(tool: AgentTool, request: ToolPresentationRequest = {}): NativeToolDefinition {
  return nativeToolPresentation.present([tool], request)[0]
}
