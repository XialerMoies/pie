import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CommandConfirmationResponse,
  PermissionRule,
  PermissionRuleScope,
  PermissionSuggestion,
  SessionPermissionState,
  McpToolCapabilityDeclaration,
  ToolAuthorizationRequest,
  ToolAuthorizationMode,
  ToolAuthorizationResult,
  ToolExecutionDecision,
  ToolOperation,
  ToolRiskLevel,
  PermissionMode,
} from "../agent/types.js";
import { toolAuthorizationDecisionRequest } from "../agent/types.js";
import {
  createMcpCapabilityPermissionSuggestions,
  createPathPermissionSuggestions,
  createToolPermissionSuggestions,
  evaluatePathPermission,
  normalizePermissionPath,
  type PathPermissionDecision,
  type PathPermissionOperation,
} from "../agent/permissions.js";
import {
  guardPathWithinRoot,
  PathGuardError,
  type GuardedPath,
} from "./routes/path-guard.js";
import {
  PermissionAuditLog,
  type PendingPermissionAuditEntry,
  type PermissionAuditEntry,
  type PermissionAuditOperation,
  type PermissionAuditStore,
} from "./permission-audit-log.js";
import {
  PermissionRuleManager,
  eligibleMcpCapability,
  type PermissionRuleListName,
  type PermissionRulesSnapshot,
} from "./permission-rule-manager.js";
import type { WorkspacePermissionRuleStore } from "./permission-rule-store.js";
import type { RootRegistry } from "./root-registry.js";
import { createPermissionFailure, type PermissionFailureContext } from "./permission-failure.js";

export type { PermissionAuditEntry, PermissionAuditOperation } from "./permission-audit-log.js";
export type {
  PermissionRuleListName,
  PermissionRulesSnapshot,
  ScopedPermissionRule,
} from "./permission-rule-manager.js";

export interface ServerPermissionConfirmationRequest {
  source: string;
  operation: PermissionAuditOperation;
  root: string;
  path?: string;
  relativePath?: string;
  reason: string;
  permissionSuggestions: PermissionSuggestion[];
  toolName?: string;
  toolOperations?: readonly ToolOperation[];
  riskLevel?: ToolRiskLevel;
  workspaceBounded?: boolean;
  authorizationMode?: ToolAuthorizationMode;
  permissionRequired?: boolean;
  mcpCapabilities?: McpToolCapabilityDeclaration;
}

export type ServerPermissionConfirmCallback = (
  request: ServerPermissionConfirmationRequest,
) => Promise<CommandConfirmationResponse>;

export interface ServerPermissionServiceOptions {
  sessionPermissionState?: SessionPermissionState;
  workspaceRootProvider?: () => string | undefined;
  trustedRootsProvider?: () => readonly string[];
  rootRegistry?: RootRegistry;
  confirmPermission?: ServerPermissionConfirmCallback;
  auditStore?: PermissionAuditStore;
  permissionRuleStore?: WorkspacePermissionRuleStore;
  maxAuditEntries?: number;
}

export interface ServerPathAuthorizationOptions {
  suggestedDirectory?: string;
  /** Authenticated Agent read callbacks must not wait for a desktop confirmation UI. */
  internalToolRequest?: boolean;
}

export class ServerPermissionError extends Error {
  statusCode: number;
  code: string;
  failureContext: PermissionFailureContext;

  constructor(message: string, statusCode = 403, code = "permission_denied", failureContext: PermissionFailureContext = {}) {
    super(message);
    this.name = "ServerPermissionError";
    this.statusCode = statusCode;
    this.code = code;
    this.failureContext = failureContext;
  }
}

export class ServerPermissionService {
  private readonly sessionPermissionState?: SessionPermissionState;
  private readonly workspaceRootProvider?: () => string | undefined;
  private readonly trustedRootsProvider?: () => readonly string[];
  private readonly rootRegistry?: RootRegistry;
  private readonly confirmPermission?: ServerPermissionConfirmCallback;
  private readonly auditLog: PermissionAuditLog;
  private readonly ruleManager?: PermissionRuleManager;

