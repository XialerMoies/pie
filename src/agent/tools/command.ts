/**
 * CommandTool — 执行 shell 命令，支持流式 stdout/stderr
 *
 * 替代 PI 内置 bash 工具，提供实时输出推送。
 *
 * ## 安全层
 *
 * 1. 危险命令检测（isDangerousCommand）— 每次执行前拦截，阻止系统破坏性命令
 * 2. 只读白名单（isReadOnlyCommand）— 可选参数 readOnly=true 时仅允许只读命令
 * 3. 权限模式（permissionMode + confirmCommand）— 由宿主控制，非只读命令需用户确认
 *
 * 适用场景：单用户桌面开发环境，非企业级多用户权限治理。
 */
import { defineAgentTool, structuredToolError, structuredToolResult, type AgentTool, type AgentToolResult, type CommandConfirmationRequest, type CommandConfirmationResponse, type CommandConfirmationScope, type PermissionFailure, type PermissionSuggestion, type ToolContext } from "../types.js"
import { spawn } from "child_process"
import { StringDecoder } from "string_decoder"
import { TextDecoder } from "util"
import { validateCommandPaths } from "./command/path-validation.js"
import { isCommandReadOnly } from "./command/read-only.js"
import { defaultShellDialect, envFlagEnabled, parseCommandForSecurity, parseCommandForSecurityAsync, parseCommandForSecurityWithTreeSitterAsync } from "./command/security-parser.js"
import type { SecurityParseResult, ShellDialect } from "./command/security-ast.js"
import { parseShellCommand, shellDialectFromEnv, tokensWithoutRedirects } from "./command/shell-parser.js"
import { isPureFileOperation, isRegularGitOperation } from "./command/pure-file-op.js"
import { baseCommandName, isDangerousCommand, type DangerResult } from "./command/dangerous-command.js"
import { resolveBashExecutable } from "./command/shell-runtime.js"
import { createUserCommandEnv, sanitizeProcessOutput } from "../../process/env-policy.js"

export { isDangerousCommand, resolveBashExecutable }

const MAX_OUTPUT = 100 * 1024 // 100KB 总输出上限
const COMMAND_TIMEOUT = 300_000 // 5 分钟

/* eslint-disable @typescript-eslint/no-non-null-assertion */

export function isReadOnlyCommand(cmd: string): boolean {
  return isCommandReadOnly(cmd)
}

// ─── 通用函数 ───────────────────────────────────────────

function isWindows(): boolean { return process.platform === "win32" }

function commandExecutionEnv(): NodeJS.ProcessEnv {
  return createUserCommandEnv({
    hostEnv: process.env,
    platform: process.platform,
    bashExecutable: isWindows() ? resolveBashExecutable() : undefined,
  })
}

function decodeCommandChunk(data: Buffer, decoder: StringDecoder): string {
  const text = decoder.write(data)
  if (!isWindows() || !text.includes("�")) return text
  try { return new TextDecoder("gb18030").decode(data) } catch { return text }
}

function windowsCompatibilityWarning(cmd: string, shellDialect = defaultShellDialect()): string | undefined {
  if (shellDialect !== "cmd") return undefined
  if (/\$env:MY_CODE_AGENT_[A-Z0-9_]+/i.test(cmd)) {
    return "⚠ 当前 command tool 使用 cmd.exe，$env:... 是 PowerShell 语法；并且在对话里设置环境变量不会影响已经启动的桌面端。请在启动桌面端前的 PowerShell 窗口设置 MY_CODE_AGENT_*。"
  }
  if (/^\s*set\s+MY_CODE_AGENT_[A-Z0-9_]+\s*=/i.test(cmd)) {
    return "⚠ set MY_CODE_AGENT_* 只会影响本次 cmd 子进程，不会改变已经启动的桌面端进程。请在启动桌面端前设置环境变量。"
  }

  const parsed = parseShellCommand(cmd, { shellDialect: "cmd" })
  if (!parsed.ok) return undefined

  for (const segment of parsed.segments) {
    const tokens = tokensWithoutRedirects(segment)
    const command = tokens[0]?.toLowerCase()
    if ((command === "mkdir" || command === "md") && tokens.slice(1).some((token) => token === "-p" || token === "--parents")) {
      return "⚠ Windows 默认 shell 是 cmd.exe，不支持 mkdir -p；请改用: mkdir src data out"
    }
  }
  return undefined
}

