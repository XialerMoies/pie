import { existsSync, realpathSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import type { ServerResponse } from "http";
import { createPermissionFailure, type PermissionFailureContext } from "../permission-failure.js";

export type PathGuardOperation = "read" | "write" | "create" | "remove";

export interface GuardedPath {
  operation: PathGuardOperation;
  root: string;
  path: string;
  relativePath: string;
}

export class PathGuardError extends Error {
  statusCode: number;
  code: string;
  failureContext: PermissionFailureContext;

  constructor(message: string, statusCode = 403, code = "access_denied", failureContext: PermissionFailureContext = {}) {
    super(message);
    this.name = "PathGuardError";
    this.statusCode = statusCode;
    this.code = code;
    this.failureContext = failureContext;
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function realpathIfExists(p: string): string | null {
  if (!existsSync(p)) return null;
  return realpathSync(p);
}

function resolveThroughExistingSegments(rootReal: string, relativeTarget: string): string {
  if (!relativeTarget) return rootReal;
  const segments = relativeTarget.split(/[\\/]+/).filter(Boolean);
  let current = rootReal;

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new PathGuardError("Access denied");
    }

    const candidate = resolve(current, segment);
    current = realpathIfExists(candidate) ?? candidate;
  }

  return current;
}

export function guardPathWithinRoot(
  root: string,
  target = "",
  operation: PathGuardOperation = "read",
): GuardedPath {
  const rootText = String(root ?? "").trim();
  if (!rootText) {
    throw new PathGuardError("Missing root", 400, "missing_root", { operation, target });
  }

  const rootResolved = resolve(rootText);
  const rootReal = realpathIfExists(rootResolved);
  if (!rootReal) {
    throw new PathGuardError("Root not found", 404, "root_not_found", { operation, target, workspaceRoot: rootResolved });
  }

  const targetResolved = resolve(rootResolved, String(target ?? ""));
  if (!isInside(rootResolved, targetResolved)) {
    throw new PathGuardError("Access denied", 403, "access_denied", {
      operation,
      target: targetResolved,
      workspaceRoot: rootResolved,
    });
  }

  const relativeTarget = relative(rootResolved, targetResolved);
  const guardedPath = resolveThroughExistingSegments(rootReal, relativeTarget);
  if (!isInside(rootReal, guardedPath)) {
    throw new PathGuardError("Access denied", 403, "access_denied", {
      operation,
      target: guardedPath,
      workspaceRoot: rootReal,
    });
  }

  return {
    operation,
    root: rootReal,
    path: guardedPath,
    relativePath: relative(rootReal, guardedPath).replace(/\\/g, "/"),
  };
}

export function isPathGuardError(error: unknown): error is PathGuardError {
  return error instanceof PathGuardError;
}

export function writePathGuardError(
  res: ServerResponse,
  headers: Record<string, string>,
  error: unknown,
): boolean {
  if (!isPathGuardError(error)) return false;
  res.writeHead(error.statusCode, { "Content-Type": "application/json", ...headers });
  const owner = (error as PathGuardError & { owner?: unknown }).owner;
  res.end(JSON.stringify({
    error: error.message,
    code: error.code,
    failure: createPermissionFailure(error.code, error.message, error.failureContext),
    ...(owner ? { owner } : {}),
  }));
  return true;
}
