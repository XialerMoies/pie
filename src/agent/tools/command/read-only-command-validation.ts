export type FlagArgType = "none" | "string" | "number" | "path" | "stdout"

export interface FlagValidationConfig {
  safeLongFlags?: Record<string, FlagArgType>
  safeShortFlags?: Record<string, FlagArgType>
  dangerousLongFlags?: Set<string>
  dangerousShortFlags?: Set<string>
  allowUnknownLongFlags?: boolean
  allowUnknownShortFlags?: boolean
  allowPositionals?: boolean
  minPositionals?: number
  maxPositionals?: number
}

const noArg = "none" as const

function longFlagParts(token: string): { flag: string; value?: string } {
  const eq = token.indexOf("=")
  if (eq === -1) return { flag: token }
  return { flag: token.slice(0, eq), value: token.slice(eq + 1) }
}

function validateArg(type: FlagArgType, value: string | undefined): boolean {
  if (type === "none") return value === undefined
  if (value === undefined) return false
  if (type === "stdout") return value === "-"
  if (type === "number") return /^-?\d+$/.test(value)
  return value.length > 0
}

export function validateFlags(tokens: string[], startIndex: number, config: FlagValidationConfig): boolean {
  let positionals = 0

  for (let i = startIndex; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue

    if (token === "--") {
      const rest = tokens.length - i - 1
      positionals += rest
      break
    }

    if (token.startsWith("--") && token.length > 2) {
      const { flag, value } = longFlagParts(token)
      if (config.dangerousLongFlags?.has(flag)) return false
      const type = config.safeLongFlags?.[flag]
      if (type === undefined) {
        if (!config.allowUnknownLongFlags) return false
        continue
      }
      if (type === noArg) {
        if (value !== undefined) return false
        continue
      }
      const arg = value ?? tokens[i + 1]
      if (!validateArg(type, arg)) return false
      if (value === undefined) i++
      continue
    }

    if (token.startsWith("-") && token !== "-") {
      if (config.dangerousShortFlags?.has(token.slice(1, 2)) || config.dangerousLongFlags?.has(token)) return false
      if (token.length === 2) {
        const key = token[1]
        const type = config.safeShortFlags?.[key]
        if (type === undefined) return !!config.allowUnknownShortFlags
        if (type === noArg) continue
        const arg = tokens[i + 1]
        if (!validateArg(type, arg)) return false
        i++
        continue
      }

      for (let j = 1; j < token.length; j++) {
        const key = token[j]
        if (config.dangerousShortFlags?.has(key)) return false
        const type = config.safeShortFlags?.[key]
        if (type === undefined) {
          if (!config.allowUnknownShortFlags) return false
          continue
        }
        if (type === noArg) continue

        const inlineArg = token.slice(j + 1)
        const arg = inlineArg || tokens[i + 1]
        if (!validateArg(type, arg)) return false
        if (!inlineArg) i++
        break
      }
      continue
    }

    positionals++
  }

  if (config.allowPositionals === false && positionals > 0) return false
  if (config.minPositionals !== undefined && positionals < config.minPositionals) return false
  if (config.maxPositionals !== undefined && positionals > config.maxPositionals) return false
  return true
}

const CURL_CONFIG: FlagValidationConfig = {
  safeLongFlags: {
    "--silent": noArg,
    "--show-error": noArg,
    "--fail": noArg,
    "--fail-with-body": noArg,
    "--location": noArg,
    "--head": noArg,
    "--include": noArg,
    "--verbose": noArg,
    "--compressed": noArg,
    "--insecure": noArg,
    "--ipv4": noArg,
    "--ipv6": noArg,
    "--http1.1": noArg,
    "--http2": noArg,
    "--http3": noArg,
    "--get": noArg,
    "--globoff": noArg,
    "--no-progress-meter": noArg,
    "--url": "string",
    "--user-agent": "string",
    "--header": "string",
    "--request": "string",
    "--connect-timeout": "number",
    "--max-time": "number",
    "--retry": "number",
  },
  safeShortFlags: {
    s: noArg,
    S: noArg,
    f: noArg,
    L: noArg,
    I: noArg,
    i: noArg,
    v: noArg,
    k: noArg,
    g: noArg,
    H: "string",
    A: "string",
    X: "string",
    m: "number",
  },
  dangerousLongFlags: new Set([
    "--output",
    "--remote-name",
    "--remote-name-all",
    "--output-dir",
    "--dump-header",
    "--cookie-jar",
    "--trace",
    "--trace-ascii",
    "--trace-time",
    "--stderr",
    "--config",
    "--upload-file",
    "--form",
    "--form-string",
    "--data",
    "--data-raw",
    "--data-binary",
    "--data-urlencode",
    "--request-target",
  ]),
  dangerousShortFlags: new Set(["o", "O", "D", "c", "K", "T", "F", "d"]),
  allowPositionals: true,
  minPositionals: 1,
}

const WGET_DANGEROUS_LONG = new Set([
  "--output-document",
  "--append-output",
  "--save-cookies",
  "--warc-file",
  "--output-file",
  "--directory-prefix",
  "--input-file",
  "--load-cookies",
])

