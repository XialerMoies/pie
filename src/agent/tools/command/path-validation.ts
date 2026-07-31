import os from "os"
import path from "path"
import { existsSync, statSync } from "fs"
import { parseShellCommand, tokensWithoutRedirects, type ShellSegment } from "./shell-parser.js"
import { parseCommandForSecurity } from "./security-parser.js"
import type { SecurityParseResult, SecurityRedirect, ShellDialect, SimpleCommand } from "./security-ast.js"
import {
  createPathPermissionSuggestions,
  findMatchingPathPermissionRule,
  pathPermissionToolForOperation,
  pathRuleContentForDirectory as sharedPathRuleContentForDirectory,
} from "../../permissions.js"
import { isSensitiveExternalPath } from "../../sensitive-paths.js"
import type { AdditionalWorkingDirectory, PathPermissionToolName, PermissionRule, PermissionSuggestion } from "../../types.js"

type PathOperation = "read" | "write" | "create" | "remove"

interface PathValidationFailureMeta {
  operation?: PathOperation
  blockedPath?: string
  suggestions?: PermissionSuggestion[]
}

export type PathValidationResult =
  | { allowed: true }
  | ({ allowed: false; reason: string; requiresConfirmation: true; hardDeny?: false } & PathValidationFailureMeta)
  | ({ allowed: false; reason: string; requiresConfirmation: false; hardDeny: true } & PathValidationFailureMeta)

export interface PathValidationOptions {
  cwd: string
  workspaceRoot?: string
  shellDialect?: ShellDialect
  parsed?: SecurityParseResult
  additionalWorkingDirectories?: ReadonlyMap<string, AdditionalWorkingDirectory>
  alwaysAllowRules?: Record<"session", PermissionRule[]>
  alwaysDenyRules?: Record<"session", PermissionRule[]>
  alwaysAskRules?: Record<"session", PermissionRule[]>
}

type PathCommand =
  | "cd"
  | "pushd"
  | "ls"
  | "dir"
  | "find"
  | "findstr"
  | "cat"
  | "type"
  | "head"
  | "tail"
  | "more"
  | "sort"
  | "uniq"
  | "wc"
  | "cut"
  | "paste"
  | "column"
  | "tr"
  | "file"
  | "stat"
  | "diff"
  | "fc"
  | "awk"
  | "strings"
  | "hexdump"
  | "od"
  | "base64"
  | "nl"
  | "grep"
  | "rg"
  | "sed"
  | "jq"
  | "git"
  | "tar"
  | "touch"
  | "mkdir"
  | "new-item"
  | "cp"
  | "copy"
  | "mv"
  | "move"
  | "rm"
  | "rmdir"
  | "del"
  | "erase"
  | "rd"
  | "remove-item"
  | "set-content"
  | "add-content"
  | "out-file"

interface CommandPathArg {
  token: string
  operation: PathOperation
  source?: string
}

interface PathExtractorContext {
  shellDialect?: ShellDialect
}

type PathExtractor = (args: string[], command: PathCommand, context: PathExtractorContext) => CommandPathArg[]

const PATH_COMMANDS = new Set<PathCommand>([
  "cd",
  "pushd",
  "ls",
  "dir",
  "find",
  "findstr",
  "cat",
  "type",
  "head",
  "tail",
  "more",
  "sort",
  "uniq",
  "wc",
  "cut",
  "paste",
  "column",
  "tr",
  "file",
  "stat",
  "diff",
  "fc",
  "awk",
  "strings",
  "hexdump",
  "od",
  "base64",
  "nl",
  "grep",
  "rg",
  "sed",
  "jq",
  "git",
  "tar",
  "touch",
  "mkdir",
  "new-item",
  "cp",
  "copy",
  "mv",
  "move",
  "rm",
  "rmdir",
  "del",
  "erase",
  "rd",
  "remove-item",
  "set-content",
  "add-content",
  "out-file",
])

const DEFAULT_OPERATION: Record<PathCommand, PathOperation> = {
  cd: "read",
  pushd: "read",
  ls: "read",
  dir: "read",
  find: "read",
  findstr: "read",
  cat: "read",
  type: "read",
  head: "read",
  tail: "read",
  more: "read",
  sort: "read",
  uniq: "read",
  wc: "read",
  cut: "read",
  paste: "read",
  column: "read",
  tr: "read",
  file: "read",
  stat: "read",
  diff: "read",
  fc: "read",
  awk: "read",
  strings: "read",
  hexdump: "read",
  od: "read",
  base64: "read",
  nl: "read",
  grep: "read",
  rg: "read",
  sed: "read",
  jq: "read",
  git: "read",
  tar: "read",
  touch: "create",
  mkdir: "create",
  "new-item": "create",
  cp: "write",
  copy: "write",
  mv: "write",
  move: "write",
  rm: "remove",
  rmdir: "remove",
  del: "remove",
  erase: "remove",
  rd: "remove",
  "remove-item": "remove",
  "set-content": "write",
  "add-content": "write",
  "out-file": "write",
}

const COMMON_VALUE_FLAGS = new Set([
  "-b",
  "-c",
  "-d",
  "-f",
  "-F",
  "-m",
  "-n",
  "-o",
  "-s",
  "-t",
  "-w",
  "--block-size",
  "--bytes",
  "--context",
  "--format",
  "--lines",
  "--max-count",
  "--output",
  "--skip-bytes",
  "--tabs",
  "--width",
])

const GREP_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-D",
  "-d",
  "-e",
  "-f",
  "-m",
  "--after-context",
  "--before-context",
  "--binary-files",
  "--context",
  "--devices",
  "--directories",
  "--exclude",
  "--exclude-dir",
  "--exclude-from",
  "--file",
  "--include",
  "--label",
  "--max-count",
  "--regexp",
])

