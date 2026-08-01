/**
 * str_replace_editor — 精确文件编辑工具
 *
 * 替换 PI 内置的整文件 Edit/Write，只修改匹配的文本块。
 * 参考 Claude Code FileEditTool 设计。
 *
 * 三种模式：
 *   1. old_string + new_string → 单次替换（已有文件）
 *   2. old_string: "" + new_string → 创建新文件
 *   3. edits: [{old_string, new_string}] → 批量替换
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "fs";
import { dirname } from "path";
import { defineAgentTool, structuredToolResult, type AgentTool } from "../types.js";
import { authorizeToolPath, guardToolPath } from "./path-authorization.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const MAX_RESULT_LINES = 50;

// ─── 弯引号常量（Unicode 弯引号 → 直引号归一）──────────────
const CURLY_SO = "‘"; // '
const CURLY_SC = "’"; // '
const CURLY_DO = "“"; // "
const CURLY_DC = "”"; // "

// ─── 反转义表 ───────────────────────────────────────────
const DESANITIZE: Record<string, string> = {
  "<fnr>": "<function_results>",
  "<n>": "<name>",
  "</n>": "</name>",
  "<o>": "<output>",
  "</o>": "</output>",
  "<e>": "<error>",
  "</e>": "</error>",
  "<s>": "<system>",
  "</s>": "</system>",
  "<r>": "<result>",
  "</r>": "</result>",
};

/** 弯引号 → 直引号 */
function normalizeQuotes(s: string): string {
  return s.replaceAll(CURLY_SO, "'").replaceAll(CURLY_SC, "'").replaceAll(CURLY_DO, '"').replaceAll(CURLY_DC, '"');
}

/** 在文件中找实际匹配（先精确，再归一引号重试） */
function findActualString(file: string, search: string): string | null {
  if (file.includes(search)) return search;
  const normSearch = normalizeQuotes(search);
  const normFile = normalizeQuotes(file);
  const idx = normFile.indexOf(normSearch);
  if (idx !== -1) return file.substring(idx, idx + search.length);
  return null;
}

/** 反转义 */
function desanitize(s: string): string {
  let r = s;
  for (const [from, to] of Object.entries(DESANITIZE)) {
    r = r.replaceAll(from, to);
  }
  return r;
}

