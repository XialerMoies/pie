/**
 * file_write — 创建新文件或覆写已有文件
 *
 * 与 str_replace_editor 配合使用：str_replace_editor 改已有文件，
 * file_write 创建新文件。两者互补，覆盖所有写场景。
 */
import { writeFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { defineAgentTool, structuredToolError, structuredToolResult, type AgentTool } from "../types.js";
import { authorizeToolPath, guardToolPath } from "./path-authorization.js";
import { buildFileDiffMetadata } from "./file-diff.js";

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
  operations: ["create", "read", "write"],
  riskLevel: "high",
  needsPermission: false,
  workspaceBounded: true,
  resultFormat: "structured",
  execute: async ({ file_path, content }, ctx) => {
    const fp = String(file_path ?? "");
    const cnt = String(content ?? "");

    if (!fp) return structuredToolError("file_path 不能为空。", "invalid_file_path");

    const root = ctx.workspace || "";
    if (!root) return structuredToolError("当前没有活跃 workspace。", "workspace_required");

    let absPath: string;
    let isNew: boolean;
    let oldContent: string | null = null;
    try {
      const candidatePath = guardToolPath(root, fp);
      isNew = !existsSync(candidatePath);
      if (isNew) {
        absPath = await authorizeToolPath(ctx, root, candidatePath, "create", "agent.file_write.create");
      } else {
        const readPath = await authorizeToolPath(ctx, root, candidatePath, "read", "agent.file_write.read");
        oldContent = readFileSync(readPath, "utf-8");
        absPath = await authorizeToolPath(ctx, root, candidatePath, "write", "agent.file_write.write");
      }
    } catch (e: any) {
      return structuredToolError(e.message, "path_authorization_denied", { path: fp });
    }

    // 确保父目录存在
    const parent = dirname(absPath);
    mkdirSync(parent, { recursive: true });

    // 写文件
    writeFileSync(absPath, cnt, "utf-8");

    const lines = cnt.split("\n").length;
    const sizeKB = (Buffer.byteLength(cnt, "utf-8") / 1024).toFixed(1);
    const diff = buildFileDiffMetadata(fp, oldContent, cnt);
    return structuredToolResult(`${isNew ? "已创建" : "已覆盖"} ${fp}（${lines} 行，${sizeKB}KB）。`, {
      path: fp,
      operation: isNew ? "create" : "write",
      created: isNew,
      bytes: Buffer.byteLength(cnt, "utf-8"),
      lines,
    }, [], { diff });
  },
});
