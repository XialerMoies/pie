/**
 * file_write — 创建新文件或覆写已有文件
 *
 * 与 str_replace_editor 配合使用：str_replace_editor 改已有文件，
 * file_write 创建新文件。两者互补，覆盖所有写场景。
 */
import { writeFileSync, existsSync, statSync, mkdirSync, realpathSync } from "fs";
import { resolve, relative, isAbsolute, dirname, sep } from "path";
import type { AgentTool } from "../types.js";

/**
 * 确保路径在当前 workspace 内，拒绝路径穿越和 symlink 逃逸。
 *
 * 对已有文件：realpathSync 解析整个路径。
 * 对新文件（路径尚不存在）：解析最近的存在祖先的 realpath，
 * 再拼接剩余路径段，防止通过 symlink 目录写出外部。
 */
function guardPath(root: string, filePath: string): string {
  const rootResolved = resolve(root);
  let resolved = resolve(rootResolved, filePath);
  // 先尝试完整路径 realpath；如果文件不存在，逐级向上找存在的祖先
  try {
    resolved = realpathSync(resolved);
  } catch {
    // 文件/路径不存在：从 root 向下逐段检查 symlink
    const relSegments = relative(rootResolved, resolved).split(sep).filter(Boolean);
    let safePath = rootResolved;
    for (const seg of relSegments) {
      const candidate = resolve(safePath, seg);
      try {
        safePath = realpathSync(candidate);
      } catch {
        // 段不存在（新文件路径），用 resolve 继续拼接
        safePath = candidate;
      }
    }
    resolved = safePath;
  }
  const rel = relative(rootResolved, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Access denied: "${filePath}" is outside workspace`);
  }
  return resolved;
}

export const fileWriteTool: AgentTool = {
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
  execute: async ({ file_path, content }, ctx) => {
    const fp = String(file_path ?? "");
    const cnt = String(content ?? "");

    if (!fp) return "file_path 不能为空。";

    const root = ctx.workspace || "";
    if (!root) return "当前没有活跃 workspace。";

    let absPath: string;
    try {
      absPath = guardPath(root, fp);
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
};
