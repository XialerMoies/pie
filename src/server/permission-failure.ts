import { basename, isAbsolute, relative, resolve } from "node:path";
import type {
  PermissionFailure,
  PermissionFailureCode,
  PermissionFailureSuggestion,
} from "../agent/types.js";

export interface PermissionFailureContext {
  operation?: string;
  target?: string;
  workspaceRoot?: string;
}

const OPEN_PERMISSIONS: PermissionFailureSuggestion = {
  action: "open_permissions",
  label: "查看权限设置",
};
const RECONNECT: PermissionFailureSuggestion = { action: "reconnect", label: "重新连接" };
const RETRY: PermissionFailureSuggestion = { action: "retry", label: "重试操作" };

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function summarizePermissionTarget(
  target: string | undefined,
  workspaceRoot?: string,
  dangerous = false,
): string | undefined {
  if (dangerous) return target ? "高风险命令" : undefined;
  const raw = String(target ?? "").trim();
  if (!raw) return undefined;
  if (workspaceRoot) {
    const root = resolve(workspaceRoot);
    const resolvedTarget = resolve(raw);
    if (isInside(root, resolvedTarget)) {
      const rel = relative(root, resolvedTarget).replace(/\\/g, "/");
      return (rel || ".").slice(0, 160);
    }
  }
  if (isAbsolute(raw)) return (basename(raw) || "外部路径").slice(0, 160);
  const safe = raw.replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "..");
  return (safe.join("/") || basename(raw) || "目标路径").slice(0, 160);
}

function normalizeCode(code: string): PermissionFailureCode {
  if (code === "permission_denied") return code;
  if (code === "permission_confirmation_required") return code;
  if (code === "confirmation_unavailable" || code === "permission_confirmation_failed") return "confirmation_unavailable";
  if (code === "dangerous" || code === "dangerous_command") return "dangerous";
  if (code === "permission_state_unavailable") return code;
  return "path_outside_root";
}

export function createPermissionFailure(
  code: string,
  reason: string,
  context: PermissionFailureContext = {},
): PermissionFailure {
  const normalized = normalizeCode(code);
  if (normalized === "dangerous") {
    return {
      code: normalized,
      category: "safety",
      decision: "block",
      message: "安全策略已阻止高风险操作。",
      reason: "命令命中强制安全规则",
      ...(context.operation ? { operation: context.operation } : {}),
      ...(context.target ? { target: summarizePermissionTarget(context.target, context.workspaceRoot, true) } : {}),
      recoverable: false,
      suggestions: [],
    };
  }
  if (normalized === "confirmation_unavailable") {
    return {
      code: normalized,
      category: "confirmation",
      decision: "deny",
      message: "权限确认通道不可用，操作已安全拒绝。",
      reason,
      ...(context.operation ? { operation: context.operation } : {}),
      ...(context.target ? { target: summarizePermissionTarget(context.target, context.workspaceRoot) } : {}),
      recoverable: true,
      suggestions: [RECONNECT, RETRY],
    };
  }
  if (normalized === "permission_confirmation_required") {
    return {
      code: normalized,
      category: "confirmation",
      decision: "ask",
      message: "此操作需要你的确认。",
      reason,
      ...(context.operation ? { operation: context.operation } : {}),
      ...(context.target ? { target: summarizePermissionTarget(context.target, context.workspaceRoot) } : {}),
      recoverable: true,
      suggestions: [RETRY, OPEN_PERMISSIONS],
    };
  }
  if (normalized === "permission_denied" || normalized === "permission_state_unavailable") {
    return {
      code: normalized,
      category: "permission",
      decision: "deny",
      message: normalized === "permission_state_unavailable"
        ? "权限服务暂时不可用，操作已安全拒绝。"
        : "权限规则拒绝了此操作。",
      reason,
      ...(context.operation ? { operation: context.operation } : {}),
      ...(context.target ? { target: summarizePermissionTarget(context.target, context.workspaceRoot) } : {}),
      recoverable: true,
      suggestions: normalized === "permission_state_unavailable" ? [RETRY] : [OPEN_PERMISSIONS],
    };
  }
  return {
    code: normalized,
    category: "path",
    decision: "block",
    message: "目标路径不在允许范围内。",
    reason,
    ...(context.operation ? { operation: context.operation } : {}),
    ...(context.target ? { target: summarizePermissionTarget(context.target, context.workspaceRoot) } : {}),
    recoverable: false,
    suggestions: [],
  };
}
