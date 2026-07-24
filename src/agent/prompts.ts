/**
 * System prompt section management
 *
 * 分片组装 system prompt，每片独立缓存。
 * 目标：类似 Claude Code 的 systemPromptSection() 模式。
 *
 * 当前实现：同步加载缓存的 sections。后续可扩展为按需刷新。
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..");
const MEMORY_DIR = resolve(APP_ROOT, "data", "pi", "memory");
const MEMORY_INDEX = resolve(MEMORY_DIR, "MEMORY.md");

export interface PromptSection {
  key: string;
  /** 静态内容（与 factory 二选一） */
  content?: string;
  /** 惰性工厂函数（与 content 二选一）。每次 resolve 时调用 */
  factory?: () => string;
  /** 是否需要每次重新计算（如环境信息）。对 factory section 自动为 true */
  volatile?: boolean;
  /** 是否启用。设为 false 时 resolveSystemPrompt 会跳过这片。运行时可通过 setSectionEnabled() 开关 */
  enabled?: boolean;
  /** 永久 section，不会被 invalidateAllSections() 清除（如 identity / tools_guidance 等默认注册） */
  permanent?: boolean;
}

const sectionCache = new Map<string, PromptSection>();

/**
 * 注册一个 system prompt section。
 * 相同 key 的 section 会被缓存，直到调用 invalidateSection(key)。
 *
 * @param key   唯一标识
 * @param contentOrFactory  静态内容字符串，或惰性工厂函数（volatile 时每次 resolve 重新调用）
 * @param options  可选：volatile（每次重算）、enabled（是否启用，默认 true）
 */
export function defineSection(key: string, contentOrFactory: string | (() => string), options?: boolean | { volatile?: boolean; enabled?: boolean; permanent?: boolean }): PromptSection {
  const opts = typeof options === "boolean" ? { volatile: options } : (options || {});
  const isFactory = typeof contentOrFactory === "function";
  const section: PromptSection = {
    key,
    content: isFactory ? undefined : contentOrFactory as string,
    factory: isFactory ? contentOrFactory as () => string : undefined,
    volatile: opts.volatile ?? isFactory,
    enabled: opts.enabled ?? true,
    permanent: opts.permanent,
  };
  sectionCache.set(key, section);
  return section;
}

/**
 * 注册一个永不缓存的 system prompt section。
 * 每次 resolveSystemPrompt() 都会重新调用 factory。
 * 适用于环境信息、时间、cwd 等每次都变的上下文。
 */
export function DANGEROUS_uncachedSystemPromptSection(key: string, factory: () => string): PromptSection {
  return defineSection(key, factory, { volatile: true });
}

/**
 * 动态开关一个 section（运行时修改 enabled 状态，不需要重新注册）。
 */
export function setSectionEnabled(key: string, enabled: boolean): void {
  const section = sectionCache.get(key);
  if (section) section.enabled = enabled;
}

/**
 * 使某个 section 的缓存失效，下次 resolve 时重新计算。
 */
export function invalidateSection(key: string): void {
  sectionCache.delete(key);
}

/**
 * 使所有可清除的缓存 section 失效。
 * - permanent 标记的 section（如 identity / tools_guidance 等默认注册）保留
 * - factory section 保留（它们每次 resolve 已重新求值，无需删除）
 * - 静态非永久 section 被清除
 */
export function invalidateAllSections(): void {
  for (const [key, section] of sectionCache) {
    if (section.permanent || section.factory) continue;
    sectionCache.delete(key);
  }
}

/**
 * 合并所有已注册且启用的 sections 为一个完整的 system prompt。
 * - enabled === false 的 section 会被跳过
 * - volatile 或 factory 的 section 每次重新求值
 * - 静态 section 直接使用缓存内容
 */
export function resolveSystemPrompt(): string {
  const parts: string[] = [];
  for (const [, section] of sectionCache) {
    if (section.enabled === false) continue;
    if (section.factory) {
      parts.push(section.factory());
    } else if (section.content !== undefined) {
      parts.push(section.content);
    }
  }
  return parts.join("\n\n");
}

