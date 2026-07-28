import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { Language, Parser, type Node } from "web-tree-sitter"
import type { SecurityParseOptions, SecurityParseResult, SecurityRedirect, SimpleCommand } from "./security-ast.js"
import type { ShellSegmentOperator } from "./shell-parser.js"

const require = createRequire(import.meta.url)

const MAX_TREE_SITTER_PARSE_MS = 50
const MAX_TREE_SITTER_NODES = 50_000
const MAX_SHELL_WRAPPER_DEPTH = 3

const POSIX_SHELLS = new Set(["bash", "bash.exe", "sh", "sh.exe", "zsh", "zsh.exe"])
const UNSUPPORTED_NODE_TYPES = new Set([
  "arithmetic_expansion",
  "case_statement",
  "command_substitution",
  "coproc",
  "do_group",
  "expansion",
  "for_statement",
  "function_definition",
  "heredoc_body",
  "heredoc_redirect",
  "if_statement",
  "process_substitution",
  "simple_expansion",
  "subscript",
  "subshell",
  "test_command",
  "while_statement",
])

let initPromise: Promise<Language> | undefined

function packagedResourcePath(fileName: string): string | undefined {
  const resourcesPath = (process as typeof process & { resourcesPath?: string }).resourcesPath
  if (!resourcesPath) return undefined
  return path.join(resourcesPath, "tree-sitter", fileName)
}

function resolveResource(packagePath: string, resourceFileName: string): string {
  const packaged = packagedResourcePath(resourceFileName)
  if (packaged && existsSync(packaged)) return packaged
  return require.resolve(packagePath)
}

async function loadBashLanguage(): Promise<Language> {
  if (!initPromise) {
    initPromise = (async () => {
      const webTreeSitterWasm = resolveResource("web-tree-sitter/web-tree-sitter.wasm", "web-tree-sitter.wasm")
      const bashWasm = resolveResource("tree-sitter-bash/tree-sitter-bash.wasm", "tree-sitter-bash.wasm")
      await Parser.init({
        locateFile(fileName: string) {
          return fileName.endsWith(".wasm") ? webTreeSitterWasm : fileName
        },
      } as unknown as Parameters<typeof Parser.init>[0])
      return Language.load(bashWasm)
    })()
  }
  return initPromise
}

function safeRedirectTarget(target?: string): boolean {
  if (!target) return false
  const normalized = target.replace(/\\/g, "/").toLowerCase()
  return normalized === "/dev/null" || normalized === "nul"
}

function operatorToSegmentOperator(op: string): ShellSegmentOperator | undefined {
  if (op === "|") return "pipe"
  if (op === "&&") return "and"
  if (op === "||") return "or"
  if (op === ";") return "sequence"
  if (op === "&") return "background"
  return undefined
}

function isShellWrapper(command: SimpleCommand): boolean {
  const executable = command.argv[0]?.toLowerCase()
  return executable !== undefined && POSIX_SHELLS.has(executable)
}

function extractStaticShellWrapperCommand(command: SimpleCommand): string | undefined {
  if (!isShellWrapper(command)) return undefined
  const argv = command.argv
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index]
    if (token === "-c" || token === "-lc") return argv[index + 1]
    if (token.startsWith("-") && token.includes("c")) return argv[index + 1]
  }
  return undefined
}

function containsUnsupportedNode(node: Node): Node | undefined {
  if (UNSUPPORTED_NODE_TYPES.has(node.type)) return node
  for (const child of node.namedChildren) {
    const unsupported = containsUnsupportedNode(child)
    if (unsupported) return unsupported
  }
  return undefined
}

function countNodes(node: Node, budget: number): number {
  let count = 1
  const stack = [...node.children]
  while (stack.length > 0) {
    const current = stack.pop()!
    count++
    if (count > budget) return count
    stack.push(...current.children)
  }
  return count
}

function stripMatchingQuotes(text: string, quote: "'" | "\""): string {
  return text.length >= 2 && text.startsWith(quote) && text.endsWith(quote) ? text.slice(1, -1) : text
}

function literalText(node: Node): string | undefined {
  const unsupported = containsUnsupportedNode(node)
  if (unsupported) return undefined

  if (node.type === "string") {
    let value = ""
    for (const child of node.children) {
      if (child.type === "string_content") value += child.text
      else if (child.text === "\"" || child.text === "'") continue
      else if (!child.isNamed && child.text === "\\") continue
      else if (!child.isNamed) value += child.text
      else return undefined
    }
    return value
  }

  if (node.type === "raw_string") return stripMatchingQuotes(node.text, "'")
  if (node.type === "ansi_c_string") return undefined
  if (node.type === "concatenation") {
    let value = ""
    for (const child of node.namedChildren) {
      const childValue = literalText(child)
      if (childValue === undefined) return undefined
      value += childValue
    }
    return value
  }

  return node.text
}

