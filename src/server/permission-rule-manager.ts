import type {
  McpCapabilityName,
  McpToolCapabilityDeclaration,
  PermissionRule,
  PermissionRuleMatch,
  PermissionRuleScope,
  PermissionSuggestion,
  PermissionToolName,
  SessionPermissionState,
} from "../agent/types.js";
import {
  applySessionPermissionSuggestions,
  findMatchingMcpCapabilityPermissionRule,
  findMatchingToolPermissionRule,
  normalizePermissionPath,
  pathPermissionRuleOverlapsRoot,
} from "../agent/permissions.js";
import {
  emptyWorkspacePermissionRuleSet,
  type WorkspacePermissionRuleSet,
  type WorkspacePermissionRuleStore,
} from "./permission-rule-store.js";

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

export interface ScopedPermissionRuleMatch {
  rule: PermissionRule;
  scope: PermissionRuleScope;
}

type PermissionRuleErrorFactory = (message: string, statusCode: number, code: string) => Error;

export interface PermissionRuleManagerOptions {
  sessionPermissionState: SessionPermissionState;
  workspaceRootProvider?: () => string | undefined;
  permissionRuleStore?: WorkspacePermissionRuleStore;
  createError: PermissionRuleErrorFactory;
}

const PERMISSION_TOOL_NAMES = new Set<PermissionToolName>([
  "Read",
  "Write",
  "Create",
  "Remove",
  "Command",
  "Tool",
  "McpCapability",
]);
const PERMISSION_RULE_MATCHES = new Set<PermissionRuleMatch>(["exact", "prefix", "wildcard"]);

export class PermissionRuleManager {
  private readonly state: SessionPermissionState;
  private readonly workspaceRootProvider?: () => string | undefined;
  private readonly store?: WorkspacePermissionRuleStore;
  private readonly createError: PermissionRuleErrorFactory;
  private activeWorkspaceKey = "";
  private activeWorkspacePath = "";

  constructor(options: PermissionRuleManagerOptions) {
    this.state = options.sessionPermissionState;
    this.workspaceRootProvider = options.workspaceRootProvider;
    this.store = options.permissionRuleStore;
    this.createError = options.createError;
  }

  syncWorkspaceRules(): void {
    if (!this.store) return;
    const workspacePath = this.workspaceRootProvider?.();
    if (!workspacePath) return;
    const key = normalizePermissionPath(workspacePath);
    if (key === this.activeWorkspaceKey) return;

    let loaded = emptyWorkspacePermissionRuleSet();
    try {
      loaded = this.store.load(workspacePath);
    } catch {
      loaded = emptyWorkspacePermissionRuleSet();
    }
    replaceWorkspaceRules(this.state, loaded);
    this.activeWorkspaceKey = key;
    this.activeWorkspacePath = workspacePath;
  }

  getRulesSnapshot(): PermissionRulesSnapshot {
    this.syncWorkspaceRules();
    return {
      additionalWorkingDirectories: [...this.state.additionalWorkingDirectories.values()],
      alwaysAllowRules: scopedRuleViews(this.state.alwaysAllowRules),
      alwaysDenyRules: scopedRuleViews(this.state.alwaysDenyRules),
      alwaysAskRules: scopedRuleViews(this.state.alwaysAskRules),
    };
  }

  async applyPermissionSuggestions(
    suggestions: readonly PermissionSuggestion[],
    scope: PermissionRuleScope,
  ): Promise<PermissionRule[]> {
    this.syncWorkspaceRules();
    if (scope === "session") {
      applySessionPermissionSuggestions(this.state, suggestions);
      return suggestions.flatMap((suggestion) => (
        suggestion.type === "addWorkingDirectory" ? [] : [{ ...suggestion.rule }]
      ));
    }

    const rules = suggestions.flatMap((suggestion) => (
      suggestion.type === "addReadRule" || suggestion.type === "addPathRule" || suggestion.type === "addToolRule"
        ? [this.normalizeRule(suggestion.rule)]
        : []
    ));
    if (rules.length === 0) return [];
    await this.mutateWorkspaceRules((candidate) => {
      for (const rule of rules) addUniqueRule(candidate.alwaysAllowRules, rule);
    });
    return rules;
  }

  async addSessionRule(
    list: PermissionRuleListName,
    rule: PermissionRule,
  ): Promise<{ added: boolean; rule: PermissionRule }> {
    return this.addRule(list, rule, "session");
  }

