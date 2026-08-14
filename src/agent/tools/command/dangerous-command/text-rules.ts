import { confirmDanger, normalizeTarget, type DangerResult } from "./shared.js"

function hasShellExpansion(cmd: string): boolean {
  if (/\$\(/.test(cmd)) return true
  if (/`/.test(cmd)) return true
  if (/[<>]\(/.test(cmd)) return true
  return false
}

function hasUnquotedLineBreak(cmd: string): boolean {
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

function firstTarget(cmd: string, from: number): string {
  const rest = cmd.slice(from)
  const tokens = rest.split(/\s+/).filter(t => t && t !== "--" && !t.startsWith("-"))
  return tokens[0] ?? ""
}

function rmIsDangerous(trimmed: string): boolean {
  const m = trimmed.match(/\brm\b/)
  if (!m) return false
  const afterRm = trimmed.slice(m.index! + m[0].length)
  if (!/\s(-[a-z]*r[a-z]*|--recursive)\b/.test(afterRm) || !/\s(-[a-z]*f[a-z]*|--force)\b/.test(afterRm)) return false
  if (/\s--no-preserve-root\b/.test(afterRm)) return true
  const rawTarget = firstTarget(trimmed, m.index! + m[0].length)
  if (!rawTarget) return false
  const target = normalizeTarget(rawTarget)
  if (target === "/" || target === "~") return true
  if (target === ".") return true
  if (/^\.\.(\/|$)/.test(target)) return true
  if (/^\/(etc|usr|bin|boot|dev|var|sbin|lib|opt|sys|proc|root|home)(\/|$)/.test(target)) return true
  if (/^~[\/]/.test(target)) return true
  if (/^\/(Windows|Users|Program\s?Files|ProgramData)(\/|$)/i.test(target)) return true
  return false
}

function gitPushIsForce(trimmed: string): boolean {
  const m = trimmed.match(/\bgit\s+push\b/)
  if (!m) return false
  const afterPush = trimmed.slice(m.index! + m[0].length)
  if (/\s(-f\b|--force\b|--force-with-lease\b)/.test(" " + afterPush)) return true
  if (/\+[a-zA-Z]/.test(afterPush)) return true
  return false
}

function gitCleanIsDangerous(trimmed: string): boolean {
  const m = trimmed.match(/\bgit\s+clean\b/)
  if (!m) return false
  const afterClean = trimmed.slice(m.index! + m[0].length)
  return /-[a-z]*d[a-z]*\b/.test(afterClean) && /-[a-z]*f[a-z]*\b/.test(afterClean)
}

function chmodIsDangerous(trimmed: string): boolean {
  const m = trimmed.match(/\bchmod\b/)
  if (!m) return false
  const afterChmod = trimmed.slice(m.index! + m[0].length)
  if (!/\s-R\b/.test(afterChmod)) return false
  const tokens = afterChmod.split(/\s+/).filter(t => t && t !== "--")
  const lastToken = tokens[tokens.length - 1]
  if (!lastToken) return false
  const target = normalizeTarget(lastToken)
  return target === "/" || target === "." || target === "~" || /^\/(etc|usr|bin|boot|dev|var|sbin|lib|opt|Windows|Users|home)(\/|$)/i.test(target)
}

function removeItemIsDangerous(trimmed: string): boolean {
  const m = trimmed.match(/\bRemove-Item\b/i)
  if (!m) return false
  const afterCmd = trimmed.slice(m.index! + m[0].length)
  if (!/\s(-R\b|-Recurse\b|-r\b)/i.test(afterCmd) || !/\s(-F\b|-Force\b|-fo\b)/i.test(afterCmd)) return false
  const tokens = afterCmd.split(/\s+/).filter(t => t && !t.startsWith('-'))
  const target = tokens[tokens.length - 1]
  if (!target) return false
  const nt = normalizeTarget(target)
  return nt === "/" || nt === "~" || nt === "." || /^\/(etc|usr|bin|boot|dev|var|sbin|lib|opt|Windows|Users)(\/|$)/i.test(nt)
}

function delIsDangerous(trimmed: string): boolean {
  let m = trimmed.match(/\b(del|erase)\b/i)
  if (m) {
    const afterCmd = trimmed.slice(m.index! + m[0].length)
    if (!/\s\/s\b/i.test(afterCmd) || !/\s\/f\b/i.test(afterCmd)) return false
    const tokens = afterCmd.split(/\s+/).filter(t => t && !t.startsWith('/'))
    const target = tokens[tokens.length - 1] ?? ""
    const nt = normalizeTarget(target)
    return nt === "/" || /^\/(Windows|Users)/i.test(nt)
  }
  m = trimmed.match(/\b(rmdir|rd)\b/i)
  if (!m) return false
  const afterCmd = trimmed.slice(m.index! + m[0].length)
  if (!/\s\/s\b/i.test(afterCmd) || !/\s\/q\b/i.test(afterCmd)) return false
  const tokens = afterCmd.split(/\s+/).filter(t => t && !t.startsWith('/'))
  const target = tokens[tokens.length - 1] ?? ""
  const nt = normalizeTarget(target)
  return nt === "/" || /^\/(Windows|Users)/i.test(nt)
}

function hasCarriageReturn(cmd: string): boolean {
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

function extractQuoteContext(cmd: string): { withDoubleQuotes: string; fullyUnquoted: string } {
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

function hasUnquotedShellOperator(cmd: string, from: number, operators: string): boolean {
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

function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === "\\") {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

function hasDangerousVariables(cmd: string): boolean {
  const content = extractQuoteContext(cmd).fullyUnquoted
  const variableRef = String.raw`(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\})`
  return new RegExp(String.raw`[<>|]\s*${variableRef}`).test(content) ||
    new RegExp(String.raw`${variableRef}\s*[|<>]`).test(content)
}

function hasIFSInjection(cmd: string): boolean {
  return /\bIFS\s*=/.test(cmd) || /\$IFS\b|\$\{[^}]*IFS/.test(cmd)
}

function hasProcEnvironAccess(cmd: string): boolean {
  return /\/proc\/.*\/environ/.test(cmd)
}

function hasObfuscatedFlags(cmd: string): boolean {
  if (/\$['"]-/.test(cmd)) return true
  if (/(?:^|\s)(?:''|"")+\s*-/.test(cmd)) return true
  if (/(?:""|'')+['"]-/.test(cmd)) return true
  return false
}

function hasBraceExpansion(cmd: string): boolean {
  const content = extractQuoteContext(cmd).fullyUnquoted
  let openBraces = 0
  let closeBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "{" && !isEscapedAtPosition(content, i)) openBraces++
    if (content[i] === "}" && !isEscapedAtPosition(content, i)) closeBraces++
  }
  if (openBraces > 0 && closeBraces > openBraces) return true

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "{" || isEscapedAtPosition(content, i)) continue
    let depth = 1
    for (let j = i + 1; j < content.length; j++) {
      if (content[j] === "{" && !isEscapedAtPosition(content, j)) depth++
      if (content[j] !== "}" || isEscapedAtPosition(content, j)) continue
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

function hasUnicodeWhitespace(cmd: string): boolean {
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd.charCodeAt(i)
    if (c === 0xA0 || (c >= 0x2000 && c <= 0x200B) || c === 0x2028 || c === 0x2029 || c === 0xFEFF) return true
  }
  return false
}

function hasBackslashEscapedWhitespace(cmd: string): boolean {
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

function hasBackslashEscapedOperators(cmd: string): boolean {
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

function hasNetworkRedirect(cmd: string): boolean {
  const content = extractQuoteContext(cmd).fullyUnquoted
  return /(?:^|\s)\d?>\s*\/dev\/(tcp|udp)/.test(content) || /(?:^|\s)\d?<\s*\/dev\/(tcp|udp)/.test(content)
}

function gitCommitIsInjected(cmd: string): boolean {
  const m = cmd.match(/\bgit\s+commit\b/)
  if (!m) return false
  return hasUnquotedShellOperator(cmd, m.index! + m[0].length, ";&|<>")
}

function hasShellMetacharacters(cmd: string): boolean {
  const { withDoubleQuotes } = extractQuoteContext(cmd)
  if (/(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(withDoubleQuotes)) return true
  if (/(?:^|\s)-(?:name|path|iname)\s+["'][^"']*[;|&][^"']*["']/.test(cmd)) return true
  if (/(?:^|\s)-regex\s+["'][^"']*[;&][^"']*["']/.test(cmd)) return true
  return false
}

function checkCCSecurityPatterns(cmd: string): DangerResult | null {
  if (hasCarriageReturn(cmd)) return { dangerous: true, reason: `命令含回车符(\\r)可绕过安全检查: ${cmd.slice(0, 120)}` }
  if (hasDangerousVariables(cmd)) return { dangerous: true, reason: `变量靠近重定向/管道可绕过检查: ${cmd.slice(0, 120)}` }
  if (hasIFSInjection(cmd)) return { dangerous: true, reason: `IFS 变量可改变 shell 分隔符: ${cmd.slice(0, 120)}` }
  if (hasProcEnvironAccess(cmd)) return { dangerous: true, reason: `访问 /proc/*/environ 可能泄露环境变量: ${cmd.slice(0, 120)}` }
  if (hasObfuscatedFlags(cmd)) return { dangerous: true, reason: `ANSI-C/区域引用可隐藏危险 flag: ${cmd.slice(0, 120)}` }
  if (hasBraceExpansion(cmd)) return { dangerous: true, reason: `花括号展开可在安全检测后注入参数: ${cmd.slice(0, 120)}` }
  if (hasUnicodeWhitespace(cmd)) return { dangerous: true, reason: `Unicode 空白字符可绕过命令名检测: ${cmd.slice(0, 120)}` }
  if (hasBackslashEscapedWhitespace(cmd)) return { dangerous: true, reason: `反斜杠转义空白改变 shell 分词: ${cmd.slice(0, 120)}` }
  if (hasBackslashEscapedOperators(cmd)) return { dangerous: true, reason: `反斜杠转义运算符可隐藏命令分隔符: ${cmd.slice(0, 120)}` }
  if (hasNetworkRedirect(cmd)) return { dangerous: true, reason: `网络重定向到 /dev/(tcp|udp): ${cmd.slice(0, 120)}` }
  if (gitCommitIsInjected(cmd)) return { dangerous: true, reason: `git commit -m 前含 shell 运算符: ${cmd.slice(0, 120)}` }
  if (hasShellMetacharacters(cmd)) return { dangerous: true, reason: `命令参数中包含 shell 元字符(;|&): ${cmd.slice(0, 120)}` }
  return null
}

const DANGEROUS_FS = [
  /\bmkfs\b/i, /\bdd\s+if=.*\s+of=/i, /\bformat\s+[a-z]:/i, /\bfdisk\b/i,
  /\bmkswap\b/i, /\bparted\b/i, /\b>\/dev\/(sda|sdb|sdc|nvme|hd[a-z])/,
  /:\s*\(\s*\)\s*\{[^}]*:.*:.*&?\s*;?\s*\}\s*;\s*:/s,
  /\b(rmdir|rd)\s+\/s\s+\/q\b/i,
]

const DANGEROUS_SYSTEM = [
  /\bsudo\s+/, /\bsu\s+-/, /\bshutdown\b/, /\breboot\b/, /\bhalt\b/,
  /\bpoweroff\b/, /\binit\s+0\b/, /\binit\s+6\b/,
  /\bsystemctl\s+(stop|disable|mask|reboot|poweroff)\s+/,
]

const DANGEROUS_PIPE_SHELL = [
  /(curl|wget)\b[^|;]*\|\s*(bash|sh|zsh|powershell|pwsh)\b/i,
  /(curl|wget)\b[^|;]*\|\s*sudo\s+(bash|sh)/i,
]

const DANGEROUS_GIT_SIMPLE = [
  /\bgit\s+reset\s+--hard\s*(\s|$)/, /\bgit\s+checkout\s+--force\b/,
  /\bgit\s+rebase\s+--(onto|interactive)\b/,
]

const DANGEROUS_KILL = [
  /\bkill\s+-9\b/, /\bpkill\s+-9\b/, /\bkillall\b/, /\btaskkill\s+\/f\b/i,
]

export function checkTextPreparseDangerousPatterns(trimmed: string): DangerResult | null {
  if (hasShellExpansion(trimmed)) {
    return { dangerous: true, reason: `Shell 展开/替换语法可执行任意代码: ${trimmed.slice(0, 120)}` }
  }
  if (hasUnquotedLineBreak(trimmed)) {
    return { dangerous: true, reason: `命令含未引用换行符，可注入额外命令: ${trimmed.slice(0, 120)}` }
  }
  return checkCCSecurityPatterns(trimmed)
}

export function checkLegacyDangerousPatterns(trimmed: string): DangerResult | null {
  if (rmIsDangerous(trimmed)) return { dangerous: true, reason: `递归删除危险路径: ${trimmed.slice(0, 120)}` }
  if (gitPushIsForce(trimmed)) return confirmDanger("高风险 Git 操作：强制推送可能覆盖远端历史", trimmed)
  if (gitCleanIsDangerous(trimmed)) return confirmDanger("高风险 Git 操作：Git clean 将删除未跟踪文件", trimmed)
  if (chmodIsDangerous(trimmed)) return { dangerous: true, reason: `文件权限高危操作: ${trimmed.slice(0, 120)}` }
  if (delIsDangerous(trimmed)) return { dangerous: true, reason: `Windows 强制递归删除: ${trimmed.slice(0, 120)}` }
  if (removeItemIsDangerous(trimmed)) return { dangerous: true, reason: `PowerShell 递归删除: ${trimmed.slice(0, 120)}` }

  const patternChecks = [
    { patterns: DANGEROUS_FS, cat: "文件系统破坏性操作" },
    { patterns: DANGEROUS_SYSTEM, cat: "系统控制命令" },
    { patterns: DANGEROUS_PIPE_SHELL, cat: "远程下载后执行" },
    { patterns: DANGEROUS_KILL, cat: "进程杀伤" },
  ] as const

  for (const { patterns, cat } of patternChecks) {
    for (const re of patterns) {
      if (re.test(trimmed)) return { dangerous: true, reason: `${cat}: ${trimmed.slice(0, 120)}` }
    }
  }

  for (const re of DANGEROUS_GIT_SIMPLE) {
    if (re.test(trimmed)) return confirmDanger("高风险 Git 操作", trimmed)
  }

  return null
}
