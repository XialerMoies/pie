import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

export interface DataRootChangeResult {
  dataRoot: string;
  currentDataRoot: string;
  restartRequired: boolean;
  moved: false;
}

function comparablePath(value: string): string {
  const normalized = normalize(resolve(value));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function validateDataRoot(dataRoot: unknown): string {
  if (typeof dataRoot !== "string" || !dataRoot.trim() || dataRoot.includes("\0")) {
    throw new Error("dataRoot must be an absolute path");
  }
  if (!isAbsolute(dataRoot)) {
    throw new Error("dataRoot must be an absolute path");
  }

  const candidate = resolve(dataRoot);
  try {
    if (!statSync(candidate).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("dataRoot must be an existing directory");
  }

  return candidate;
}

export function readDataRootPointer(pointerFile: string, fallback: string): string {
  const fallbackRoot = resolve(fallback);
  if (!existsSync(pointerFile)) return fallbackRoot;

  try {
    const parsed: unknown = JSON.parse(readFileSync(pointerFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { dataRoot?: unknown }).dataRoot !== "string") {
      return fallbackRoot;
    }
    return validateDataRoot((parsed as { dataRoot: string }).dataRoot);
  } catch {
    return fallbackRoot;
  }
}

export function writeDataRootPointer(
  pointerFile: string,
  selectedRoot: unknown,
  currentDataRoot: string,
): DataRootChangeResult {
  const dataRoot = validateDataRoot(selectedRoot);
  const currentRoot = resolve(currentDataRoot);
  mkdirSync(dirname(pointerFile), { recursive: true });

  const temporaryFile = `${pointerFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFile, JSON.stringify({ dataRoot }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    renameSync(temporaryFile, pointerFile);
  } finally {
    try {
      if (existsSync(temporaryFile)) {
        // A failed rename must not leave bootstrap artifacts behind.
        unlinkSync(temporaryFile);
      }
    } catch {}
  }

  return {
    dataRoot,
    currentDataRoot: currentRoot,
    restartRequired: comparablePath(dataRoot) !== comparablePath(currentRoot),
    moved: false,
  };
}