  constructor(options: ServerPermissionServiceOptions = {}) {
    this.sessionPermissionState = options.sessionPermissionState;
    this.workspaceRootProvider = options.workspaceRootProvider;
    this.trustedRootsProvider = options.trustedRootsProvider;
    this.rootRegistry = options.rootRegistry;
    this.confirmPermission = options.confirmPermission;
    this.auditLog = new PermissionAuditLog({
      store: options.auditStore,
      maxEntries: options.maxAuditEntries,
    });
    this.ruleManager = options.sessionPermissionState
      ? new PermissionRuleManager({
          sessionPermissionState: options.sessionPermissionState,
          workspaceRootProvider: options.workspaceRootProvider,
          permissionRuleStore: options.permissionRuleStore,
          createError: (message, statusCode, code) => new ServerPermissionError(message, statusCode, code),
        })
      : undefined;
  }

  recordPermissionModeChange(mode: PermissionMode, source: string): void {
    this.record({
      source,
      operation: "tool",
      root: this.workspaceRootProvider?.() || "",
      toolName: "PermissionMode",
      toolOperations: ["execute"],
      riskLevel: mode === "yes" ? "high" : "low",
      permissionRequired: true,
      decision: "allow",
      reason: `Permission mode changed to ${mode}`,
    });
  }