function envAssignment(node: Node): { name: string; value: string } | undefined {
  const text = node.text
  const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
  if (!match) return undefined
  const unsupported = containsUnsupportedNode(node)
  if (unsupported) return undefined
  return { name: match[1]!, value: match[2] ?? "" }
}

interface RedirectTextParts {
  operator: string
  target?: string
  fd?: number
  isFdRedirect: boolean
}

function parseRedirectText(text: string): RedirectTextParts | undefined {
  const match = text.trim().match(/^(\d*)\s*(&>>|&>|>&|<&|>>|<>|>|<)\s*(.*)$/s)
  if (!match) return undefined
  const [, fdRaw, operatorRaw, targetRaw] = match
  const operator = `${fdRaw ?? ""}${operatorRaw}`
  const target = targetRaw?.trim() || undefined
  return {
    operator,
    target,
    fd: fdRaw ? Number(fdRaw) : undefined,
    isFdRedirect: operatorRaw!.includes("&"),
  }
}

function redirectOperator(node: Node): string | undefined {
  for (const child of node.children) {
    if (!child.isNamed && /[<>]/.test(child.text)) return child.text
  }
  const match = node.text.match(/^(\d*>>?|\d*<|&>>?|&>)/)
  return match?.[1]
}

function redirectTarget(node: Node): string | undefined {
  for (let index = node.namedChildren.length - 1; index >= 0; index--) {
    const child = node.namedChildren[index]!
    if (child.type === "word" || child.type === "string" || child.type === "raw_string" || child.type === "concatenation") {
      return literalText(child)
    }
  }
  return undefined
}

function parseRedirect(node: Node): SecurityRedirect | { tooComplex: SecurityParseResult } {
  const unsupported = containsUnsupportedNode(node)
  if (unsupported) {
    return {
      tooComplex: {
        kind: "too-complex",
        reason: "Redirect contains complex shell expansion and cannot be parsed safely",
        nodeType: unsupported.type,
      },
    }
  }

  const textParts = parseRedirectText(node.text)
  const operator = textParts?.operator ?? redirectOperator(node)
  const target = redirectTarget(node) ?? textParts?.target
  if (!operator || !target) {
    return {
      tooComplex: {
        kind: "too-complex",
        reason: "Redirect target cannot be parsed statically",
        nodeType: node.type,
      },
    }
  }

  const fdMatch = operator.match(/^(\d+)/)
  const isOutput = operator.includes(">")
  const isFdRedirect = textParts?.isFdRedirect === true || /&\d+$/.test(target) || operator.includes("&")
  return {
    operator,
    target,
    fd: textParts?.fd ?? (fdMatch ? Number(fdMatch[1]) : undefined),
    isOutput,
    isFdRedirect,
    isSafeReadOnlySink: isFdRedirect || (isOutput && safeRedirectTarget(target)),
  }
}

interface ParseState {
  commands: SimpleCommand[]
}

function attachRedirects(commands: SimpleCommand[], redirects: SecurityRedirect[]): void {
  if (commands.length === 0 || redirects.length === 0) return
  commands[commands.length - 1]!.redirects.push(...redirects)
}

function parseCommandNode(node: Node): SimpleCommand | SecurityParseResult {
  const argv: string[] = []
  const envVars: { name: string; value: string }[] = []
  const redirects: SecurityRedirect[] = []

  for (const child of node.namedChildren) {
    if (child.type === "variable_assignment") {
      const envVar = envAssignment(child)
      if (!envVar) return { kind: "too-complex", reason: "Environment assignment contains complex shell syntax", nodeType: child.type }
      envVars.push(envVar)
      continue
    }

    if (child.type === "command_name") {
      const nameNode = child.namedChildren[0] ?? child
      const value = literalText(nameNode)
      if (value === undefined) return { kind: "too-complex", reason: "Command name cannot be parsed statically", nodeType: child.type }
      argv.push(value)
      continue
    }

    if (child.type === "word" || child.type === "string" || child.type === "raw_string" || child.type === "concatenation") {
      const value = literalText(child)
      if (value === undefined) return { kind: "too-complex", reason: "Argument contains complex shell expansion and cannot be parsed safely", nodeType: child.type }
      argv.push(value)
      continue
    }

    if (child.type === "file_redirect") {
      const redirect = parseRedirect(child)
      if ("tooComplex" in redirect) return redirect.tooComplex
      redirects.push(redirect)
      continue
    }

    return { kind: "too-complex", reason: "Command contains unsupported bash syntax", nodeType: child.type }
  }

  return {
    argv,
    envVars,
    redirects,
    text: node.text,
    start: node.startIndex,
    end: node.endIndex,
    dialect: "posix-bash",
  }
}

function childCommandsFrom(state: ParseState, startIndex: number): SimpleCommand[] {
  return state.commands.slice(startIndex)
}

