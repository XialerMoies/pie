/**
 * WebSearchTool — 自适应互联网搜索工具
 *
 * 搜索后端（按优先级）：
 * 1. Provider 原生搜索（web_search_20250305）— 走用户配置的 API
 * 2. Bing HTML 搜索 — 国内可访问，无需 API Key
 *
 * 配置方式：setSearchBackend("auto" | "bing" | "provider")
 */

import type { AgentTool } from "../types.js"
import { existsSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"

/** 本工具所在项目根目录（推导自本文件路径） */
function getProjectRoot(): string {
  try {
    // 文件在 src/agent/tools/web-search.ts → 往上 3 层
    const __dirname = dirname(fileURLToPath(import.meta.url))
    return resolve(__dirname, "..", "..", "..")
  } catch {
    return process.cwd()
  }
}

// ─── 搜索后端类型 ─────────────────────────────────

type SearchBackend = "auto" | "bing" | "provider"

let _searchBackend: SearchBackend = "auto"

export function setSearchBackend(mode: SearchBackend): void {
  _searchBackend = mode
}
export function getSearchBackend(): SearchBackend {
  return _searchBackend
}

// ─── 公用类型 ─────────────────────────────────────

interface SearchResult {
  title: string
  url: string
  snippet: string
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `未找到 "${query}" 的相关搜索结果`
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n")
}

// ─── Bing HTML 搜索（国内可访问，零配置） ─────────

async function bingSearch(query: string): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  })

  if (!res.ok) throw new Error(`Bing 搜索失败: HTTP ${res.status}`)

  const html = await res.text()
  const results: SearchResult[] = []

  // Bing 搜索结果解析
  // <li class="b_algo"> ... <h2 class=""><a href="url">title</a></h2> ... <div class="b_caption"><p>snippet</p></div>
  const algoRe = /<li[^>]*class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<div class="b_caption">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi

  let m: RegExpExecArray | null
  while ((m = algoRe.exec(html)) !== null) {
    results.push({
      url: m[1] || "",
      title: m[2]?.replace(/<[^>]+>/g, "").trim() || "",
      snippet: m[3]?.replace(/<[^>]+>/g, "").trim() || "",
    })
  }

  return formatResults(query, results)
}

// ─── Provider 原生搜索（web_search_20250305） ─────

interface ProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
}

/** 从环境变量读取 Provider 配置 */
function getProviderConfig(): ProviderConfig | null {
  const model = process.env.PI_MODEL || "deepseek-v4-flash"

  // 1. 从 PI auth.json 读取 DeepSeek Key（优先于环境变量）
  let apiKey = ""
  let detectedProvider = ""

  try {
    const projectRoot = getProjectRoot()
    const candidates = [
      process.env.PI_CONFIG_DIR && resolve(process.env.PI_CONFIG_DIR, "auth.json"),
      resolve(projectRoot, "data", "pi", "auth.json"),
      resolve(homedir(), ".pi", "agent", "auth.json"),
    ].filter(Boolean) as string[]

    for (const authPath of candidates) {
      if (!existsSync(authPath)) continue
      const authData = JSON.parse(readFileSync(authPath, "utf-8"))
      for (const prov of ["deepseek", "anthropic", "openai"]) {
        if (authData[prov]?.apiKey) {
          apiKey = authData[prov].apiKey
          detectedProvider = prov
          break
        }
      }
      if (apiKey) break
    }
  } catch { /* 静默 */ }

  // 2. 回退环境变量
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_API_KEY || ""
  }

  if (!apiKey) return null

  // 3. 根据 Key 来源选择正确的 API 地址
  let baseUrl: string
  if (detectedProvider === "deepseek") {
    // auth.json 里是 DeepSeek Key → 走 DeepSeek 官方的 Anthropic 兼容接口
    baseUrl = "https://api.deepseek.com/anthropic"
  } else {
    // 环境变量或第三方 Key → 用用户配置的 baseUrl
    baseUrl = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "")
  }

  return { baseUrl, apiKey, model }
}

/**
 * 通过 Provider API 搜索（web_search_20250305）。
 *
 * 流程（与 Claude Code 相同）：
 * 1. 构造一条用户消息 "搜索: {query}"
 * 2. 带上 web_search_20250305 tool schema
 * 3. 发送到 Provider API
 * 4. 解析返回的搜索工具结果
 */
async function providerSearch(query: string): Promise<string> {
  const config = getProviderConfig()
  if (!config) throw new Error("未配置 Provider API Key")

  // 先探测 Provider 是否支持 web_search
  const probeUrl = `${config.baseUrl}/v1/messages`

  const body = {
    model: config.model,
    max_tokens: 1024,
    system: "你是一个搜索助手。请执行网页搜索并将结果整理返回。",
    messages: [{ role: "user" as const, content: `Perform a web search for: ${query}` }],
    tools: [
      {
        type: "web_search_20250305" as const,
        name: "web_search" as const,
      },
    ],
    tool_choice: { type: "tool" as const, name: "web_search" as const },
    stream: false,
  }

  const res = await fetch(probeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Provider 搜索失败 (${config.baseUrl}): HTTP ${res.status} ${text.slice(0, 300)}`)
  }

  const data = await res.json() as {
    content: Array<{
      type: string
      text?: string
      name?: string
      content?: Array<{ title: string; url: string }>
    }>
  }

  // 从响应中提取搜索结果
  const results: SearchResult[] = []

  for (const block of data.content || []) {
    if (block.type === "tool_use" || block.type === "server_tool_use") {
      // 搜索工具的输入参数（可能包含 query 等）
      continue
    }

    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const hit of block.content) {
        results.push({
          title: hit.title || "",
          url: hit.url || "",
          snippet: "",
        })
      }
    }

    if (block.type === "text" && block.text) {
      // 模型对搜索结果的文字总结
      if (results.length === 0) return block.text
    }
  }

  if (results.length > 0) return formatResults(query, results)

  // 备选：从文本内容中提取链接
  const textBlocks = data.content?.filter((b) => b.type === "text") || []
  const fullText = textBlocks.map((b) => b.text || "").join("\n")
  if (fullText.trim()) return fullText

  throw new Error("搜索结果为空")
}

// ─── 主搜索函数 ───────────────────────────────────

export async function webSearch(query: string): Promise<string> {
  const backend = _searchBackend

  if (backend === "provider") {
    try { return await providerSearch(query) }
    catch (e) { return `搜索不可用: ${(e as Error).message}` }
  }

  if (backend === "bing") {
    try { return await bingSearch(query) }
    catch (e) { return `搜索失败: ${(e as Error).message}` }
  }

  // auto 模式
  try { return await providerSearch(query) }
  catch {
    try { return await bingSearch(query) }
    catch (e) { return `搜索失败: ${(e as Error).message}` }
  }
}

// ─── AgentTool ─────────────────────────────────────

export const webSearchTool: AgentTool = {
  name: "web-search",
  description: "搜索互联网获取最新信息。适用于查询新闻、技术文档、实时数据、百科知识等",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
    },
    required: ["query"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async (args) => {
    const query = String(args.query ?? "")
    if (!query.trim()) return "请输入搜索关键词"
    return await webSearch(query.trim())
  },
}
