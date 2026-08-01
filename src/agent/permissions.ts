import path from "path"
import type {
  McpCapabilityName,
  PermissionRule,
  PermissionRuleScope,
  PermissionSuggestion,
  PermissionToolName,
  SessionPermissionState,
} from "./types.js"
import { isSensitiveExternalPath } from "./sensitive-paths.js"

export type PathPermissionOperation = "read" | "write" | "create" | "remove"

export type PathPermissionDecision =
  | { status: "allow"; matchedRule?: PermissionRule }
  | { status: "ask"; operation: PathPermissionOperation; path: string; reason: string; matchedRule?: PermissionRule; suggestions: PermissionSuggestion[] }
  | { status: "deny"; operation: PathPermissionOperation; path: string; reason: string; matchedRule?: PermissionRule }

export interface PathPermissionPolicy {
  workspaceRoot: string
  allowedWorkingRoots?: readonly string[]
  alwaysAllowRules?: SessionPermissionState["alwaysAllowRules"]
  alwaysDenyRules?: SessionPermissionState["alwaysDenyRules"]
  alwaysAskRules?: SessionPermissionState["alwaysAskRules"]
}

function permissionPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

export function normalizePermissionPath(value: string): string {
  const resolved = path.resolve(value)
  const normalized = path.normalize(resolved)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function isPathInside(candidate: string, root: string): boolean {
  const child = normalizePermissionPath(candidate)
  const parent = normalizePermissionPath(root)
  if (child === parent) return true
  const rel = path.relative(parent, child)
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel)
}

export function pathPermissionToolForOperation(operation: PathPermissionOperation): "Read" | "Write" | "Create" | "Remove" {
  if (operation === "write") return "Write"
  if (operation === "create") return "Create"
  if (operation === "remove") return "Remove"
  return "Read"
}

export function pathRuleContentForDirectory(directory: string, operation: PathPermissionOperation): string {
  const toolName = pathPermissionToolForOperation(operation)
  return `${toolName}(${path.join(path.resolve(directory), "**")})`
}

export function createPathPermissionSuggestions(directory: string, operation: PathPermissionOperation): PermissionSuggestion[] {
  const resolvedDirectory = path.resolve(directory)
  return [{
    type: "addPathRule",
    operation,
    directory: resolvedDirectory,
    rule: {
      toolName: pathPermissionToolForOperation(operation),
      ruleContent: pathRuleContentForDirectory(resolvedDirectory, operation),
      match: "wildcard",
    },
    destination: "session",
  }]
}

export function toolRuleContentForTool(toolName: string): string {
  return `Tool(${toolName})`
}

export function createToolPermissionSuggestions(toolName: string): PermissionSuggestion[] {
  return [{
    type: "addToolRule",
    toolName,
    rule: {
      toolName: "Tool",
      ruleContent: toolRuleContentForTool(toolName),
      match: "exact",
    },
    destination: "session",
  }]
}

export function mcpCapabilityRuleContent(serverName: string, capability: McpCapabilityName): string {
  return `McpCapability(${encodeURIComponent(serverName)},${capability})`
}

export function createMcpCapabilityPermissionSuggestions(
  serverName: string,
  capability: McpCapabilityName,
): PermissionSuggestion[] {
  return [{
    type: "addToolRule",
    toolName: `mcp:${serverName}:${capability}`,
    rule: {
      toolName: "McpCapability",
      ruleContent: mcpCapabilityRuleContent(serverName, capability),
      match: "exact",
    },
    destination: "session",
  }]
}

export function findMatchingMcpCapabilityPermissionRule(
  serverName: string,
  capability: McpCapabilityName,
  rules: readonly PermissionRule[] = [],
): PermissionRule | undefined {
  const expected = mcpCapabilityRuleContent(serverName, capability)
  return rules.find((rule) => (
    rule.toolName === "McpCapability" &&
    rule.ruleContent === expected &&
    (rule.match === undefined || rule.match === "exact")
  ))
}

export function findMatchingPathPermissionRule(
  resolvedPath: string,
  operation: PathPermissionOperation,
  rules: readonly PermissionRule[] = [],
): PermissionRule | undefined {
  return rules.find((rule) => pathRuleMatches(resolvedPath, rule, operation))
}

export function findMatchingToolPermissionRule(
  toolName: string,
  rules: readonly PermissionRule[] = [],
): PermissionRule | undefined {
  return rules.find((rule) => toolRuleMatches(toolName, rule))
}