function firstCommandTokens(cmd: string, shellDialect: ShellDialect): string[] {
  const parsed = parseShellCommand(cmd, { shellDialect })
  for (const segment of parsed.segments) {
    const tokens = tokensWithoutRedirects(segment)
    if (tokens.length > 0) return tokens
  }
  return []
}

function commandLooksPosixForWindows(cmd: string): boolean {
  const tokens = firstCommandTokens(cmd, "posix-bash")
  let commandIndex = 0
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex] ?? "")) commandIndex++

  const command = baseCommandName(tokens[commandIndex])
  if (!command) return false
  if (["pwd", "ls", "cat", "bash", "sh", "zsh"].includes(command)) return true
  if (command === "mkdir" && tokens.slice(commandIndex + 1).some((token) => token === "-p" || token === "--parents")) {
    return true
  }
  return false
}

export function shellDialectForCommand(cmd: string, ctx?: Pick<ToolContext, "shellDialect">): ShellDialect {
  const configured = ctx?.shellDialect ?? shellDialectFromEnv()
  if (configured) return configured

  const fallback = defaultShellDialect()
  if (!isWindows() || fallback !== "cmd") return fallback
  if (!resolveBashExecutable()) return fallback
  return commandLooksPosixForWindows(cmd) ? "posix-bash" : fallback
}

export interface CommandSecurityVerdictsForShadow {
  danger: DangerResult
  readOnly: boolean
  path: ReturnType<typeof validateCommandPaths>
}

export interface CommandSecurityVerdictShadowDiff {
  legacy: CommandSecurityVerdictsForShadow
  treeSitter: CommandSecurityVerdictsForShadow
}

export interface CommandSecurityVerdictShadowOptions {
  cwd: string
  workspaceRoot?: string
  shellDialect?: ShellDialect
}

function treeSitterVerdictShadowEnabled(): boolean {
  return envFlagEnabled("MY_CODE_AGENT_TREE_SITTER_SHADOW") ||
    envFlagEnabled("MY_CODE_AGENT_TREE_SITTER_SHADOW_ONLY")
}

function normalizeDangerForShadow(result: DangerResult): object {
  return result.dangerous
    ? { dangerous: true, reason: result.reason }
    : result.requiresConfirmation
      ? { dangerous: false, requiresConfirmation: true, reason: result.reason }
      : { dangerous: false }
}

function normalizePathForShadow(result: ReturnType<typeof validateCommandPaths>): object {
  if (result.allowed) return { allowed: true }
  return {
    allowed: false,
    reason: result.reason,
    requiresConfirmation: result.requiresConfirmation,
    hardDeny: result.hardDeny === true,
  }
}

function normalizeVerdictsForShadow(verdicts: CommandSecurityVerdictsForShadow): object {
  return {
    danger: normalizeDangerForShadow(verdicts.danger),
    readOnly: verdicts.readOnly,
    path: normalizePathForShadow(verdicts.path),
  }
}

function securityVerdictsForShadow(
  command: string,
  parsed: SecurityParseResult,
  options: Required<CommandSecurityVerdictShadowOptions>,
): CommandSecurityVerdictsForShadow {
  return {
    danger: isDangerousCommand(command, { parsed, shellDialect: options.shellDialect }),
    readOnly: isCommandReadOnly(command, { parsed, shellDialect: options.shellDialect }),
    path: validateCommandPaths(command, {
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot,
      shellDialect: options.shellDialect,
      parsed,
    }),
  }
}

export function securityVerdictsDifferForShadow(
  left: CommandSecurityVerdictsForShadow,
  right: CommandSecurityVerdictsForShadow,
): boolean {
  return JSON.stringify(normalizeVerdictsForShadow(left)) !== JSON.stringify(normalizeVerdictsForShadow(right))
}

