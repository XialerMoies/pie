import type {
  CommandConfirmationResponse,
  PermissionRule,
  PermissionRuleMatch,
  PermissionSuggestion,
  PermissionToolName,
  SessionPermissionState,
  ToolAuthorizationRequest,
  ToolAuthorizationResult,
  ToolRiskLevel,
} from "../agent/types";
import {
  applySessionPermissionSuggestions,
  createToolPermissionSuggestions,
  evaluatePathPermission,
  findMatchingToolPermissionRule,
  normalizePermissionPath,
  type PathPermissionDecision,
  type PathPermissionOperation,
} from "../agent/permissions";
import {
  guardPathWithinRoot,
  PathGuardError,
  type GuardedPath,
} from "./routes/path-guard";
import type { PermissionAuditStore } from "./permission-audit-store";

export interface PermissionAuditEntry {
  id: number;
  timestamp: string;
  source: string;
  operation: PermissionAuditOperation;
  root: string;
  path?: string;
  relativePath?: string;
  decision: PathPermissionDecision["status"];
  reason?: string;
  code?: string;
  toolName?: string;
  riskLevel?: ToolRiskLevel;
}

export type PermissionAuditOperation = PathPermissionOperation | "tool";

export interface ServerPermissionConfirmationRequest {
  source: string;
  operation: PermissionAuditOperation;
  root: string;
  path?: string;
  relativePath?: string;
  reason: string;
  permissionSuggestions: PermissionSuggestion[];
  toolName?: string;
  riskLevel?: ToolRiskLevel;
}

export type ServerPermissionConfirmCallback = (
  request: ServerPermissionConfirmationRequest,
) => Promise<CommandConfirmationResponse>;

export interface ServerPermissionServiceOptions {
  sessionPermissionState?: SessionPermissionState;
  workspaceRootProvider?: () => string | undefined;
  trustedRootsProvider?: () => readonly string[];
  confirmPermission?: ServerPermissionConfirmCallback;
  auditStore?: PermissionAuditStore;
  maxAuditEntries?: number;
}

export type PermissionRuleListName = "allow" | "deny" | "ask";

export interface PermissionRulesSnapshot {
  additionalWorkingDirectories: Array<{ path: string; source: string }>;
  alwaysAllowRules: PermissionRule[];
  alwaysDenyRules: PermissionRule[];
  alwaysAskRules: PermissionRule[];
}

export class ServerPermissionError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 403, code = "permission_denied") {
    super(message);
    this.name = "ServerPermissionError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class ServerPermissionService {
  private readonly sessionPermissionState?: SessionPermissionState;
  private readonly workspaceRootProvider?: () => string | undefined;
  private readonly trustedRootsProvider?: () => readonly string[];
  private readonly confirmPermission?: ServerPermissionConfirmCallback;
  private readonly auditStore?: PermissionAuditStore;
  private readonly maxAuditEntries: number;
  private auditSeq = 0;
  private audit: PermissionAuditEntry[] = [];

  constructor(options: ServerPermissionServiceOptions = {}) {
    this.sessionPermissionState = options.sessionPermissionState;
    this.workspaceRootProvider = options.workspaceRootProvider;
    this.trustedRootsProvider = options.trustedRootsProvider;
    this.confirmPermission = options.confirmPermission;
    this.auditStore = options.auditStore;
    this.maxAuditEntries = options.maxAuditEntries ?? 500;
    this.loadPersistedAudit();
  }

