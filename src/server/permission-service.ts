import { existsSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CommandConfirmationResponse,
  PermissionRule,
  PermissionRuleMatch,
  PermissionRuleScope,
  PermissionSuggestion,
  PermissionToolName,
  SessionPermissionState,
  McpCapabilityName,
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
  applySessionPermissionSuggestions,
  createMcpCapabilityPermissionSuggestions,
  createPathPermissionSuggestions,
  createToolPermissionSuggestions,
  evaluatePathPermission,
  findMatchingMcpCapabilityPermissionRule,
  findMatchingToolPermissionRule,
  normalizePermissionPath,
  pathPermissionRuleOverlapsRoot,
  permissionRulesForScopes,
  type PathPermissionDecision,
  type PathPermissionOperation,
} from "../agent/permissions.js";
import {
  guardPathWithinRoot,
  PathGuardError,
  type GuardedPath,
} from "./routes/path-guard.js";
import type { PermissionAuditStore } from "./permission-audit-store.js";
import {
  emptyWorkspacePermissionRuleSet,
  type WorkspacePermissionRuleSet,
  type WorkspacePermissionRuleStore,
} from "./permission-rule-store.js";
import type { RootRegistry } from "./root-registry.js";

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
  toolOperations?: readonly ToolOperation[];
  riskLevel?: ToolRiskLevel;
  workspaceBounded?: boolean;
  authorizationMode?: ToolAuthorizationMode;
  permissionRequired?: boolean;
  mcpCapabilities?: McpToolCapabilityDeclaration;
  mcpCapabilityAutoAllowed?: boolean;
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
}

export type PermissionRuleListName = "allow" | "deny" | "ask";

export interface ScopedPermissionRule extends PermissionRule {
  scope: PermissionRuleScope;
  index: number;
}

export interface PermissionRulesSnapshot {
  additionalWorkingDirectories: Array<{ path: string; source: string }>;
  alwaysAllowRules: ScopedPermissionRule[];
  alwaysDenyRules: ScopedPermissionRule[];
  alwaysAskRules: ScopedPermissionRule[];
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
  private readonly rootRegistry?: RootRegistry;
  private readonly confirmPermission?: ServerPermissionConfirmCallback;
  private readonly auditStore?: PermissionAuditStore;
  private readonly permissionRuleStore?: WorkspacePermissionRuleStore;
  private readonly maxAuditEntries: number;
  private activeWorkspaceRuleKey = "";
  private activeWorkspaceRulePath = "";
  private auditSeq = 0;
  private audit: PermissionAuditEntry[] = [];
  private auditWriteQueue: Promise<void> = Promise.resolve();

