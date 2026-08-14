import type { SecurityParseResult, SecurityRedirect, SimpleCommand } from "../security-ast.js"
import {
  baseCommandName,
  confirmDanger,
  danger,
  normalizeTarget,
  type DangerResult,
} from "./shared.js"

function commandSample(command: SimpleCommand, fallback: string): string {
  return command.text || command.argv.join(" ") || fallback
}

function shortFlagHas(arg: string, flag: string): boolean {
  return arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).toLowerCase().includes(flag.toLowerCase())
}

function isDashNine(arg: string): boolean {
  const lower = arg.toLowerCase()
  return lower === "-9" || lower === "-kill" || lower === "--signal=kill" || lower === "--signal=9"
}

function isDangerousRmTarget(target: string): boolean {
  const normalized = normalizeTarget(target)
  if (normalized === "/" || normalized === "~" || normalized === ".") return true
  if (/^\.\.(\/|$)/.test(normalized)) return true
  if (/^\/(etc|usr|bin|boot|dev|var|sbin|lib|opt|sys|proc|root|home)(\/|$)/.test(normalized)) return true
  if (/^~[\/]/.test(normalized)) return true
  if (/^\/(Windows|Users|Program\s?Files|ProgramData)(\/|$)/i.test(normalized)) return true
  return false
}

function isDangerousWindowsRootTarget(target: string): boolean {
  const normalized = normalizeTarget(target)
  return normalized === "/" || /^\/(Windows|Users)(\/|$)/i.test(normalized)
}

function astRmDanger(command: SimpleCommand, sample: string): DangerResult | null {
  const argv = command.argv
  let recursive = false
  let force = false
  let noPreserveRoot = false
  let endOptions = false
  const targets: string[] = []

  for (const arg of argv.slice(1)) {
    if (!endOptions && arg === "--") {
      endOptions = true
      continue
    }
    if (!endOptions && arg === "--no-preserve-root") {
      noPreserveRoot = true
      continue
    }
    if (!endOptions && (arg === "--recursive" || arg === "--dir")) {
      recursive = true
      continue
    }
    if (!endOptions && arg === "--force") {
      force = true
      continue
    }
    if (!endOptions && arg.startsWith("-") && !arg.startsWith("--")) {
      if (/[rR]/.test(arg)) recursive = true
      if (/f/.test(arg)) force = true
      continue
    }
    targets.push(arg)
  }

  if (!recursive || !force) return null
  if (noPreserveRoot || targets.some(isDangerousRmTarget)) return danger("递归删除危险路径", sample)
  return null
}

function astChmodDanger(command: SimpleCommand, sample: string): DangerResult | null {
  let recursive = false
  const targets: string[] = []
  let endOptions = false

  for (const arg of command.argv.slice(1)) {
    if (!endOptions && arg === "--") {
      endOptions = true
      continue
    }
    if (!endOptions && (arg === "-R" || arg === "--recursive" || shortFlagHas(arg, "r"))) {
      recursive = true
      continue
    }
    if (!endOptions && arg.startsWith("-")) continue
    targets.push(arg)
  }

  if (recursive && targets.some((target) => {
    const normalized = normalizeTarget(target)
    return normalized === "/" || normalized === "." || normalized === "~" ||
      /^\/(etc|usr|bin|boot|dev|var|sbin|lib|opt|Windows|Users|home)(\/|$)/i.test(normalized)
  })) {
    return danger("文件权限高危操作", sample)
  }
  return null
}

function gitSubcommand(argv: readonly string[]): { name: string; args: string[] } | null {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--") {
      const next = argv[i + 1]
      return next ? { name: next.toLowerCase(), args: argv.slice(i + 2) } : null
    }
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      i++
      continue
    }
    if (/^(--git-dir|--work-tree|--namespace)=/.test(arg)) continue
    if (arg.startsWith("-")) continue
    return { name: arg.toLowerCase(), args: argv.slice(i + 1) }
  }
  return null
}