function parseStatement(node: Node, state: ParseState): SecurityParseResult | undefined {
  switch (node.type) {
    case "program":
    case "list": {
      let lastCommand: SimpleCommand | undefined
      for (const child of node.children) {
        const operator = operatorToSegmentOperator(child.text)
        if (operator && lastCommand) {
          lastCommand.nextOperator = operator
          continue
        }
        if (!child.isNamed) continue
        const before = state.commands.length
        const result = parseStatement(child, state)
        if (result?.kind === "too-complex") return result
        const added = childCommandsFrom(state, before)
        if (added.length > 0) lastCommand = added[added.length - 1]
      }
      return undefined
    }

    case "pipeline": {
      let lastCommand: SimpleCommand | undefined
      for (const child of node.children) {
        if (operatorToSegmentOperator(child.text) === "pipe" && lastCommand) {
          lastCommand.nextOperator = "pipe"
          continue
        }
        if (!child.isNamed) continue
        const before = state.commands.length
        const result = parseStatement(child, state)
        if (result?.kind === "too-complex") return result
        const added = childCommandsFrom(state, before)
        if (added.length > 0) lastCommand = added[added.length - 1]
      }
      return undefined
    }

    case "redirected_statement": {
      const before = state.commands.length
      const redirects: SecurityRedirect[] = []
      for (const child of node.namedChildren) {
        if (child.type === "file_redirect") {
          const redirect = parseRedirect(child)
          if ("tooComplex" in redirect) return redirect.tooComplex
          redirects.push(redirect)
          continue
        }
        const result = parseStatement(child, state)
        if (result?.kind === "too-complex") return result
      }
      const added = childCommandsFrom(state, before)
      if (added.length === 0) {
        return { kind: "too-complex", reason: "Redirected statement has no verifiable command", nodeType: node.type }
      }
      attachRedirects(added, redirects)
      return undefined
    }

    case "command": {
      const command = parseCommandNode(node)
      if ("kind" in command) return command
      state.commands.push(command)
      return undefined
    }

    case "comment":
      return undefined

    default:
      return { kind: "too-complex", reason: "Command contains unsupported bash structure", nodeType: node.type }
  }
}

async function parseShellWrapperIfPresent(result: SecurityParseResult, options: SecurityParseOptions, depth: number): Promise<SecurityParseResult> {
  if (result.kind !== "simple") return result
  if (depth >= MAX_SHELL_WRAPPER_DEPTH) return { kind: "too-complex", reason: "Shell wrapper nesting is too deep" }
  if (result.commands.length !== 1) return result

  const inner = extractStaticShellWrapperCommand(result.commands[0]!)
  if (inner === undefined) return result

  return parseBashCommandWithTreeSitter(inner, { ...options, shellDialect: "posix-bash" }, depth + 1)
}

export async function parseBashCommandWithTreeSitter(
  command: string,
  options: SecurityParseOptions = {},
  depth = 0,
): Promise<SecurityParseResult> {
  if (options.shellDialect && options.shellDialect !== "posix-bash") {
    return { kind: "parse-unavailable", reason: "Tree-sitter bash parser only supports POSIX shell" }
  }

  let language: Language
  try {
    language = await loadBashLanguage()
  } catch (error) {
    return {
      kind: "parse-unavailable",
      reason: error instanceof Error ? error.message : String(error),
    }
  }

  let parser: Parser | undefined
  let tree: ReturnType<Parser["parse"]> | undefined
  try {
    parser = new Parser()
    parser.setLanguage(language)

    const startedAt = Date.now()
    let timedOut = false
    tree = parser.parse(command, null, {
      progressCallback: (() => {
        if (Date.now() - startedAt > MAX_TREE_SITTER_PARSE_MS) {
          timedOut = true
          return true
        }
        return false
      }) as never,
    })

    if (!tree) {
      return {
        kind: "too-complex",
        reason: timedOut ? "Tree-sitter parse timed out; ask for confirmation" : "Tree-sitter could not parse command",
      }
    }

    const root = tree.rootNode
    if (root.hasError) {
      return { kind: "too-complex", reason: "Tree-sitter found a syntax error; ask for confirmation" }
    }

    if (countNodes(root, MAX_TREE_SITTER_NODES) > MAX_TREE_SITTER_NODES) {
      return { kind: "too-complex", reason: "Command AST exceeds the security node budget" }
    }

    const unsupported = containsUnsupportedNode(root)
    if (unsupported) {
      return {
        kind: "too-complex",
        reason: "Command contains complex bash expansion or control flow; ask for confirmation",
        nodeType: unsupported.type,
      }
    }

    const state: ParseState = { commands: [] }
    const result = parseStatement(root, state)
    if (result?.kind === "too-complex") return result

    const parsed: SecurityParseResult = {
      kind: "simple",
      commands: state.commands,
      redirects: state.commands.flatMap((command) => command.redirects),
      dialect: "posix-bash",
    }
    return parseShellWrapperIfPresent(parsed, options, depth)
  } catch (error) {
    return {
      kind: "too-complex",
      reason: `Tree-sitter parse failed after parser load; ask for confirmation: ${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    tree?.delete()
    ;(parser as (Parser & { delete?: () => void }) | undefined)?.delete?.()
  }
}