export async function commandSecurityVerdictShadowDiff(
  command: string,
  options: CommandSecurityVerdictShadowOptions,
): Promise<CommandSecurityVerdictShadowDiff | null> {
  const shellDialect = options.shellDialect ?? defaultShellDialect()
  if (shellDialect !== "posix-bash") return null

  const normalizedOptions: Required<CommandSecurityVerdictShadowOptions> = {
    cwd: options.cwd,
    workspaceRoot: options.workspaceRoot ?? options.cwd,
    shellDialect,
  }
  const legacyParsed = parseCommandForSecurity(command, { shellDialect })
  const treeSitterParsed = await parseCommandForSecurityWithTreeSitterAsync(command, { shellDialect })
  if (treeSitterParsed.kind === "parse-unavailable") return null

  const legacy = securityVerdictsForShadow(command, legacyParsed, normalizedOptions)
  const treeSitter = securityVerdictsForShadow(command, treeSitterParsed, normalizedOptions)
  return securityVerdictsDifferForShadow(legacy, treeSitter) ? { legacy, treeSitter } : null
}

async function maybeLogSecurityVerdictShadowDiff(
  command: string,
  options: CommandSecurityVerdictShadowOptions,
): Promise<void> {
  if (!treeSitterVerdictShadowEnabled()) return
  const diff = await commandSecurityVerdictShadowDiff(command, options)
  if (!diff) return
  console.debug("[command-security] Tree-sitter verdict shadow diff", {
    command: sanitizeProcessOutput(command),
    legacy: normalizeVerdictsForShadow(diff.legacy),
    treeSitter: normalizeVerdictsForShadow(diff.treeSitter),
  })
}

// ─── 权限模式 ───────────────────────────────────────────

type ConfirmationOutcome = "allowed" | "rejected" | "unavailable" | "failed"

interface ConfirmationState {
  outcome?: ConfirmationOutcome
  scope?: CommandConfirmationScope
  applyPermissionSuggestions?: boolean
  appliedPermissionRules?: string[]
  command?: string
  cwd?: string
  shellDialect?: ShellDialect
  execution?: CommandExecutionResult
}

interface CommandExecutionResult {
  text: string
  stdout: string
  stderr: string
  exitCode: number | null
  truncated: boolean
}

function updateCommandAuthorization(
  ctx: ToolContext | undefined,
  status: "allow" | "deny",
  state: ConfirmationState,
  reason?: string,
): void {
  const decision = ctx?.authorizationDecision
  if (!decision) return
  decision.status = status
  decision.source = "specialized"
  decision.reason = reason
  decision.scope = state.scope
  decision.specialized = {
    status,
    reason,
    scope: state.scope,
    ...(state.appliedPermissionRules?.length
      ? { appliedRules: [...state.appliedPermissionRules] }
      : {}),
  }
}

function commandDecisionResult(
  text: string,
  ctx: ToolContext | undefined,
  state: ConfirmationState,
  status: "allow" | "deny",
  reason?: string,
  permissionFailure?: PermissionFailure,
): AgentToolResult {
  updateCommandAuthorization(ctx, status, state, reason)
  const data = {
    command: state.command || "",
    cwd: state.cwd || ctx?.cwd || "",
    shellDialect: state.shellDialect,
    stdout: state.execution?.stdout || "",
    stderr: state.execution?.stderr || "",
    exitCode: state.execution?.exitCode ?? null,
    truncated: state.execution?.truncated || false,
  }
  if (status === "deny") return structuredToolError(
    text,
    "command_denied",
    { ...data, reason },
    permissionFailure ? { permissionFailure } : undefined,
  )
  return structuredToolResult(text, data)
}