  async authorizePath(
    root: string,
    target: string,
    operation: PathPermissionOperation,
    source: string,
    options: ServerPathAuthorizationOptions = {},
  ): Promise<GuardedPath> {
    try {
      this.syncWorkspaceRules();
      const authorizedRoot = this.authorizedRoot(root);
      const guarded = guardPathWithinRoot(authorizedRoot, target, operation);
      const permissionRoot = this.workspaceRootProvider?.() || guarded.root;
      const internalWorkspaceRead = options.internalToolRequest === true
        && operation === "read"
        && normalizePermissionPath(guarded.root) === normalizePermissionPath(permissionRoot);
      if (internalWorkspaceRead) {
        const denyDecision = evaluatePathPermission(guarded.path, operation, {
          workspaceRoot: guarded.root,
          allowedWorkingRoots: [guarded.root],
          alwaysDenyRules: this.sessionPermissionState?.alwaysDenyRules,
        });
        if (denyDecision.status === "deny") {
          throw new ServerPermissionError(denyDecision.reason, 403, "permission_denied", {
            operation,
            target: guarded.path,
            workspaceRoot: permissionRoot,
          });
        }
        return guarded;
      }
      const evaluatedDecision = evaluatePathPermission(guarded.path, operation, {
        workspaceRoot: permissionRoot,
        allowedWorkingRoots: this.allowedRoots(permissionRoot, guarded.root, operation),
        alwaysAllowRules: this.sessionPermissionState?.alwaysAllowRules,
        alwaysDenyRules: this.sessionPermissionState?.alwaysDenyRules,
        alwaysAskRules: this.sessionPermissionState?.alwaysAskRules,
      });
      const decision = evaluatedDecision.status === "ask" && options.suggestedDirectory
        ? {
            ...evaluatedDecision,
            suggestions: createPathPermissionSuggestions(options.suggestedDirectory, operation),
          }
        : evaluatedDecision;

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
          throw new ServerPermissionError(decision.reason, 403, "permission_denied", {
            operation,
            target: guarded.path,
            workspaceRoot: permissionRoot,
          });
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

  /**
   * 授权"进入工作区"本身。工作区根目录建立新边界，不是边界内的待授权路径，
   * 因此不走外部路径 ask 流程——只验证是真实目录 + 拒绝敏感系统根。
   * 用户显式选择的目录 / 恢复的上次工作区由此直接放行，而不是弹确认。
   */
  async authorizeWorkspaceRoot(workspace: string, source: string): Promise<string> {
    this.syncWorkspaceRules();
    const resolved = path.resolve(String(workspace ?? "").trim());
    if (!resolved) {
      throw new ServerPermissionError("Missing workspace", 400, "missing_workspace");
    }
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new ServerPermissionError("Workspace is not a directory", 400, "workspace_not_directory");
    }

    if (isSensitiveWorkspaceRoot(resolved)) {
      this.record({
        source,
        operation: "read",
        root: resolved,
        path: resolved,
        decision: "deny",
        reason: "Workspace is a sensitive system directory",
        code: "sensitive_workspace_root",
      });
      throw new ServerPermissionError("Workspace path is a sensitive system directory", 403, "sensitive_workspace_root");
    }

    // 尊重显式 deny 规则：用户明确拒绝过的目录不能作为工作区进入
    const denyDecision = evaluatePathPermission(resolved, "read", {
      workspaceRoot: resolved,
      allowedWorkingRoots: [],
      alwaysDenyRules: this.sessionPermissionState?.alwaysDenyRules,
    });
    if (denyDecision.status === "deny") {
      this.record({
        source,
        operation: "read",
        root: resolved,
        path: resolved,
        decision: "deny",
        reason: denyDecision.reason,
        code: "permission_denied",
      });
      throw new ServerPermissionError(denyDecision.reason, 403, "permission_denied");
    }

    const real = realpathSync(resolved);
    this.rootRegistry?.setWorkspaceRoot(real);
    this.record({
      source,
      operation: "read",
      root: real,
      path: real,
      decision: "allow",
      reason: "User workspace root",
    });
    return real;
  }

  authorizePathSync(root: string, target: string, operation: PathPermissionOperation, source: string): GuardedPath {
    try {
      this.syncWorkspaceRules();
      const authorizedRoot = this.authorizedRoot(root);
      const guarded = guardPathWithinRoot(authorizedRoot, target, operation);
      const permissionRoot = this.workspaceRootProvider?.() || guarded.root;
      const decision = evaluatePathPermission(guarded.path, operation, {
        workspaceRoot: permissionRoot,
        allowedWorkingRoots: this.allowedRoots(permissionRoot, guarded.root, operation),
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

      if (decision.status === "deny") {
        throw new ServerPermissionError(decision.reason, 403, "permission_denied", {
          operation,
          target: guarded.path,
          workspaceRoot: permissionRoot,
        });
      }
      if (decision.status === "ask") {
        throw new ServerPermissionError(decision.reason, 403, "permission_confirmation_required", {
          operation,
          target: guarded.path,
          workspaceRoot: permissionRoot,
        });
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
    this.syncWorkspaceRules();
    const root = this.workspaceRootProvider?.() || "";
    const permissionRequired = request.permissionRequired !== false;
    const reason = permissionRequired
      ? `External tool "${request.toolName}" requires confirmation before execution`
      : `Tool "${request.toolName}" is tracked by the permission service`;
    const mcpCapability = eligibleMcpCapability(request.mcpCapabilities);
    const suggestions = mcpCapability
      ? createMcpCapabilityPermissionSuggestions(request.mcpCapabilities!.serverName, mcpCapability)
      : createToolPermissionSuggestions(request.toolName);
    const baseEntry = {
      source: request.source,
      operation: "tool" as const,
      root,
      toolName: request.toolName,
      toolOperations: request.operations,
      riskLevel: request.riskLevel,
      workspaceBounded: request.workspaceBounded,
      authorizationMode: request.authorizationMode,
      permissionRequired,
      mcpCapabilities: request.mcpCapabilities,
    };
    const decisionRequest = toolAuthorizationDecisionRequest(request);
    const result = (
      allow: boolean,
      decision: ToolExecutionDecision,
      reason?: string,
      failure?: ReturnType<typeof createPermissionFailure>,
    ): ToolAuthorizationResult => ({
      allow,
      ...(reason ? { reason } : {}),
      ...(failure ? { failure } : {}),
      decision: { ...decision, request: decisionRequest },
    });

    const denyMatch = this.ruleManager?.findToolRule(request.toolName, "deny");
    const capabilityDenyMatch = mcpCapability && request.mcpCapabilities
      ? this.ruleManager?.findMcpCapabilityRule(request.mcpCapabilities.serverName, mcpCapability, "deny")
      : undefined;
    if (denyMatch || capabilityDenyMatch) {
      const matchedScope = denyMatch?.scope || capabilityDenyMatch!.scope;
      this.record({
        ...baseEntry,
        decision: "deny",
        reason: `Tool execution is denied by ${matchedScope} rule`,
        code: "permission_denied",
      });
      const deniedReason = `Tool execution is denied by ${matchedScope} rule`;
      return result(false, {
        status: "deny",
        source: "rule",
        reason: deniedReason,
        scope: matchedScope,
        appliedRules: [denyMatch?.rule || capabilityDenyMatch!.rule],
        pathDecisions: [],
      }, deniedReason, createPermissionFailure("permission_denied", deniedReason, {
        operation: "execute",
        target: request.toolName,
        workspaceRoot: root,
      }));
    }

    if (request.authorizationMode === "specialized") {
      const specializedReason = `Authorization is owned by the specialized ${request.toolName} policy`;
      return result(true, {
        status: "delegated",
        source: "specialized",
        reason: specializedReason,
        pathDecisions: [],
        specialized: { status: "pending" },
      }, specializedReason);
    }

    const askMatch = this.ruleManager?.findToolRule(request.toolName, "ask");
    const capabilityAskMatch = mcpCapability && request.mcpCapabilities
      ? this.ruleManager?.findMcpCapabilityRule(request.mcpCapabilities.serverName, mcpCapability, "ask")
      : undefined;
    const allowMatch = this.ruleManager?.findToolRule(request.toolName, "allow");
    const capabilityAllowMatch = mcpCapability && request.mcpCapabilities
      ? this.ruleManager?.findMcpCapabilityRule(request.mcpCapabilities.serverName, mcpCapability, "allow")
      : undefined;
    const effectiveAskMatch = askMatch || capabilityAskMatch;
    if (allowMatch && !effectiveAskMatch) {
      this.record({
        ...baseEntry,
        decision: "allow",
        reason: `Allowed by ${allowMatch.scope} tool rule`,
      });
      return result(true, {
        status: "allow",
        source: "rule",
        reason: `Allowed by ${allowMatch.scope} tool rule`,
        scope: allowMatch.scope,
        appliedRules: [allowMatch.rule],
        pathDecisions: [],
      });
    }

    if (capabilityAllowMatch && !effectiveAskMatch) {
      this.record({
        ...baseEntry,
        decision: "allow",
        reason: `Allowed by ${capabilityAllowMatch.scope} MCP ${mcpCapability} capability rule`,
        mcpCapabilityAutoAllowed: true,
      });
      return result(true, {
        status: "allow",
        source: "rule",
        reason: `Allowed by ${capabilityAllowMatch.scope} MCP ${mcpCapability} capability rule`,
        scope: capabilityAllowMatch.scope,
        appliedRules: [capabilityAllowMatch.rule],
        pathDecisions: [],
      });
    }

    if (!permissionRequired && !effectiveAskMatch) {
      this.record({
        ...baseEntry,
        decision: "allow",
        reason,
      });
      return result(true, {
        status: "allow",
        source: "implicit",
        reason,
        pathDecisions: [],
      });
    }

    this.record({
      ...baseEntry,
      decision: "ask",
      reason: effectiveAskMatch ? `Tool execution requires confirmation by ${effectiveAskMatch.scope} rule` : reason,
    });

    if (!this.confirmPermission) {
      this.record({
        ...baseEntry,
        decision: "deny",
        reason: "Tool permission confirmation is unavailable",
        code: "confirmation_unavailable",
      });
      return result(false, {
        status: "deny",
        source: "confirmation",
        reason: "Tool permission confirmation is unavailable",
        pathDecisions: [],
      }, "Tool permission confirmation is unavailable", createPermissionFailure(
        "confirmation_unavailable",
        "Tool permission confirmation is unavailable",
        { operation: "execute", target: request.toolName, workspaceRoot: root },
      ));
    }

    let response: CommandConfirmationResponse;
    try {
      response = await this.confirmPermission({
        source: request.source,
        operation: "tool",
        root,
        reason: effectiveAskMatch ? `Tool execution requires confirmation by ${effectiveAskMatch.scope} rule` : reason,
        permissionSuggestions: suggestions,
        toolName: request.toolName,
        toolOperations: request.operations,
        riskLevel: request.riskLevel,
        workspaceBounded: request.workspaceBounded,
        authorizationMode: request.authorizationMode,
        permissionRequired,
        mcpCapabilities: request.mcpCapabilities,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record({
        ...baseEntry,
        decision: "deny",
        reason: `Permission confirmation failed: ${message}`,
        code: "permission_confirmation_failed",
      });
      return result(false, {
        status: "deny",
        source: "confirmation",
        reason: "Permission confirmation failed",
        pathDecisions: [],
      }, "Permission confirmation failed", createPermissionFailure(
        "confirmation_unavailable",
        "Permission confirmation failed",
        { operation: "execute", target: request.toolName, workspaceRoot: root },
      ));
    }

    const confirmed = typeof response === "boolean" ? { allow: response } : response;
    if (!confirmed?.allow) {
      this.record({
        ...baseEntry,
        decision: "deny",
        reason: "Tool permission confirmation denied or timed out",
        code: "permission_denied",
      });
      return result(false, {
        status: "deny",
        source: "confirmation",
        reason: "Tool permission confirmation denied or timed out",
        pathDecisions: [],
      }, "Tool permission confirmation denied or timed out", createPermissionFailure(
        "permission_denied",
        "Tool permission confirmation denied or timed out",
        { operation: "execute", target: request.toolName, workspaceRoot: root },
      ));
    }

    const appliedRules = confirmed.scope === "session" || confirmed.scope === "workspace"
      ? await this.applyPermissionSuggestions(suggestions, confirmed.scope)
      : [];

    this.record({
      ...baseEntry,
      decision: "allow",
      reason: confirmed.scope === "session"
        ? "Confirmed by user for this session"
        : confirmed.scope === "workspace"
          ? "Confirmed by user for this workspace"
          : "Confirmed by user once",
    });
    return result(true, {
      status: "allow",
      source: "confirmation",
      reason: confirmed.scope === "session"
        ? "Confirmed by user for this session"
        : confirmed.scope === "workspace"
          ? "Confirmed by user for this workspace"
          : "Confirmed by user once",
      scope: confirmed.scope === "session" || confirmed.scope === "workspace" ? confirmed.scope : "once",
      appliedRules,
      pathDecisions: [],
    });
  }

  getAuditTrail(limit = 100): PermissionAuditEntry[] {
    return this.auditLog.getTrail(limit);
  }

  async flushAuditWrites(): Promise<void> {
    await this.auditLog.flushWrites();
  }

  async clearAuditTrail(): Promise<void> {
    await this.auditLog.clear();
  }

  getRulesSnapshot(): PermissionRulesSnapshot {
    return this.requireRuleManager().getRulesSnapshot();
  }

  async applyPermissionSuggestions(
    suggestions: readonly PermissionSuggestion[],
    scope: PermissionRuleScope,
  ): Promise<PermissionRule[]> {
    return this.requireRuleManager().applyPermissionSuggestions(suggestions, scope);
  }

  async addSessionRule(list: PermissionRuleListName, rule: PermissionRule): Promise<{ added: boolean; rule: PermissionRule }> {
    return this.requireRuleManager().addSessionRule(list, rule);
  }

  async addRule(list: PermissionRuleListName, rule: PermissionRule, scope: PermissionRuleScope = "session"): Promise<{ added: boolean; rule: PermissionRule }> {
    return this.requireRuleManager().addRule(list, rule, scope);
  }

  async removeSessionRule(list: PermissionRuleListName, index: number): Promise<PermissionRule | undefined> {
    return this.requireRuleManager().removeSessionRule(list, index);
  }

  async removeRule(list: PermissionRuleListName, index: number, scope: PermissionRuleScope = "session"): Promise<PermissionRule | undefined> {
    return this.requireRuleManager().removeRule(list, index, scope);
  }

  async clearSessionRules(list?: PermissionRuleListName | "all"): Promise<number> {
    return this.requireRuleManager().clearSessionRules(list);
  }

  async clearRules(list: PermissionRuleListName | "all" = "all", scope: PermissionRuleScope = "session"): Promise<number> {
    return this.requireRuleManager().clearRules(list, scope);
  }

  private syncWorkspaceRules(): void {
    this.ruleManager?.syncWorkspaceRules();
  }

  private record(entry: PendingPermissionAuditEntry): void {
    this.auditLog.record(entry);
  }

  private requireRuleManager(): PermissionRuleManager {
    if (!this.ruleManager) {
      throw new ServerPermissionError("Session permission state is not available", 503, "permission_state_unavailable");
    }
    return this.ruleManager;
  }

  private allowedRoots(permissionRoot: string, guardedRoot: string, operation: PathPermissionOperation): string[] {
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
    for (const root of this.rootRegistry?.getRoots() || []) {
      if (root.operations.includes(operation)) add(root.path);
    }
    for (const root of this.trustedRootsProvider?.() || []) add(root);
    for (const directory of this.sessionPermissionState?.additionalWorkingDirectories.values() || []) add(directory.path);

    if (!this.workspaceRootProvider && !this.trustedRootsProvider) add(guardedRoot);
    return roots;
  }

  private authorizedRoot(root: string): string {
    // 已登记 root → 用规范化路径；未登记 → 原样透传给 evaluatePathPermission 决策
    // （普通外部读放行、敏感读走确认，写入仍确认/fail-closed——低摩擦读取策略）
    return this.rootRegistry?.resolveRegisteredRoot(root)?.path || root;
  }

  private async confirmAskDecision(
    decision: Extract<PathPermissionDecision, { status: "ask" }>,
    guarded: GuardedPath,
    source: string,
  ): Promise<void> {
    if (!this.confirmPermission) {
      throw new ServerPermissionError("Permission confirmation is unavailable", 403, "confirmation_unavailable", {
        operation: decision.operation,
        target: guarded.path,
        workspaceRoot: guarded.root,
      });
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
      throw new ServerPermissionError("Permission confirmation failed", 403, "permission_confirmation_failed", {
        operation: decision.operation,
        target: guarded.path,
        workspaceRoot: guarded.root,
      });
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
      throw new ServerPermissionError("Permission confirmation denied or timed out", 403, "permission_denied", {
        operation: decision.operation,
        target: guarded.path,
        workspaceRoot: guarded.root,
      });
    }

    if (confirmed.scope === "session" || confirmed.scope === "workspace") {
      await this.applyPermissionSuggestions(decision.suggestions, confirmed.scope);
    }

    this.record({
      source,
      operation: decision.operation,
      root: guarded.root,
      path: decision.path,
      relativePath: guarded.relativePath,
      decision: "allow",
      reason: confirmed.scope === "session"
        ? "Confirmed by user for this session"
        : confirmed.scope === "workspace"
          ? "Confirmed by user for this workspace"
          : "Confirmed by user once",
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
  res.end(JSON.stringify({
    error: error.message,
    code: error.code,
    failure: createPermissionFailure(error.code, error.message, error.failureContext),
  }));
  return true;
}

export interface RouteSecurityContext {
  permissionService?: ServerPermissionService;
  rootRegistry?: RootRegistry;
}

export async function authorizePath(
  security: RouteSecurityContext,
  root: string,
  target: string,
  operation: PathPermissionOperation,
  source: string,
  internalToolRequest = false,
): Promise<GuardedPath> {
  const effectiveRoot = security.rootRegistry?.resolveRegisteredRoot(root)?.path || root;
  return security.permissionService
    ? security.permissionService.authorizePath(effectiveRoot, target, operation, source, {
        internalToolRequest,
      })
    : guardPathWithinRoot(effectiveRoot, target, operation);
}

export async function authorizeRoutePath(
  ctx: {
    groups: { security: RouteSecurityContext };
    internalToolRequest?: boolean;
  },
  root: string,
  target: string,
  operation: PathPermissionOperation,
  source: string,
): Promise<GuardedPath> {
  const { permissionService, rootRegistry } = ctx.groups.security;
  const effectiveRoot = rootRegistry?.resolveRegisteredRoot(root)?.path || root;
  return permissionService
    ? permissionService.authorizePath(effectiveRoot, target, operation, source, {
        internalToolRequest: ctx.internalToolRequest,
      })
    : guardPathWithinRoot(effectiveRoot, target, operation);
}

function isSensitiveWorkspaceRoot(workspace: string): boolean {
  // 归一化：小写 + 正斜杠 + 去尾斜杠；c:\windows → c:/windows
  const normalized = normalizePermissionPath(workspace).replace(/\\/g, "/").replace(/\/+$/, "");
  // 去掉盘符前缀：c:/windows → /windows，统一按 POSIX 段比较
  const afterDrive = normalized.replace(/^[a-z]:/, "");

  // Windows 盘符根：c: / c:\（去尾斜杠后为 c:）
  if (/^[a-z]:$/.test(normalized)) return true;

  // 系统根（同时覆盖 POSIX 与 afterDrive 化的 Windows 目录）
  const systemRoots = [
    "/", "/etc", "/usr", "/bin", "/boot", "/dev", "/var", "/sbin", "/lib", "/opt", "/sys", "/proc", "/root",
    "/windows", "/windows/system32", "/windows/syswow64", "/program files", "/program files (x86)",
    "/programdata", "/users/default",
  ];
  if (systemRoots.some((dir) => afterDrive === dir || afterDrive.startsWith(dir + "/"))) return true;

  // home 目录本身（拒绝把 home 当 workspace 根）
  const home = normalizePermissionPath(os.homedir()).replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === home) return true;

  return false;
}
