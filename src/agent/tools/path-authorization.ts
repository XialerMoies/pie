import { existsSync, realpathSync } from "fs"
import { isAbsolute, relative, resolve } from "path"
import type { ToolContext, ToolPathOperation } from "../types.js"

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))
}

function realpathIfExists(path: string): string | null {
  if (!existsSync(path)) return null
  return realpathSync(path)
}

function resolveThroughExistingSegments(rootReal: string, relativeTarget: string): string {
  if (!relativeTarget) return rootReal
  const segments = relativeTarget.split(/[\\/]+/).filter(Boolean)
  let current = rootReal

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error("Access denied")
    }

    const candidate = resolve(current, segment)
    current = realpathIfExists(candidate) ?? candidate
  }

  return current
}

export function guardToolPath(root: string, target = ""): string {
  const rootText = String(root ?? "").trim()
  if (!rootText) throw new Error("Missing workspace root")

  const rootResolved = resolve(rootText)
  const rootReal = realpathIfExists(rootResolved) ?? rootResolved
  const targetResolved = resolve(rootResolved, String(target ?? ""))
  if (!isInside(rootResolved, targetResolved)) {
    throw new Error(`Access denied: "${target}" is outside workspace`)
  }

  const guardedPath = resolveThroughExistingSegments(rootReal, relative(rootResolved, targetResolved))
  if (!isInside(rootReal, guardedPath)) {
    throw new Error(`Access denied: "${target}" is outside workspace`)
  }

  return guardedPath
}

export async function authorizeToolPath(
  ctx: ToolContext | undefined,
  root: string,
  target: string,
  operation: ToolPathOperation,
  source: string,
): Promise<string> {
  const guardedPath = guardToolPath(root, target)
  if (!ctx?.authorizePath) return guardedPath
  const authorized = await ctx.authorizePath(root, guardedPath, operation, source)
  return guardToolPath(root, authorized.path)
}
