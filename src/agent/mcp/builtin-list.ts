/**
 * 内置精选 MCP server 目录（唯一权威源）
 *
 * 前端列表从 GET /api/mcp/catalog 获取。
 * 安装接口只接受此列表中的 id。
 */

export interface CatalogEntry {
  /** 唯一标识（用于安装） */
  id: string
  /** 显示名 */
  name: string
  /** 简短描述 */
  description: string
  /** 分类标签 */
  category: string
  /** 启动命令 */
  command: string
  /** 启动参数 */
  args: string[]
  /** 需要用户自行设置的环境变量 */
  envHints?: string[]
  /** 安装后提示用户修改的配置 */
  postInstallHint?: string
}

export const MCP_CATALOG: CatalogEntry[] = [
  { id: "filesystem", name: "文件系统", description: "安全的文件读写、搜索、目录操作", category: "工具", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"], postInstallHint: "安装后将 /path/to/dir 替换为要授权的目录路径" },
  { id: "github", name: "GitHub", description: "GitHub API 集成：仓库、Issue、PR、代码搜索", category: "开发", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envHints: ["GITHUB_TOKEN"] },
  { id: "postgres", name: "PostgreSQL", description: "数据库查询、表结构浏览、SQL 执行", category: "数据库", command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://user:pass@localhost/db"], postInstallHint: "将连接串替换为你的 PostgreSQL 连接字符串" },
  { id: "sqlite", name: "SQLite", description: "SQLite 数据库查询和管理", category: "数据库", command: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite", "/path/to/db.sqlite"], postInstallHint: "替换为你的数据库文件路径" },
  { id: "duckduckgo", name: "DuckDuckGo 搜索", description: "互联网搜索，无需 API Key，国内可访问", category: "网络", command: "npx", args: ["-y", "mcp-server-duckduckgo"] },
  { id: "brave-search", name: "Brave 搜索", description: "互联网搜索（需 Brave API Key，每月 2000 次免费）", category: "网络", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], envHints: ["BRAVE_API_KEY"] },
  { id: "web-fetch", name: "Web 抓取", description: "抓取网页内容并转为 Markdown", category: "网络", command: "npx", args: ["-y", "@anthropic/mcp-server-web-fetch"] },
  { id: "docker", name: "Docker", description: "Docker 容器、镜像、日志管理", category: "工具", command: "npx", args: ["-y", "@modelcontextprotocol/server-docker"] },
  { id: "playwright", name: "Playwright", description: "浏览器自动化：截图、点击、导航", category: "工具", command: "npx", args: ["-y", "@modelcontextprotocol/server-playwright"] },
  { id: "memory", name: "Memory", description: "为 LLM 提供持久化知识图谱记忆", category: "AI", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  { id: "sequential-thinking", name: "Sequential Thinking", description: "思维链逐步推理和问题分解", category: "AI", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
  { id: "puppeteer", name: "Puppeteer", description: "无头浏览器操作：抓取、截图、PDF", category: "工具", command: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] },
]
