import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { PermissionAuditEntry } from "./permission-service";

export interface PermissionAuditStore {
  load(limit: number): PermissionAuditEntry[];
  save(entries: readonly PermissionAuditEntry[]): void;
  clear(): void;
}

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

  save(entries: readonly PermissionAuditEntry[]): void {
    const recent = entries.filter(isPermissionAuditEntry).slice(-this.maxEntries);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(recent, null, 2)}\n`);
    renameSync(tmp, this.filePath);
  }

  clear(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, "[]\n");
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
    optionalString(entry.code)
  );
}

function isOperation(value: unknown): boolean {
  return value === "read" || value === "write" || value === "create" || value === "remove";
}

function isDecision(value: unknown): boolean {
  return value === "allow" || value === "ask" || value === "deny";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}
