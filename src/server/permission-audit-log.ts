import type {
  McpToolCapabilityDeclaration,
  ToolAuthorizationMode,
  ToolOperation,
  ToolRiskLevel,
} from "../agent/types.js";
import type {
  PathPermissionDecision,
  PathPermissionOperation,
} from "../agent/permissions.js";

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
export type PendingPermissionAuditEntry = Omit<PermissionAuditEntry, "id" | "timestamp">;

export interface PermissionAuditStore {
  load(limit: number): PermissionAuditEntry[];
  append(entry: PermissionAuditEntry): Promise<void>;
  clear(): Promise<void>;
}

export interface PermissionAuditLogOptions {
  store?: PermissionAuditStore;
  maxEntries?: number;
}

export class PermissionAuditLog {
  private readonly store?: PermissionAuditStore;
  private readonly maxEntries: number;
  private sequence = 0;
  private entries: PermissionAuditEntry[] = [];
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: PermissionAuditLogOptions = {}) {
    this.store = options.store;
    this.maxEntries = options.maxEntries ?? 500;
    this.loadPersistedEntries();
  }

  record(entry: PendingPermissionAuditEntry): void {
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
      id: ++this.sequence,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(nextEntry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    if (this.store) {
      const persistedEntry = { ...nextEntry };
      this.writeQueue = this.writeQueue
        .then(() => this.store!.append(persistedEntry))
        .catch(() => {});
    }
  }

  getTrail(limit = 100): PermissionAuditEntry[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.floor(limit), this.maxEntries))
      : 100;
    return this.entries.slice(-normalizedLimit);
  }

  async flushWrites(): Promise<void> {
    await this.writeQueue;
  }

  async clear(): Promise<void> {
    this.entries = [];
    if (!this.store) return;
    this.writeQueue = this.writeQueue.then(() => this.store!.clear()).catch(() => {});
    await this.writeQueue;
  }

  private loadPersistedEntries(): void {
    if (!this.store) return;
    try {
      this.entries = this.store.load(this.maxEntries);
      this.sequence = this.entries.reduce((max, entry) => Math.max(max, entry.id), 0);
    } catch {
      this.entries = [];
      this.sequence = 0;
    }
  }
}
