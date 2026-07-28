import type { ShellDialect } from "../../types.js"

export type ShellSegmentOperator = "pipe" | "and" | "or" | "sequence" | "background"

export interface ShellToken {
  value: string
  raw: string
  start: number
  end: number
  quote: "none" | "single" | "double" | "mixed"
}

export interface ShellRedirect {
  operator: string
  target?: string
  tokenIndex: number
  targetTokenIndex?: number
  isOutput: boolean
  isFdRedirect: boolean
  isSafeReadOnlySink: boolean
}

export interface ShellSegment {
  text: string
  start: number
  end: number
  nextOperator?: ShellSegmentOperator
  tokens: ShellToken[]
  redirects: ShellRedirect[]
  hasNewline: boolean
  hasShellExpansion: boolean
  parseError?: string
}

export interface ShellParseResult {
  ok: boolean
  segments: ShellSegment[]
  error?: string
}

export interface ShellParseOptions {
  shellDialect?: ShellDialect
  windowsShell?: boolean
}

interface SegmentSlice {
  text: string
  start: number
  end: number
  nextOperator?: ShellSegmentOperator
}

function dialectUsesWindowsBackslash(dialect: ShellDialect): boolean {
  return dialect === "cmd" || dialect === "powershell"
}

export function shellDialectFromEnv(): ShellDialect | undefined {
  const raw = process.env.MY_CODE_AGENT_SHELL_DIALECT?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === "cmd" || raw === "cmd.exe") return "cmd"
  if (raw === "posix" || raw === "bash" || raw === "posix-bash" || raw === "git-bash") return "posix-bash"
  if (raw === "powershell" || raw === "pwsh" || raw === "pwsh.exe" || raw === "powershell.exe") return "powershell"
  return undefined
}

function shouldTreatBackslashAsEscape(inSingle: boolean, windowsShell: boolean): boolean {
  return !windowsShell && !inSingle
}

function operatorAt(command: string, index: number): { length: number; operator: ShellSegmentOperator } | null {
  const c = command[index]
  const next = command[index + 1]
  if (c === "|" && next === "|") return { length: 2, operator: "or" }
  if (c === "|") return { length: 1, operator: "pipe" }
  if (c === "&" && next === "&") return { length: 2, operator: "and" }
  if (c === "&" && next !== ">" && command[index - 1] !== ">") return { length: 1, operator: "background" }
  if (c === ";") return { length: 1, operator: "sequence" }
  return null
}

function splitSegments(command: string, options: Required<ShellParseOptions>): SegmentSlice[] {
  const segments: SegmentSlice[] = []
  let inSingle = false
  let inDouble = false
  let escaped = false
  let start = 0

  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === "\\" && shouldTreatBackslashAsEscape(inSingle, options.windowsShell)) {
      escaped = true
      continue
    }
    if (c === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (inSingle || inDouble) continue

    if (c === "\n" || c === "\r") {
      segments.push({
        text: command.slice(start, i),
        start,
        end: i,
        nextOperator: "sequence",
      })
      if (c === "\r" && command[i + 1] === "\n") i++
      start = i + 1
      continue
    }

    const op = operatorAt(command, i)
    if (!op) continue
    segments.push({
      text: command.slice(start, i),
      start,
      end: i,
      nextOperator: op.operator,
    })
    i += op.length - 1
    start = i + 1
  }

  segments.push({ text: command.slice(start), start, end: command.length })
  return segments
}

function quoteKind(hasSingle: boolean, hasDouble: boolean): ShellToken["quote"] {
  if (hasSingle && hasDouble) return "mixed"
  if (hasSingle) return "single"
  if (hasDouble) return "double"
  return "none"
}

function tokenizeSegment(text: string, absoluteStart: number, options: Required<ShellParseOptions>): { tokens: ShellToken[]; error?: string } {
  const tokens: ShellToken[] = []
  let i = 0

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++
    if (i >= text.length) break

    const tokenStart = i
    let raw = ""
    let value = ""
    let inSingle = false
    let inDouble = false
    let hasSingle = false
    let hasDouble = false

    while (i < text.length) {
      const c = text[i]
      if (!inSingle && !inDouble && /\s/.test(c)) break

      raw += c
      if (c === "'" && !inDouble) {
        inSingle = !inSingle
        hasSingle = true
        i++
        continue
      }
      if (c === '"' && !inSingle) {
        inDouble = !inDouble
        hasDouble = true
        i++
        continue
      }
      if (c === "\\" && shouldTreatBackslashAsEscape(inSingle, options.windowsShell)) {
        const next = text[i + 1]
        if (next !== undefined) {
          raw += next
          value += next
          i += 2
          continue
        }
      }

      value += c
      i++
    }

    if (inSingle || inDouble) return { tokens, error: "引号未闭合" }
    tokens.push({
      value,
      raw,
      start: absoluteStart + tokenStart,
      end: absoluteStart + i,
      quote: quoteKind(hasSingle, hasDouble),
    })
  }

  return { tokens }
}

