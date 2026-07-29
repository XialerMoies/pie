import path from "path"
import type { PermissionRule, PermissionSuggestion, PermissionToolName, SessionPermissionState } from "./types"

function permissionPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
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

    if (suggestion.type === "addReadRule" || suggestion.type === "addPathRule") {
      addAllowRule(state, suggestion.rule)
    }
  }
}