  async addRule(
    list: PermissionRuleListName,
    rule: PermissionRule,
    scope: PermissionRuleScope = "session",
  ): Promise<{ added: boolean; rule: PermissionRule }> {
    this.syncWorkspaceRules();
    const normalized = this.normalizeRule(rule);
    const workspaceRoot = this.workspaceRootProvider?.();
    if (list === "ask" && workspaceRoot && pathPermissionRuleOverlapsRoot(normalized, workspaceRoot)) {
      throw this.createError(
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

    const rules = rulesForList(this.state, list, scope);
    const added = addUniqueRule(rules, normalized);
    return { added, rule: normalized };
  }

  async removeSessionRule(list: PermissionRuleListName, index: number): Promise<PermissionRule | undefined> {
    return this.removeRule(list, index, "session");
  }

  async removeRule(
    list: PermissionRuleListName,
    index: number,
    scope: PermissionRuleScope = "session",
  ): Promise<PermissionRule | undefined> {
    this.syncWorkspaceRules();
    const rules = rulesForList(this.state, list, scope);
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

  async clearRules(
    list: PermissionRuleListName | "all" = "all",
    scope: PermissionRuleScope = "session",
  ): Promise<number> {
    this.syncWorkspaceRules();
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
      const rules = rulesForList(this.state, item, scope);
      removed += rules.length;
      rules.length = 0;
    }
    if (scope === "session" && (!list || list === "all")) {
      removed += this.state.additionalWorkingDirectories.size;
      this.state.additionalWorkingDirectories.clear();
    }
    return removed;
  }

  findToolRule(toolName: string, list: PermissionRuleListName): ScopedPermissionRuleMatch | undefined {
    this.syncWorkspaceRules();
    return findScopedToolRule(toolName, ruleScopesForList(this.state, list));
  }

  findMcpCapabilityRule(
    serverName: string,
    capability: McpCapabilityName,
    list: PermissionRuleListName,
  ): ScopedPermissionRuleMatch | undefined {
    this.syncWorkspaceRules();
    return findScopedMcpCapabilityRule(serverName, capability, ruleScopesForList(this.state, list));
  }

  private async mutateWorkspaceRules(mutator: (candidate: WorkspacePermissionRuleSet) => void): Promise<void> {
    if (!this.store || !this.activeWorkspacePath) {
      throw this.createError(
        "Workspace permission rule store is not available",
        503,
        "permission_rule_store_unavailable",
      );
    }
    const candidate = await this.store.update(this.activeWorkspacePath, (latest) => {
      mutator(latest);
      return latest;
    });
    replaceWorkspaceRules(this.state, candidate);
  }

  private normalizeRule(rule: PermissionRule): PermissionRule {
    const toolName = String(rule?.toolName || "") as PermissionToolName;
    const ruleContent = String(rule?.ruleContent || "").trim();
    const match = rule?.match === undefined ? undefined : String(rule.match) as PermissionRuleMatch;

    if (!PERMISSION_TOOL_NAMES.has(toolName)) {
      throw this.createError("Invalid permission rule toolName", 400, "invalid_permission_rule");
    }
    if (!ruleContent || ruleContent.length > 1000) {
      throw this.createError("Invalid permission rule content", 400, "invalid_permission_rule");
    }
    if (match !== undefined && !PERMISSION_RULE_MATCHES.has(match)) {
      throw this.createError("Invalid permission rule match mode", 400, "invalid_permission_rule");
    }

    return match === undefined ? { toolName, ruleContent } : { toolName, ruleContent, match };
  }
}

export function eligibleMcpCapability(
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

function rulesForList(
  state: SessionPermissionState,
  list: PermissionRuleListName,
  scope: PermissionRuleScope = "session",
): PermissionRule[] {
  return ruleScopesForList(state, list)[scope];
}

function ruleScopesForList(
  state: SessionPermissionState,
  list: PermissionRuleListName,
): Record<PermissionRuleScope, PermissionRule[]> {
  if (list === "allow") return state.alwaysAllowRules;
  if (list === "deny") return state.alwaysDenyRules;
  return state.alwaysAskRules;
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
): ScopedPermissionRuleMatch | undefined {
  for (const scope of ["session", "workspace"] as const) {
    const rule = findMatchingToolPermissionRule(toolName, rules?.[scope]);
    if (rule) return { rule, scope };
  }
  return undefined;
}

function findScopedMcpCapabilityRule(
  serverName: string,
  capability: McpCapabilityName,
  rules: Partial<Record<PermissionRuleScope, readonly PermissionRule[]>> | undefined,
): ScopedPermissionRuleMatch | undefined {
  for (const scope of ["session", "workspace"] as const) {
    const rule = findMatchingMcpCapabilityPermissionRule(serverName, capability, rules?.[scope]);
    if (rule) return { rule, scope };
  }
  return undefined;
}

function replaceWorkspaceRules(state: SessionPermissionState, rules: WorkspacePermissionRuleSet): void {
  state.alwaysAllowRules.workspace.splice(
    0,
    state.alwaysAllowRules.workspace.length,
    ...rules.alwaysAllowRules.map((rule) => ({ ...rule })),
  );
  state.alwaysDenyRules.workspace.splice(
    0,
    state.alwaysDenyRules.workspace.length,
    ...rules.alwaysDenyRules.map((rule) => ({ ...rule })),
  );
  state.alwaysAskRules.workspace.splice(
    0,
    state.alwaysAskRules.workspace.length,
    ...rules.alwaysAskRules.map((rule) => ({ ...rule })),
  );
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
