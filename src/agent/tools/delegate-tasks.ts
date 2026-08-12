import {
  defineAgentTool,
  structuredToolError,
  structuredToolResult,
  type AgentTool,
  type CommandConfirmationResponse,
  type SubagentDelegationModel,
  type SubagentDelegationProfile,
  type SubagentDelegationRequest,
  type SubagentModelValidator,
} from "../types.js"

const PROFILES = ["general", "explorer", "reviewer", "planner"] as const
const PROFILE_SET = new Set<string>(PROFILES)
const INPUT_KEYS = new Set([
  "tasks",
  "defaultModel",
  "timeoutSeconds",
  "maxTurns",
  "maxToolCalls",
  "maxConcurrent",
])
const TASK_KEYS = new Set(["profile", "prompt", "focusPaths", "deliverable", "model"])
const MODEL_KEYS = new Set(["provider", "id"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function inputError(message: string): Error {
  return new Error(`Invalid delegate_tasks input: ${message}`)
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw inputError(`${field} contains unknown field: ${unknown}`)
}

function parseModel(value: unknown, field: string): SubagentDelegationModel {
  if (!isRecord(value)) throw inputError(`${field} model must be an object with provider and id`)
  assertAllowedKeys(value, MODEL_KEYS, `${field} model`)
  const provider = typeof value.provider === "string" ? value.provider.trim() : ""
  const id = typeof value.id === "string" ? value.id.trim() : ""
  if (!provider || !id) throw inputError(`${field} model requires non-empty provider and id`)
  return { provider, id }
}

function parseLimit(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw inputError(`${field} must be a finite number`)
  }
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)))
}

function modelKey(model: SubagentDelegationModel): string {
  return JSON.stringify([model.provider, model.id])
}

function displayModel(model: SubagentDelegationModel): string {
  return `${model.provider}/${model.id}`
}

export async function validateDelegateTasksInput(
  input: unknown,
  validateModel?: SubagentModelValidator,
): Promise<SubagentDelegationRequest> {
  if (!isRecord(input)) throw inputError("input must be an object")
  assertAllowedKeys(input, INPUT_KEYS, "input")
  if (!Array.isArray(input.tasks)) throw inputError("tasks is required and must be an array")
  if (input.tasks.length < 1 || input.tasks.length > 4) {
    throw inputError("tasks must contain 1 to 4 items")
  }

  const defaultModel = input.defaultModel === undefined
    ? undefined
    : parseModel(input.defaultModel, "defaultModel")
  const tasks = input.tasks.map((value, index) => {
    if (!isRecord(value)) throw inputError(`tasks[${index}] must be an object`)
    assertAllowedKeys(value, TASK_KEYS, `tasks[${index}]`)
    const profile = typeof value.profile === "string" ? value.profile.trim() : ""
    if (!PROFILE_SET.has(profile)) {
      throw inputError(`tasks[${index}].profile must be one of ${PROFILES.join(", ")}`)
    }
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : ""
    if (!prompt) throw inputError(`tasks[${index}].prompt must be a non-empty string`)

    let focusPaths: string[] | undefined
    if (value.focusPaths !== undefined) {
      if (!Array.isArray(value.focusPaths)) {
        throw inputError(`tasks[${index}].focusPaths must be an array of non-empty strings`)
      }
      focusPaths = value.focusPaths.map((path, pathIndex) => {
        const normalized = typeof path === "string" ? path.trim() : ""
        if (!normalized) {
          throw inputError(`tasks[${index}].focusPaths[${pathIndex}] must be a non-empty string`)
        }
        return normalized
      })
    }

    let deliverable: string | undefined
    if (value.deliverable !== undefined) {
      deliverable = typeof value.deliverable === "string" ? value.deliverable.trim() : ""
      if (!deliverable) throw inputError(`tasks[${index}].deliverable must be a non-empty string`)
    }

    const taskModel = value.model === undefined ? undefined : parseModel(value.model, `tasks[${index}]`)
    const model = taskModel ?? defaultModel
    return {
      profile: profile as SubagentDelegationProfile,
      prompt,
      ...(focusPaths ? { focusPaths } : {}),
      ...(deliverable ? { deliverable } : {}),
      ...(model ? { model } : {}),
    }
  })

  const uniqueModels = new Map<string, SubagentDelegationModel>()
  if (defaultModel) uniqueModels.set(modelKey(defaultModel), defaultModel)
  for (const task of tasks) {
    if (task.model) uniqueModels.set(modelKey(task.model), task.model)
  }
  if (uniqueModels.size > 0 && !validateModel) {
    throw new Error("Subagent model validation is unavailable")
  }
  for (const model of uniqueModels.values()) {
    let valid = false
    try {
      valid = await validateModel!(model)
    } catch {
      valid = false
    }
    if (!valid) throw inputError(`model ${displayModel(model)} is not available`)
  }

  return {
    tasks,
    maxConcurrent: parseLimit(input.maxConcurrent, "maxConcurrent", 2, 1, 4),
    timeoutSeconds: parseLimit(input.timeoutSeconds, "timeoutSeconds", 300, 30, 3600),
    maxTurns: parseLimit(input.maxTurns, "maxTurns", 20, 1, 100),
    maxToolCalls: parseLimit(input.maxToolCalls, "maxToolCalls", 50, 1, 500),
  }
}