export function permissionRulesForScopes(
  rules: Partial<Record<PermissionRuleScope, readonly PermissionRule[]>> | undefined,
): PermissionRule[] {
  return [...(rules?.session || []), ...(rules?.workspace || [])]
}

function findMatchingScopedPathPermissionRule(
  resolvedPath: string,
  operation: PathPermissionOperation,
  rules: Partial<Record<PermissionRuleScope, readonly PermissionRule[]>> | undefined,
): { rule: PermissionRule; scope: PermissionRuleScope } | undefined {
  for (const scope of ["session", "workspace"] as const) {
    const rule = findMatchingPathPermissionRule(resolvedPath, operation, rules?.[scope])
    if (rule) return { rule, scope }
  }
  return undefined
}

export function evaluatePathPermission(
  targetPath: string,
  operation: PathPermissionOperation,
  policy: PathPermissionPolicy,
): PathPermissionDecision {
  const resolvedPath = path.resolve(targetPath)
  const workspaceRoot = path.resolve(policy.workspaceRoot)
  const allowedRoots = [workspaceRoot, ...(policy.allowedWorkingRoots || [])].map((root) => path.resolve(root))

  const denyMatch = findMatchingScopedPathPermissionRule(resolvedPath, operation, policy.alwaysDenyRules)
  if (denyMatch) {
    return {
      status: "deny",
      operation,
      path: resolvedPath,
      reason: `${pathPermissionToolForOperation(operation)} path is denied by ${denyMatch.scope} rule`,
      matchedRule: denyMatch.rule,
    }
  }

  if (allowedRoots.some((root) => isPathInside(resolvedPath, root))) {
    return { status: "allow" }
  }

  const askMatch = findMatchingScopedPathPermissionRule(resolvedPath, operation, policy.alwaysAskRules)
  if (askMatch) {
    return {
      status: "ask",
      operation,
      path: resolvedPath,
      reason: `${pathPermissionToolForOperation(operation)} path requires confirmation by ${askMatch.scope} rule`,
      matchedRule: askMatch.rule,
      suggestions: createPathPermissionSuggestions(path.dirname(resolvedPath), operation),
    }
  }

  const allowRule = findMatchingPathPermissionRule(
    resolvedPath,
    operation,
    permissionRulesForScopes(policy.alwaysAllowRules),
  )
  if (allowRule) return { status: "allow", matchedRule: allowRule }

  if (operation === "read") {
    if (isSensitiveExternalPath(resolvedPath, workspaceRoot)) {
      return {
        status: "ask",
        operation,
        path: resolvedPath,
        reason: "Read path points to sensitive data outside the workspace",
        suggestions: createPathPermissionSuggestions(path.dirname(resolvedPath), operation),
      }
    }
    return { status: "allow" }
  }

  return {
    status: "ask",
    operation,
    path: resolvedPath,
    reason: `${pathPermissionToolForOperation(operation)} path is outside workspace/authorized roots`,
    suggestions: createPathPermissionSuggestions(path.dirname(resolvedPath), operation),
  }
}

const PATH_PERMISSION_TOOLS = new Set(["Read", "Write", "Create", "Remove"])

function stripPathRuleWrapper(ruleContent: string, toolName: "Read" | "Write" | "Create" | "Remove"): string {
  const trimmed = ruleContent.trim()
  const prefix = `${toolName}(`
  if (trimmed.startsWith(prefix) && trimmed.endsWith(")")) {
    return trimmed.slice(prefix.length, -1)
  }
  return trimmed
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === "'" && last === "'") || (first === "\"" && last === "\"")) return trimmed.slice(1, -1)
  }
  return trimmed
}

function pathRulePattern(rule: PermissionRule, operation: PathPermissionOperation): string | undefined {
  const toolName = rule.toolName as "Read" | "Write" | "Create" | "Remove"
  if (!PATH_PERMISSION_TOOLS.has(toolName)) return undefined
  if (toolName !== pathPermissionToolForOperation(operation)) return undefined

  const content = stripSurroundingQuotes(stripPathRuleWrapper(rule.ruleContent, toolName))
  return content ? content : undefined
}