// ─── 默认 sections（permanent，不会被 invalidateAllSections 清除）────

defineSection("identity", `你是 My Code Agent，一个基于 PI 框架的智能编程助手。
你通过工具与用户交互：读文件、写代码、执行命令、搜索内容。
`, { permanent: true });

defineSection("tools_guidance", `## 工具使用指南

- 使用 Read 来查看文件内容
- 使用 Edit/Write 来修改文件
- 使用 Command 来执行命令（编译、运行、测试），支持实时查看输出
- 使用 Glob/Grep 来搜索文件

注意安全：执行破坏性命令前需确认。
`, { permanent: true });

defineSection("code_style", `## 代码风格

- TypeScript + ESM（"type": "module"）
- 注释密度与周围代码保持一致
- 使用 markdown 链接格式引用文件：\`[filename](path)\`
- 渐进式修改，不重写
`, { permanent: true });

defineSection("response_style", `## 回复风格

根据消息的复杂程度自动调节回复详细程度。
问候和简单查询用一句话回答，复杂任务深入分析。

不要在最终回答中输出内部思考、计划步骤或英文过程句。
连续调用 2-3 个工具后，用一句话（≤15 字）说明当前进展。
工具结果与预期明显不符时，简述发生了什么。
其余情况不需要每次工具调用后都回复，等最终一次性输出。
`, { permanent: true });

// ─── 记忆管理引导 ────────────────────────────────────────────────

defineSection("memory_management", `## 记忆管理

你可以用以下工具管理记忆：
- write_agent_md — 更新项目级记忆（AGENT.md），适合记录项目配置、架构决策
- read_memory — 读取一条全局记忆（编码偏好、说话风格等）
- write_memory — 写入/更新一条全局记忆

当以下情况发生时，应该主动更新记忆：
- 发现项目的构建/测试/部署方式（如"用 pnpm"、"测试用 vitest"）
- 用户明确说了代码风格偏好（如"用单引号"、"测试放 __tests__ 目录"）
- 你做了重要决策（如"不用 Redis，用 SQLite"）
- 用户纠正了你的错误理解

不需要记录普通的对话内容或临时修改。
`, { permanent: true });

// ─── volatile 动态 section（每次 resolve 重新计算）────────────────

/**
 * 环境信息：cwd + 时间。每次 resolve 重新计算，适合 /clear 后自动刷新。
 * worker prompt 在 worker 进程内会自动获得 CWD，不需要注入。
 * 这里仅注入辅助上下文（时间、平台），帮助 LLM 理解当前环境。
 */
DANGEROUS_uncachedSystemPromptSection("env_info", () => {
  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return `## 当前环境\n\n- 时间：${dateStr}\n- 平台：${typeof process !== "undefined" ? process.platform : "unknown"}\n- CWD：${typeof process !== "undefined" ? process.cwd() : "unknown"}`;
});

// ─── 项目级记忆（AGENT.md）────────────────────────────────────────

import { getCurrentRuntime } from "./globals.js";

// ─── project sections ─────────────────────────────────────────────

DANGEROUS_uncachedSystemPromptSection("agent_md", () => {
  // globals.ts 零依赖，不会产生循环引用
  const runtime = getCurrentRuntime();
  const root = runtime?.currentWorkspace || APP_ROOT;
  const agentMdPath = resolve(root, "AGENT.md");
  try {
    const content = readFileSync(agentMdPath, "utf-8");
    if (!content.trim()) return "";
    return `# 项目指南（来自 AGENT.md）\n\n${content}\n\n你可以用 write_agent_md 工具更新此文件。`;
  } catch {
    return "";
  }
});

// ─── 全局记忆（memory/ 索引）──────────────────────────────────────

DANGEROUS_uncachedSystemPromptSection("global_memory", () => {
  try {
    if (!existsSync(MEMORY_DIR)) return "";
    const indexContent = readFileSync(MEMORY_INDEX, "utf-8");
    if (!indexContent.trim()) return "";
    return `# 全局记忆\n\n${indexContent}\n\n你可以用 read_memory / write_memory 工具读取或更新这些记忆。`;
  } catch {
    return "";
  }
});
