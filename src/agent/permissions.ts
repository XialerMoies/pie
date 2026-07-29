import path from "path"
import type { PermissionSuggestion, SessionPermissionState } from "./types"

function permissionPathKey(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function hasRule(state: SessionPermissionState, ruleContent: string, toolName: "Read" | "Command"): boolean {
  return state.alwaysAllowRules.session.some((rule) => (
    rule.toolName === toolName && rule.ruleContent === ruleContent
  ))
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

    if (suggestion.type === "addReadRule") {
      const { rule } = suggestion
      if (!hasRule(state, rule.ruleContent, rule.toolName)) {
        state.alwaysAllowRules.session.push(rule)
      }
    }
  }
}