function safeRedirectTarget(target?: string): boolean {
  if (!target) return false
  const normalized = target.replace(/\\/g, "/").toLowerCase()
  return normalized === "/dev/null" || normalized === "nul"
}

function redirectFromToken(tokens: ShellToken[], index: number): ShellRedirect | null {
  const token = tokens[index]?.value
  if (!token) return null

  const fdRedirect = token.match(/^(\d*)>&(\d+|-)$/)
  if (fdRedirect) {
    return {
      operator: `${fdRedirect[1] ?? ""}>&`,
      target: fdRedirect[2],
      tokenIndex: index,
      isOutput: true,
      isFdRedirect: true,
      isSafeReadOnlySink: true,
    }
  }

  const combined = token.match(/^(&?>>?|(\d+)(>>?)|(\d+)?<)(.*)$/)
  if (!combined) return null

  const operator = combined[1]
  const inlineTarget = combined[5] || undefined
  const targetTokenIndex = inlineTarget ? undefined : index + 1 < tokens.length ? index + 1 : undefined
  const target = inlineTarget ?? (targetTokenIndex === undefined ? undefined : tokens[targetTokenIndex]?.value)
  const isOutput = operator.includes(">")
  const isFdRedirect = /^&?>&$/.test(operator)
  return {
    operator,
    target,
    tokenIndex: index,
    targetTokenIndex,
    isOutput,
    isFdRedirect,
    isSafeReadOnlySink: isFdRedirect || (isOutput && safeRedirectTarget(target)),
  }
}

function extractRedirects(tokens: ShellToken[]): ShellRedirect[] {
  const redirects: ShellRedirect[] = []
  for (let i = 0; i < tokens.length; i++) {
    const redirect = redirectFromToken(tokens, i)
    if (!redirect) continue
    redirects.push(redirect)
    if (redirect.targetTokenIndex !== undefined) i = redirect.targetTokenIndex
  }
  return redirects
}

function hasShellExpansion(text: string): boolean {
  return /\$\(|`|[<>]\(/.test(text)
}

export function parseShellCommand(command: string, options: ShellParseOptions = {}): ShellParseResult {
  const inferredDialect: ShellDialect = options.shellDialect ?? shellDialectFromEnv() ?? (process.platform === "win32" ? "cmd" : "posix-bash")
  const parseOptions: Required<ShellParseOptions> = {
    shellDialect: inferredDialect,
    windowsShell: options.windowsShell ?? dialectUsesWindowsBackslash(inferredDialect),
  }
  const slices = splitSegments(command, parseOptions)
  const segments: ShellSegment[] = []
  for (const slice of slices) {
    const tokenized = tokenizeSegment(slice.text, slice.start, parseOptions)
    const segment: ShellSegment = {
      text: slice.text,
      start: slice.start,
      end: slice.end,
      nextOperator: slice.nextOperator,
      tokens: tokenized.tokens,
      redirects: extractRedirects(tokenized.tokens),
      hasNewline: /[\r\n]/.test(slice.text),
      hasShellExpansion: hasShellExpansion(slice.text),
      parseError: tokenized.error,
    }
    segments.push(segment)
  }

  const failed = segments.find((segment) => segment.parseError || segment.hasShellExpansion)
  if (failed?.parseError) return { ok: false, segments, error: failed.parseError }
  if (failed?.hasShellExpansion) return { ok: false, segments, error: "包含 shell 展开/替换语法" }
  return { ok: true, segments }
}

export function tokensWithoutRedirects(segment: ShellSegment): string[] {
  const skipped = new Set<number>()
  for (const redirect of segment.redirects) {
    skipped.add(redirect.tokenIndex)
    if (redirect.targetTokenIndex !== undefined) skipped.add(redirect.targetTokenIndex)
  }
  return segment.tokens
    .filter((_, index) => !skipped.has(index))
    .map((token) => token.value)
}
