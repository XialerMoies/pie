import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock, type FileLockOptions } from "./file-lock.js";
import { createJsonBackup, readJsonBackup } from "./backup-store.js";

export interface LockedJsonStoreOptions {
  lock?: FileLockOptions;
  recoverInvalidJson?: boolean;
  space?: number;
  trailingNewline?: boolean;
}

type JsonFallback<T> = T | (() => T);

function fallbackValue<T>(fallback: JsonFallback<T>): T {
  return typeof fallback === "function" ? (fallback as () => T)() : fallback;
}

async function readJson<T>(
  filePath: string,
  fallback: JsonFallback<T>,
  recoverInvalidJson: boolean,
): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return fallbackValue(fallback);
    }
    if (recoverInvalidJson && error instanceof SyntaxError) {
      const backup = await readJsonBackup<T>(filePath);
      return backup ?? fallbackValue(fallback);
    }
    throw error;
  }
}

export async function readLockedJson<T>(
  filePath: string,
  fallback: JsonFallback<T>,
  options: Pick<LockedJsonStoreOptions, "recoverInvalidJson"> = {},
): Promise<T> {
  return readJson(filePath, fallback, options.recoverInvalidJson === true);
}

export async function updateLockedJson<T>(
  filePath: string,
  fallback: JsonFallback<T>,
  updater: (current: T) => T | Promise<T>,
  options: LockedJsonStoreOptions = {},
): Promise<T> {
  return withFileLock(`${filePath}.lock`, options.lock, async () => {
    const current = await readJson(filePath, fallback, options.recoverInvalidJson === true);
    const updated = await updater(current);
    const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

    await mkdir(dirname(filePath), { recursive: true });
    try {
      const serialized = JSON.stringify(updated, null, options.space ?? 2);
      await writeFile(temporaryPath, options.trailingNewline === false ? serialized : `${serialized}\n`, "utf8");
      await rename(temporaryPath, filePath);
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    await createJsonBackup(filePath, updated);
    return updated;
  });
}
