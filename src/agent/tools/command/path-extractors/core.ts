import type { ShellDialect } from "../security-ast.js"

export type PathOperation = "read" | "write" | "create" | "remove"

export type PathCommand =
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

export interface CommandPathArg {
  token: string
  operation: PathOperation
  source?: string
}

export interface PathExtractorContext {
  shellDialect?: ShellDialect
}

export type PathExtractor = (args: string[], command: PathCommand, context: PathExtractorContext) => CommandPathArg[]

export const PATH_COMMANDS = new Set<PathCommand>([
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

export const DEFAULT_OPERATION: Record<PathCommand, PathOperation> = {
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

export const COMMON_VALUE_FLAGS = new Set([
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

export function pathArgsOnly(cmd: string, args: string[], valueFlags: Set<string> = COMMON_VALUE_FLAGS): string[] {
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

export function mark(paths: string[], operation: PathOperation, source?: string): CommandPathArg[] {
  return paths.map((token) => ({ token, operation, source }))
}

export function simpleExtractor(args: string[], command: PathCommand): CommandPathArg[] {
  return mark(pathArgsOnly(command, args), DEFAULT_OPERATION[command])
}

export function defaultDotExtractor(args: string[], command: PathCommand): CommandPathArg[] {
  const paths = pathArgsOnly(command, args)
  return mark(paths.length > 0 ? paths : ["."], DEFAULT_OPERATION[command])
}

export function cdExtractor(args: string[], command: PathCommand, context: PathExtractorContext): CommandPathArg[] {
  const targetArgs = command === "cd" && context.shellDialect === "cmd" && args[0]?.toLowerCase() === "/d" ? args.slice(1) : args
  if (command === "cd" && context.shellDialect === "cmd" && targetArgs.length === 0) return []
  return [{ token: targetArgs.length === 0 ? "~" : targetArgs.join(" "), operation: DEFAULT_OPERATION[command], source: `${command} target` }]
}