function astGitDanger(command: SimpleCommand, sample: string): DangerResult | null {
  const sub = gitSubcommand(command.argv)
  if (!sub) return null
  const args = sub.args

  if (sub.name === "push") {
    const forced = args.some((arg) =>
      arg === "-f" || shortFlagHas(arg, "f") || arg === "--force" ||
      arg.startsWith("--force-with-lease") || arg.startsWith("+")
    )
    if (forced) return confirmDanger("高风险 Git 操作：强制推送可能覆盖远端历史", sample)
  }

  if (sub.name === "clean") {
    const force = args.some((arg) => arg === "--force" || shortFlagHas(arg, "f"))
    const recursive = args.some((arg) => arg === "-d" || shortFlagHas(arg, "d"))
    if (force && recursive) return confirmDanger("高风险 Git 操作：Git clean 将删除未跟踪文件", sample)
  }

  if (sub.name === "reset" && args.some((arg) => arg === "--hard")) return confirmDanger("高风险 Git 操作：Git reset --hard 会丢弃未提交修改", sample)
  if (sub.name === "checkout" && args.some((arg) => arg === "--force" || shortFlagHas(arg, "f"))) return confirmDanger("高风险 Git 操作：强制 checkout 会覆盖工作区修改", sample)
  if (sub.name === "rebase" && args.some((arg) => arg === "--onto" || arg === "--interactive" || arg === "-i")) return confirmDanger("高风险 Git 操作：交互式或重定位 rebase 会改写提交历史", sample)
  if (sub.name === "commit" && (command.nextOperator || command.redirects.length > 0)) {
    return danger("git commit 后含 shell 运算符或重定向", sample)
  }

  return null
}

function astWindowsDeleteDanger(command: SimpleCommand, sample: string): DangerResult | null {
  const name = baseCommandName(command.argv[0])
  const args = command.argv.slice(1)
  const hasSwitch = (flag: string) => args.some((arg) => arg.toLowerCase().startsWith("/") && arg.toLowerCase().includes(flag))
  const targets = args.filter((arg) => !arg.startsWith("/") && !arg.startsWith("-"))

  if ((name === "del" || name === "erase") && hasSwitch("s") && hasSwitch("f") && targets.some(isDangerousWindowsRootTarget)) {
    return danger("Windows 强制递归删除", sample)
  }
  if ((name === "rmdir" || name === "rd") && hasSwitch("s") && hasSwitch("q") && targets.some(isDangerousWindowsRootTarget)) {
    return danger("Windows 强制递归删除", sample)
  }
  return null
}

function astPowerShellDeleteDanger(command: SimpleCommand, sample: string): DangerResult | null {
  const name = baseCommandName(command.argv[0])
  if (name !== "remove-item") return null
  const args = command.argv.slice(1)
  const recurse = args.some((arg) => /^-(r|recurse)$/i.test(arg))
  const force = args.some((arg) => /^-(f|force|fo)$/i.test(arg))
  const targets = args.filter((arg) => !arg.startsWith("-"))
  if (recurse && force && targets.some(isDangerousRmTarget)) return danger("PowerShell 递归删除", sample)
  return null
}

function redirectTargetIsDangerousDevice(redirect: SecurityRedirect): boolean {
  const target = redirect.target ?? ""
  return /^\/dev\/(sda|sdb|sdc|nvme|hd[a-z])/.test(target)
}

function redirectTargetIsNetwork(redirect: SecurityRedirect): boolean {
  const target = redirect.target ?? ""
  return /^\/dev\/(tcp|udp)(\/|$)/.test(target)
}

function astFsDanger(command: SimpleCommand, sample: string): DangerResult | null {
  const name = baseCommandName(command.argv[0])
  const argv = command.argv
  if (name.startsWith("mkfs") || name === "fdisk" || name === "mkswap" || name === "parted") {
    return danger("文件系统破坏性操作", sample)
  }
  if (name === "dd" && argv.some((arg) => arg.startsWith("if=")) && argv.some((arg) => arg.startsWith("of="))) {
    return danger("文件系统破坏性操作", sample)
  }
  if (name === "format" && argv.slice(1).some((arg) => /^[a-z]:$/i.test(arg))) return danger("文件系统破坏性操作", sample)
  if (command.redirects.some(redirectTargetIsDangerousDevice)) return danger("文件系统破坏性操作", sample)
  return null
}

