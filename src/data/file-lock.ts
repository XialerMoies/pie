import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface FileLockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
  instanceId?: string;
}

interface LockMetadata {
  pid: number;
  instanceId?: string;
  createdAt: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_MS = 25;
const DEFAULT_STALE_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function removeStaleLock(lockPath: string, staleMs: number): Promise<void> {
  let raw: string;
  let modifiedAt: number;
  try {
    const [contents, details] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    raw = contents;
    modifiedAt = details.mtimeMs;
  } catch (error: any) {
    if (error?.code !== "ENOENT") return;
    return;
  }

  let metadata: LockMetadata | undefined;
  try {
    const candidate = JSON.parse(raw) as Partial<LockMetadata>;
    if (Number.isInteger(candidate.pid) && candidate.pid! > 0 && Number.isFinite(candidate.createdAt)) {
      metadata = candidate as LockMetadata;
    }
  } catch {
    // Incomplete lock metadata is only stale by age; it may still be mid-write.
  }

  const staleByAge = Date.now() - (metadata?.createdAt ?? modifiedAt) > staleMs;
  const shouldRemove = metadata ? !processIsAlive(metadata.pid) : staleByAge;
  if (shouldRemove) {
    try { await unlink(lockPath); } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

async function acquireLock(lockPath: string, options: Required<Pick<FileLockOptions, "timeoutMs" | "retryMs" | "staleMs">> & Pick<FileLockOptions, "instanceId">): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + options.timeoutMs;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          instanceId: options.instanceId,
          createdAt: Date.now(),
        } satisfies LockMetadata));
      } catch (error) {
        try {
          await handle.close();
        } finally {
          try { await unlink(lockPath); } catch (unlinkError: any) {
            if (unlinkError?.code !== "ENOENT") throw unlinkError;
          }
        }
        throw error;
      }

      return async () => {
        try { await handle.close(); } finally {
          try { await unlink(lockPath); } catch (error: any) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      await removeStaleLock(lockPath, options.staleMs);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring lock: ${lockPath}`);
      }
      await sleep(Math.min(options.retryMs, Math.max(1, deadline - Date.now())));
    }
  }
}

export async function withFileLock<T>(
  lockPath: string,
  options: FileLockOptions = {},
  callback: () => T | Promise<T>,
): Promise<T> {
  const release = await acquireLock(lockPath, {
    timeoutMs: Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    retryMs: Math.max(1, options.retryMs ?? DEFAULT_RETRY_MS),
    staleMs: Math.max(1, options.staleMs ?? DEFAULT_STALE_MS),
    instanceId: options.instanceId,
  });

  try {
    return await callback();
  } finally {
    await release();
  }
}
