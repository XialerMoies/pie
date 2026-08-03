import type { PermissionMode } from "../agent/types.js"

export interface PermissionModeController {
  get(): PermissionMode
  set(mode: PermissionMode): PermissionMode
}

export function createPermissionModeController(
  initial: PermissionMode = "standard",
  onChange?: (mode: PermissionMode) => void,
): PermissionModeController {
  let current = initial
  return {
    get: () => current,
    set: (mode) => {
      current = mode
      onChange?.(mode)
      return current
    },
  }
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "plan" || value === "standard" || value === "dontAsk" || value === "yes"
}
