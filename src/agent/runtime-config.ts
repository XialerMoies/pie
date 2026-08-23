import type { ModelRuntime } from "@xiamol/pi-coding-agent"
import type { SessionPermissionState, ToolExecutionExtraContext, ToolHostContext } from "./types.js"
import { applySessionPermissionSuggestions } from "./permissions.js"
import type { SkillService } from "./skills/skill-service.js"

/** Host configuration shared by the runtime lifecycle and tool adapters. */
export interface RuntimeConfig extends ToolHostContext {
  agentDir: string
  cwd: string
  sessionsDir: string
  sessionsDirForWorkspace?: (workspace: string) => string
  authFile: string
  modelsFile: string
  userMemoryRoot?: string
  workspaceMemoryRoot?: string
  sessionPermissionState?: SessionPermissionState
  syncModelProviders?: (runtime: ModelRuntime) => Promise<number>
  skillService?: SkillService
}

/** Select only host-owned capabilities for the custom-tool adapter boundary. */
export function buildToolContextExtra(config: RuntimeConfig): ToolExecutionExtraContext | undefined {
  const permissionState = config.sessionPermissionState
  if (!config.userMemoryRoot && !config.workspaceMemoryRoot && !config.permissionMode && !config.getPermissionMode && !config.confirmCommand && !config.shellDialect && !permissionState && !config.authorizePath && !config.authorizeTool && !config.applyPermissionSuggestions && !config.desktopApiToken && !config.validateSubagentModel && !config.getSubagentDefinitions && !config.getSubagentLimits && !config.delegateTasks && !config.toolOutcomeObserver && !config.evidenceLookup && !config.getCorrelationContext && !config.getExecutionContract && !config.authorizeExecutionContract) return undefined
  return {
    userMemoryRoot: config.userMemoryRoot,
    workspaceMemoryRoot: config.workspaceMemoryRoot,
    permissionMode: config.permissionMode,
    getPermissionMode: config.getPermissionMode,
    confirmCommand: config.confirmCommand,
    shellDialect: config.shellDialect,
    additionalWorkingDirectories: permissionState?.additionalWorkingDirectories,
    alwaysAllowRules: permissionState?.alwaysAllowRules,
    alwaysDenyRules: permissionState?.alwaysDenyRules,
    alwaysAskRules: permissionState?.alwaysAskRules,
    applyPermissionSuggestions: config.applyPermissionSuggestions || (permissionState
      ? (suggestions, scope) => {
          if (scope === "session") applySessionPermissionSuggestions(permissionState, suggestions)
        }
      : undefined),
    authorizePath: config.authorizePath,
    authorizeTool: config.authorizeTool,
    desktopApiToken: config.desktopApiToken,
    validateSubagentModel: config.validateSubagentModel,
    getSubagentDefinitions: config.getSubagentDefinitions,
    getSubagentLimits: config.getSubagentLimits,
    delegateTasks: config.delegateTasks,
    toolOutcomeObserver: config.toolOutcomeObserver,
    toolOutcomeSource: config.toolOutcomeSource,
    evidenceLookup: config.evidenceLookup,
    getCorrelationContext: config.getCorrelationContext,
    getExecutionContract: config.getExecutionContract,
    authorizeExecutionContract: config.authorizeExecutionContract,
  }
}