function confirmationAllowed(response: CommandConfirmationResponse): boolean {
  if (response === true) return true
  return !!response && typeof response === "object" && response.allow === true
}

function confirmationText(request: SubagentDelegationRequest): string {
  const models = new Map<string, string>()
  for (const task of request.tasks) {
    if (task.model) models.set(modelKey(task.model), displayModel(task.model))
  }
  return `Delegate ${request.tasks.length} tasks using models: ${models.size ? [...models.values()].join(", ") : "parent model"}`
}

function updateSpecializedDecision(
  ctx: Parameters<AgentTool["execute"]>[1],
  status: "allow" | "deny",
  reason: string,
): void {
  if (!ctx.authorizationDecision) return
  ctx.authorizationDecision.status = status
  ctx.authorizationDecision.source = "confirmation"
  ctx.authorizationDecision.reason = reason
  ctx.authorizationDecision.specialized = {
    ...ctx.authorizationDecision.specialized,
    status,
    reason,
  }
}

export const delegateTasksTool: AgentTool = defineAgentTool({
  name: "delegate_tasks",
  description: "Delegate 1 to 4 read-only analysis tasks to isolated in-process subagents and return one structured batch result.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            profile: { type: "string", enum: PROFILES },
            prompt: { type: "string", minLength: 1 },
            focusPaths: { type: "array", items: { type: "string", minLength: 1 } },
            deliverable: { type: "string", minLength: 1 },
            model: {
              type: "object",
              properties: {
                provider: { type: "string", minLength: 1 },
                id: { type: "string", minLength: 1 },
              },
              required: ["provider", "id"],
              additionalProperties: false,
            },
          },
          required: ["profile", "prompt"],
          additionalProperties: false,
        },
      },
      defaultModel: {
        type: "object",
        properties: {
          provider: { type: "string", minLength: 1 },
          id: { type: "string", minLength: 1 },
        },
        required: ["provider", "id"],
        additionalProperties: false,
      },
      timeoutSeconds: { type: "number", minimum: 30, maximum: 3600, default: 300 },
      maxTurns: { type: "number", minimum: 1, maximum: 100, default: 20 },
      maxToolCalls: { type: "number", minimum: 1, maximum: 500, default: 50 },
      maxConcurrent: { type: "number", minimum: 1, maximum: 4, default: 2 },
    },
    required: ["tasks"],
  },
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  operations: ["execute"],
  riskLevel: "high",
  needsPermission: false,
  workspaceBounded: true,
  authorizationMode: "specialized",
  permissionSource: "agent.delegate_tasks",
  resultFormat: "structured",
  execute: async (args, ctx) => {
    if (!ctx.delegateTasks) {
      return structuredToolError("Subagent delegation host is unavailable", "delegation_host_unavailable")
    }
    if (!ctx.confirmCommand) {
      updateSpecializedDecision(ctx, "deny", "Subagent delegation confirmation is unavailable")
      return structuredToolError("Subagent delegation requires explicit user confirmation", "delegation_not_confirmed")
    }

    let request: SubagentDelegationRequest
    try {
      request = await validateDelegateTasksInput(args, ctx.validateSubagentModel)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = /validation is unavailable/i.test(message)
        ? "delegation_host_unavailable"
        : "invalid_delegate_tasks_input"
      return structuredToolError(message, code)
    }

    const summary = confirmationText(request)
    let confirmed = false
    let confirmationReason = "User rejected subagent delegation"
    try {
      confirmed = confirmationAllowed(await ctx.confirmCommand("delegate_tasks", summary))
      if (confirmed) confirmationReason = "User confirmed subagent delegation"
    } catch (error) {
      confirmed = false
      const message = error instanceof Error ? error.message : String(error)
      confirmationReason = `Subagent delegation confirmation failed: ${message}`
    }
    if (!confirmed) {
      updateSpecializedDecision(ctx, "deny", confirmationReason)
      return structuredToolError("Subagent delegation was not confirmed", "delegation_not_confirmed")
    }
    updateSpecializedDecision(ctx, "allow", confirmationReason)

    try {
      const result = await ctx.delegateTasks(request, ctx.signal, ctx.toolCallId)
      return structuredToolResult(
        `Subagent batch ${result.batchId} finished with status ${result.status}`,
        result,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return structuredToolError(`Subagent delegation failed: ${message}`, "delegation_failed")
    }
  },
})
