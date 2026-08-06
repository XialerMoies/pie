import { existsSync, readFileSync } from "node:fs";
import { normalizePermissionPath } from "../agent/permissions.js";
import type { PermissionRule, PermissionRuleMatch, PermissionToolName } from "../agent/types.js";
import { updateLockedJson } from "../data/locked-json-store.js";

export interface WorkspacePermissionRuleSet {
  alwaysAllowRules: PermissionRule[];
  alwaysDenyRules: PermissionRule[];
  alwaysAskRules: PermissionRule[];
}

export interface WorkspacePermissionRuleStore {
  load(workspacePath: string): WorkspacePermissionRuleSet;
  save(workspacePath: string, rules: WorkspacePermissionRuleSet): Promise<void>;
  update(
    workspacePath: string,
    updater: (rules: WorkspacePermissionRuleSet) => WorkspacePermissionRuleSet | void,
  ): Promise<WorkspacePermissionRuleSet>;
}

interface WorkspacePermissionRuleEntry extends WorkspacePermissionRuleSet {
  workspacePath: string;
}

interface WorkspacePermissionRuleDocument {
  version: 1;
  workspaces: Record<string, WorkspacePermissionRuleEntry>;
}

const TOOL_NAMES = new Set<PermissionToolName>(["Read", "Write", "Create", "Remove", "Command", "Tool", "McpCapability"]);
const MATCH_MODES = new Set<PermissionRuleMatch>(["exact", "prefix", "wildcard"]);

export class FileWorkspacePermissionRuleStore implements WorkspacePermissionRuleStore {
  constructor(private readonly filePath: string) {}

  load(workspacePath: string): WorkspacePermissionRuleSet {
    const document = this.readDocument();
    const key = normalizePermissionPath(workspacePath);
    const direct = document.workspaces[key];
    const entry = direct || Object.values(document.workspaces).find((candidate) => (
      normalizePermissionPath(candidate.workspacePath) === key
    ));
    return entry ? cloneRuleSet(entry) : emptyRuleSet();
  }

  async save(workspacePath: string, rules: WorkspacePermissionRuleSet): Promise<void> {
    await this.update(workspacePath, () => sanitizeRuleSet(rules));
  }

  async update(
    workspacePath: string,
    updater: (rules: WorkspacePermissionRuleSet) => WorkspacePermissionRuleSet | void,
  ): Promise<WorkspacePermissionRuleSet> {
    const resolvedWorkspace = normalizePermissionPath(workspacePath);
    let updatedRules = emptyRuleSet();
    await updateLockedJson<unknown>(this.filePath, emptyDocument, (raw) => {
      const document = normalizeDocument(raw);
      const existingKey = document.workspaces[resolvedWorkspace]
        ? resolvedWorkspace
        : Object.keys(document.workspaces).find((key) => (
          normalizePermissionPath(document.workspaces[key].workspacePath) === resolvedWorkspace
        ));
      const existing = existingKey ? document.workspaces[existingKey] : undefined;
      const candidate = existing ? cloneRuleSet(existing) : emptyRuleSet();
      updatedRules = sanitizeRuleSet(updater(candidate) || candidate);
      if (existingKey && existingKey !== resolvedWorkspace) delete document.workspaces[existingKey];
      document.workspaces[resolvedWorkspace] = {
        workspacePath,
        ...updatedRules,
      };
      return document;
    }, { recoverInvalidJson: true });
    return cloneRuleSet(updatedRules);
  }

  private readDocument(): WorkspacePermissionRuleDocument {
    if (!existsSync(this.filePath)) return emptyDocument();
    try {
      return normalizeDocument(JSON.parse(readFileSync(this.filePath, "utf-8")));
    } catch {
      return emptyDocument();
    }
  }
}

function normalizeDocument(parsed: unknown): WorkspacePermissionRuleDocument {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyDocument();
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || !raw.workspaces || typeof raw.workspaces !== "object" || Array.isArray(raw.workspaces)) {
    return emptyDocument();
  }

  const workspaces: Record<string, WorkspacePermissionRuleEntry> = {};
  for (const [key, value] of Object.entries(raw.workspaces as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.workspacePath !== "string" || !entry.workspacePath.trim()) continue;
    workspaces[key] = {
      workspacePath: entry.workspacePath,
      ...sanitizeRuleSet(entry),
    };
  }
  return { version: 1, workspaces };
}

function emptyDocument(): WorkspacePermissionRuleDocument {
  return { version: 1, workspaces: {} };
}

export function emptyWorkspacePermissionRuleSet(): WorkspacePermissionRuleSet {
  return emptyRuleSet();
}

function emptyRuleSet(): WorkspacePermissionRuleSet {
  return { alwaysAllowRules: [], alwaysDenyRules: [], alwaysAskRules: [] };
}

function sanitizeRuleSet(value: Partial<Record<keyof WorkspacePermissionRuleSet, unknown>>): WorkspacePermissionRuleSet {
  return {
    alwaysAllowRules: sanitizeRules(value.alwaysAllowRules),
    alwaysDenyRules: sanitizeRules(value.alwaysDenyRules),
    alwaysAskRules: sanitizeRules(value.alwaysAskRules),
  };
}

function sanitizeRules(value: unknown): PermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPermissionRule).map((rule) => ({ ...rule }));
}

function cloneRuleSet(value: WorkspacePermissionRuleSet): WorkspacePermissionRuleSet {
  return {
    alwaysAllowRules: value.alwaysAllowRules.map((rule) => ({ ...rule })),
    alwaysDenyRules: value.alwaysDenyRules.map((rule) => ({ ...rule })),
    alwaysAskRules: value.alwaysAskRules.map((rule) => ({ ...rule })),
  };
}

function isPermissionRule(value: unknown): value is PermissionRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  return (
    typeof rule.toolName === "string" &&
    TOOL_NAMES.has(rule.toolName as PermissionToolName) &&
    typeof rule.ruleContent === "string" &&
    rule.ruleContent.trim().length > 0 &&
    rule.ruleContent.length <= 1000 &&
    (rule.match === undefined || (
      typeof rule.match === "string" && MATCH_MODES.has(rule.match as PermissionRuleMatch)
    ))
  );
}
