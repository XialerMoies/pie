import {
  COMMON_VALUE_FLAGS,
  mark,
  type CommandPathArg,
} from "./core.js"

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

export function grepExtractor(args: string[]): CommandPathArg[] {
  return patternCommandExtractor(args, GREP_VALUE_FLAGS)
}

export function rgExtractor(args: string[]): CommandPathArg[] {
  return patternCommandExtractor(args, RG_VALUE_FLAGS, ["."])
}

export function sedExtractor(args: string[]): CommandPathArg[] {
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

export function jqExtractor(args: string[]): CommandPathArg[] {
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