const RG_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-e",
  "-f",
  "-g",
  "-m",
  "-t",
  "-T",
  "--after-context",
  "--before-context",
  "--context",
  "--engine",
  "--field-context-separator",
  "--field-match-separator",
  "--file",
  "--glob",
  "--glob-case-insensitive",
  "--iglob",
  "--max-count",
  "--max-depth",
  "--max-filesize",
  "--path-separator",
  "--regexp",
  "--sort",
  "--sortr",
  "--type",
  "--type-add",
  "--type-clear",
  "--type-not",
])

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value)
  const normalized = path.normalize(resolved)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isInsidePath(candidate: string, root: string): boolean {
  const child = normalizeForCompare(candidate)
  const parent = normalizeForCompare(root)
  if (child === parent) return true
  const rel = path.relative(parent, child)
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel)
}

interface PathValidationScope {
  workspaceRoot: string
  allowedWorkingRoots: string[]
  alwaysAllowRules?: Record<"session", PermissionRule[]>
  alwaysDenyRules?: Record<"session", PermissionRule[]>
  alwaysAskRules?: Record<"session", PermissionRule[]>
}

function addUniquePath(paths: string[], seen: Set<string>, value: string): void {
  const resolved = path.resolve(value)
  const key = normalizeForCompare(resolved)
  if (seen.has(key)) return
  seen.add(key)
  paths.push(resolved)
}

function buildValidationScope(workspaceRoot: string, options: PathValidationOptions): PathValidationScope {
  const allowedWorkingRoots: string[] = []
  const seen = new Set<string>()
  addUniquePath(allowedWorkingRoots, seen, workspaceRoot)

  for (const directory of options.additionalWorkingDirectories?.values() ?? []) {
    if (directory.path) addUniquePath(allowedWorkingRoots, seen, directory.path)
  }

  return {
    workspaceRoot,
    allowedWorkingRoots,
    alwaysAllowRules: options.alwaysAllowRules,
    alwaysDenyRules: options.alwaysDenyRules,
    alwaysAskRules: options.alwaysAskRules,
  }
}

function isInsideAnyPath(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInsidePath(candidate, root))
}

function operationLabel(operation: PathOperation): string {
  if (operation === "read") return "读取"
  if (operation === "create") return "创建"
  if (operation === "remove") return "删除"
  return "写入"
}

function fail(reason: string, hardDeny = false, meta: PathValidationFailureMeta = {}): PathValidationResult {
  if (hardDeny) return { allowed: false, reason, requiresConfirmation: false, hardDeny: true, ...meta }
  return { allowed: false, reason, requiresConfirmation: true, ...meta }
}

function shouldHardDeny(operation: PathOperation): boolean {
  return operation === "write" || operation === "create" || operation === "remove"
}

const PATH_PERMISSION_TOOLS = new Set<PathPermissionToolName>(["Read", "Write", "Create", "Remove"])

function permissionToolForOperation(operation: PathOperation): PathPermissionToolName {
  return pathPermissionToolForOperation(operation)
}

function pathRuleContentForDirectory(directory: string, operation: PathOperation): string {
  return sharedPathRuleContentForDirectory(directory, operation)
}

function stripPathRuleWrapper(ruleContent: string, toolName: PathPermissionToolName): string {
  const trimmed = ruleContent.trim()
  const prefix = `${toolName}(`
  if (trimmed.startsWith(prefix) && trimmed.endsWith(")")) {
    return trimmed.slice(prefix.length, -1)
  }
  return trimmed
}

function pathRulePattern(rule: PermissionRule, operation: PathOperation): string | undefined {
  const toolName = rule.toolName as PathPermissionToolName
  if (!PATH_PERMISSION_TOOLS.has(toolName)) return undefined
  if (toolName !== permissionToolForOperation(operation)) return undefined

  const content = stripSurroundingQuotes(stripPathRuleWrapper(rule.ruleContent, toolName))
  return content ? content : undefined
}

function normalizeRulePath(value: string): string {
  const normalized = path.normalize(path.resolve(value)).replace(/[\\/]+/g, "/").replace(/\/$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
}

function wildcardPathMatches(resolvedPath: string, pattern: string): boolean {
  const normalizedPattern = normalizeRulePath(pattern)
  const normalizedPath = normalizeRulePath(resolvedPath)
  const recursiveRoot = normalizedPattern.replace(/\/\*\*$/, "")
  if (recursiveRoot !== normalizedPattern) {
    return normalizedPath === recursiveRoot || normalizedPath.startsWith(`${recursiveRoot}/`)
  }

  let regex = ""
  for (let i = 0; i < normalizedPattern.length; i++) {
    const ch = normalizedPattern[i]
    if (ch === "*") {
      if (normalizedPattern[i + 1] === "*") {
        regex += ".*"
        i++
      } else {
        regex += "[^/]*"
      }
    } else if (ch === "?") {
      regex += "[^/]"
    } else {
      regex += escapeRegExp(ch)
    }
  }
  return new RegExp(`^${regex}$`).test(normalizedPath)
}

function stripRecursiveGlob(pattern: string): string {
  return pattern.replace(/[\\/]\*\*$/, "")
}

function pathRuleMatches(resolvedPath: string, rule: PermissionRule, operation: PathOperation): boolean {
  const pattern = pathRulePattern(rule, operation)
  if (!pattern) return false

  const match = rule.match ?? (containsGlob(pattern) ? "wildcard" : "prefix")
  if (match === "exact") return normalizeRulePath(resolvedPath) === normalizeRulePath(stripRecursiveGlob(pattern))
  if (match === "wildcard") return wildcardPathMatches(resolvedPath, pattern)
  return isInsidePath(resolvedPath, path.resolve(stripRecursiveGlob(pattern)))
}

function matchingPathRule(resolvedPath: string, operation: PathOperation, rules: readonly PermissionRule[] = []): PermissionRule | undefined {
  return findMatchingPathPermissionRule(resolvedPath, operation, rules)
}

function permissionDirectoryForPath(resolvedPath: string, operation: PathOperation, assumeDirectory = false): string {
  if (assumeDirectory) return resolvedPath
  try {
    if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) return resolvedPath
  } catch {}
  if (operation === "read") return path.dirname(resolvedPath)
  return path.dirname(resolvedPath)
}

