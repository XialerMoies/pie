import {
  COMMON_VALUE_FLAGS,
  mark,
  pathArgsOnly,
  type CommandPathArg,
} from "./core.js"

export function gitExtractor(args: string[]): CommandPathArg[] {
  if (args[0] !== "diff" || !args.includes("--no-index")) return []
  const paths = pathArgsOnly("git", args.slice(1), COMMON_VALUE_FLAGS).filter((arg) => arg !== "--no-index")
  return mark(paths.slice(0, 2), "read", "git diff --no-index")
}

export function tarExtractor(args: string[]): CommandPathArg[] {
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
