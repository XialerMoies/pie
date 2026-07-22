/**
 * WebFetchTool — 抓取网页内容并转为 Markdown
 *
 * 参考 Claude Code 的 WebFetchTool 实现：
 * - 取 URL → 判断 HTML → 转 Markdown
 * - 不需要 API Key
 */

import type { AgentTool } from "../types.js"

const FETCH_TIMEOUT_MS = 30_000
const MAX_CONTENT_LENGTH = 500_000

/** 简易 HTML → 文本转换（不依赖 turndown，零依赖） */
function htmlToText(html: string): string {
  // 移除 script 和 style 标签及其内容
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")

  // 替换块级标签为换行
  text = text.replace(/<\/?(?:div|p|h[1-6]|li|blockquote|tr|th|td|section|article|br)[^>]*>/gi, "\n")

  // 替换其他标签
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "[图片: $1]")
    .replace(/<img[^>]*>/gi, "[图片]")
    .replace(/<[^>]+>/g, "")

  // 解码 HTML 实体
  text = text.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")

  // 压缩空白
  text = text.replace(/\n{3,}/g, "\n\n").trim()

  return text
}

/** 获取 HTTP 客户端超时信号 */
function timeoutSignal(ms: number): AbortController {
  const ac = new AbortController()
  setTimeout(() => ac.abort(), ms)
  return ac
}

export interface FetchResult {
  url: string
  title: string
  content: string
  contentType: string
  bytes: number
  code: number
}

async function fetchUrl(targetUrl: string): Promise<FetchResult> {
  const ac = timeoutSignal(FETCH_TIMEOUT_MS)

  const res = await fetch(targetUrl, {
    signal: ac.signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; MyCodeAgent/1.0)",
      "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
    },
    redirect: "follow",
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }

  const contentType = res.headers.get("content-type") || ""
  const isHtml = contentType.includes("text/html") || contentType.includes("application/xhtml")
  const raw = await res.text()
  const bytes = raw.length

  // 截断过大的内容
  const truncated = bytes > MAX_CONTENT_LENGTH
    ? raw.slice(0, MAX_CONTENT_LENGTH) + "\n\n[内容过长，已截断...]"
    : raw

  // 提取标题
  let title = ""
  const titleMatch = truncated.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (titleMatch) title = titleMatch[1].trim()

  // 内容转换
  const content = isHtml ? htmlToText(truncated) : truncated

  return { url: targetUrl, title, content, contentType, bytes, code: res.status }
}

// ─── AgentTool ─────────────────────────────────────

export const webFetchTool: AgentTool = {
  name: "web-fetch",
  description: "抓取指定 URL 的网页内容并转为可读文本。用于查看文档、网页、API 响应等",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "要抓取的完整 URL（含 https://）" },
    },
    required: ["url"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async (args) => {
    const url = String(args.url ?? "").trim()
    if (!url) return "请输入 URL"

    // 自动补全 https://
    const fullUrl = url.startsWith("http://") || url.startsWith("https://")
      ? url
      : `https://${url}`

    try {
      const result = await fetchUrl(fullUrl)

      let output = ""
      if (result.title) output += `# ${result.title}\n\n`
      output += `来源: ${result.url}\n`
      output += `大小: ${(result.bytes / 1024).toFixed(1)}KB`
      if (result.code !== 200) output += ` | HTTP ${result.code}`
      output += "\n\n---\n\n"
      output += result.content.slice(0, 50_000) // 截断到 5 万字

      if (result.content.length > 50_000) {
        output += "\n\n[内容过长，仅显示前 50000 字符]"
      }

      return output
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `抓取失败: ${msg}`
    }
  },
}
