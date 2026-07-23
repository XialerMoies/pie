/**
 * CommandTool — 执行 shell 命令，支持流式 stdout/stderr
 *
 * 替代 PI 内置 bash 工具，提供实时输出推送。
 * 通过 ctx.onUpdate 每收到一段 stdout 即推送。
 */
import type { AgentTool } from "../types.js"
import { spawn } from "child_process"
import { StringDecoder } from "string_decoder"
import { TextDecoder } from "util"

const MAX_OUTPUT = 100 * 1024 // 100KB 总输出上限
const COMMAND_TIMEOUT = 300_000 // 5 分钟

function isWindows(): boolean {
  return process.platform === "win32"
}

function decodeCommandChunk(data: Buffer, decoder: StringDecoder): string {
  const text = decoder.write(data)
  if (!isWindows() || !text.includes("�")) return text
  try {
    return new TextDecoder("gb18030").decode(data)
  } catch {
    return text
  }
}

export const commandTool: AgentTool = {
  name: "command",
  description: "在项目目录执行 shell 命令并返回输出。支持流式实时 stdout/stderr",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      cwd: { type: "string", description: "工作目录（可选，默认为项目根目录）" },
      timeout: { type: "number", description: "超时时间（毫秒，默认 300000）" },
    },
    required: ["command"],
  },
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  execute: async (args, ctx) => {
    const cmd = String(args.command ?? "").trim()
    if (!cmd) return "请输入要执行的命令"

    const cwd = String(args.cwd || ctx.cwd || process.cwd())
    const timeout = Number(args.timeout) || COMMAND_TIMEOUT

    return new Promise<string>((resolve, reject) => {
      const isWin = isWindows()
      const shellCommand = isWin ? `chcp 65001>nul && ${cmd}` : cmd
      const child = spawn(shellCommand, [], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
        timeout,
        windowsHide: true,
      })

      let stdout = ""
      let stderr = ""
      const stdoutDecoder = new StringDecoder("utf8")
      const stderrDecoder = new StringDecoder("utf8")

      const pushUpdate = (chunk: string) => {
        ctx?.onUpdate?.(chunk)
      }

      child.stdout?.on("data", (data: Buffer) => {
        const text = decodeCommandChunk(data, stdoutDecoder)
        const remaining = MAX_OUTPUT - stdout.length
        if (remaining <= 0) return // 已截断，静默丢弃
        if (text.length >= remaining) {
          stdout += text.slice(0, remaining) + "\n...输出截断（超过 100KB）"
          pushUpdate(text.slice(0, remaining))
          pushUpdate("\n...输出截断（超过 100KB）")
          child.kill()
          return
        }
        stdout += text
        pushUpdate(text)
      })

      child.stderr?.on("data", (data: Buffer) => {
        const text = decodeCommandChunk(data, stderrDecoder)
        const remaining = MAX_OUTPUT - stderr.length
        if (remaining <= 0) return
        if (text.length >= remaining) {
          stderr += text.slice(0, remaining) + "\n...输出截断（超过 100KB）"
          pushUpdate(text.slice(0, remaining))
          pushUpdate("\n...输出截断（超过 100KB）")
          child.kill()
          return
        }
        stderr += text
        pushUpdate(text)
      })

      child.on("error", (err) => {
        const msg = `命令执行失败: ${err.message}`
        ctx?.onUpdate?.(msg + "\n")
        reject(new Error(msg))
      })

      child.on("close", (code) => {
        const stdoutTail = stdoutDecoder.end()
        const stderrTail = stderrDecoder.end()
        if (stdoutTail) stdout += stdoutTail
        if (stderrTail) stderr += stderrTail
        let result = ""
        if (stdout) result += stdout
        if (stderr) result += (result ? "\n" : "") + stderr
        if (code !== null && code !== 0) {
          result += `\n⚠ 命令退出码: ${code}`
        }
        resolve(result || `命令已完成（退出码: ${code}）`)
      })
    })
  },
}