  constructor(options: ServerPermissionServiceOptions = {}) {
    this.sessionPermissionState = options.sessionPermissionState;
    this.workspaceRootProvider = options.workspaceRootProvider;
    this.trustedRootsProvider = options.trustedRootsProvider;
    this.rootRegistry = options.rootRegistry;
    this.confirmPermission = options.confirmPermission;
    this.auditStore = options.auditStore;
    this.permissionRuleStore = options.permissionRuleStore;
    this.maxAuditEntries = options.maxAuditEntries ?? 500;
    this.loadPersistedAudit();
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
        throw new ServerPermissionError(decision.reason, 403, "permission_denied");
      }
      if (decision.status === "ask") {
        throw new ServerPermissionError(decision.reason, 403, "permission_confirmation_required");
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
    const state = this.sessionPermissionState;
    const decisionRequest = toolAuthorizationDecisionRequest(request);
    const result = (
      allow: boolean,
      decision: ToolExecutionDecision,
      reason?: string,
    ): ToolAuthorizationResult => ({ allow, ...(reason ? { reason } : {}), decision: { ...decision, request: decisionRequest } });

    const denyMatch = findScopedToolRule(request.toolName, state?.alwaysDenyRules);
    const capabilityDenyMatch = mcpCapability && request.mcpCapabilities
      ? findScopedMcpCapabilityRule(request.mcpCapabilities.serverName, mcpCapability, state?.alwaysDenyRules)
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
      }, deniedReason);
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

    const askMatch = findScopedToolRule(request.toolName, state?.alwaysAskRules);
    const capabilityAskMatch = mcpCapability && request.mcpCapabilities
      ? findScopedMcpCapabilityRule(request.mcpCapabilities.serverName, mcpCapability, state?.alwaysAskRules)
      : undefined;
    const allowMatch = findScopedToolRule(request.toolName, state?.alwaysAllowRules);
    const capabilityAllowMatch = mcpCapability && request.mcpCapabilities
      ? findScopedMcpCapabilityRule(request.mcpCapabilities.serverName, mcpCapability, state?.alwaysAllowRules)
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
        code: "permission_confirmation_required",
      });
      return result(false, {
        status: "deny",
        source: "confirmation",
        reason: "Tool permission confirmation is unavailable",
        pathDecisions: [],
      }, "Tool permission confirmation is unavailable");
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
      }, "Permission confirmation failed");
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
      }, "Tool permission confirmation denied or timed out");
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
    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), this.maxAuditEntries)) : 100;
    return this.audit.slice(-normalizedLimit);
  }

  async flushAuditWrites(): Promise<void> {
    await this.auditWriteQueue;
  }

  async clearAuditTrail(): Promise<void> {
    this.audit = [];
    if (!this.auditStore) return;
    this.auditWriteQueue = this.auditWriteQueue.then(() => this.auditStore!.clear()).catch(() => {});
    await this.auditWriteQueue;
  }

  getRulesSnapshot(): PermissionRulesSnapshot {
    this.syncWorkspaceRules();
    const state = this.requireSessionPermissionState();
    return {
      additionalWorkingDirectories: [...state.additionalWorkingDirectories.values()],
      alwaysAllowRules: scopedRuleViews(state.alwaysAllowRules),
      alwaysDenyRules: scopedRuleViews(state.alwaysDenyRules),
      alwaysAskRules: scopedRuleViews(state.alwaysAskRules),
    };
  }

  async applyPermissionSuggestions(
    suggestions: readonly PermissionSuggestion[],
    scope: PermissionRuleScope,
  ): Promise<PermissionRule[]> {
    this.syncWorkspaceRules();
    const state = this.requireSessionPermissionState();
    if (scope === "session") {
      applySessionPermissionSuggestions(state, suggestions);
      return suggestions.flatMap((suggestion) => (
        suggestion.type === "addWorkingDirectory" ? [] : [{ ...suggestion.rule }]
      ));
    }

    const rules = suggestions.flatMap((suggestion) => (
      suggestion.type === "addReadRule" || suggestion.type === "addPathRule" || suggestion.type === "addToolRule"
        ? [normalizePermissionRule(suggestion.rule)]
        : []
    ));
    if (rules.length === 0) return [];
    await this.mutateWorkspaceRules((candidate) => {
      for (const rule of rules) addUniqueRule(candidate.alwaysAllowRules, rule);
    });
    return rules;
  }

  async addSessionRule(list: PermissionRuleListName, rule: PermissionRule): Promise<{ added: boolean; rule: PermissionRule }> {
    return this.addRule(list, rule, "session");
  }

  async addRule(list: PermissionRuleListName, rule: PermissionRule, scope: PermissionRuleScope = "session"): Promise<{ added: boolean; rule: PermissionRule }> {
    this.syncWorkspaceRules();
    const state = this.requireSessionPermissionState();
    const normalized = normalizePermissionRule(rule);
    const workspaceRoot = this.workspaceRootProvider?.();
    if (list === "ask" && workspaceRoot && pathPermissionRuleOverlapsRoot(normalized, workspaceRoot)) {
      throw new ServerPermissionError(
        "Ask rules cannot target paths inside the active workspace",
        400,
        "workspace_internal_ask_rule",
      );
    }
    if (scope === "workspace") {
      let added = false;
      await this.mutateWorkspaceRules((candidate) => {
        added = addUniqueRule(rulesForRuleSet(candidate, list), normalized);
      });
      return { added, rule: normalized };
    }

    const rules = rulesForList(state, list, scope);
    const added = addUniqueRule(rules, normalized);
    return { added, rule: normalized };
  }

  async removeSessionRule(list: PermissionRuleListName, index: number): Promise<PermissionRule | undefined> {
    return this.removeRule(list, index, "session");
  }

  async removeRule(list: PermissionRuleListName, index: number, scope: PermissionRuleScope = "session"): Promise<PermissionRule | undefined> {
    this.syncWorkspaceRules();
    const state = this.requireSessionPermissionState();
    const rules = rulesForList(state, list, scope);
    if (!Number.isInteger(index) || index < 0 || index >= rules.length) return undefined;
    const selected = { ...rules[index] };
    if (scope === "workspace") {
      let removed: PermissionRule | undefined;
      await this.mutateWorkspaceRules((candidate) => {
        const latest = rulesForRuleSet(candidate, list);
        const latestIndex = latest.findIndex((rule) => samePermissionRule(rule, selected));
        if (latestIndex >= 0) removed = latest.splice(latestIndex, 1)[0];
      });
      return removed ? { ...removed } : undefined;
    }
    return rules.splice(index, 1)[0];
  }

  async clearSessionRules(list?: PermissionRuleListName | "all"): Promise<number> {
    return this.clearRules(list, "session");
  }

  async clearRules(list: PermissionRuleListName | "all" = "all", scope: PermissionRuleScope = "session"): Promise<number> {
    this.syncWorkspaceRules();
    const state = this.requireSessionPermissionState();
    const lists: PermissionRuleListName[] = list && list !== "all" ? [list] : ["allow", "deny", "ask"];
    if (scope === "workspace") {
      let removed = 0;
      await this.mutateWorkspaceRules((candidate) => {
        for (const item of lists) {
          const rules = rulesForRuleSet(candidate, item);
          removed += rules.length;
          rules.length = 0;
        }
      });
      return removed;
    }

    let removed = 0;
    for (const item of lists) {
      const rules = rulesForList(state, item, scope);
      removed += rules.length;
      rules.length = 0;
    }
    if (scope === "session" && (!list || list === "all")) {
      removed += state.additionalWorkingDirectories.size;
      state.additionalWorkingDirectories.clear();
    }
    return removed;
  }

  private syncWorkspaceRules(): void {
    if (!this.sessionPermissionState || !this.permissionRuleStore) return;
    const workspacePath = this.workspaceRootProvider?.();
    if (!workspacePath) return;
    const key = normalizePermissionPath(workspacePath);
    if (key === this.activeWorkspaceRuleKey) return;

    let loaded = emptyWorkspacePermissionRuleSet();
    try {
      loaded = this.permissionRuleStore.load(workspacePath);
    } catch {
      loaded = emptyWorkspacePermissionRuleSet();
    }
    replaceWorkspaceRules(this.sessionPermissionState, loaded);
    this.activeWorkspaceRuleKey = key;
    this.activeWorkspaceRulePath = workspacePath;
  }

  private async mutateWorkspaceRules(mutator: (candidate: WorkspacePermissionRuleSet) => void): Promise<void> {
    const state = this.requireSessionPermissionState();
    if (!this.permissionRuleStore || !this.activeWorkspaceRulePath) {
      throw new ServerPermissionError("Workspace permission rule store is not available", 503, "permission_rule_store_unavailable");
    }
    const candidate = await this.permissionRuleStore.update(this.activeWorkspaceRulePath, (latest) => {
      mutator(latest);
      return latest;
    });
    replaceWorkspaceRules(state, candidate);
  }

  private record(entry: Omit<PermissionAuditEntry, "id" | "timestamp">): void {
    const confirmedByUser = entry.reason?.startsWith("Confirmed by user") === true;
    if (entry.operation === "read" && entry.decision === "allow" && !confirmedByUser) {
      return;
    }
    if (
      entry.operation === "tool" &&
      entry.decision === "allow" &&
      !confirmedByUser &&
      entry.permissionRequired === false &&
      entry.riskLevel !== "high"
    ) {
      return;
    }
    const nextEntry: PermissionAuditEntry = {
      id: ++this.auditSeq,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.audit.push(nextEntry);
    if (this.audit.length > this.maxAuditEntries) {
      this.audit.splice(0, this.audit.length - this.maxAuditEntries);
    }
    if (this.auditStore) {
      const persistedEntry = { ...nextEntry };
      this.auditWriteQueue = this.auditWriteQueue
        .then(() => this.auditStore!.append(persistedEntry))
        .catch(() => {});
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
  res.end(JSON.stringify({ error: error.message, code: error.code }));
  return true;
}

export async function authorizeRoutePath(
  ctx: { permissionService?: ServerPermissionService; rootRegistry?: RootRegistry },
  root: string,
  target: string,
  operation: PathPermissionOperation,
  source: string,
): Promise<GuardedPath> {
  const effectiveRoot = ctx.rootRegistry?.resolveRegisteredRoot(root)?.path || root;
  return ctx.permissionService
    ? ctx.permissionService.authorizePath(effectiveRoot, target, operation, source)
    : guardPathWithinRoot(effectiveRoot, target, operation);
}

const PERMISSION_TOOL_NAMES = new Set<PermissionToolName>(["Read", "Write", "Create", "Remove", "Command", "Tool", "McpCapability"]);
const PERMISSION_RULE_MATCHES = new Set<PermissionRuleMatch>(["exact", "prefix", "wildcard"]);

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

function rulesForList(
  state: SessionPermissionState,
  list: PermissionRuleListName,
  scope: PermissionRuleScope = "session",
): PermissionRule[] {
  if (list === "allow") return state.alwaysAllowRules[scope];
  if (list === "deny") return state.alwaysDenyRules[scope];
  return state.alwaysAskRules[scope];
}

function rulesForRuleSet(rules: WorkspacePermissionRuleSet, list: PermissionRuleListName): PermissionRule[] {
  if (list === "allow") return rules.alwaysAllowRules;
  if (list === "deny") return rules.alwaysDenyRules;
  return rules.alwaysAskRules;
}

function scopedRuleViews(
  rules: Partial<Record<PermissionRuleScope, readonly PermissionRule[]>>,
): ScopedPermissionRule[] {
  return (["session", "workspace"] as const).flatMap((scope) => (
    (rules[scope] || []).map((rule, index) => ({ ...rule, scope, index }))
  ));
}

function findScopedToolRule(
  toolName: string,
  rules: Partial<Record<PermissionRuleScope, readonly PermissionRule[]>> | undefined,
): { rule: PermissionRule; scope: PermissionRuleScope } | undefined {
  for (const scope of ["session", "workspace"] as const) {
    const rule = findMatchingToolPermissionRule(toolName, rules?.[scope]);
    if (rule) return { rule, scope };
  }
  return undefined;
}

function eligibleMcpCapability(
  capabilities: McpToolCapabilityDeclaration | undefined,
): McpCapabilityName | undefined {
  if (
    capabilities?.declaration === "declared" &&
    capabilities.readOnly &&
    !capabilities.destructive &&
    !capabilities.openWorld
  ) {
    return "readOnly";
  }
  return undefined;
}

function findScopedMcpCapabilityRule(
  serverName: string,
  capability: McpCapabilityName,
  rules: Partial<Record<PermissionRuleScope, readonly PermissionRule[]>> | undefined,
): { rule: PermissionRule; scope: PermissionRuleScope } | undefined {
  for (const scope of ["session", "workspace"] as const) {
    const rule = findMatchingMcpCapabilityPermissionRule(serverName, capability, rules?.[scope]);
    if (rule) return { rule, scope };
  }
  return undefined;
}

function replaceWorkspaceRules(state: SessionPermissionState, rules: WorkspacePermissionRuleSet): void {
  state.alwaysAllowRules.workspace.splice(0, state.alwaysAllowRules.workspace.length, ...rules.alwaysAllowRules.map((rule) => ({ ...rule })));
  state.alwaysDenyRules.workspace.splice(0, state.alwaysDenyRules.workspace.length, ...rules.alwaysDenyRules.map((rule) => ({ ...rule })));
  state.alwaysAskRules.workspace.splice(0, state.alwaysAskRules.workspace.length, ...rules.alwaysAskRules.map((rule) => ({ ...rule })));
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

function addUniqueRule(rules: PermissionRule[], rule: PermissionRule): boolean {
  const exists = rules.some((existing) => samePermissionRule(existing, rule));
  if (!exists) rules.push({ ...rule });
  return !exists;
}

function samePermissionRule(left: PermissionRule, right: PermissionRule): boolean {
  return (
    left.toolName === right.toolName &&
    left.ruleContent === right.ruleContent &&
    (left.match ?? "prefix") === (right.match ?? "prefix")
  );
}
