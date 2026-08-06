import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { canonicalWorkspacePath, resolveDataLayout } from "../data/data-layout.js";
import { PathGuardError } from "./routes/path-guard.js";

export interface WorkspaceLockOwner {
  workspace: string;
  pid: number;
  instanceId: string;
  port: number;
  startedAt: number;
  lockId: string;
}

export interface AcquireWorkspaceLockOptions {
  dataRoot: string;
  workspace: string;
  instanceId: string;
  port?: number;
  pid?: number;
  startedAt?: number;
}

export interface WorkspaceLockLease {
  lockPath: string;
  owner: WorkspaceLockOwner;
  updatePort(port: number): Promise<void>;
  release(): Promise<void>;
}

export type WorkspaceLockOwnerDetails = Omit<WorkspaceLockOwner, "lockId">;

function ownerDetails(owner: WorkspaceLockOwner): WorkspaceLockOwnerDetails {
  const { lockId: _lockId, ...details } = owner;
  return details;
}

export class WorkspaceLockConflictError extends PathGuardError {

  constructor(
    readonly lockPath: string,
    owner: WorkspaceLockOwner,
  ) {
    super(
      `Workspace is already open by ${owner.instanceId} (PID ${owner.pid}, port ${owner.port || "pending"})`,
      409,
      "workspace_locked",
    );
    this.name = "WorkspaceLockConflictError";
    this.owner = ownerDetails(owner);
  }

  readonly owner: WorkspaceLockOwnerDetails;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function parseWorkspaceLockOwner(value: unknown): WorkspaceLockOwner | null {
  if (!value || typeof value !== "object") return null;
  const owner = value as Partial<WorkspaceLockOwner>;
  const valid = typeof owner.workspace === "string"
    && Number.isInteger(owner.pid)
    && typeof owner.instanceId === "string"
    && Number.isInteger(owner.port)
    && Number.isFinite(owner.startedAt);
  if (!valid) return null;
  return {
    workspace: owner.workspace!,
    pid: owner.pid!,
    instanceId: owner.instanceId!,
    port: owner.port!,
    startedAt: owner.startedAt!,
    lockId: typeof owner.lockId === "string"
      ? owner.lockId
      : `legacy:${owner.pid}:${owner.startedAt}:${owner.instanceId}`,
  };
}

async function readOwner(lockPath: string): Promise<WorkspaceLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    return parseWorkspaceLockOwner(parsed);
  } catch {
    return null;
  }
}

async function removeDeadOwner(lockPath: string, expected: WorkspaceLockOwner | null): Promise<boolean> {
  const current = await readOwner(lockPath);
  if (expected && current?.lockId !== expected.lockId) return false;
  if (current && processIsAlive(current.pid)) return false;

  if (!current) {
    try {
      const details = await stat(lockPath);
      if (Date.now() - details.mtimeMs < 30_000) return false;
    } catch (error: any) {
      return error?.code === "ENOENT";
    }
  }

  try {
    await unlink(lockPath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
}

function unknownOwner(workspace: string): WorkspaceLockOwner {
  return {
    workspace,
    pid: -1,
    instanceId: "unknown",
    port: 0,
    startedAt: 0,
    lockId: "unknown",
  };
}

export async function acquireWorkspaceLock(options: AcquireWorkspaceLockOptions): Promise<WorkspaceLockLease> {
  const workspace = canonicalWorkspacePath(options.workspace);
  const layout = resolveDataLayout({
    dataRoot: options.dataRoot,
    workspace,
    instanceId: options.instanceId,
  });
  const lockPath = layout.workspaceLockFile;
  const owner: WorkspaceLockOwner = {
    workspace,
    pid: options.pid ?? process.pid,
    instanceId: options.instanceId,
    port: options.port ?? 0,
    startedAt: options.startedAt ?? Date.now(),
    lockId: randomUUID(),
  };

  await mkdir(layout.workspaceRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify(owner, null, 2));
        await handle.sync();
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        lockPath,
        owner,
        async updatePort(port: number): Promise<void> {
          if (released) throw new Error("Workspace lock has already been released");
          if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port is invalid");
          const current = await readOwner(lockPath);
          if (current?.lockId !== owner.lockId) throw new Error("Workspace lock ownership was lost");
          owner.port = port;
          await writeFile(lockPath, JSON.stringify(owner, null, 2));
        },
        async release(): Promise<void> {
          if (released) return;
          const current = await readOwner(lockPath);
          if (current?.lockId !== owner.lockId) {
            released = true;
            return;
          }
          try {
            await unlink(lockPath);
          } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
          }
          released = true;
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readOwner(lockPath);
      if (existing && !processIsAlive(existing.pid) && await removeDeadOwner(lockPath, existing)) continue;
      if (!existing && await removeDeadOwner(lockPath, null)) continue;
      throw new WorkspaceLockConflictError(lockPath, existing ?? unknownOwner(workspace));
    }
  }

  throw new Error(`Failed to acquire workspace lock: ${lockPath}`);
}

export interface WorkspaceLockCoordinatorOptions {
  dataRoot: string;
  instanceId: string;
  pid?: number;
  startedAt?: number;
}

export class WorkspaceLockCoordinator {
  private lease: WorkspaceLockLease | null = null;
  private port = 0;

  constructor(private readonly options: WorkspaceLockCoordinatorOptions) {}

  get owner(): WorkspaceLockOwner | null {
    return this.lease ? { ...this.lease.owner } : null;
  }

  async acquireInitial(workspace: string): Promise<void> {
    if (this.lease) throw new Error("Initial workspace lock is already acquired");
    this.lease = await this.acquire(workspace);
  }

  async initialize<T>(workspace: string, initialize: () => T | Promise<T>): Promise<T> {
    await this.acquireInitial(workspace);
    try {
      return await initialize();
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  async switchTo<T>(workspace: string, operation: () => T | Promise<T>): Promise<T> {
    const target = canonicalWorkspacePath(workspace);
    if (this.lease?.owner.workspace === target) return operation();

    const next = await this.acquire(target);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      await next.release();
      throw error;
    }

    const previous = this.lease;
    this.lease = next;
    try {
      await previous?.release();
    } catch (error) {
      console.error("Failed to release previous workspace lock:", error);
    }
    return result;
  }

  async updatePort(port: number): Promise<void> {
    this.port = port;
    await this.lease?.updatePort(port);
  }

  async release(): Promise<void> {
    const current = this.lease;
    if (!current) return;
    await current.release();
    if (this.lease === current) this.lease = null;
  }

  private acquire(workspace: string): Promise<WorkspaceLockLease> {
    return acquireWorkspaceLock({
      ...this.options,
      workspace,
      port: this.port,
    });
  }
}
