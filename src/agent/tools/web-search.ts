import { defineAgentTool, structuredToolError, structuredToolResult, type AgentTool, type ToolContext } from "../types.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { authorizeToolPath } from "./path-authorization.js";

function getProjectRoot(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    return resolve(__dirname, "..", "..", "..");
  } catch {
    return process.cwd();
  }
}

type SearchBackend = "auto" | "bing" | "provider";

let searchBackend: SearchBackend = "auto";

export function setSearchBackend(mode: SearchBackend): void {
  searchBackend = mode;
}

export function getSearchBackend(): SearchBackend {
  return searchBackend;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `未找到"${query}" 的相关搜索结果`;
  return results
    .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
    .join("\n\n");
}

async function bingSearch(query: string): Promise<string> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });

  if (!res.ok) throw new Error(`Bing 搜索失败: HTTP ${res.status}`);

  const html = await res.text();
  const results: SearchResult[] = [];
  const algoRe = /<li[^>]*class="b_algo"[^>]*>[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<div class="b_caption">[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;

  let m: RegExpExecArray | null;
  while ((m = algoRe.exec(html)) !== null) {
    results.push({
      url: m[1] || "",
      title: m[2]?.replace(/<[^>]+>/g, "").trim() || "",
      snippet: m[3]?.replace(/<[^>]+>/g, "").trim() || "",
    });
  }

  return formatResults(query, results);
}

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function isPermissionDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /permission denied|access denied/i.test(message);
}

async function readAuthorizedAuthJson(ctx: ToolContext | undefined, authPath: string): Promise<Record<string, any> | null> {
  if (!existsSync(authPath)) return null;
  try {
    const authorizedAuthPath = await authorizeToolPath(
      ctx,
      dirname(authPath),
      authPath,
      "read",
      "agent.web_search.auth",
    );
    return JSON.parse(readFileSync(authorizedAuthPath, "utf-8"));
  } catch (error) {
    if (isPermissionDeniedError(error)) throw error;
    return null;
  }
}

async function getProviderConfig(ctx?: ToolContext): Promise<ProviderConfig | null> {
  const model = process.env.PI_MODEL || "deepseek-v4-flash";
  let apiKey = "";
  let detectedProvider = "";

  const projectRoot = getProjectRoot();
  const candidates = [
    process.env.PI_USER_CONFIG && resolve(process.env.PI_USER_CONFIG, "auth.json"),
    process.env.PI_CONFIG_DIR && resolve(process.env.PI_CONFIG_DIR, "auth.json"),
    resolve(projectRoot, "data", "pi", "auth.json"),
    resolve(homedir(), ".pi", "agent", "auth.json"),
  ].filter(Boolean) as string[];

  for (const authPath of candidates) {
    const authData = await readAuthorizedAuthJson(ctx, authPath);
    if (!authData) continue;

    for (const provider of ["deepseek", "anthropic", "openai"]) {
      if (authData[provider]?.apiKey) {
        apiKey = authData[provider].apiKey;
        detectedProvider = provider;
        break;
      }
    }
    if (apiKey) break;
  }

  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_API_KEY || "";
  }
  if (!apiKey) return null;

  const baseUrl = detectedProvider === "deepseek"
    ? "https://api.deepseek.com/anthropic"
    : (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");

  return { baseUrl, apiKey, model };
}

async function providerSearch(query: string, ctx?: ToolContext): Promise<string> {
  const config = await getProviderConfig(ctx);
  if (!config) throw new Error("未配置 Provider API Key");

  const probeUrl = `${config.baseUrl}/v1/messages`;
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
  };

  const res = await fetch(probeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Provider 搜索失败 (${config.baseUrl}): HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const data = await res.json() as {
    content: Array<{
      type: string;
      text?: string;
      name?: string;
      content?: Array<{ title: string; url: string }>;
    }>;
  };

  const results: SearchResult[] = [];
  for (const block of data.content || []) {
    if (block.type === "tool_use" || block.type === "server_tool_use") continue;
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const hit of block.content) {
        results.push({
          title: hit.title || "",
          url: hit.url || "",
          snippet: "",
        });
      }
    }
    if (block.type === "text" && block.text && results.length === 0) {
      return block.text;
    }
  }

  if (results.length > 0) return formatResults(query, results);

  const textBlocks = data.content?.filter((block) => block.type === "text") || [];
  const fullText = textBlocks.map((block) => block.text || "").join("\n");
  if (fullText.trim()) return fullText;

  throw new Error("搜索结果为空");
}

export async function webSearch(query: string, ctx?: ToolContext): Promise<string> {
  const backend = searchBackend;

  if (backend === "provider") {
    try {
      return await providerSearch(query, ctx);
    } catch (error) {
      return `搜索不可用: ${(error as Error).message}`;
    }
  }

  if (backend === "bing") {
    try {
      return await bingSearch(query);
    } catch (error) {
      return `搜索失败: ${(error as Error).message}`;
    }
  }

  try {
    return await providerSearch(query, ctx);
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return `搜索不可用: ${(error as Error).message}`;
    }
    try {
      return await bingSearch(query);
    } catch (bingError) {
      return `搜索失败: ${(bingError as Error).message}`;
    }
  }
}

export const webSearchTool: AgentTool = defineAgentTool({
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
  operations: ["execute"],
  riskLevel: "medium",
  needsPermission: false,
  workspaceBounded: false,
  resultFormat: "structured",
  execute: async (args, ctx) => {
    const query = String(args.query ?? "");
    if (!query.trim()) return structuredToolError("请输入搜索关键词", "invalid_query");
    const normalizedQuery = query.trim();
    const text = await webSearch(normalizedQuery, ctx);
    return structuredToolResult(text, {
      query: normalizedQuery,
      backend: searchBackend,
      text,
    });
  },
});
