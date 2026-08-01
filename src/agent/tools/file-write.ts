/**
 * file_write — 创建新文件或覆写已有文件
 *
 * 与 str_replace_editor 配合使用：str_replace_editor 改已有文件，
 * file_write 创建新文件。两者互补，覆盖所有写场景。
 */
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { defineAgentTool, type AgentTool } from "../types.js";
import { authorizeToolPath, guardToolPath } from "./path-authorization.js";

export const fileWriteTool: AgentTool = defineAgentTool({
  name: "file_write",
  description:
    "创建新文件或覆写已有文件。会完全覆盖目标文件内容，使用前请确认。" +
    "修改已有文件请优先用 str_replace_editor（精确替换），避免整文件覆写。",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "文件路径（相对 workspace 或绝对路径）",
      },
      content: {
        type: "string",
        description: "文件完整内容",
      },
    },
    required: ["file_path", "content"],
  },
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  operations: ["create", "write"],
  riskLevel: "high",
  needsPermission: false,
  workspaceBounded: true,
  execute: async ({ file_path, content }, ctx) => {
    const fp = String(file_path ?? "");
    const cnt = String(content ?? "");

    if (!fp) return "file_path 不能为空。";

    const root = ctx.workspace || "";
    if (!root) return "当前没有活跃 workspace。";

    let absPath: string;
    try {
      const candidatePath = guardToolPath(root, fp);
      const operation = existsSync(candidatePath) ? "write" : "create";
      absPath = await authorizeToolPath(ctx, root, candidatePath, operation, `agent.file_write.${operation}`);
    } catch (e: any) {
      return e.message;
    }

    // 确保父目录存在
    const parent = dirname(absPath);
    mkdirSync(parent, { recursive: true });

    const isNew = !existsSync(absPath);

    // 写文件
    writeFileSync(absPath, cnt, "utf-8");

    const lines = cnt.split("\n").length;
    const sizeKB = (Buffer.byteLength(cnt, "utf-8") / 1024).toFixed(1);
    return `${isNew ? "已创建" : "已覆盖"} ${fp}（${lines} 行，${sizeKB}KB）。`;
  },
});
