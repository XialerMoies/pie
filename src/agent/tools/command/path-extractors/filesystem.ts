import {
  DEFAULT_OPERATION,
  mark,
  pathArgsOnly,
  type CommandPathArg,
  type PathCommand,
} from "./core.js"

export function cpExtractor(args: string[], command: PathCommand): CommandPathArg[] {
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

export function mvExtractor(args: string[], command: PathCommand): CommandPathArg[] {
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

export function findExtractor(args: string[]): CommandPathArg[] {
  const paths: string[] = []
  const pathFlags = new Set(["-newer", "-anewer", "-cnewer", "-samefile"])
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

export function findstrExtractor(args: string[]): CommandPathArg[] {
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

export function sortExtractor(args: string[]): CommandPathArg[] {
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

export function powershellContentExtractor(args: string[], command: PathCommand): CommandPathArg[] {
  const explicitPath = args.findIndex((arg) => /^-(filepath|literalpath|path)$/i.test(arg))
  if (explicitPath !== -1 && args[explicitPath + 1]) return [{ token: args[explicitPath + 1]!, operation: DEFAULT_OPERATION[command] }]
  const positional = pathArgsOnly(command, args)
  return positional[0] ? [{ token: positional[0], operation: DEFAULT_OPERATION[command] }] : []
}
