/**
 * Monaco 主题定义 + 语言映射 + Completion kind 映射
 *
 * 从 monaco-setup.ts 拆出的纯数据层。
 */
import * as monaco from "monaco-editor";

// ─── Completion kind mapping ───────────────────────────────────

const completionKindMap: Record<number, monaco.languages.CompletionItemKind> = {
  0: monaco.languages.CompletionItemKind.Text,
  1: monaco.languages.CompletionItemKind.Method,
  2: monaco.languages.CompletionItemKind.Function,
  3: monaco.languages.CompletionItemKind.Constructor,
  4: monaco.languages.CompletionItemKind.Field,
  5: monaco.languages.CompletionItemKind.Variable,
  6: monaco.languages.CompletionItemKind.Class,
  7: monaco.languages.CompletionItemKind.Struct,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Event,
  12: monaco.languages.CompletionItemKind.Operator,
  13: monaco.languages.CompletionItemKind.Unit,
  14: monaco.languages.CompletionItemKind.Value,
  15: monaco.languages.CompletionItemKind.Constant,
  16: monaco.languages.CompletionItemKind.Enum,
  17: monaco.languages.CompletionItemKind.EnumMember,
  18: monaco.languages.CompletionItemKind.Keyword,
  19: monaco.languages.CompletionItemKind.Snippet,
  20: monaco.languages.CompletionItemKind.Color,
  21: monaco.languages.CompletionItemKind.File,
  22: monaco.languages.CompletionItemKind.Reference,
  23: monaco.languages.CompletionItemKind.Deprecated,
};

export function mapCompletionKind(kind: string | number): monaco.languages.CompletionItemKind {
  if (typeof kind === "number") return completionKindMap[kind] || monaco.languages.CompletionItemKind.Text;
  const strMap: Record<string, monaco.languages.CompletionItemKind> = {
    method: monaco.languages.CompletionItemKind.Method,
    function: monaco.languages.CompletionItemKind.Function,
    constructor: monaco.languages.CompletionItemKind.Constructor,
    field: monaco.languages.CompletionItemKind.Field,
    variable: monaco.languages.CompletionItemKind.Variable,
    class: monaco.languages.CompletionItemKind.Class,
    interface: monaco.languages.CompletionItemKind.Interface,
    module: monaco.languages.CompletionItemKind.Module,
    property: monaco.languages.CompletionItemKind.Property,
    constant: monaco.languages.CompletionItemKind.Constant,
    enum: monaco.languages.CompletionItemKind.Enum,
    keyword: monaco.languages.CompletionItemKind.Keyword,
  };
  return strMap[kind.toLowerCase()] || monaco.languages.CompletionItemKind.Text;
}

// ─── 语言映射 ───────────────────────────────────────────────────

const langMap: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json", md: "markdown",
  html: "html", htm: "html", css: "css", scss: "scss", less: "less",
  py: "python", rs: "rust", go: "go", rb: "ruby", php: "php",
  java: "java", kt: "kotlin", swift: "swift",
  c: "c", cpp: "cpp", h: "c", cs: "csharp",
  sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml",
  xml: "xml", svg: "xml", vue: "html", svelte: "html",
  sql: "sql", r: "r", pl: "perl", lua: "lua", scala: "scala",
  hs: "haskell", dart: "dart", zig: "zig", graphql: "graphql",
  toml: "ini", env: "dotenv", conf: "ini", cfg: "ini",
};

export function langFromPath(id: string): string {
  const ext = (id.split(".").pop() || "").toLowerCase();
  return langMap[ext] || "plaintext";
}

// ─── 自定义主题与背景色统一 ──────────────────────────────────

// 暗色主题 — 与应用 --bg: #0A0A0F 保持一致
export function defineThemes(): void {
  monaco.editor.defineTheme("app-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0A0A0F",
      "editor.foreground": "#F1F1F9",
      "editor.lineHighlightBackground": "#111118",
      "editor.selectionBackground": "#222238",
      "editor.inactiveSelectionBackground": "#1E1E30",
      "editorCursor.foreground": "#F59E0B",
      "editorLineNumber.foreground": "#555570",
      "editorLineNumber.activeForeground": "#A0A0BB",
      "editor.selectionHighlightBackground": "#262640",
      "editorBracketMatch.background": "#1E1E30",
      "editorBracketMatch.border": "#333358",
      "editorWidget.background": "#111118",
      "editorWidget.border": "#262640",
      "editorSuggestWidget.background": "#111118",
      "editorSuggestWidget.border": "#262640",
      "editorSuggestWidget.selectedBackground": "#222238",
      "menu.background": "#111118",
      "menu.foreground": "#F1F1F9",
      "menu.border": "#262640",
      "menu.selectionBackground": "#222238",
      "menu.selectionForeground": "#F59E0B",
      "menu.separatorBackground": "#262640",
      "minimap.background": "#0A0A0F",
    },
  });

  // 亮色主题 — 简约亮色
  monaco.editor.defineTheme("app-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#FAFAFA",
      "editor.foreground": "#333333",
      "editor.lineHighlightBackground": "#F0F0F0",
      "editor.selectionBackground": "#D6E8FF",
      "editorCursor.foreground": "#F59E0B",
      "editorLineNumber.foreground": "#CCCCCC",
      "editorLineNumber.activeForeground": "#888888",
      "editorWidget.background": "#FAFAFA",
      "editorWidget.border": "#E0E0E0",
      "menu.background": "#FAFAFA",
      "menu.foreground": "#333333",
      "menu.border": "#D0D0D0",
      "menu.selectionBackground": "#D6E8FF",
      "menu.selectionForeground": "#333333",
      "menu.separatorBackground": "#E0E0E0",
      "minimap.background": "#FAFAFA",
    },
  });
}