function externalPathSuggestions(directory: string, operation: PathOperation): PermissionSuggestion[] {
  return createPathPermissionSuggestions(directory, operation)
}

function stripSurroundingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === "'" && last === "'") || (first === "\"" && last === "\"")) return trimmed.slice(1, -1)
  }
  return trimmed
}

function isSafeNullPath(token: string): boolean {
  const normalized = token.replace(/\\/g, "/").toLowerCase()
  return normalized === "/dev/null" || normalized === "nul"
}

function containsUnresolvedExpansion(token: string): boolean {
  return token.includes("$") || token.includes("%") || token.includes("{") || token.includes("}") || token.startsWith("=")
}

function containsGlob(token: string): boolean {
  return /[*?\[]/.test(token)
}

function containsUnexpandedTilde(token: string): boolean {
  return token.startsWith("~")
}

function containsUncPath(token: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(token) || /^\/\/[^/]+\/[^/]+/.test(token)
}

function expandHome(token: string): string {
  if (token === "~") return os.homedir()
  if (token.startsWith("~/") || token.startsWith("~\\")) return path.join(os.homedir(), token.slice(2))
  return token
}

function globBase(token: string): string {
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"))
  if (slash <= 0) return "."
  return token.slice(0, slash)
}

function resolvePathToken(token: string, cwd: string): string {
  const expanded = expandHome(token)
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)
}

function isDangerousRemovalPath(resolvedPath: string, workspaceRoot: string): boolean {
  const normalized = normalizeForCompare(resolvedPath).replace(/[\\/]+/g, "/").replace(/\/$/, "")
  const normalizedWorkspace = normalizeForCompare(workspaceRoot).replace(/[\\/]+/g, "/").replace(/\/$/, "")
  const normalizedHome = normalizeForCompare(os.homedir()).replace(/[\\/]+/g, "/").replace(/\/$/, "")

  if (normalized === "" || normalized === "/" || normalized === normalizedHome || normalized === normalizedWorkspace) return true
  if (/^[a-z]:$/i.test(normalized) || /^[a-z]:\/?$/i.test(normalized)) return true
  if (path.dirname(normalized) === "/" && normalized !== normalizedWorkspace) return true
  if (/^[a-z]:\/[^/]+$/i.test(normalized)) return true
  return false
}

