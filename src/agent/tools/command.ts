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
import type { AgentTool, ToolContext } from "../types.js"
import { spawn } from "child_process"
import { StringDecoder } from "string_decoder"
import { TextDecoder } from "util"
import { validateCommandPaths } from "./command/path-validation.js"
import { isCommandReadOnly } from "./command/read-only.js"
import { parseShellCommand, tokensWithoutRedirects } from "./command/shell-parser.js"

const MAX_OUTPUT = 100 * 1024 // 100KB 总输出上限
const COMMAND_TIMEOUT = 300_000 // 5 分钟

/* eslint-disable @typescript-eslint/no-non-null-assertion */

export function isReadOnlyCommand(cmd: string): boolean {
  return isCommandReadOnly(cmd)
}

function _hasShellExpansion(cmd: string): boolean {
  if (/\$\(/.test(cmd)) return true
  if (/`/.test(cmd)) return true
  if (/[<>]\(/.test(cmd)) return true
  return false
}

function _hasUnquotedLineBreak(cmd: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (escaped) { escaped = false; continue }
    if (c === "\\" && !inSingleQuote) { escaped = true; continue }
    if (c === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue }
    if (c === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue }
    if ((c === "\n" || c === "\r") && !inSingleQuote && !inDoubleQuote) return true
  }
  return false
}

// ─── 危险命令检测 ───────────────────────────────────────

type DangerResult = { dangerous: false } | { dangerous: true; reason: string }

function _firstTarget(cmd: string, from: number): string {
  const rest = cmd.slice(from)
  const tokens = rest.split(/\s+/).filter(t => t && t !== "--" && !t.startsWith("-"))
  return tokens[0] ?? ""
}

function _normalizeTarget(target: string): string {
  let t = target.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim()
  t = t.replace(/^\$HOME(?:\/|$)/, '~/').replace(/^\${HOME}(?:\/|$)/, '~/')
  t = t.replace(/^\$HOME$/, '~').replace(/^\${HOME}$/, '~')
  t = t.replace(/^%USERPROFILE%/, '~').replace(/^%HOMEPATH%/, '~')
  t = t.replace(/^%HOMEDRIVE%%HOMEPATH%/, '~')
  t = t.replace(/^%WINDIR%/, '/Windows').replace(/^%SystemRoot%/, '/Windows')
  if (/^[A-Za-z]:\\/.test(t)) { const rest = t.slice(2).replace(/\\/g, '/'); t = rest ? '/' + rest : '/' }
  if (t === '/*') return '/'
  if (/^\/\.+$/.test(t)) return '/'
  if (/^\/\//.test(t)) { t = t.replace(/^\/+/, '/'); if (t === '/*') return '/' }
  return t
}

function _rmIsDangerous(trimmed: string): boolean {
  const m = trimmed.match(/\brm\b/)
  if (!m) return false
  const afterRm = trimmed.slice(m.index! + m[0].length)
  if (!/\s(-[a-z]*r[a-z]*|--recursive)\b/.test(afterRm) || !/\s(-[a-z]*f[a-z]*|--force)\b/.test(afterRm)) return false
  if (/\s--no-preserve-root\b/.test(afterRm)) return true
  const rawTarget = _firstTarget(trimmed, m.index! + m[0].length)
  if (!rawTarget) return false
  const target = _normalizeTarget(rawTarget)
  if (target === "/" || target === "~") return true
  if (target === ".") return true
  if (/^\.\.(\/|$)/.test(target)) return true
  if (/^\/(etc|usr|bin|boot|dev|var|sbin|lib|opt|sys|proc|root|home)(\/|$)/.test(target)) return true
  if (/^~[\/]/.test(target)) return true
  if (/^\/(Windows|Users|Program\s?Files|ProgramData)(\/|$)/i.test(target)) return true
  return false
}

function _gitPushIsForce(trimmed: string): boolean {
  const m = trimmed.match(/\bgit\s+push\b/)
  if (!m) return false
  const afterPush = trimmed.slice(m.index! + m[0].length)
  if (/\s(-f\b|--force\b|--force-with-lease\b)/.test(" " + afterPush)) return true
  if (/\+[a-zA-Z]/.test(afterPush)) return true
  return false
}

function _gitCleanIsDangerous(trimmed: string): boolean {
  const m = trimmed.match(/\bgit\s+clean\b/)
  if (!m) return false
  const afterClean = trimmed.slice(m.index! + m[0].length)
  return /-[a-z]*d[a-z]*\b/.test(afterClean) && /-[a-z]*f[a-z]*\b/.test(afterClean)
}

function _chmodIsDangerous(trimmed: string): boolean {
  const m = trimmed.match(/\bchmod\b/)
  if (!m) return false
  const afterChmod = trimmed.slice(m.index! + m[0].length)
  if (!/\s-R\b/.test(afterChmod)) return false
  const tokens = afterChmod.split(/\s+/).filter(t => t && t !== "--")
  const lastToken = tokens[tokens.length - 1]
  if (!lastToken) return false
  const target = _normalizeTarget(lastToken)
  return target === "/" || target === "." || target === "~" || /^\/(etc|usr|bin|boot|dev|var|sbin|lib|opt|Windows|Users|home)(\/|$)/i.test(target)
}

function _removeItemIsDangerous(trimmed: string): boolean {
  const m = trimmed.match(/\bRemove-Item\b/i)
  if (!m) return false
  const afterCmd = trimmed.slice(m.index! + m[0].length)
  if (!/\s(-R\b|-Recurse\b|-r\b)/i.test(afterCmd) || !/\s(-F\b|-Force\b|-fo\b)/i.test(afterCmd)) return false
  const tokens = afterCmd.split(/\s+/).filter(t => t && !t.startsWith('-'))
  const target = tokens[tokens.length - 1]
  if (!target) return false
  const nt = _normalizeTarget(target)
  return nt === "/" || nt === "~" || nt === "." || /^\/(etc|usr|bin|boot|dev|var|sbin|lib|opt|Windows|Users)(\/|$)/i.test(nt)
}

function _delIsDangerous(trimmed: string): boolean {
  let m = trimmed.match(/\b(del|erase)\b/i)
  if (m) {
    const afterCmd = trimmed.slice(m.index! + m[0].length)
    if (!/\s\/s\b/i.test(afterCmd) || !/\s\/f\b/i.test(afterCmd)) return false
    const tokens = afterCmd.split(/\s+/).filter(t => t && !t.startsWith('/'))
    const target = tokens[tokens.length - 1] ?? ""
    const nt = _normalizeTarget(target)
    return nt === "/" || /^\/(Windows|Users)/i.test(nt)
  }
  m = trimmed.match(/\b(rmdir|rd)\b/i)
  if (!m) return false
  const afterCmd = trimmed.slice(m.index! + m[0].length)
  if (!/\s\/s\b/i.test(afterCmd) || !/\s\/q\b/i.test(afterCmd)) return false
  const tokens = afterCmd.split(/\s+/).filter(t => t && !t.startsWith('/'))
  const target = tokens[tokens.length - 1] ?? ""
  const nt = _normalizeTarget(target)
  return nt === "/" || /^\/(Windows|Users)/i.test(nt)
}

// ─── CC 安全模式检查 ──────────────────────────────
// 从 Claude Code bashSecurity.ts 提取的 12 类攻击面

function _hasCarriageReturn(cmd: string): boolean {
  if (!cmd.includes('\r')) return false
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (escaped) { escaped = false; continue }
    if (c === "\\" && !inSingleQuote) { escaped = true; continue }
    if (c === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue }
    if (c === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue }
    if (c === '\r' && !inDoubleQuote) return true
  }
  return false
}

function _extractQuoteContext(cmd: string): { withDoubleQuotes: string; fullyUnquoted: string } {
  let withDoubleQuotes = ""
  let fullyUnquoted = ""
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (escaped) {
      escaped = false
      if (!inSingleQuote) withDoubleQuotes += c
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += c
      continue
    }
    if (c === "\\" && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote) withDoubleQuotes += c
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += c
      continue
    }
    if (c === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue }
    if (c === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue }
    if (!inSingleQuote) withDoubleQuotes += c
    if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += c
  }

  return { withDoubleQuotes, fullyUnquoted }
}

function _hasUnquotedShellOperator(cmd: string, from: number, operators: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = from; i < cmd.length; i++) {
    const c = cmd[i]
    if (escaped) { escaped = false; continue }
    if (c === "\\" && !inSingleQuote) { escaped = true; continue }
    if (c === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue }
    if (c === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue }
    if (!inSingleQuote && !inDoubleQuote && operators.includes(c)) return true
  }

  return false
}

function _isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === "\\") {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

function _hasDangerousVariables(cmd: string): boolean {
  const content = _extractQuoteContext(cmd).fullyUnquoted
  const variableRef = String.raw`(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\})`
  return new RegExp(String.raw`[<>|]\s*${variableRef}`).test(content) ||
    new RegExp(String.raw`${variableRef}\s*[|<>]`).test(content)
}

function _hasIFSInjection(cmd: string): boolean {
  return /\bIFS\s*=/.test(cmd) || /\$IFS\b|\$\{[^}]*IFS/.test(cmd)
}

function _hasProcEnvironAccess(cmd: string): boolean {
  return /\/proc\/.*\/environ/.test(cmd)
}

function _hasObfuscatedFlags(cmd: string): boolean {
  if (/\$['"]-/.test(cmd)) return true
  if (/(?:^|\s)(?:''|"")+\s*-/.test(cmd)) return true
  if (/(?:""|'')+['"]-/.test(cmd)) return true
  return false
}

function _hasBraceExpansion(cmd: string): boolean {
  const content = _extractQuoteContext(cmd).fullyUnquoted
  let openBraces = 0
  let closeBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{" && !_isEscapedAtPosition(content, i)) openBraces++
    if (content[i] === "}" && !_isEscapedAtPosition(content, i)) closeBraces++
  }
  if (openBraces > 0 && closeBraces > openBraces) return true

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "{" || _isEscapedAtPosition(content, i)) continue
    let depth = 1
    for (let j = i + 1; j < content.length; j++) {
      if (content[j] === "{" && !_isEscapedAtPosition(content, j)) depth++
      if (content[j] !== "}" || _isEscapedAtPosition(content, j)) continue
      depth--
      if (depth !== 0) continue
      const inner = content.slice(i + 1, j)
      if (inner.includes(",") || /^[0-9A-Za-z]\.\.[0-9A-Za-z]$/.test(inner)) return true
      i = j
      break
    }
  }
  return false
}

function _hasUnicodeWhitespace(cmd: string): boolean {
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd.charCodeAt(i)
    // Non-breaking space (0xA0), various Unicode spaces (0x2000-0x200A),
    // line separator (0x2028), paragraph separator (0x2029),
    // BOM (0xFEFF), zero-width space (0x200B)
    if (c === 0xA0 || (c >= 0x2000 && c <= 0x200B) || c === 0x2028 || c === 0x2029 || c === 0xFEFF) return true
  }
  return false
}

function _hasBackslashEscapedWhitespace(cmd: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  for (let i = 0; i < cmd.length - 1; i++) {
    const c = cmd[i]
    if (c === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue }
    if (c === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue }
    if (c === "\\" && !inSingleQuote && !inDoubleQuote && /\s/.test(cmd[i + 1] ?? "")) return true
  }
  return false
}

function _hasBackslashEscapedOperators(cmd: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  for (let i = 0; i < cmd.length - 1; i++) {
    const c = cmd[i]
    if (c === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue }
    if (c === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue }
    if (c === "\\" && !inSingleQuote && !inDoubleQuote && /[;&|<>]/.test(cmd[i + 1] ?? "")) return true
  }
  return false
}

function _hasNetworkRedirect(cmd: string): boolean {
  const content = _extractQuoteContext(cmd).fullyUnquoted
  return /(?:^|\s)\d?>\s*\/dev\/(tcp|udp)/.test(content) || /(?:^|\s)\d?<\s*\/dev\/(tcp|udp)/.test(content)
}

function _gitCommitIsInjected(cmd: string): boolean {
  const m = cmd.match(/\bgit\s+commit\b/)
  if (!m) return false
  return _hasUnquotedShellOperator(cmd, m.index! + m[0].length, ";&|<>")
}

function _hasShellMetacharacters(cmd: string): boolean {
  const { withDoubleQuotes } = _extractQuoteContext(cmd)
  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(withDoubleQuotes)) return true
  if (/(?:^|\s)-(?:name|path|iname)\s+["'][^"']*[;|&][^"']*["']/.test(cmd)) return true
  if (/(?:^|\s)-regex\s+["'][^"']*[;&][^"']*["']/.test(cmd)) return true
  return false
}

function _checkCCSecurityPatterns(cmd: string): DangerResult | null {
  if (_hasCarriageReturn(cmd)) return { dangerous: true, reason: `命令含回车符(\\r)可绕过安全检查: ${cmd.slice(0, 120)}` }
  if (_hasDangerousVariables(cmd)) return { dangerous: true, reason: `变量靠近重定向/管道可绕过检查: ${cmd.slice(0, 120)}` }
  if (_hasIFSInjection(cmd)) return { dangerous: true, reason: `IFS 变量可改变 shell 分隔符: ${cmd.slice(0, 120)}` }
  if (_hasProcEnvironAccess(cmd)) return { dangerous: true, reason: `访问 /proc/*/environ 可能泄露环境变量: ${cmd.slice(0, 120)}` }
  if (_hasObfuscatedFlags(cmd)) return { dangerous: true, reason: `ANSI-C/区域引用可隐藏危险 flag: ${cmd.slice(0, 120)}` }
  if (_hasBraceExpansion(cmd)) return { dangerous: true, reason: `花括号展开可在安全检测后注入参数: ${cmd.slice(0, 120)}` }
  if (_hasUnicodeWhitespace(cmd)) return { dangerous: true, reason: `Unicode 空白字符可绕过命令名检测: ${cmd.slice(0, 120)}` }
  if (_hasBackslashEscapedWhitespace(cmd)) return { dangerous: true, reason: `反斜杠转义空白改变 shell 分词: ${cmd.slice(0, 120)}` }
  if (_hasBackslashEscapedOperators(cmd)) return { dangerous: true, reason: `反斜杠转义运算符可隐藏命令分隔符: ${cmd.slice(0, 120)}` }
  if (_hasNetworkRedirect(cmd)) return { dangerous: true, reason: `网络重定向到 /dev/(tcp|udp): ${cmd.slice(0, 120)}` }
  if (_gitCommitIsInjected(cmd)) return { dangerous: true, reason: `git commit -m 前含 shell 运算符: ${cmd.slice(0, 120)}` }
  if (_hasShellMetacharacters(cmd)) return { dangerous: true, reason: `命令参数中包含 shell 元字符(;|&): ${cmd.slice(0, 120)}` }
  return null
}

// ─── 正则模式 ──────────────────────────────────────────

const _DANGEROUS_FS = [
  /\bmkfs\b/i, /\bdd\s+if=.*\s+of=/i, /\bformat\s+[a-z]:/i, /\bfdisk\b/i,
  /\bmkswap\b/i, /\bparted\b/i, /\b>\/dev\/(sda|sdb|sdc|nvme|hd[a-z])/,
  /:\s*\(\s*\)\s*\{[^}]*:.*:.*&?\s*;?\s*\}\s*;\s*:/s,
  /\b(rmdir|rd)\s+\/s\s+\/q\b/i,
]

const _DANGEROUS_SYSTEM = [
  /\bsudo\s+/, /\bsu\s+-/, /\bshutdown\b/, /\breboot\b/, /\bhalt\b/,
  /\bpoweroff\b/, /\binit\s+0\b/, /\binit\s+6\b/,
  /\bsystemctl\s+(stop|disable|mask|reboot|poweroff)\s+/,
]

const _DANGEROUS_PIPE_SHELL = [
  /(curl|wget)\b[^|;]*\|\s*(bash|sh|zsh|powershell|pwsh)\b/i,
  /(curl|wget)\b[^|;]*\|\s*sudo\s+(bash|sh)/i,
]

const _DANGEROUS_GIT_SIMPLE = [
  /\bgit\s+reset\s+--hard\s*(\s|$)/, /\bgit\s+checkout\s+--force\b/,
  /\bgit\s+rebase\s+--(onto|interactive)\b/,
]

const _DANGEROUS_KILL = [
  /\bkill\s+-9\b/, /\bpkill\s+-9\b/, /\bkillall\b/, /\btaskkill\s+\/f\b/i,
]

export function isDangerousCommand(cmd: string): DangerResult {
  const trimmed = cmd.trim()
  if (!trimmed) return { dangerous: false }

  if (_hasShellExpansion(trimmed)) {
    return { dangerous: true, reason: `Shell 展开/替换语法可执行任意代码: ${trimmed.slice(0, 120)}` }
  }
  if (_hasUnquotedLineBreak(trimmed)) {
    return { dangerous: true, reason: `命令含未引用换行符，可注入额外命令: ${trimmed.slice(0, 120)}` }
  }

  // CC 安全模式检查（12 类攻击面）
  const ccResult = _checkCCSecurityPatterns(trimmed)
  if (ccResult) return ccResult

  if (_rmIsDangerous(trimmed)) return { dangerous: true, reason: `递归删除危险路径: ${trimmed.slice(0, 120)}` }
  if (_gitPushIsForce(trimmed)) return { dangerous: true, reason: `Git 强制推送: ${trimmed.slice(0, 120)}` }
  if (_gitCleanIsDangerous(trimmed)) return { dangerous: true, reason: `Git clean 删除文件: ${trimmed.slice(0, 120)}` }
  if (_chmodIsDangerous(trimmed)) return { dangerous: true, reason: `文件权限高危操作: ${trimmed.slice(0, 120)}` }
  if (_delIsDangerous(trimmed)) return { dangerous: true, reason: `Windows 强制递归删除: ${trimmed.slice(0, 120)}` }
  if (_removeItemIsDangerous(trimmed)) return { dangerous: true, reason: `PowerShell 递归删除: ${trimmed.slice(0, 120)}` }

  const patternChecks = [
    { patterns: _DANGEROUS_FS, cat: "文件系统破坏性操作" },
    { patterns: _DANGEROUS_SYSTEM, cat: "系统控制命令" },
    { patterns: _DANGEROUS_PIPE_SHELL, cat: "远程下载后执行" },
    { patterns: _DANGEROUS_GIT_SIMPLE, cat: "Git 破坏性操作" },
    { patterns: _DANGEROUS_KILL, cat: "进程杀伤" },
  ] as const

  for (const { patterns, cat } of patternChecks) {
    for (const re of patterns) {
      if (re.test(trimmed)) return { dangerous: true, reason: `${cat}: ${trimmed.slice(0, 120)}` }
    }
  }

  return { dangerous: false }
}

// ─── 通用函数 ───────────────────────────────────────────

function isWindows(): boolean { return process.platform === "win32" }

function decodeCommandChunk(data: Buffer, decoder: StringDecoder): string {
  const text = decoder.write(data)
  if (!isWindows() || !text.includes("�")) return text
  try { return new TextDecoder("gb18030").decode(data) } catch { return text }
}

function windowsCompatibilityWarning(cmd: string): string | undefined {
  if (!isWindows()) return undefined
  const parsed = parseShellCommand(cmd, { windowsShell: true })
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

// ─── 权限模式 ───────────────────────────────────────────

async function askUser(cmd: string, reason: string, ctx?: ToolContext): Promise<boolean> {
  if (!ctx?.confirmCommand) return false
  try {
    const result = await ctx.confirmCommand(cmd, reason)
    return result === true
  } catch { return false }
}

async function executeCmd(cmd: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const cwd = String(args.cwd || ctx?.cwd || process.cwd())
  const timeout = Number(args.timeout) || COMMAND_TIMEOUT

  return new Promise<string>((resolve, reject) => {
    const isWin = isWindows()
    const shellCommand = isWin ? `chcp 65001>nul && ${cmd}` : cmd
    const child = spawn(shellCommand, [], { cwd, stdio: ["pipe", "pipe", "pipe"], shell: true, timeout, windowsHide: true })
    let stdout = "", stderr = ""
    const stdoutDecoder = new StringDecoder("utf8"), stderrDecoder = new StringDecoder("utf8")
    const pushUpdate = (chunk: string) => ctx?.onUpdate?.(chunk)
    child.stdout?.on("data", (data: Buffer) => {
      const text = decodeCommandChunk(data, stdoutDecoder)
      const remaining = MAX_OUTPUT - stdout.length
      if (remaining <= 0) return
      if (text.length >= remaining) { stdout += text.slice(0, remaining) + "\n...截断"; pushUpdate(text.slice(0, remaining)); pushUpdate("\n...截断"); child.kill(); return }
      stdout += text; pushUpdate(text)
    })
    child.stderr?.on("data", (data: Buffer) => {
      const text = decodeCommandChunk(data, stderrDecoder)
      const remaining = MAX_OUTPUT - stderr.length
      if (remaining <= 0) return
      if (text.length >= remaining) { stderr += text.slice(0, remaining) + "\n...截断"; pushUpdate(text.slice(0, remaining)); pushUpdate("\n...截断"); child.kill(); return }
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

export const commandTool: AgentTool = {
  name: "command",
  description: "执行 shell 命令，支持流式实时 stdout/stderr。Windows 默认使用 cmd.exe 语法（dir/type/copy/move/mkdir；不要用 mkdir -p，cat/rg 仅在已安装时可用）。readOnly=true 时仅可执行查看命令。",
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
  execute: async (args, ctx) => {
    const cmd = String(args.command ?? "").trim()
    if (!cmd) return "请输入要执行的命令"

    const danger = isDangerousCommand(cmd)
    if (danger.dangerous) return `⛔ 危险命令已拦截: ${danger.reason}\n如需执行该命令，请在终端中手动运行。`

    const compatibilityWarning = windowsCompatibilityWarning(cmd)
    if (compatibilityWarning) return compatibilityWarning

    const cmdIsReadOnly = isReadOnlyCommand(cmd)
    const readOnlyRequested = args.readOnly === true
    const executionCwd = String(args.cwd || ctx?.cwd || process.cwd())
    const pathResult = validateCommandPaths(cmd, {
      cwd: executionCwd,
      workspaceRoot: ctx?.workspace || ctx?.cwd || process.cwd(),
    })

    if (!pathResult.allowed && pathResult.hardDeny) {
      return `⛔ 路径安全检查未通过: ${pathResult.reason}`
    }

    if (readOnlyRequested) {
      if (!cmdIsReadOnly) return `⛔ 当前处于只读模式，不允许执行非只读命令: ${cmd.slice(0, 100)}`
      if (!pathResult.allowed) return `⛔ 当前处于只读模式，路径安全检查未通过: ${pathResult.reason}`
      if (ctx?.permissionMode === "plan") {
        if (!(await askUser(cmd, "当前为 plan 模式，所有命令需确认", ctx))) return "⛔ 用户已取消执行"
      }
      return executeCmd(cmd, args, ctx)
    }

    const mode = ctx?.permissionMode ?? "default"
    if (mode === "plan") {
      const reason = pathResult.allowed
        ? "当前为 plan 模式，所有命令需确认"
        : `当前为 plan 模式，且路径安全检查需要确认: ${pathResult.reason}`
      if (!(await askUser(cmd, reason, ctx))) return "⛔ 用户已取消执行"
    } else if (mode === "dontAsk") {
      if (!pathResult.allowed) {
        if (!(await askUser(cmd, `路径安全检查需要确认: ${pathResult.reason}`, ctx))) {
          return `⛔ 路径安全检查需要确认: ${pathResult.reason}`
        }
      }
    } else {
      if (!cmdIsReadOnly || !pathResult.allowed) {
        const reason = mode === "acceptEdits"
          ? (pathResult.allowed
            ? "acceptEdits 仅自动接受文件编辑，shell 非只读命令仍需确认"
            : `acceptEdits 仅自动接受文件编辑，且路径安全检查需要确认: ${pathResult.reason}`)
          : (pathResult.allowed
            ? "该命令不是只读操作，是否允许执行？"
            : `该命令不是只读操作，且路径安全检查需要确认: ${pathResult.reason}`)
        if (!(await askUser(cmd, reason, ctx))) return "⛔ 用户已取消执行"
      }
    }

    return executeCmd(cmd, args, ctx)
  },
}
