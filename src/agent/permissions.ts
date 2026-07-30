import path from "path"
import type { PermissionRule, PermissionSuggestion, PermissionToolName, SessionPermissionState } from "./types"

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

export function evaluatePathPermission(
  targetPath: string,
  operation: PathPermissionOperation,
  policy: PathPermissionPolicy,
): PathPermissionDecision {
  const resolvedPath = path.resolve(targetPath)
  const workspaceRoot = path.resolve(policy.workspaceRoot)
  const allowedRoots = [workspaceRoot, ...(policy.allowedWorkingRoots || [])].map((root) => path.resolve(root))

  const denyRule = findMatchingPathPermissionRule(resolvedPath, operation, policy.alwaysDenyRules?.session)
  if (denyRule) {
    return {
      status: "deny",
      operation,
      path: resolvedPath,
      reason: `${pathPermissionToolForOperation(operation)} path is denied by session rule`,
      matchedRule: denyRule,
    }
  }

  const askRule = findMatchingPathPermissionRule(resolvedPath, operation, policy.alwaysAskRules?.session)
  if (askRule) {
    return {
      status: "ask",
      operation,
      path: resolvedPath,
      reason: `${pathPermissionToolForOperation(operation)} path requires confirmation by session rule`,
      matchedRule: askRule,
      suggestions: createPathPermissionSuggestions(path.dirname(resolvedPath), operation),
    }
  }

  if (allowedRoots.some((root) => isPathInside(resolvedPath, root))) {
    return { status: "allow" }
  }

  const allowRule = findMatchingPathPermissionRule(resolvedPath, operation, policy.alwaysAllowRules?.session)
  if (allowRule) return { status: "allow", matchedRule: allowRule }

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
    alwaysAllowRules: { session: [] },
    alwaysDenyRules: { session: [] },
    alwaysAskRules: { session: [] },
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