function validatePathToken(token: string | undefined, operation: PathOperation, cwd: string, scope: PathValidationScope, source?: string): PathValidationResult {
  const workspaceRoot = scope.workspaceRoot
  const label = operationLabel(operation)
  if (!token) return fail(`命令包含缺少目标的${label}路径`, shouldHardDeny(operation))

  const clean = stripSurroundingQuotes(token)
  if (!clean) return { allowed: true }
  if (clean === "-") {
    if (source === "cd target" || source === "pushd target") return fail(`${label}路径指向未知的上一次目录: ${token}`, true)
    return { allowed: true }
  }
  if (isSafeNullPath(clean)) return { allowed: true }
  if (containsUncPath(clean)) return fail(`${label}路径包含 UNC 网络路径: ${token}`, true)
  if (containsUnresolvedExpansion(clean)) return fail(`${label}路径包含变量或 shell 展开语法: ${token}`, shouldHardDeny(operation))

  if (containsUnexpandedTilde(clean) && clean !== "~" && !clean.startsWith("~/") && !clean.startsWith("~\\")) {
    return fail(`${label}路径包含无法静态解析的用户目录语法: ${token}`, shouldHardDeny(operation))
  }

  if (containsGlob(clean)) {
    if (operation !== "read") return fail(`${label}路径包含通配符，无法安全验证具体目标: ${token}`, true)
    const base = globBase(clean)
    const resolvedBase = resolvePathToken(base, cwd)
    if (!isInsidePath(resolvedBase, workspaceRoot)) {
      if (matchingPathRule(resolvedBase, operation, scope.alwaysDenyRules?.session)) {
        return fail(`${label}路径被本会话规则拒绝: ${token}`, true, { operation, blockedPath: resolvedBase })
      }
      if (matchingPathRule(resolvedBase, operation, scope.alwaysAskRules?.session)) {
        const directory = permissionDirectoryForPath(resolvedBase, operation, true)
        return fail(`${label}路径需要本会话规则确认: ${token}`, false, {
          operation,
          blockedPath: resolvedBase,
          suggestions: externalPathSuggestions(directory, operation),
        })
      }
      if (isInsideAnyPath(resolvedBase, scope.allowedWorkingRoots) || matchingPathRule(resolvedBase, operation, scope.alwaysAllowRules?.session)) {
        return { allowed: true }
      }
      if (isSensitiveExternalPath(resolvedBase, workspaceRoot)) {
        const directory = permissionDirectoryForPath(resolvedBase, operation, true)
        return fail(`${label}路径指向敏感路径: ${token}`, false, {
          operation,
          blockedPath: resolvedBase,
          suggestions: externalPathSuggestions(directory, operation),
        })
      }
      return { allowed: true }
    }
    if (!isInsidePath(resolvedBase, workspaceRoot)) return fail(`${label}路径不在 workspace 内: ${token}`, true)
    return { allowed: true }
  }

  const resolved = resolvePathToken(clean, cwd)
  if (isInsidePath(resolved, workspaceRoot)) {
    if (operation === "remove" && isDangerousRemovalPath(resolved, workspaceRoot)) {
      return fail(`删除路径指向高风险目录: ${token}`, true)
    }
    if (matchingPathRule(resolved, operation, scope.alwaysDenyRules?.session)) {
      return fail(`${label}路径被本会话规则拒绝: ${token}`, true, { operation, blockedPath: resolved })
    }
    if (matchingPathRule(resolved, operation, scope.alwaysAskRules?.session)) {
      const directory = permissionDirectoryForPath(resolved, operation)
      return fail(`${label}路径需要本会话规则确认: ${token}`, false, {
        operation,
        blockedPath: resolved,
        suggestions: externalPathSuggestions(directory, operation),
      })
    }
  }
  if (!isInsidePath(resolved, workspaceRoot)) {
    if (operation === "remove" && isDangerousRemovalPath(resolved, workspaceRoot)) {
      return fail(`删除路径指向高风险目录: ${token}`, true)
    }
    if (matchingPathRule(resolved, operation, scope.alwaysDenyRules?.session)) {
      return fail(`${label}路径被本会话规则拒绝: ${token}`, true, { operation, blockedPath: resolved })
    }
    if (matchingPathRule(resolved, operation, scope.alwaysAskRules?.session)) {
      const directory = permissionDirectoryForPath(resolved, operation)
      return fail(`${label}路径需要本会话规则确认: ${token}`, false, {
        operation,
        blockedPath: resolved,
        suggestions: externalPathSuggestions(directory, operation),
      })
    }
    if (isInsideAnyPath(resolved, scope.allowedWorkingRoots)) return { allowed: true }
    if (matchingPathRule(resolved, operation, scope.alwaysAllowRules?.session)) return { allowed: true }

    if (isSensitiveExternalPath(resolved, workspaceRoot)) {
      const directory = permissionDirectoryForPath(resolved, operation)
      return fail(`${label}路径指向敏感路径: ${token}`, false, {
        operation,
        blockedPath: resolved,
        suggestions: externalPathSuggestions(directory, operation),
      })
    }
    if (operation === "read") return { allowed: true }

    const directory = permissionDirectoryForPath(resolved, operation)
    return fail(`${label}路径不在 workspace/授权目录内: ${token}`, false, {
      operation,
      blockedPath: resolved,
      suggestions: externalPathSuggestions(directory, operation),
    })
  }
  if (operation === "remove" && isDangerousRemovalPath(resolved, workspaceRoot)) {
    return fail(`删除路径指向高风险目录: ${token}`, true)
  }
  if (!isInsidePath(resolved, workspaceRoot)) return fail(`${label}路径不在 workspace 内: ${token}`, true)
  return { allowed: true }
}

function isWindowsSwitch(cmd: string, arg: string): boolean {
  if (!arg.startsWith("/")) return false
  return ["copy", "move", "del", "erase", "rd", "rmdir", "dir", "findstr", "fc", "more", "type"].includes(cmd)
    && /^\/[a-z0-9?:+-]+$/i.test(arg)
}

function isOptionToken(cmd: string, arg: string): boolean {
  if (arg === "-") return false
  if (arg.startsWith("-")) return true
  return isWindowsSwitch(cmd, arg)
}

function pathArgsOnly(cmd: string, args: string[], valueFlags: Set<string> = COMMON_VALUE_FLAGS): string[] {
  const result: string[] = []
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (afterDoubleDash) {
      result.push(arg)
      continue
    }
    if (arg === "--") {
      afterDoubleDash = true
      continue
    }
    if (isOptionToken(cmd, arg)) {
      const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
      if (!arg.includes("=") && valueFlags.has(flag)) i++
      continue
    }
    result.push(arg)
  }

  return result
}

function mark(paths: string[], operation: PathOperation, source?: string): CommandPathArg[] {
  return paths.map((token) => ({ token, operation, source }))
}

function simpleExtractor(args: string[], command: PathCommand): CommandPathArg[] {
  return mark(pathArgsOnly(command, args), DEFAULT_OPERATION[command])
}

function defaultDotExtractor(args: string[], command: PathCommand): CommandPathArg[] {
  const paths = pathArgsOnly(command, args)
  return mark(paths.length > 0 ? paths : ["."], DEFAULT_OPERATION[command])
}

function cdExtractor(args: string[], command: PathCommand, context: PathExtractorContext): CommandPathArg[] {
  const targetArgs = command === "cd" && context.shellDialect === "cmd" && args[0]?.toLowerCase() === "/d" ? args.slice(1) : args
  if (command === "cd" && context.shellDialect === "cmd" && targetArgs.length === 0) return []
  return [{ token: targetArgs.length === 0 ? "~" : targetArgs.join(" "), operation: DEFAULT_OPERATION[command], source: `${command} target` }]
}

