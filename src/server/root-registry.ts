import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isPathInside, normalizePermissionPath, type PathPermissionOperation } from "../agent/permissions.js";

export type RootSource = "workspace" | "user-selected" | "app-data" | "session" | "attachment";

export interface RootRegistration {
  source: RootSource;
  operations: readonly PathPermissionOperation[];
}

export interface RegisteredRoot {
  path: string;
  source: RootSource;
  operations: readonly PathPermissionOperation[];
}

function canonicalDirectory(root: string): string {
  const text = String(root ?? "").trim();
  const resolved = path.resolve(text);
  if (!text || !existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error("Root must be an existing directory");
  }
  return realpathSync(resolved);
}

export class RootRegistry {
  private readonly roots = new Map<string, RegisteredRoot>();

  register(root: string, registration: RootRegistration): RegisteredRoot {
    const canonical = canonicalDirectory(root);
    const record: RegisteredRoot = {
      path: canonical,
      source: registration.source,
      operations: [...new Set(registration.operations)],
    };
    this.roots.set(normalizePermissionPath(canonical), record);
    return record;
  }

  setWorkspaceRoot(root: string): RegisteredRoot {
    for (const [key, record] of this.roots) {
      if (record.source === "workspace") this.roots.delete(key);
    }
    return this.register(root, {
      source: "workspace",
      operations: ["read", "write", "create", "remove"],
    });
  }

  unregister(root: string): boolean {
    const text = String(root ?? "").trim();
    if (!text) return false;
    const resolved = path.resolve(text);
    const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
    return this.roots.delete(normalizePermissionPath(canonical));
  }

  resolveRegisteredRoot(root: string): RegisteredRoot | undefined {
    const text = String(root ?? "").trim();
    if (!text) return undefined;
    const resolved = path.resolve(text);
    const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
    return this.roots.get(normalizePermissionPath(canonical));
  }

  findRootForPath(target: string): RegisteredRoot | undefined {
    const text = String(target ?? "").trim();
    if (!text) return undefined;
    const resolved = path.resolve(text);
    const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
    return [...this.roots.values()]
      .filter((record) => isPathInside(canonical, record.path))
      .sort((left, right) => right.path.length - left.path.length)[0];
  }

  allows(root: string, operation: PathPermissionOperation): boolean {
    return this.resolveRegisteredRoot(root)?.operations.includes(operation) === true;
  }

  getRootPaths(): string[] {
    return [...this.roots.values()].map((record) => record.path);
  }

  getRoots(): RegisteredRoot[] {
    return [...this.roots.values()].map((record) => ({
      ...record,
      operations: [...record.operations],
    }));
  }
}