function normalizeRulePath(value: string): string {
  const normalized = path.normalize(path.resolve(value)).replace(/[\\/]+/g, "/").replace(/\/$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function containsPathGlob(value: string): boolean {
  return /[*?\[]/.test(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function wildcardPathMatches(resolvedPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRulePath(pattern)
  const normalizedPath = normalizeRulePath(resolvedPath)
  const recursiveRoot = normalizedPattern.replace(/\/\*\*$/, "")
  if (recursiveRoot !== normalizedPattern) {
    return normalizedPath === recursiveRoot || normalizedPath.startsWith(`${recursiveRoot}/`)
  }

  let regex = ""
  for (let i = 0; i < normalizedPattern.length; i++) {
    const ch = normalizedPattern[i]
    if (ch === "*") {
      if (normalizedPattern[i + 1] === "*") {
        regex += ".*"
        i++
      } else {
        regex += "[^/]*"
      }
    } else if (ch === "?") {
      regex += "[^/]"
    } else {
      regex += escapeRegExp(ch)
    }
  }
  return new RegExp(`^${regex}$`).test(normalizedPath)
}

function stripRecursiveGlob(pattern: string): string {
  return pattern.replace(/[\\/]\*\*$/, "")
}

function pathRuleMatches(resolvedPath: string, rule: PermissionRule, operation: PathPermissionOperation): boolean {
  const pattern = pathRulePattern(rule, operation)
  if (!pattern) return false

  const match = rule.match ?? (containsPathGlob(pattern) ? "wildcard" : "prefix")
  if (match === "exact") return normalizeRulePath(resolvedPath) === normalizeRulePath(stripRecursiveGlob(pattern))
  if (match === "wildcard") return wildcardPathMatches(resolvedPath, pattern)
  return isPathInside(resolvedPath, path.resolve(stripRecursiveGlob(pattern)))
}

function stripToolRuleWrapper(ruleContent: string): string {
  const trimmed = stripSurroundingQuotes(ruleContent)
  if (trimmed.startsWith("Tool(") && trimmed.endsWith(")")) {
    return trimmed.slice("Tool(".length, -1)
  }
  return trimmed
}

function wildcardTextMatches(value: string, pattern: string): boolean {
  const regex = pattern.split("*").map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")).join(".*")
  return new RegExp(`^${regex}$`).test(value)
}

function toolRuleMatches(toolName: string, rule: PermissionRule): boolean {
  if (rule.toolName !== "Tool") return false
  const pattern = stripToolRuleWrapper(rule.ruleContent)
  if (!pattern) return false
  const match = rule.match ?? (pattern.includes("*") ? "wildcard" : "exact")
  if (match === "exact") return toolName === pattern
  if (match === "prefix") return toolName === pattern || toolName.startsWith(pattern)
  return wildcardTextMatches(toolName, pattern)
}

function hasRule(state: SessionPermissionState, ruleContent: string, toolName: PermissionToolName): boolean {
  return state.alwaysAllowRules.session.some((rule) => (
    rule.toolName === toolName && rule.ruleContent === ruleContent
  ))
}

function addAllowRule(state: SessionPermissionState, rule: PermissionRule): void {
  if (!hasRule(state, rule.ruleContent, rule.toolName)) {
    state.alwaysAllowRules.session.push(rule)
  }
}

export function createSessionPermissionState(): SessionPermissionState {
  return {
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: { session: [], workspace: [] },
    alwaysDenyRules: { session: [], workspace: [] },
    alwaysAskRules: { session: [], workspace: [] },
  }
}

export function resetSessionPermissionState(state: SessionPermissionState): void {
  state.additionalWorkingDirectories.clear()
  state.alwaysAllowRules.session.length = 0
  state.alwaysDenyRules.session.length = 0
  state.alwaysAskRules.session.length = 0
}

export function applySessionPermissionSuggestions(
  state: SessionPermissionState,
  suggestions: readonly PermissionSuggestion[],
): void {
  for (const suggestion of suggestions) {
    if (suggestion.destination !== "session") continue

    if (suggestion.type === "addWorkingDirectory") {
      const directory = path.resolve(suggestion.directory)
      state.additionalWorkingDirectories.set(permissionPathKey(directory), {
        path: directory,
        source: "session",
      })
      continue
    }

    if (suggestion.type === "addReadRule" || suggestion.type === "addPathRule" || suggestion.type === "addToolRule") {
      addAllowRule(state, suggestion.rule)
    }
  }
}