function cpExtractor(args: string[], command: PathCommand): CommandPathArg[] {
  const explicitTarget = args.findIndex((arg) => arg === "-t" || arg === "--target-directory")
  if (explicitTarget !== -1 && args[explicitTarget + 1]) {
    const remaining = args.filter((_, index) => index !== explicitTarget && index !== explicitTarget + 1)
    return [
      { token: args[explicitTarget + 1]!, operation: "write", source: `${command} target-directory` },
      ...mark(pathArgsOnly(command, remaining), "read", `${command} source`),
    ]
  }

  const inlineTarget = args.find((arg) => arg.startsWith("--target-directory="))
  if (inlineTarget) {
    const remaining = args.filter((arg) => arg !== inlineTarget)
    return [
      { token: inlineTarget.slice("--target-directory=".length), operation: "write", source: `${command} target-directory` },
      ...mark(pathArgsOnly(command, remaining), "read", `${command} source`),
    ]
  }

  const paths = pathArgsOnly(command, args)
  if (paths.length <= 1) return mark(paths, "read", `${command} source`)
  return [
    ...mark(paths.slice(0, -1), "read", `${command} source`),
    { token: paths[paths.length - 1]!, operation: "write", source: `${command} destination` },
  ]
}

function mvExtractor(args: string[], command: PathCommand): CommandPathArg[] {
  const explicitTarget = args.findIndex((arg) => arg === "-t" || arg === "--target-directory")
  if (explicitTarget !== -1 && args[explicitTarget + 1]) {
    const remaining = args.filter((_, index) => index !== explicitTarget && index !== explicitTarget + 1)
    return [
      { token: args[explicitTarget + 1]!, operation: "write", source: `${command} target-directory` },
      ...mark(pathArgsOnly(command, remaining), "remove", `${command} source`),
    ]
  }

  const inlineTarget = args.find((arg) => arg.startsWith("--target-directory="))
  if (inlineTarget) {
    const remaining = args.filter((arg) => arg !== inlineTarget)
    return [
      { token: inlineTarget.slice("--target-directory=".length), operation: "write", source: `${command} target-directory` },
      ...mark(pathArgsOnly(command, remaining), "remove", `${command} source`),
    ]
  }

  const paths = pathArgsOnly(command, args)
  if (paths.length <= 1) return mark(paths, "remove", `${command} source`)
  return [
    ...mark(paths.slice(0, -1), "remove", `${command} source`),
    { token: paths[paths.length - 1]!, operation: "write", source: `${command} destination` },
  ]
}

function findExtractor(args: string[]): CommandPathArg[] {
  const paths: string[] = []
  const pathFlags = new Set([
    "-newer",
    "-anewer",
    "-cnewer",
    "-samefile",
  ])
  const newerPattern = /^-newer[acmBt][acmtB]$/
  let foundPredicate = false
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (afterDoubleDash) {
      paths.push(arg)
      continue
    }
    if (arg === "--") {
      afterDoubleDash = true
      continue
    }
    if (arg.startsWith("-")) {
      foundPredicate = true
      if ((pathFlags.has(arg) || newerPattern.test(arg)) && args[i + 1]) {
        paths.push(args[i + 1]!)
        i++
      }
      continue
    }
    if (!foundPredicate) paths.push(arg)
  }

  return mark(paths.length > 0 ? paths : ["."], "read", "find path")
}

function findstrExtractor(args: string[]): CommandPathArg[] {
  const paths: CommandPathArg[] = []
  let patternFound = false

  for (const arg of args) {
    if (!arg) continue

    if (/^\/[fg]:/i.test(arg)) {
      paths.push({ token: arg.slice(3), operation: "read", source: "findstr list file" })
      continue
    }
    if (/^\/c:/i.test(arg)) {
      patternFound = true
      continue
    }
    if (arg.startsWith("/")) continue

    if (!patternFound) {
      patternFound = true
      continue
    }
    paths.push({ token: arg, operation: "read", source: "findstr file" })
  }

  return paths
}

function patternCommandExtractor(args: string[], valueFlags: Set<string>, defaultPaths: string[] = []): CommandPathArg[] {
  const paths: string[] = []
  let patternFound = false
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith("-")) {
      const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
      if (arg.startsWith("-f") && !arg.startsWith("--") && arg.length > 2) {
        paths.push(arg.slice(2))
        patternFound = true
        continue
      }
      if (flag === "-f" || flag === "--file") {
        const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[i + 1]
        if (value) paths.push(value)
        if (!arg.includes("=")) i++
        patternFound = true
        continue
      }
      if (flag === "-e" || flag === "--regexp" || flag === "-f" || flag === "--file") patternFound = true
      if (!arg.includes("=") && valueFlags.has(flag)) i++
      continue
    }

    if (!patternFound) {
      patternFound = true
      continue
    }
    paths.push(arg)
  }

  return mark(paths.length > 0 ? paths : defaultPaths, "read")
}

function sortExtractor(args: string[]): CommandPathArg[] {
  const outputs: CommandPathArg[] = []
  let afterDoubleDash = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if (arg === "--") {
      afterDoubleDash = true
      continue
    }
    if (afterDoubleDash) continue
    if ((arg === "-o" || arg === "--output") && args[i + 1]) {
      outputs.push({ token: args[i + 1]!, operation: "write", source: "sort output" })
      i++
      continue
    }
    if (arg.startsWith("--output=")) {
      outputs.push({ token: arg.slice("--output=".length), operation: "write", source: "sort output" })
      continue
    }
    if (arg.startsWith("-o") && arg.length > 2) {
      outputs.push({ token: arg.slice(2), operation: "write", source: "sort output" })
    }
  }
  return [...outputs, ...mark(pathArgsOnly("sort", args), "read", "sort input")]
}

