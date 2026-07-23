/**
 * 启动耗时埋点 — 记录关键节点时间戳，启动完成后输出汇总
 *
 * 使用：
 *   import { mark, logTiming } from "./timing"
 *   mark("server_start")
 *   // ... 后面各阶段
 *   mark("http_listening")
 *   logTiming() // 启动完成时调用一次
 */
const marks: Record<string, number> = {}
const LABEL_MAX = 24

export function mark(name: string): void {
  marks[name] = Date.now()
}

export function logTiming(): void {
  const entries = Object.entries(marks).sort((a, b) => a[1] - b[1])
  if (entries.length === 0) return
  const base = entries[0][1]
  const lines: string[] = []
  for (const [name, ts] of entries) {
    const offset = (ts - base).toFixed(0).padStart(6)
    lines.push(`  +${offset}ms  ${name.padEnd(LABEL_MAX)}`)
  }
  // 最后一行：总耗时
  const last = entries[entries.length - 1]
  const total = ((last[1] - base) / 1000).toFixed(2)
  console.log(`[timing] 启动耗时 ${total}s\n${lines.join("\n")}`)
}
