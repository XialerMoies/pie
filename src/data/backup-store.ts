import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JsonBackupResult {
  path: string;
  archivePath?: string;
}

export function backupPath(filePath: string): string {
  return `${filePath}.bak`;
}

function archivePath(filePath: string): string {
  return `${backupPath(filePath)}.${Date.now()}.${randomUUID()}`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function createJsonBackup<T>(filePath: string, value: T): Promise<JsonBackupResult> {
  const latest = backupPath(filePath);
  const archive = await exists(latest) ? archivePath(filePath) : undefined;
  await mkdir(dirname(filePath), { recursive: true });
  if (archive) await copyFile(latest, archive);

  const temporary = `${latest}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, latest);
  } finally {
    if (await exists(temporary)) {
      await unlink(temporary);
    }
  }
  return archive ? { path: latest, archivePath: archive } : { path: latest };
}

export async function readJsonBackup<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(backupPath(filePath), "utf8")) as T;
  } catch (error: any) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function restoreJsonBackup(filePath: string): Promise<boolean> {
  const latest = backupPath(filePath);
  if (!(await exists(latest))) return false;
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.restore.tmp`;
  try {
    await copyFile(latest, temporary);
    await rename(temporary, filePath);
    return true;
  } finally {
    if (await exists(temporary)) {
      await unlink(temporary);
    }
  }
}