function sedExtractor(args: string[]): CommandPathArg[] {
  const paths: CommandPathArg[] = []
  let scriptFound = false
  let inPlace = false
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith("-")) {
      const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
      if (flag === "-i" || flag.startsWith("-i") || flag === "--in-place") inPlace = true
      if ((flag === "-e" || flag === "--expression") && !arg.includes("=")) {
        i++
        scriptFound = true
      } else if ((flag === "-f" || flag === "--file") && !arg.includes("=") && args[i + 1]) {
        paths.push({ token: args[i + 1]!, operation: "read", source: "sed script file" })
        i++
        scriptFound = true
      } else if ((flag === "-f" || flag === "--file") && arg.includes("=")) {
        paths.push({ token: arg.slice(arg.indexOf("=") + 1), operation: "read", source: "sed script file" })
        scriptFound = true
      }
      continue
    }

    if (!scriptFound) {
      scriptFound = true
      continue
    }
    paths.push({ token: arg, operation: inPlace ? "write" : "read", source: "sed file" })
  }

  return paths
}

function jqExtractor(args: string[]): CommandPathArg[] {
  const paths: CommandPathArg[] = []
  let filterFound = false
  let afterDoubleDash = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue

    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true
      continue
    }

    if (!afterDoubleDash && arg.startsWith("-")) {
      const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
      if ((flag === "-f" || flag === "--from-file") && args[i + 1] && !arg.includes("=")) {
        paths.push({ token: args[i + 1]!, operation: "read", source: "jq filter file" })
        i++
        filterFound = true
      } else if ((flag === "-f" || flag === "--from-file") && arg.includes("=")) {
        paths.push({ token: arg.slice(arg.indexOf("=") + 1), operation: "read", source: "jq filter file" })
        filterFound = true
      } else if ((flag === "--slurpfile" || flag === "--rawfile") && args[i + 2]) {
        paths.push({ token: args[i + 2]!, operation: "read", source: "jq bound file" })
        i += 2
      } else if ((flag === "--arg" || flag === "--argjson") && args[i + 2]) {
        i += 2
      } else if (!arg.includes("=") && COMMON_VALUE_FLAGS.has(flag)) {
        i++
      }
      continue
    }

    if (!filterFound) {
      filterFound = true
      continue
    }
    paths.push({ token: arg, operation: "read", source: "jq input file" })
  }

  return paths
}

function gitExtractor(args: string[]): CommandPathArg[] {
  if (args[0] !== "diff" || !args.includes("--no-index")) return []
  const paths = pathArgsOnly("git", args.slice(1), COMMON_VALUE_FLAGS).filter((arg) => arg !== "--no-index")
  return mark(paths.slice(0, 2), "read", "git diff --no-index")
}

function tarExtractor(args: string[]): CommandPathArg[] {
  const modeText = args.filter((arg) => arg.startsWith("-")).join("")
  const extracts = /(^|[^a-zA-Z])x/.test(modeText) || args.includes("--extract")
  const createsArchive = /(^|[^a-zA-Z])c/.test(modeText) || args.includes("--create")
  const consumed = new Set<number>()
  const archives: CommandPathArg[] = []
  const directories: CommandPathArg[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg) continue
    if ((arg === "-f" || arg === "--file") && args[i + 1]) {
      archives.push({ token: args[i + 1]!, operation: createsArchive ? "write" : "read", source: "tar archive" })
      consumed.add(i)
      consumed.add(i + 1)
      i++
      continue
    }
    if (/^-[A-Za-z]*f/.test(arg)) {
      const inline = arg.slice(arg.indexOf("f") + 1)
      if (inline) {
        archives.push({ token: inline, operation: createsArchive ? "write" : "read", source: "tar archive" })
        consumed.add(i)
      } else if (args[i + 1]) {
        archives.push({ token: args[i + 1]!, operation: createsArchive ? "write" : "read", source: "tar archive" })
        consumed.add(i)
        consumed.add(i + 1)
        i++
      }
      continue
    }
    if (arg.startsWith("--file=")) {
      archives.push({ token: arg.slice("--file=".length), operation: createsArchive ? "write" : "read", source: "tar archive" })
      consumed.add(i)
      continue
    }
    if ((arg === "-C" || arg === "--directory") && args[i + 1]) {
      directories.push({ token: args[i + 1]!, operation: extracts ? "write" : "read", source: "tar directory" })
      consumed.add(i)
      consumed.add(i + 1)
      i++
      continue
    }
  }

  if (extracts) return [...archives, ...directories]

  const paths = pathArgsOnly("tar", args.filter((_, index) => !consumed.has(index)), new Set(["-C", "--directory", "-f", "--file"]))
  for (const token of paths) {
    if (token === "x" || token === "c") continue
    archives.push({ token, operation: createsArchive ? "read" : "read", source: "tar path" })
  }
  return [...archives, ...directories]
}

function powershellContentExtractor(args: string[], command: PathCommand): CommandPathArg[] {
  const explicitPath = args.findIndex((arg) => /^-(filepath|literalpath|path)$/i.test(arg))
  if (explicitPath !== -1 && args[explicitPath + 1]) return [{ token: args[explicitPath + 1]!, operation: DEFAULT_OPERATION[command] }]
  const positional = pathArgsOnly(command, args)
  return positional[0] ? [{ token: positional[0], operation: DEFAULT_OPERATION[command] }] : []
}