function astSystemDanger(command: SimpleCommand, sample: string): DangerResult | null {
  const name = baseCommandName(command.argv[0])
  const args = command.argv.slice(1).map((arg) => arg.toLowerCase())
  if (name === "sudo") return danger("系统控制命令", sample)
  if (name === "su" && args[0] === "-") return danger("系统控制命令", sample)
  if (name === "shutdown" || name === "reboot" || name === "halt" || name === "poweroff") return danger("系统控制命令", sample)
  if (name === "init" && (args[0] === "0" || args[0] === "6")) return danger("系统控制命令", sample)
  if (name === "systemctl" && ["stop", "disable", "mask", "reboot", "poweroff"].includes(args[0] ?? "")) {
    return danger("系统控制命令", sample)
  }
  return null
}

function astKillDanger(command: SimpleCommand, sample: string): DangerResult | null {
  const name = baseCommandName(command.argv[0])
  const args = command.argv.slice(1)
  if ((name === "kill" || name === "pkill") && args.some(isDashNine)) return danger("进程杀伤", sample)
  if (name === "killall") return danger("进程杀伤", sample)
  if (name === "taskkill" && args.some((arg) => arg.toLowerCase() === "/f")) return danger("进程杀伤", sample)
  return null
}

function commandInvokesShell(command: SimpleCommand): boolean {
  const name = baseCommandName(command.argv[0])
  if (["bash", "sh", "zsh", "powershell", "pwsh"].includes(name)) return true
  if (name === "sudo") {
    const next = baseCommandName(command.argv.find((arg, index) => index > 0 && !arg.startsWith("-")))
    return ["bash", "sh", "zsh", "powershell", "pwsh"].includes(next)
  }
  return false
}

function astPipeShellDanger(commands: readonly SimpleCommand[], fallback: string): DangerResult | null {
  for (let i = 0; i < commands.length - 1; i++) {
    const command = commands[i]!
    const next = commands[i + 1]!
    const name = baseCommandName(command.argv[0])
    if ((name === "curl" || name === "wget") && command.nextOperator === "pipe" && commandInvokesShell(next)) {
      return danger("远程下载后执行", `${commandSample(command, fallback)} | ${commandSample(next, fallback)}`)
    }
  }
  return null
}

function astProcEnvironDanger(command: SimpleCommand, sample: string): DangerResult | null {
  const tokens = [
    ...command.argv,
    ...command.redirects.map((redirect) => redirect.target ?? ""),
  ]
  if (tokens.some((token) => /\/proc\/.*\/environ/.test(token))) {
    return danger("访问 /proc/*/environ 可能泄露环境变量", sample)
  }
  return null
}

export function checkAstDangerousPatterns(parsed: SecurityParseResult | undefined, fallback: string): DangerResult | null {
  if (!parsed || parsed.kind !== "simple") return null

  const pipeDanger = astPipeShellDanger(parsed.commands, fallback)
  if (pipeDanger) return pipeDanger

  for (const command of parsed.commands) {
    const sample = commandSample(command, fallback)
    if (command.redirects.some(redirectTargetIsNetwork)) return danger("网络重定向到 /dev/(tcp|udp)", sample)

    const name = baseCommandName(command.argv[0])
    const checks = [
      astProcEnvironDanger,
      astFsDanger,
      astSystemDanger,
      astKillDanger,
      astWindowsDeleteDanger,
      astPowerShellDeleteDanger,
      astChmodDanger,
      astGitDanger,
    ]

    for (const check of checks) {
      const result = check(command, sample)
      if (result) return result
    }
    if (name === "rm") {
      const result = astRmDanger(command, sample)
      if (result) return result
    }
  }

  return null
}
