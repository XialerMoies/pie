import { existsSync, readFileSync } from "fs";
import type { PermissionAuditEntry, PermissionAuditStore } from "./permission-audit-log.js";
import { updateLockedJson } from "../data/locked-json-store.js";

export type { PermissionAuditStore } from "./permission-audit-log.js";

export class FilePermissionAuditStore implements PermissionAuditStore {
  private readonly maxEntries: number;

  constructor(private readonly filePath: string, options: { maxEntries?: number } = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 2000);
  }

  load(limit: number): PermissionAuditEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isPermissionAuditEntry)
        .slice(-Math.max(1, Math.min(Math.floor(limit), this.maxEntries)));
    } catch {
      return [];
    }
  }

  async append(entry: PermissionAuditEntry): Promise<void> {
    if (!isPermissionAuditEntry(entry)) return;
    await updateLockedJson<unknown>(this.filePath, () => [], (raw) => {
      const existing = Array.isArray(raw) ? raw.filter(isPermissionAuditEntry) : [];
      existing.push({ ...entry });
      return existing.slice(-this.maxEntries);
    }, { recoverInvalidJson: true });
  }

  async clear(): Promise<void> {
    await updateLockedJson<PermissionAuditEntry[]>(this.filePath, () => [], () => [], { recoverInvalidJson: true });
  }
}

function isPermissionAuditEntry(value: unknown): value is PermissionAuditEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Number.isInteger(entry.id) &&
    typeof entry.timestamp === "string" &&
    typeof entry.source === "string" &&
    isOperation(entry.operation) &&
    typeof entry.root === "string" &&
    isDecision(entry.decision) &&
    optionalString(entry.path) &&
    optionalString(entry.relativePath) &&
    optionalString(entry.reason) &&
    optionalString(entry.code) &&
    optionalString(entry.toolName) &&
    optionalToolOperations(entry.toolOperations) &&
    optionalString(entry.riskLevel) &&
    optionalBoolean(entry.workspaceBounded) &&
    optionalBoolean(entry.permissionRequired)
  );
}

function isOperation(value: unknown): boolean {
  return value === "read" || value === "write" || value === "create" || value === "remove" || value === "tool";
}

function isDecision(value: unknown): boolean {
  return value === "allow" || value === "ask" || value === "deny";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalToolOperations(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => (
    item === "read" ||
    item === "write" ||
    item === "create" ||
    item === "remove" ||
    item === "execute"
  ));
}