const PATH_EXTRACTORS: Record<PathCommand, PathExtractor> = {
  cd: cdExtractor,
  pushd: cdExtractor,
  ls: defaultDotExtractor,
  dir: defaultDotExtractor,
  find: findExtractor,
  findstr: findstrExtractor,
  cat: simpleExtractor,
  type: simpleExtractor,
  head: simpleExtractor,
  tail: simpleExtractor,
  more: simpleExtractor,
  sort: sortExtractor,
  uniq: simpleExtractor,
  wc: simpleExtractor,
  cut: simpleExtractor,
  paste: simpleExtractor,
  column: simpleExtractor,
  tr: simpleExtractor,
  file: simpleExtractor,
  stat: simpleExtractor,
  diff: simpleExtractor,
  fc: simpleExtractor,
  awk: simpleExtractor,
  strings: simpleExtractor,
  hexdump: simpleExtractor,
  od: simpleExtractor,
  base64: simpleExtractor,
  nl: simpleExtractor,
  grep: (args) => patternCommandExtractor(args, GREP_VALUE_FLAGS),
  rg: (args) => patternCommandExtractor(args, RG_VALUE_FLAGS, ["."]),
  sed: sedExtractor,
  jq: jqExtractor,
  git: gitExtractor,
  tar: tarExtractor,
  touch: simpleExtractor,
  mkdir: simpleExtractor,
  "new-item": powershellContentExtractor,
  cp: cpExtractor,
  copy: cpExtractor,
  mv: mvExtractor,
  move: mvExtractor,
  rm: simpleExtractor,
  rmdir: simpleExtractor,
  del: simpleExtractor,
  erase: simpleExtractor,
  rd: simpleExtractor,
  "remove-item": simpleExtractor,
  "set-content": powershellContentExtractor,
  "add-content": powershellContentExtractor,
  "out-file": powershellContentExtractor,
}

function stripSafeWrappers(tokens: string[]): string[] {
  let current = tokens
  let changed = true
  while (changed && current.length > 0) {
    changed = false
    const cmd = current[0]?.toLowerCase()
    if (!cmd) break

    if (cmd === "nohup" || cmd === "time" || cmd === "command" || cmd === "builtin" || cmd === "exec") {
      current = current.slice(1)
      changed = true
      continue
    }

    if (cmd === "env") {
      let i = 1
      while (i < current.length) {
        const arg = current[i]!
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { i++; continue }
        if (arg === "-i" || arg === "--ignore-environment") { i++; continue }
        if ((arg === "-u" || arg === "--unset") && current[i + 1]) { i += 2; continue }
        break
      }
      if (i > 1) {
        current = current.slice(i)
        changed = true
      }
      continue
    }

    if (cmd === "timeout") {
      let i = 1
      while (i < current.length && current[i]?.startsWith("-")) {
        const arg = current[i]!
        if (arg === "--foreground" || arg === "--preserve-status" || arg === "--verbose") i++
        else if ((arg === "-k" || arg === "--kill-after" || arg === "-s" || arg === "--signal") && current[i + 1]) i += 2
        else if (/^--(?:kill-after|signal)=/.test(arg)) i++
        else break
      }
      if (current[i]) {
        current = current.slice(i + 1)
        changed = true
      }
      continue
    }

    if (cmd === "nice") {
      let i = 1
      if (current[i] === "-n" && current[i + 1]) i += 2
      else if (/^-\d+$/.test(current[i] ?? "")) i++
      if (i > 1 || current[i]) {
        current = current.slice(i)
        changed = true
      }
      continue
    }

    if (cmd === "stdbuf") {
      let i = 1
      while (i < current.length && /^-[ioe]/.test(current[i] ?? "")) {
        if (/^-[ioe]$/.test(current[i]!) && current[i + 1]) i += 2
        else i++
      }
      if (i > 1) {
        current = current.slice(i)
        changed = true
      }
    }
  }
  return current
}

function commandPathArgs(tokens: string[], context: PathExtractorContext = {}): CommandPathArg[] {
  const stripped = stripSafeWrappers(tokens)
  const cmd = stripped[0]?.toLowerCase() as PathCommand | undefined
  if (!cmd || !PATH_COMMANDS.has(cmd)) return []
  return PATH_EXTRACTORS[cmd](stripped.slice(1), cmd, context)
}

function segmentCommand(segment: ShellSegment): string | undefined {
  return stripSafeWrappers(tokensWithoutRedirects(segment))[0]?.toLowerCase()
}

function segmentChangesDirectory(segment: ShellSegment, shellDialect?: ShellDialect): boolean {
  const cmd = segmentCommand(segment)
  if (cmd === "cd" && shellDialect === "cmd") {
    return commandPathArgs(tokensWithoutRedirects(segment), { shellDialect }).length > 0
  }
  return cmd === "cd" || cmd === "pushd"
}

function segmentHasWriteLikeOperation(segment: ShellSegment, shellDialect?: ShellDialect): boolean {
  if (segment.redirects.some((redirect) => redirect.isOutput && !redirect.isSafeReadOnlySink)) return true
  const tokens = tokensWithoutRedirects(segment)
  return commandPathArgs(tokens, { shellDialect }).some((arg) => arg.operation !== "read")
}

function compoundCdWithWrite(parsed: ReturnType<typeof parseShellCommand>, shellDialect?: ShellDialect): boolean {
  const cdIndex = parsed.segments.findIndex((segment) => segmentChangesDirectory(segment, shellDialect) && segment.nextOperator)
  if (cdIndex === -1) return false
  return parsed.segments.slice(cdIndex + 1).some((segment) => segmentHasWriteLikeOperation(segment, shellDialect))
}

function nextCwdAfterSegment(segment: ShellSegment, cwd: string, shellDialect?: ShellDialect): string | undefined {
  if (segment.nextOperator !== "and") return undefined
  const cdTarget = commandPathArgs(tokensWithoutRedirects(segment), { shellDialect })
    .find((arg) => arg.source === "cd target" || arg.source === "pushd target")
  if (!cdTarget) return undefined

  const clean = stripSurroundingQuotes(cdTarget.token)
  if (!clean || clean === "-") return undefined
  if (containsUncPath(clean) || containsUnresolvedExpansion(clean) || containsGlob(clean)) return undefined
  if (containsUnexpandedTilde(clean) && clean !== "~" && !clean.startsWith("~/") && !clean.startsWith("~\\")) return undefined
  return resolvePathToken(clean, cwd)
}