/** 将 new_string 中的直引号转为文件原有的弯引号风格 */
function preserveQuoteStyle(oldString: string, actualOld: string, newString: string): string {
  if (oldString === actualOld) return newString;
  const hasDQ = actualOld.includes(CURLY_DO) || actualOld.includes(CURLY_DC);
  const hasSQ = actualOld.includes(CURLY_SO) || actualOld.includes(CURLY_SC);
  if (!hasDQ && !hasSQ) return newString;
  let r = newString;
  if (hasDQ) {
    let open = true;
    r = r.replace(/"/g, () => { const q = open ? CURLY_DO : CURLY_DC; open = !open; return q; });
  }
  if (hasSQ) {
    let open = true;
    r = r.replace(/'/g, () => { const q = open ? CURLY_SO : CURLY_SC; open = !open; return q; });
  }
  return r;
}

// ─── 替换执行 ──────────────────────────────────────────────

interface EditOp {
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

interface EditApplyResult {
  content: string;
  applied: number;
  missed?: string[];
}

/**
 * 对 content 执行一组替换。
 *
 * 单次编辑：支持 replace_all。
 * 批量编辑（edits.length > 1）：
 *   - 每项在原文中定位，反向偏移应用
 *   - 支持 replace_all 替换该 old_string 的所有匹配
 *   - 检测重叠：如果两个 edit 在原文中命中相同或交叉范围，拒绝并报错
 */
function applyEdits(content: string, edits: EditOp[]): EditApplyResult {
  if (edits.length === 0) return { content, applied: 0 };

  // ── 单次编辑（支持 replace_all，计数准确） ─────────────
  if (edits.length === 1) {
    const e = edits[0];
    if (e.old_string === "") {
      throw new Error('批量 edits 中 old_string 不能为空；创建新文件请使用单次模式的 old_string: ""。');
    }
    if (e.old_string === e.new_string) return { content, applied: 0 };
    const count = content.split(e.old_string).length - 1;
    if (count === 0) return { content, applied: 0 };
    if (!e.replace_all && count > 1) {
      throw new Error(`找到 ${count} 处匹配，但 replace_all 未开启。请扩大 old_string 惟一化，或设 replace_all: true。`);
    }

    const result = e.replace_all
      ? content.replaceAll(e.old_string, e.new_string)
      : content.replace(e.old_string, e.new_string);
    return { content: result, applied: e.replace_all ? count : 1 };
  }

  // ── 批量编辑：定位 + 全有或全无 + 重叠检测 + 反向偏移 ──
  const positioned: Array<{ offset: number; end: number; oldStr: string; newStr: string }> = [];
  const missed: string[] = [];

  for (const e of edits) {
    if (e.old_string === "") {
      throw new Error('批量 edits 中 old_string 不能为空；创建新文件请使用单次模式的 old_string: ""。');
    }
    if (e.old_string === e.new_string) continue;

    if (e.replace_all) {
      let searchFrom = 0;
      let found = false;
      while (true) {
        const idx = content.indexOf(e.old_string, searchFrom);
        if (idx === -1) break;
        positioned.push({ offset: idx, end: idx + e.old_string.length, oldStr: e.old_string, newStr: e.new_string });
        searchFrom = idx + 1;
        found = true;
      }
      if (!found) missed.push(e.old_string);
    } else {
      const idx = content.indexOf(e.old_string);
      if (idx === -1) { missed.push(e.old_string); continue; }
      positioned.push({ offset: idx, end: idx + e.old_string.length, oldStr: e.old_string, newStr: e.new_string });
    }
  }

  if (missed.length > 0) {
    return { content, applied: 0, missed };
  }
  if (positioned.length === 0) return { content, applied: 0 };

  // 重叠检测：排序后检查相邻项是否交叉
  positioned.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < positioned.length; i++) {
    if (positioned[i].offset < positioned[i - 1].end) {
      const overlapping = `编辑项重叠: "${positioned[i - 1].oldStr}" 和 "${positioned[i].oldStr}" 命中重叠区间，无法同时应用。请确保每项 old_string 在原文中不交叉。`;
      throw new Error(overlapping);
    }
  }

  // 反向替换从尾到头
  positioned.sort((a, b) => b.offset - a.offset);
  let result = content;
  for (const p of positioned) {
    result = result.slice(0, p.offset) + p.newStr + result.slice(p.offset + p.oldStr.length);
  }

  return { content: result, applied: positioned.length };
}

// ─── 工具定义 ──────────────────────────────────────────────

export const strReplaceEditorTool: AgentTool = defineAgentTool({
  name: "str_replace_editor",
  description:
    "精确文件编辑工具。三种模式：\n" +
    "1. file_path + old_string + new_string → 在已有文件中精确替换\n" +
    "2. file_path + old_string: \"\" + new_string → 创建新文件（含父目录）\n" +
    "3. file_path + edits: [{old_string, new_string, replace_all?}] → 批量替换\n\n" +
    "old_string 匹配会自动处理弯引号 → 直引号归一，以及 HTML 转义反转义。",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "文件路径（相对 workspace 或绝对路径）" },
      old_string: { type: "string", description: "要替换的文本。设为空串 \"\" 时创建新文件" },
      new_string: { type: "string", description: "替换后的文本" },
      replace_all: { type: "boolean", description: "替换所有匹配（默认 false）" },
      edits: {
        type: "array",
        description: "批量编辑。每项：{ old_string, new_string, replace_all? }",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["file_path"],
  },
  isReadOnly: false,
  isDestructive: true,
  isConcurrencySafe: false,
  operations: ["read", "create", "write"],
  riskLevel: "high",
  needsPermission: false,
  workspaceBounded: true,
  resultFormat: "structured",
  execute: async ({ file_path, old_string, new_string, replace_all, edits }, ctx) => {
    const fp = String(file_path ?? "");
    if (!fp) return "file_path 不能为空。";
    const root = ctx.workspace || "";
    if (!root) return "当前没有活跃 workspace。";

    let absPath: string;
    try { absPath = guardToolPath(root, fp); } catch (e: any) { return e.message; }

    // ── 模式 A：创建新文件（old_string === ""）────────────
    if (old_string === "" && new_string !== undefined && new_string !== null) {
      if (existsSync(absPath)) return `文件已存在：${fp}。编辑已有文件请提供 old_string。`;
      try { absPath = await authorizeToolPath(ctx, root, absPath, "create", "agent.str_replace.create"); } catch (e: any) { return e.message; }
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, String(new_string), "utf-8");
      const lines = String(new_string).split("\n").length;
      return structuredToolResult(`已创建 ${fp}（${lines} 行）。创建新文件请用 file_write 工具。`, {
        path: fp,
        operation: "create",
        applied: 1,
        totalLines: lines,
        changed: true,
      });
    }

    // ── 模式 B：批量 edits ──────────────────────────────
    const useEdits = Array.isArray(edits) && edits.length > 0;

    // ── 模式 C：单次替换 ────────────────────────────────
    const oldStr = useEdits ? "" : String(old_string ?? "");
    const newStr = useEdits ? "" : String(new_string ?? "");

    if (!useEdits && !oldStr) return "old_string 不能为空（编辑已有文件）或设为 \"\"（创建新文件）。";
    if (!useEdits && oldStr === newStr) return "old_string 和 new_string 相同，无需修改。";

    // 文件存在性
    if (!existsSync(absPath)) return `文件不存在: ${fp}`;
    try { absPath = await authorizeToolPath(ctx, root, absPath, "read", "agent.str_replace.read"); } catch (e: any) { return e.message; }
    const st = statSync(absPath);
    if (!st.isFile()) return `不是文件: ${fp}`;
    if (st.size > MAX_FILE_SIZE) return `文件过大（>1MB），无法编辑。`;

    const beforeMtime = statSync(absPath).mtimeMs;

    // 读文件
    const raw = readFileSync(absPath, "utf-8");
    const content = raw.replaceAll("\r\n", "\n");
    const hadCRLF = raw.includes("\r\n");

    let editsToApply: EditOp[];

    if (useEdits) {
      editsToApply = edits.map((e: any) => ({
        old_string: desanitize(findActualString(content, String(e.old_string ?? "")) || String(e.old_string ?? "")),
        new_string: String(e.new_string ?? ""),
        replace_all: e.replace_all === true,
      }));
    } else {
      // 单次：先反转义，再找实际匹配
      const deOld = desanitize(oldStr);
      const actualOld = findActualString(content, deOld) || (content.includes(deOld) ? deOld : null);
      if (actualOld === null) {
        return `未找到匹配文本。请重新读取文件确认当前内容，或扩大 old_string 的上下文范围。\n${oldStr.slice(0, 200)}`;
      }
      const matches = content.split(actualOld).length - 1;
      if (matches > 1 && !replace_all) {
        return `找到 ${matches} 处匹配，但 replace_all 未开启。请扩大 old_string 惟一化，或设 replace_all: true。`;
      }
      const actualNew = preserveQuoteStyle(deOld, actualOld, newStr);
      editsToApply = [{ old_string: actualOld, new_string: actualNew, replace_all: replace_all === true }];
    }

    // 执行替换（含重叠检测 + 全有或全无）
    let updated: string, applied: number;
    try {
      const r = applyEdits(content, editsToApply);
      updated = r.content;
      applied = r.applied;
      if (r.missed?.length) {
        return `以下编辑项在文件中未找到匹配：${r.missed.join(", ")}。请检查后重试。`;
      }
    } catch (e: any) {
      return e.message || "替换失败：编辑项之间存在冲突。";
    }
    if (applied === 0) return "没有匹配的替换项，请检查 old_string 是否正确。";

    // mtime 自检（允许 2ms 误差，防 Windows 文件系统缓存精度问题）
    const afterMtime = statSync(absPath).mtimeMs;
    if (Math.abs(afterMtime - beforeMtime) > 2) return `文件自读取后被外部修改，请重新读取后再编辑。`;

    // 保持 CRLF 并写盘
    const output = hadCRLF ? updated.replaceAll("\n", "\r\n") : updated;
    try { absPath = await authorizeToolPath(ctx, root, absPath, "write", "agent.str_replace.write"); } catch (e: any) { return e.message; }
    writeFileSync(absPath, output, "utf-8");

    const totalLines = updated.split("\n").length;
    const changed = useEdits ? `${applied} 处替换` : `${editsToApply[0].replace_all ? "全部" : "1"} 处替换`;
    let preview = totalLines <= MAX_RESULT_LINES ? `\n\n${updated.slice(0, 2000)}` : "";

    return structuredToolResult(`已替换 ${fp}：${changed}（文件共 ${totalLines} 行）。${preview}`, {
      path: fp,
      operation: "write",
      applied,
      totalLines,
      changed: true,
      replaceAll: useEdits ? undefined : editsToApply[0].replace_all,
    });
  },
});
