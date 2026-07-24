/**
 * read_memory / write_memory — 读写全局记忆
 *
 * 全局记忆存储在 App 数据目录 data/pi/memory/ 下，
 * 跨项目生效，记录用户编码偏好、说话风格、习惯等。
 *
 * MEMORY.md 索引自动维护，每次写入时重建。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { AgentTool } from "../types.js";
import { getCurrentRuntime } from "../globals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..", "..");
const MEMORY_DIR = resolve(APP_ROOT, "data", "pi", "memory");
const MEMORY_INDEX = resolve(MEMORY_DIR, "MEMORY.md");

/** 安全文件名校验：只允许字母、数字、点、下划线、短横线，最长 64 字符 */
export function validMemoryName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) && name.length <= 64;
}

/** 扫描 memory/ 目录，重建 MEMORY.md 索引 */
function updateMemoryIndex(): void {
  try {
    const files = readdirSync(MEMORY_DIR);
    const lines: string[] = [];
    for (const f of files.sort()) {
      if (f === "MEMORY.md" || !f.endsWith(".md")) continue;
      const name = f.replace(/\.md$/, "");
      // 读取第一行作为描述
      try {
        const firstLine = readFileSync(resolve(MEMORY_DIR, f), "utf-8").split("\n")[0] || "";
        const desc = firstLine.replace(/^#\s*/, "").trim();
        lines.push(`- [${name}](${f}) — ${desc}`);
      } catch {
        lines.push(`- [${name}](${f})`);
      }
    }
    writeFileSync(MEMORY_INDEX, lines.join("\n") + "\n", "utf-8");
  } catch {
    // memory/ 还不存在时静默
  }
}

export const readMemoryTool: AgentTool = {
  name: "read_memory",
  description: "读取一条全局记忆的完整内容。全局记忆记录用户偏好、习惯、项目无关的知识。name 是记忆文件名（不含 .md）。使用前先看 prompt 中的 MEMORY.md 索引了解有哪些记忆可用。",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "记忆名称，如 'user-profile'（不含 .md 后缀）",
      },
    },
    required: ["name"],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  execute: async ({ name }) => {
    const n = String(name ?? "");
    if (!validMemoryName(n)) return `无效的记忆名称"${n}"。名称只允许字母、数字、点、下划线、短横线，最长 64 字符。`;
    const filePath = resolve(MEMORY_DIR, `${n}.md`);
    if (!existsSync(filePath)) return `未找到记忆"${n}"。用 write_memory 创建一条新的。`;
    return readFileSync(filePath, "utf-8");
  },
};

export const writeMemoryTool: AgentTool = {
  name: "write_memory",
  description: "写入或更新一条全局记忆。全局记忆记录用户编码偏好、说话风格、习惯等跨项目通用的信息。name 是记忆名称（不含 .md），content 是完整 markdown 内容（建议含标题）。写入后自动刷新系统 prompt，当前对话可见。",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "记忆名称，如 'user-profile'（不含 .md 后缀）。建议用短横线连接的英文。",
      },
      content: {
        type: "string",
        description: "完整 markdown 内容。第一行建议用 # 标题简要概括本条记忆。",
      },
    },
    required: ["name", "content"],
  },
  isReadOnly: false,
  isDestructive: false,
  execute: async ({ name, content }) => {
    const n = String(name ?? "");
    if (!validMemoryName(n)) return `无效的记忆名称"${n}"。名称只允许字母、数字、点、下划线、短横线，最长 64 字符。`;
    // 确保 memory/ 目录存在
    if (!existsSync(MEMORY_DIR)) {
      const { mkdirSync } = await import("fs");
      mkdirSync(MEMORY_DIR, { recursive: true });
    }
    const filePath = resolve(MEMORY_DIR, `${n}.md`);
    writeFileSync(filePath, String(content), "utf-8");
    updateMemoryIndex();
    // 刷新系统 prompt 使当前对话立即看到更新
    const runtime = getCurrentRuntime();
    if (runtime) await runtime.refreshSystemPrompt();
    return `记忆"${n}"已更新。`;
  },
};