function isWgetReadOnly(tokens: string[]): boolean {
  let hasReadOnlyMode = false
  let positionals = 0

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token) continue
    if (token === "--") {
      positionals += tokens.length - i - 1
      break
    }
    if (token === "--spider") {
      hasReadOnlyMode = true
      continue
    }
    if (token === "-O" || token === "--output-document") {
      if (tokens[i + 1] !== "-") return false
      hasReadOnlyMode = true
      i++
      continue
    }
    if (token === "--output-document=-" || token === "-O-") {
      hasReadOnlyMode = true
      continue
    }
    if (token.startsWith("--")) {
      const { flag } = longFlagParts(token)
      if (WGET_DANGEROUS_LONG.has(flag)) return false
      if (flag === "--quiet" || flag === "--no-verbose" || flag === "--server-response" || flag === "--timeout") continue
      return false
    }
    if (token.startsWith("-") && token !== "-") {
      if (/^-[A-Za-z]*O-$/.test(token)) {
        hasReadOnlyMode = true
        continue
      }
      const short = token.slice(1)
      const outputIndex = short.indexOf("O")
      if (outputIndex !== -1) {
        if (!/^[qS]*O/.test(short)) return false
        const inlineTarget = short.slice(outputIndex + 1)
        const target = inlineTarget || tokens[i + 1]
        if (target !== "-") return false
        hasReadOnlyMode = true
        if (!inlineTarget) i++
        continue
      }
      if (/[aoPi]/.test(short)) return false
      if (/^[qS]+$/.test(short)) continue
      return false
    }
    positionals++
  }

  return hasReadOnlyMode && positionals > 0
}

function isSortReadOnly(tokens: string[]): boolean {
  return validateFlags(tokens, 1, {
    safeLongFlags: {
      "--reverse": noArg,
      "--numeric-sort": noArg,
      "--human-numeric-sort": noArg,
      "--unique": noArg,
      "--field-separator": "string",
      "--key": "string",
    },
    safeShortFlags: {
      r: noArg,
      n: noArg,
      h: noArg,
      u: noArg,
      t: "string",
      k: "string",
    },
    dangerousLongFlags: new Set(["--output"]),
    dangerousShortFlags: new Set(["o"]),
    allowPositionals: true,
  })
}

function isFindReadOnly(tokens: string[]): boolean {
  const writeArgs = new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-printf",
    "-fls",
    "-fprintf",
  ])
  return tokens.slice(1).every((token) => !writeArgs.has(token))
}

function gitSubcommandIndex(tokens: string[]): number {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      i++
      continue
    }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) continue
    if (token.startsWith("-")) continue
    return i
  }
  return -1
}

function hasGitOutputFlag(tokens: string[]): boolean {
  return tokens.some((token, index) => token === "--output" || token.startsWith("--output=") || (token === "-o" && tokens[index - 1] !== "remote"))
}

function allIn(values: string[], allowed: Set<string>): boolean {
  return values.every((value) => allowed.has(value))
}

function isGitReadOnly(tokens: string[]): boolean {
  if (hasGitOutputFlag(tokens)) return false
  const subIndex = gitSubcommandIndex(tokens)
  if (subIndex === -1) return false

  const sub = tokens[subIndex]
  const args = tokens.slice(subIndex + 1)
  const directReadOnly = new Set([
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "describe",
    "shortlog",
    "ls-files",
    "ls-tree",
    "rev-parse",
    "rev-list",
  ])
  if (directReadOnly.has(sub)) return true

  if (sub === "tag") {
    if (args.length === 0) return true
    if (args[0] === "-l" || args[0] === "--list") return args.length <= 2
    return false
  }

  if (sub === "branch") {
    if (args.length === 0) return true
    const safe = new Set(["-a", "--all", "-r", "--remotes", "--show-current", "--merged", "--no-merged", "-v", "--verbose"])
    return allIn(args, safe)
  }

  if (sub === "stash") {
    if (args[0] === "list") return args.length >= 1
    if (args[0] === "show") return args.length >= 1
    return false
  }

  if (sub === "remote") {
    if (args.length === 0) return true
    if (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")) return true
    if (args[0] === "show") return args.length <= 2
    return false
  }

  if (sub === "config") {
    if (args[0] === "--list") return args.length === 1
    if (args[0] === "--get" || args[0] === "--get-regexp") return args.length >= 2
    return false
  }

  return false
}

function isNpmReadOnly(tokens: string[]): boolean {
  const sub = tokens[1]
  if (!sub) return false
  if ((sub === "list" || sub === "whoami") && tokens.length === 2) return true
  if (sub === "view" && tokens.length >= 3) return true
  if (sub === "pack" && tokens.length === 3 && tokens[2] === "--dry-run") return true
  if (sub === "config" && tokens.length === 3 && tokens[2] === "list") return true
  if (sub === "cache" && tokens.length === 3 && tokens[2] === "ls") return true
  return false
}

function isPipReadOnly(tokens: string[]): boolean {
  const sub = tokens[1]
  if (!sub) return false
  if (sub === "list") return tokens.length === 2
  if (sub === "show") return tokens.length >= 2
  return false
}

export function isCommandSafeViaFlagParsing(tokens: string[]): boolean {
  const cmd = tokens[0]?.toLowerCase()
  if (!cmd) return false
  if (cmd === "find") return isFindReadOnly(tokens)
  if (cmd === "sort") return isSortReadOnly(tokens)
  if (cmd === "curl") return validateFlags(tokens, 1, CURL_CONFIG)
  if (cmd === "wget") return isWgetReadOnly(tokens)
  if (cmd === "git" || cmd === "git.exe") return isGitReadOnly(tokens)
  if (cmd === "npm" || cmd === "npm.cmd") return isNpmReadOnly(tokens)
  if (cmd === "pip" || cmd === "pip3") return isPipReadOnly(tokens)
  return false
}
