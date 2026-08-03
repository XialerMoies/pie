import type { ShellDialect } from "./security-ast.js"

export type PathOperation = "read" | "write" | "create" | "remove"

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

export interface CommandPathArg {
  token: string
  operation: PathOperation
  source?: string
}

export interface PathExtractorContext {
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

export function extractCommandPathArgs(command: string, args: string[], context: PathExtractorContext = {}): CommandPathArg[] {
  const pathCommand = command.toLowerCase() as PathCommand
  if (!PATH_COMMANDS.has(pathCommand)) return []
  return PATH_EXTRACTORS[pathCommand](args, pathCommand, context)
}