  async authorizePath(root: string, target: string, operation: PathPermissionOperation, source: string): Promise<GuardedPath> {
    try {
      const guarded = guardPathWithinRoot(root, target, operation);
      const permissionRoot = this.workspaceRootProvider?.() || guarded.root;
      const decision = evaluatePathPermission(guarded.path, operation, {
        workspaceRoot: permissionRoot,
        allowedWorkingRoots: this.allowedRoots(permissionRoot, guarded.root),
        alwaysAllowRules: this.sessionPermissionState?.alwaysAllowRules,
        alwaysDenyRules: this.sessionPermissionState?.alwaysDenyRules,
        alwaysAskRules: this.sessionPermissionState?.alwaysAskRules,
      });

      this.record({
        source,
        operation,
        root: guarded.root,
        path: guarded.path,
        relativePath: guarded.relativePath,
        decision: decision.status,
        reason: decision.status === "allow" ? undefined : decision.reason,
      });

      if (decision.status === "deny" || decision.status === "ask") {
        if (decision.status === "deny") {
          throw new ServerPermissionError(decision.reason, 403, "permission_denied");
        }
        await this.confirmAskDecision(decision, guarded, source);
      }

      return guarded;
    } catch (error) {
      if (error instanceof PathGuardError) {
        this.record({
          source,
          operation,
          root,
          decision: "deny",
          reason: error.message,
          code: error.code,
        });
      }
      throw error;
    }
  }

