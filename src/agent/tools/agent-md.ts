/**
 * write_agent_md — 更新项目级记忆（AGENT.md）
 *
 * AI 用此工具记录项目配置、构建方式、测试框架、代码风格偏好、架构决策等。
 * 每次对话开始时自动读入 prompt。
 */
import { existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { defineAgentTool, structuredToolResult, type AgentTool } from "../types.js";
import { getCurrentRuntime } from "../globals.js";
import { authorizeToolPath } from "./path-authorization.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..", "..", "..");

export const writeAgentMdTool: AgentTool = defineAgentTool({
  name: "write_agent_md",
  description:
    "更新项目级记忆（AGENT.md）。记录项目配置（构建/测试/部署方式）、" +
    "代码风格偏好、重要架构决策等。每次对话开始时 AI 自动读取此文件。" +
    "适合记录：'用 pnpm'、'测试用 vitest'、'测试放 __tests__ 目录'、" +
    "'用单引号'、'数据库用 SQLite' 等。每次写入会覆盖全部内容。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "AGENT.md 完整内容。建议按类别分组，用 markdown 标题分隔不同主题。",
      },
    },
    required: ["content"],
  },
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false,
  operations: ["create", "write"],
  riskLevel: "medium",
  needsPermission: false,
  workspaceBounded: true,
  resultFormat: "structured",
  execute: async ({ content }, ctx) => {
    const root = ctx.workspace || APP_ROOT;
    const agentMdPath = resolve(root, "AGENT.md");
    const operation = existsSync(agentMdPath) ? "write" : "create";
    let authorizedFile: string;
    try {
      authorizedFile = await authorizeToolPath(ctx, root, agentMdPath, operation, `agent.agent_md.${operation}`);
      writeFileSync(authorizedFile, String(content), "utf-8");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    // 刷新系统 prompt 使当前对话立即生效
    const runtime = getCurrentRuntime();
    if (runtime) await runtime.refreshSystemPrompt();
    const textContent = String(content);
    return structuredToolResult("AGENT.md 已更新，当前对话已生效。", {
      path: authorizedFile,
      operation,
      bytes: Buffer.byteLength(textContent, "utf-8"),
      lines: textContent.split("\n").length,
      refreshedPrompt: true,
    });
  },
});