function confirmationOutcomeText(state: ConfirmationState): string {
  if (state.outcome === "allowed") {
    if (state.scope === "once") return "✅ 用户已允许命令执行（仅本次）。"
    if (state.scope === "session") {
      const rules = state.appliedPermissionRules?.length
        ? `已应用本会话授权规则: ${state.appliedPermissionRules.join("; ")}`
        : ""
      return rules
        ? `✅ 用户已允许命令执行（本会话）。${rules}`
        : "✅ 用户已允许命令执行（本会话）。"
    }
    if (state.scope === "workspace") {
      const rules = state.appliedPermissionRules?.length
        ? `已应用本项目授权规则: ${state.appliedPermissionRules.join("; ")}`
        : ""
      return rules
        ? `✅ 用户已允许命令执行（本项目）。${rules}`
        : "✅ 用户已允许命令执行（本项目）。"
    }
    return "✅ 用户已允许命令执行。"
  }
  if (state.outcome === "rejected") return "⛔ 用户已拒绝命令执行。"
  if (state.outcome === "unavailable") return "⛔ 命令需要确认，但当前没有确认通道，已拒绝。"
  if (state.outcome === "failed") return "⛔ 命令确认失败，已拒绝执行。"
  return ""
}

function withConfirmationOutcome(result: string | CommandExecutionResult, state: ConfirmationState): string {
  if (typeof result !== "string") {
    state.execution = result
    result = result.text
  } else {
    state.execution = { text: result, stdout: result, stderr: "", exitCode: 0, truncated: false }
  }
  const text = confirmationOutcomeText(state)
  return text ? `${text}\n${result}` : result
}

function cancelledWithConfirmationOutcome(result: string, state: ConfirmationState): string {
  const detail = result.replace(/^⛔ 用户已取消执行\s*/u, "").trim()
  return withConfirmationOutcome(detail, state)
}

function normalizeConfirmationResponse(result: CommandConfirmationResponse): { allowed: boolean; scope?: CommandConfirmationScope; applyPermissionSuggestions: boolean } {
  if (typeof result === "boolean") {
    return result
      ? { allowed: true, scope: "session", applyPermissionSuggestions: true }
      : { allowed: false, applyPermissionSuggestions: false }
  }
  if (!result) return { allowed: false, applyPermissionSuggestions: false }
  const allowed = result.allow === true
  const scope = result.scope === "session" || result.scope === "workspace" ? result.scope : "once"
  return {
    allowed,
    scope: allowed ? scope : undefined,
    applyPermissionSuggestions: allowed && (scope === "session" || scope === "workspace"),
  }
}

async function askUser(
  cmd: string,
  reason: string,
  ctx?: ToolContext,
  state?: ConfirmationState,
  request?: CommandConfirmationRequest,
): Promise<boolean> {
  if (!ctx?.confirmCommand) {
    state && (state.outcome = "unavailable")
    return false
  }
  const summary = reason.replace(/\s+/g, " ").trim()
  ctx.onUpdate?.(`⏳ 等待用户确认命令执行: ${summary}\n`)
  try {
    const result = normalizeConfirmationResponse(await ctx.confirmCommand(cmd, reason, request))
    if (state) {
      state.outcome = result.allowed ? "allowed" : "rejected"
      state.scope = result.scope
      state.applyPermissionSuggestions = result.applyPermissionSuggestions
    }
    return result.allowed
  } catch {
    state && (state.outcome = "failed")
    return false
  }
}

type CommandPathValidationResult = ReturnType<typeof validateCommandPaths>

function permissionSuggestionText(pathResult: CommandPathValidationResult): string {
  if (pathResult.allowed || !pathResult.suggestions?.length) return ""
  const rendered = pathResult.suggestions.map((suggestion) => {
    if (suggestion.type === "addWorkingDirectory") {
      return `加入工作目录: ${suggestion.directory}`
    }
    return `加入规则: ${suggestion.rule.ruleContent}`
  })
  return `\n选择会话或项目授权后将应用: ${rendered.join("; ")}`
}

function pathConfirmationReason(pathResult: CommandPathValidationResult): string {
  if (pathResult.allowed) return ""
  return `${pathResult.reason}${permissionSuggestionText(pathResult)}`
}