  async authorizeTool(request: ToolAuthorizationRequest): Promise<ToolAuthorizationResult> {
    const root = this.workspaceRootProvider?.() || "";
    const reason = `External tool "${request.toolName}" requires confirmation before execution`;
    const suggestions = createToolPermissionSuggestions(request.toolName);
    const baseEntry = {
      source: request.source,
      operation: "tool" as const,
      root,
      toolName: request.toolName,
      riskLevel: request.riskLevel,
    };
    const state = this.sessionPermissionState;

    const denyRule = findMatchingToolPermissionRule(request.toolName, state?.alwaysDenyRules.session);
    if (denyRule) {
      this.record({
        ...baseEntry,
        decision: "deny",
        reason: "Tool execution is denied by session rule",
        code: "permission_denied",
      });
      return { allow: false, reason: "Tool execution is denied by session rule" };
    }

    const askRule = findMatchingToolPermissionRule(request.toolName, state?.alwaysAskRules.session);
    const allowRule = findMatchingToolPermissionRule(request.toolName, state?.alwaysAllowRules.session);
    if (allowRule && !askRule) {
      this.record({
        ...baseEntry,
        decision: "allow",
        reason: "Allowed by session tool rule",
      });
      return { allow: true };
    }

    this.record({
      ...baseEntry,
      decision: "ask",
      reason: askRule ? "Tool execution requires confirmation by session rule" : reason,
    });

    if (!this.confirmPermission) {
      this.record({
        ...baseEntry,
        decision: "deny",
        reason: "Tool permission confirmation is unavailable",
        code: "permission_confirmation_required",
      });
      return { allow: false, reason: "Tool permission confirmation is unavailable" };
    }

    let response: CommandConfirmationResponse;
    try {
      response = await this.confirmPermission({
        source: request.source,
        operation: "tool",
        root,
        reason: askRule ? "Tool execution requires confirmation by session rule" : reason,
        permissionSuggestions: suggestions,
        toolName: request.toolName,
        riskLevel: request.riskLevel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record({
        ...baseEntry,
        decision: "deny",
        reason: `Permission confirmation failed: ${message}`,
        code: "permission_confirmation_failed",
      });
      return { allow: false, reason: "Permission confirmation failed" };
    }

    const confirmed = typeof response === "boolean" ? { allow: response } : response;
    if (!confirmed?.allow) {
      this.record({
        ...baseEntry,
        decision: "deny",
        reason: "Tool permission confirmation denied or timed out",
        code: "permission_denied",
      });
      return { allow: false, reason: "Tool permission confirmation denied or timed out" };
    }

    if (confirmed.scope === "session" && state) {
      applySessionPermissionSuggestions(state, suggestions);
    }

    this.record({
      ...baseEntry,
      decision: "allow",
      reason: confirmed.scope === "session"
        ? "Confirmed by user for this session"
        : "Confirmed by user once",
    });
    return { allow: true };
  }

  getAuditTrail(limit = 100): PermissionAuditEntry[] {
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), this.maxAuditEntries)) : 100;
    return this.audit.slice(-normalizedLimit);
  }

  clearAuditTrail(): void {
    this.audit = [];
    try {
      this.auditStore?.clear();
    } catch {
      // Keep in-memory permission decisions usable even if the history file is locked.
    }
  }

  getRulesSnapshot(): PermissionRulesSnapshot {
    const state = this.requireSessionPermissionState();
    return {
      additionalWorkingDirectories: [...state.additionalWorkingDirectories.values()],
      alwaysAllowRules: [...state.alwaysAllowRules.session],
      alwaysDenyRules: [...state.alwaysDenyRules.session],
      alwaysAskRules: [...state.alwaysAskRules.session],
    };
  }

  addSessionRule(list: PermissionRuleListName, rule: PermissionRule): { added: boolean; rule: PermissionRule } {
    const state = this.requireSessionPermissionState();
    const normalized = normalizePermissionRule(rule);
    const rules = rulesForList(state, list);
    const exists = rules.some((existing) => (
      existing.toolName === normalized.toolName &&
      existing.ruleContent === normalized.ruleContent &&
      (existing.match ?? "prefix") === (normalized.match ?? "prefix")
    ));
    if (!exists) rules.push(normalized);
    return { added: !exists, rule: normalized };
  }

  removeSessionRule(list: PermissionRuleListName, index: number): PermissionRule | undefined {
    const state = this.requireSessionPermissionState();
    const rules = rulesForList(state, list);
    if (!Number.isInteger(index) || index < 0 || index >= rules.length) return undefined;
    return rules.splice(index, 1)[0];
  }

  clearSessionRules(list?: PermissionRuleListName | "all"): number {
    const state = this.requireSessionPermissionState();
    let removed = 0;
    const lists: PermissionRuleListName[] = list && list !== "all" ? [list] : ["allow", "deny", "ask"];
    for (const item of lists) {
      const rules = rulesForList(state, item);
      removed += rules.length;
      rules.length = 0;
    }
    if (!list || list === "all") {
      removed += state.additionalWorkingDirectories.size;
      state.additionalWorkingDirectories.clear();
    }
    return removed;
  }

  private record(entry: Omit<PermissionAuditEntry, "id" | "timestamp">): void {
    const nextEntry: PermissionAuditEntry = {
      id: ++this.auditSeq,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.audit.push(nextEntry);
    if (this.audit.length > this.maxAuditEntries) {
      this.audit.splice(0, this.audit.length - this.maxAuditEntries);
    }
    try {
      this.auditStore?.save(this.audit);
    } catch {
      // Persistent history is best-effort; the hot audit trail remains available.
    }
  }

  private loadPersistedAudit(): void {
    if (!this.auditStore) return;
    try {
      this.audit = this.auditStore.load(this.maxAuditEntries);
      this.auditSeq = this.audit.reduce((max, entry) => Math.max(max, entry.id), 0);
    } catch {
      this.audit = [];
      this.auditSeq = 0;
    }
  }

  private requireSessionPermissionState(): SessionPermissionState {
    if (!this.sessionPermissionState) {
      throw new ServerPermissionError("Session permission state is not available", 503, "permission_state_unavailable");
    }
    return this.sessionPermissionState;
  }

  private allowedRoots(permissionRoot: string, guardedRoot: string): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();
    const add = (value: string | undefined) => {
      if (!value) return;
      const normalized = normalizePermissionPath(value);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      roots.push(value);
    };

    add(permissionRoot);
    for (const root of this.trustedRootsProvider?.() || []) add(root);
    for (const directory of this.sessionPermissionState?.additionalWorkingDirectories.values() || []) add(directory.path);

    if (!this.workspaceRootProvider && !this.trustedRootsProvider) add(guardedRoot);
    return roots;
  }

  private async confirmAskDecision(
    decision: Extract<PathPermissionDecision, { status: "ask" }>,
    guarded: GuardedPath,
    source: string,
  ): Promise<void> {
    if (!this.confirmPermission) {
      throw new ServerPermissionError(decision.reason, 403, "permission_confirmation_required");
    }

    const request: ServerPermissionConfirmationRequest = {
      source,
      operation: decision.operation,
      root: guarded.root,
      path: decision.path,
      relativePath: guarded.relativePath,
      reason: decision.reason,
      permissionSuggestions: decision.suggestions,
    };

    let response: CommandConfirmationResponse;
    try {
      response = await this.confirmPermission(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.record({
        source,
        operation: decision.operation,
        root: guarded.root,
        path: decision.path,
        relativePath: guarded.relativePath,
        decision: "deny",
        reason: `Permission confirmation failed: ${reason}`,
        code: "permission_confirmation_failed",
      });
      throw new ServerPermissionError("Permission confirmation failed", 403, "permission_confirmation_failed");
    }

    const confirmed = typeof response === "boolean"
      ? { allow: response }
      : response;

    if (!confirmed?.allow) {
      this.record({
        source,
        operation: decision.operation,
        root: guarded.root,
        path: decision.path,
        relativePath: guarded.relativePath,
        decision: "deny",
        reason: "Permission confirmation denied or timed out",
        code: "permission_denied",
      });
      throw new ServerPermissionError("Permission confirmation denied or timed out", 403, "permission_denied");
    }

    if (confirmed.scope === "session" && this.sessionPermissionState) {
      applySessionPermissionSuggestions(this.sessionPermissionState, decision.suggestions);
    }

    this.record({
      source,
      operation: decision.operation,
      root: guarded.root,
      path: decision.path,
      relativePath: guarded.relativePath,
      decision: "allow",
      reason: confirmed.scope === "session" ? "Confirmed by user for this session" : "Confirmed by user once",
    });
  }
}

