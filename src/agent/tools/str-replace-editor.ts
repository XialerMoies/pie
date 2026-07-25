/**
 * str_replace_editor — 精确文件编辑工具
 *
 * 替换 PI 内置的整文件 Edit/Write，只修改匹配的文本块。
 * 参考 Claude Code FileEditTool 设计，但精简到核心安全逻辑。
 */
import { readFileSync, writeFileSync, existsSync, statSync, realpathSync } from "fs";
import { resolve, relative, isAbsolute, sep } from "path";
import type { AgentTool } from "../types.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_RESULT_LINES = 50;

/**
 * 确保路径在当前 workspace 内，拒绝路径穿越和 symlink 逃逸。
 *
 * 对已有文件：realpathSync 解析整个路径。
 * 对不存在路径：逐段解析祖先目录的 realpath，防止通过 symlink 目录写出外部。
 */
function guardPath(root: string, filePath: string): string {
  const rootResolved = resolve(root);
  let resolved = resolve(rootResolved, filePath);
  try {
    resolved = realpathSync(resolved);
  } catch {
    const relSegments = relative(rootResolved, resolved).split(sep).filter(Boolean);
    let safePath = rootResolved;
    for (const seg of relSegments) {
      const candidate = resolve(safePath, seg);
      try { safePath = realpathSync(candidate); } catch { safePath = candidate; }
    }
    resolved = safePath;
  }
  const rel = relative(rootResolved, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Access denied: "${filePath}" is outside workspace`);
  }
  return resolved;
}

export const strReplaceEditorTool: AgentTool = {
  name: "str_replace_editor",
  description:
    "精确文件编辑工具。在已有文件中搜索 old_string 并替换为 new_string。" +
    "比整文件 Edit/Write 更安全：只改匹配位置，不改无关内容，不出幺蛾子。" +
    "适用于修改已有文件。创建新文件请用 file_write。",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "要编辑的文件路径（相对 workspace 或绝对路径）",
      },
      old_string: {
        type: "string",
        description: "要替换的原始文本（精确匹配，包括缩进和换行）",
      },
      new_string: {
        type: "string",
        description: "替换后的新文本",
      },
      replace_all: {
        type: "boolean",
        description: "是否替换所有匹配（默认 false：只替换第一个）",
      },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  isReadOnly: false,
  isDestructive: true,
  execute: async ({ file_path, old_string, new_string, replace_all }, ctx) => {
    const fp = String(file_path ?? "");
    const oldStr = String(old_string ?? "");
    const newStr = String(new_string ?? "");
    const replaceAll = replace_all === true;

    if (!fp) return "file_path 不能为空。";
    if (!oldStr) return "old_string 不能为空。";
    if (oldStr === newStr) return "old_string 和 new_string 相同，无需修改。";

    const root = ctx.workspace || "";
    if (!root) return "当前没有活跃 workspace。";

    // 路径校验
    let absPath: string;
    try {
      absPath = guardPath(root, fp);
    } catch (e: any) {
      return e.message;
    }

    // 文件存在性 + 大小检查
    if (!existsSync(absPath)) return `文件不存在: ${fp}`;
    const st = statSync(absPath);
    if (!st.isFile()) return `不是文件: ${fp}`;
    if (st.size > MAX_FILE_SIZE) return `文件过大（>1MB），无法编辑。`;

    // 记录修改时间用于 stale 自检（本次调用读前/写前对比）
    const beforeMtime = statSync(absPath).mtimeMs;

    // 读文件内容，规范化换行
    const raw = readFileSync(absPath, "utf-8");
    const content = raw.replaceAll("\r\n", "\n");
    const hadCRLF = raw.includes("\r\n");

    // 查找匹配
    if (!content.includes(oldStr)) {
      return `未找到匹配文本。请重新读取文件确认当前内容，或扩大 old_string 的上下文范围。\n查找: ${oldStr.slice(0, 200)}`;
    }

    // 检查重复匹配
    const matches = content.split(oldStr).length - 1;
    if (matches > 1 && !replaceAll) {
      return `找到 ${matches} 处匹配，但 replace_all 未开启。请扩大 old_string 的上下文范围使其唯一，或设置 replace_all: true 全部替换。`;
    }

    // 执行替换
    const updated = replaceAll
      ? content.replaceAll(oldStr, newStr)
      : content.replace(oldStr, newStr);

    // 写前再检查 mtime，防止外部并发修改
    const afterMtime = statSync(absPath).mtimeMs;
    if (afterMtime !== beforeMtime) {
      return `文件自读取后被外部修改，请重新读取后再编辑。`;
    }

    // 保持原文件的 CRLF 风格
    const output = hadCRLF ? updated.replaceAll("\n", "\r\n") : updated;
    writeFileSync(absPath, output, "utf-8");

    // 生成结果摘要
    const oldLines = oldStr.split("\n").length;
    const newLines = newStr.split("\n").length;
    const changedLines = Math.abs(newLines - oldLines) + 1;
    const resultLines = updated.split("\n");
    const totalLines = resultLines.length;

    let preview = "";
    if (totalLines <= MAX_RESULT_LINES) {
      preview = `\n\n当前文件内容:\n${updated.slice(0, 2000)}`;
    }

    return `已替换 ${matches} 处匹配${replaceAll ? "（全部）" : ""}，涉及 ${changedLines} 行变化（文件共 ${totalLines} 行）。${preview}`;
  },
};