function appliedPermissionRuleLabel(suggestion: PermissionSuggestion): string {
  if (suggestion.type === "addWorkingDirectory") return `WorkingDirectory(${suggestion.directory})`
  return suggestion.rule.ruleContent
}

async function applyPathPermissionSuggestions(
  pathResult: CommandPathValidationResult,
  ctx: ToolContext | undefined,
  scope: "session" | "workspace",
): Promise<string[]> {
  if (pathResult.allowed || !pathResult.suggestions?.length || !ctx?.applyPermissionSuggestions) return []
  await ctx.applyPermissionSuggestions(pathResult.suggestions, scope)
  return pathResult.suggestions.map(appliedPermissionRuleLabel)
}

function commandConfirmationRequest(pathResult: CommandPathValidationResult): CommandConfirmationRequest | undefined {
  if (pathResult.allowed || !pathResult.suggestions?.length) return undefined
  return { permissionSuggestions: pathResult.suggestions }
}

async function maybeApplyPathPermissionSuggestions(pathResult: CommandPathValidationResult, ctx: ToolContext | undefined, state: ConfirmationState): Promise<void> {
  if (!state.applyPermissionSuggestions || (state.scope !== "session" && state.scope !== "workspace")) return
  state.appliedPermissionRules = await applyPathPermissionSuggestions(pathResult, ctx, state.scope)
}

async function executeCmd(cmd: string, args: Record<string, unknown>, ctx?: ToolContext, shellDialect = shellDialectForCommand(cmd, ctx)): Promise<string> {
  const cwd = String(args.cwd || ctx?.cwd || process.cwd())
  const timeout = Number(args.timeout) || COMMAND_TIMEOUT

  return new Promise<string>((resolve, reject) => {
    const isWin = isWindows()
    const bashExecutable = shellDialect === "posix-bash" ? resolveBashExecutable() : undefined
    if (shellDialect === "posix-bash" && !bashExecutable) {
      resolve("⛔ POSIX Bash shell 未找到。请设置 MY_CODE_AGENT_BASH_PATH 指向 Git Bash 的 bash.exe。")
      return
    }

    const env = commandExecutionEnv()
    const shellCommand = isWin ? `chcp 65001>nul && ${cmd}` : cmd
    const child = bashExecutable
      ? spawn(bashExecutable, ["-lc", cmd], { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false, timeout, windowsHide: true })
      : spawn(shellCommand, [], { cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: true, timeout, windowsHide: true })
    let stdout = "", stderr = "", truncated = false
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8")
    const pushUpdate = (chunk: string) => ctx?.onUpdate?.(chunk)
    child.stdout?.on("data", (data: Buffer) => {
      const text = decodeCommandChunk(data, stdoutDecoder)
      const remaining = MAX_OUTPUT - stdout.length
      if (remaining <= 0) return
      if (text.length >= remaining) { stdout += text.slice(0, remaining) + "\n...截断"; truncated = true; pushUpdate(text.slice(0, remaining)); pushUpdate("\n...截断"); child.kill(); return }
      stdout += text; pushUpdate(text)
    })
    child.stderr?.on("data", (data: Buffer) => {
      const text = decodeCommandChunk(data, stderrDecoder)
      const remaining = MAX_OUTPUT - stderr.length
      if (remaining <= 0) return
      if (text.length >= remaining) { stderr += text.slice(0, remaining) + "\n...截断"; truncated = true; pushUpdate(text.slice(0, remaining)); pushUpdate("\n...截断"); child.kill(); return }
      stderr += text; pushUpdate(text)
    })
    child.on("error", (err) => { ctx?.onUpdate?.(`执行失败: ${err.message}\n`); reject(new Error(err.message)) })
    child.on("close", (code) => {
      const st = stdoutDecoder.end(), se = stderrDecoder.end()
      if (st) stdout += st; if (se) stderr += se
      let result = ""
      if (stdout) result += stdout
      if (stderr) result += (result ? "\n" : "") + stderr
      if (code !== null && code !== 0) result += `\n⚠ 退出码: ${code}`
      resolve(result || `已完成（退出码: ${code}）`)
    })
  })
}