function simpleCommandName(command: SimpleCommand): string | undefined {
  return stripSafeWrappers(command.argv)[0]?.toLowerCase()
}

function simpleCommandChangesDirectory(command: SimpleCommand): boolean {
  const cmd = simpleCommandName(command)
  if (cmd === "cd" && command.dialect === "cmd") {
    return commandPathArgs(command.argv, { shellDialect: command.dialect }).length > 0
  }
  return cmd === "cd" || cmd === "pushd"
}

function simpleCommandHasWriteLikeOperation(command: SimpleCommand): boolean {
  if (command.redirects.some((redirect) => redirect.isOutput && !redirect.isSafeReadOnlySink)) return true
  return commandPathArgs(command.argv, { shellDialect: command.dialect }).some((arg) => arg.operation !== "read")
}

function compoundCdWithWriteCommands(commands: readonly SimpleCommand[]): boolean {
  const cdIndex = commands.findIndex((command) => simpleCommandChangesDirectory(command) && command.nextOperator)
  if (cdIndex === -1) return false
  return commands.slice(cdIndex + 1).some(simpleCommandHasWriteLikeOperation)
}

function nextCwdAfterSimpleCommand(command: SimpleCommand, cwd: string): string | undefined {
  if (command.nextOperator !== "and") return undefined
  const cdTarget = commandPathArgs(command.argv, { shellDialect: command.dialect })
    .find((arg) => arg.source === "cd target" || arg.source === "pushd target")
  if (!cdTarget) return undefined

  const clean = stripSurroundingQuotes(cdTarget.token)
  if (!clean || clean === "-") return undefined
  if (containsUncPath(clean) || containsUnresolvedExpansion(clean) || containsGlob(clean)) return undefined
  if (containsUnexpandedTilde(clean) && clean !== "~" && !clean.startsWith("~/") && !clean.startsWith("~\\")) return undefined
  return resolvePathToken(clean, cwd)
}

function validateRedirect(redirect: SecurityRedirect, cwd: string, scope: PathValidationScope): PathValidationResult {
  if (redirect.isSafeReadOnlySink) return { allowed: true }
  const operation: PathOperation = redirect.isOutput ? "write" : "read"
  return validatePathToken(redirect.target, operation, cwd, scope)
}

function validateParsedCommands(
  parsed: SecurityParseResult,
  cwd: string,
  scope: PathValidationScope,
): PathValidationResult | null {
  if (parsed.kind === "parse-unavailable") return null
  if (parsed.kind === "too-complex") return fail(parsed.reason || "命令过于复杂，无法验证路径")

  if (compoundCdWithWriteCommands(parsed.commands)) {
    return fail("命令包含 cd/pushd 后继续执行写入操作，无法静态确认后续写入路径", true)
  }

  let effectiveCwd = cwd
  for (const command of parsed.commands) {
    for (const redirect of command.redirects) {
      const result = validateRedirect(redirect, effectiveCwd, scope)
      if (!result.allowed) return result
    }

    for (const target of commandPathArgs(command.argv, { shellDialect: command.dialect })) {
      const result = validatePathToken(target.token, target.operation, effectiveCwd, scope, target.source)
      if (!result.allowed) return result
    }

    effectiveCwd = nextCwdAfterSimpleCommand(command, effectiveCwd) ?? effectiveCwd
  }

  return { allowed: true }
}

export function validateCommandPaths(command: string, options: PathValidationOptions): PathValidationResult {
  const cwd = path.resolve(options.cwd || process.cwd())
  const workspaceRoot = path.resolve(options.workspaceRoot || cwd)
  const scope = buildValidationScope(workspaceRoot, options)

  if (!isInsideAnyPath(cwd, scope.allowedWorkingRoots)) {
    if (isSensitiveExternalPath(cwd, workspaceRoot)) {
      return fail(`工作目录指向敏感路径: ${cwd}`, false, { operation: "read", blockedPath: cwd })
    }
    return fail(`工作目录不在 workspace/授权目录内: ${cwd}`, false, {
      operation: "read",
      blockedPath: cwd,
      suggestions: externalPathSuggestions(cwd, "write"),
    })
  }

  const securityParsed = options.parsed ?? parseCommandForSecurity(command, { shellDialect: options.shellDialect })
  const parsedResult = validateParsedCommands(securityParsed, cwd, scope)
  if (parsedResult) return parsedResult

  const shellDialect = options.shellDialect ?? (process.platform === "win32" ? "cmd" : "posix-bash")
  const parsed = parseShellCommand(command, { shellDialect })
  if (!parsed.ok) return fail(parsed.error ?? "命令解析失败，无法验证路径")

  if (compoundCdWithWrite(parsed, shellDialect)) {
    return fail("命令包含 cd/pushd 后继续执行写入操作，无法静态确认后续写入路径", true)
  }

  let effectiveCwd = cwd

  for (const segment of parsed.segments) {
    for (const redirect of segment.redirects) {
      if (redirect.isSafeReadOnlySink) continue
      const operation: PathOperation = redirect.isOutput ? "write" : "read"
      const result = validatePathToken(redirect.target, operation, effectiveCwd, scope)
      if (!result.allowed) return result
    }

    const tokens = tokensWithoutRedirects(segment)
    for (const target of commandPathArgs(tokens, { shellDialect })) {
      const result = validatePathToken(target.token, target.operation, effectiveCwd, scope, target.source)
      if (!result.allowed) return result
    }

    effectiveCwd = nextCwdAfterSegment(segment, effectiveCwd, shellDialect) ?? effectiveCwd
  }

  return { allowed: true }
}