export function isServerPermissionError(error: unknown): error is ServerPermissionError {
  return error instanceof ServerPermissionError;
}

export function writeServerPermissionError(
  res: import("http").ServerResponse,
  headers: Record<string, string>,
  error: unknown,
): boolean {
  if (!isServerPermissionError(error)) return false;
  res.writeHead(error.statusCode, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ error: error.message, code: error.code }));
  return true;
}

export async function authorizeRoutePath(
  ctx: { permissionService?: ServerPermissionService },
  root: string,
  target: string,
  operation: PathPermissionOperation,
  source: string,
): Promise<GuardedPath> {
  return ctx.permissionService
    ? ctx.permissionService.authorizePath(root, target, operation, source)
    : guardPathWithinRoot(root, target, operation);
}

const PERMISSION_TOOL_NAMES = new Set<PermissionToolName>(["Read", "Write", "Create", "Remove", "Command", "Tool"]);
const PERMISSION_RULE_MATCHES = new Set<PermissionRuleMatch>(["exact", "prefix", "wildcard"]);

function rulesForList(state: SessionPermissionState, list: PermissionRuleListName): PermissionRule[] {
  if (list === "allow") return state.alwaysAllowRules.session;
  if (list === "deny") return state.alwaysDenyRules.session;
  return state.alwaysAskRules.session;
}

function normalizePermissionRule(rule: PermissionRule): PermissionRule {
  const toolName = String(rule?.toolName || "") as PermissionToolName;
  const ruleContent = String(rule?.ruleContent || "").trim();
  const match = rule?.match === undefined ? undefined : String(rule.match) as PermissionRuleMatch;

  if (!PERMISSION_TOOL_NAMES.has(toolName)) {
    throw new ServerPermissionError("Invalid permission rule toolName", 400, "invalid_permission_rule");
  }
  if (!ruleContent || ruleContent.length > 1000) {
    throw new ServerPermissionError("Invalid permission rule content", 400, "invalid_permission_rule");
  }
  if (match !== undefined && !PERMISSION_RULE_MATCHES.has(match)) {
    throw new ServerPermissionError("Invalid permission rule match mode", 400, "invalid_permission_rule");
  }

  return match === undefined ? { toolName, ruleContent } : { toolName, ruleContent, match };
}