// ─── 工具定义 ───────────────────────────────────────────

export const commandTool: AgentTool = defineAgentTool({
  name: "command",
  description: "执行 shell 命令，支持流式实时 stdout/stderr。Windows 未显式配置 shell 且检测到 Git Bash 时默认使用 POSIX Bash；没有 Git Bash 时回退 cmd.exe。可通过 shellDialect 显式选择 cmd 或 posix-bash。readOnly=true 时仅可执行只读命令。安全测试时也要原样调用本工具；危险命令由工具内置安全层返回拦截或确认信息，不要在调用前改写或自然语言拒绝。",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      cwd: { type: "string", description: "工作目录（可选）" },
      timeout: { type: "number", description: "超时（毫秒，默认 300000）" },
      readOnly: { type: "boolean", description: "只读模式，true 时仅允许只读命令" },
    },
    required: ["command"],
  },
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  operations: ["execute"],
  riskLevel: "high",
  needsPermission: false,
  workspaceBounded: false,
  authorizationMode: "specialized",
  resultFormat: "structured",
  execute: async (args, ctx) => {
    const cmd = String(args.command ?? "").trim()
    const confirmationState: ConfirmationState = {}
    confirmationState.command = cmd
    confirmationState.cwd = String(args.cwd || ctx?.cwd || process.cwd())
    if (!cmd) return commandDecisionResult("请输入要执行的命令", ctx, confirmationState, "deny", "Command is empty")
    const executionCwd = String(args.cwd || ctx?.cwd || process.cwd())
    const workspaceRoot = String(ctx?.workspace || ctx?.cwd || process.cwd())
    const shellDialect = shellDialectForCommand(cmd, ctx)
    confirmationState.shellDialect = shellDialect
    const parsed = await parseCommandForSecurityAsync(cmd, { shellDialect })

    const danger = isDangerousCommand(cmd, { parsed, shellDialect })
    if (danger.dangerous) {
      await maybeLogSecurityVerdictShadowDiff(cmd, { cwd: executionCwd, workspaceRoot, shellDialect })
      return commandDecisionResult(
        "⛔ 危险命令已拦截：该命令命中强制安全规则。",
        ctx,
        confirmationState,
        "deny",
        "Command matched a mandatory safety rule",
        {
          code: "dangerous",
          category: "safety",
          decision: "block",
          message: "安全策略已阻止高风险操作。",
          reason: "命令命中强制安全规则",
          operation: "execute",
          target: "高风险命令",
          recoverable: false,
          suggestions: [],
        },
      )
    }

    let dangerConfirmed = false
    if (danger.requiresConfirmation) {
      const dangerReason = danger.reason || "High-risk command requires confirmation"
      if (!(await askUser(cmd, dangerReason, ctx, confirmationState))) {
        return commandDecisionResult(cancelledWithConfirmationOutcome("Command confirmation was rejected", confirmationState), ctx, confirmationState, "deny", dangerReason)
      }
      dangerConfirmed = true
    }

    const compatibilityWarning = windowsCompatibilityWarning(cmd, shellDialect)
    if (compatibilityWarning) return commandDecisionResult(compatibilityWarning, ctx, confirmationState, "deny", "Shell compatibility check failed")

    const cmdIsReadOnly = isCommandReadOnly(cmd, { parsed, shellDialect })
    const readOnlyRequested = args.readOnly === true
    const mode = ctx?.getPermissionMode?.() ?? ctx?.permissionMode ?? "standard"
    const pathResult = validateCommandPaths(cmd, {
      cwd: executionCwd,
      workspaceRoot,
      shellDialect,
      parsed,
      additionalWorkingDirectories: ctx?.additionalWorkingDirectories,
      alwaysAllowRules: ctx?.alwaysAllowRules,
      alwaysDenyRules: ctx?.alwaysDenyRules,
      alwaysAskRules: ctx?.alwaysAskRules,
    })
    await maybeLogSecurityVerdictShadowDiff(cmd, { cwd: executionCwd, workspaceRoot, shellDialect })

    if (mode !== "yes" && !pathResult.allowed && pathResult.hardDeny) {
      return commandDecisionResult(`⛔ 路径安全检查未通过: ${pathResult.reason}`, ctx, confirmationState, "deny", pathResult.reason)
    }

    if (readOnlyRequested) {
      if (!cmdIsReadOnly) return commandDecisionResult(`⛔ 当前处于只读模式，不允许执行非只读命令: ${cmd.slice(0, 100)}`, ctx, confirmationState, "deny", "Command violates the read-only constraint")
      if (!pathResult.allowed || mode === "plan") {
        const reason = pathResult.allowed
          ? "当前为 plan 模式，所有命令需确认"
          : `当前处于只读模式，路径安全检查需要确认: ${pathConfirmationReason(pathResult)}`
        if (!(await askUser(cmd, reason, ctx, confirmationState, commandConfirmationRequest(pathResult)))) {
          return commandDecisionResult(pathResult.allowed
            ? cancelledWithConfirmationOutcome("⛔ 用户已取消执行", confirmationState)
            : cancelledWithConfirmationOutcome(`⛔ 路径安全检查需要确认: ${pathResult.reason}`, confirmationState), ctx, confirmationState, "deny", "Command confirmation was not granted")
        }
        await maybeApplyPathPermissionSuggestions(pathResult, ctx, confirmationState)
      }
      return commandDecisionResult(withConfirmationOutcome(await executeCmd(cmd, args, ctx, shellDialect), confirmationState), ctx, confirmationState, "allow")
    }

    if (mode === "yes") {
      return commandDecisionResult(withConfirmationOutcome(await executeCmd(cmd, args, ctx, shellDialect), confirmationState), ctx, confirmationState, "allow")
    }

    if (mode === "plan") {
      const reason = pathResult.allowed
        ? "当前为 plan 模式，所有命令需确认"
        : `当前为 plan 模式，且路径安全检查需要确认: ${pathConfirmationReason(pathResult)}`
      if (!(await askUser(cmd, reason, ctx, confirmationState, commandConfirmationRequest(pathResult)))) {
        return commandDecisionResult(cancelledWithConfirmationOutcome("⛔ 用户已取消执行", confirmationState), ctx, confirmationState, "deny", "Command confirmation was not granted")
      }
      await maybeApplyPathPermissionSuggestions(pathResult, ctx, confirmationState)
    } else if (mode === "dontAsk") {
      if (!pathResult.allowed) {
        if (!(await askUser(cmd, `路径安全检查需要确认: ${pathConfirmationReason(pathResult)}`, ctx, confirmationState, commandConfirmationRequest(pathResult)))) {
          return commandDecisionResult(cancelledWithConfirmationOutcome(`⛔ 路径安全检查需要确认: ${pathResult.reason}`, confirmationState), ctx, confirmationState, "deny", "Command path confirmation was not granted")
        }
        await maybeApplyPathPermissionSuggestions(pathResult, ctx, confirmationState)
      }
    } else {
      const standardAutoAllow = mode === "standard" && pathResult.allowed && (
        isPureFileOperation(parsed) || isRegularGitOperation(parsed)
      )
      if (!pathResult.allowed || (!dangerConfirmed && !cmdIsReadOnly && !standardAutoAllow)) {
        const reason = pathResult.allowed
          ? "该命令不是只读操作，是否允许执行？"
          : `该命令不是只读操作，且路径安全检查需要确认: ${pathConfirmationReason(pathResult)}`
        if (!(await askUser(cmd, reason, ctx, confirmationState, commandConfirmationRequest(pathResult)))) {
          return commandDecisionResult(cancelledWithConfirmationOutcome("⛔ 用户已取消执行", confirmationState), ctx, confirmationState, "deny", "Command confirmation was not granted")
        }
        await maybeApplyPathPermissionSuggestions(pathResult, ctx, confirmationState)
      }
    }

    return commandDecisionResult(withConfirmationOutcome(await executeCmd(cmd, args, ctx, shellDialect), confirmationState), ctx, confirmationState, "allow")
  },
})
