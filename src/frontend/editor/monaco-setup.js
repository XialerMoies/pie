import "monaco-editor/esm/nls.messages.zh-cn.js";
import * as monaco from "monaco-editor";
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker?url";
import tsWorkerUrl from "monaco-editor/esm/vs/language/typescript/ts.worker?url";
import jsonWorkerUrl from "monaco-editor/esm/vs/language/json/json.worker?url";
import cssWorkerUrl from "monaco-editor/esm/vs/language/css/css.worker?url";
import htmlWorkerUrl from "monaco-editor/esm/vs/language/html/html.worker?url";
self.MonacoEnvironment = {
  getWorker(_, label) {
    let url;
    switch (label) {
      case "typescript":
      case "javascript":
        url = tsWorkerUrl;
        break;
      case "json":
        url = jsonWorkerUrl;
        break;
      case "css":
      case "scss":
      case "less":
        url = cssWorkerUrl;
        break;
      case "html":
      case "handlebars":
      case "razor":
        url = htmlWorkerUrl;
        break;
      default:
        url = editorWorkerUrl;
    }
    return new Worker(url, { type: "module", name: label });
  }
};
let editor = null;
let _currentFilePath = "";
let _diagTimer = null;
function getRoot() {
  return localStorage.getItem("workspace_path") || "";
}
function absPath(filePath) {
  const root = getRoot();
  return root ? root + "/" + filePath : filePath;
}
async function tsFetch(command, body) {
  try {
    const r = await fetch("/api/ts/" + command, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (data && data.success === false) return null;
    return data;
  } catch {
    return null;
  }
}
export async function tsOpenFile(filePath, content) {
  try {
    await tsFetch("open", { file: absPath(filePath), content, scriptKindName: "TS" });
  } catch {
  }
}
export async function tsChangeFile(filePath, content) {
  try {
    await tsFetch("change", { file: absPath(filePath), content });
  } catch {
  }
}
export async function tsCloseFile(filePath) {
  try {
    await tsFetch("close", { file: absPath(filePath) });
  } catch {
  }
}
async function tsDiagnostics(filePath) {
  try {
    const r = await fetch(`/api/ts/diagnostics?file=${encodeURIComponent(absPath(filePath))}`);
    if (!r.ok) return [];
    const data = await r.json();
    if (data?.success === false) return [];
    return data;
  } catch {
    return [];
  }
}
let _diagFile = "";
async function pollDiagnostics() {
  if (!_diagFile || !editor) return;
  const model = editor.getModel();
  if (!model) return;
  try {
    const diags = await tsDiagnostics(_diagFile);
    if (diags && diags.length > 0) console.log(`[tsserver] ${diags.length} diagnostics for ${_diagFile}`);
    const markers = diags.map((d) => ({
      severity: d.severity === "error" || d.category === "error" ? monaco.MarkerSeverity.Error : d.category === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      message: d.text || d.message || "",
      startLineNumber: d.start?.line || d.line || 1,
      startColumn: d.start?.offset || d.column || 1,
      endLineNumber: d.end?.line || d.line || 1,
      endColumn: d.end?.offset || d.column || 1
    }));
    monaco.editor.setModelMarkers(model, "typescript", markers);
  } catch {
  }
}
monaco.languages.registerCompletionItemProvider("typescript", {
  triggerCharacters: [".", '"', "'", "/", "@", "<"],
  provideCompletionItems: async (model, position) => {
    const filePath = _currentFilePath;
    if (!filePath) return { suggestions: [] };
    try {
      const result = await tsFetch("completions", {
        file: absPath(filePath),
        line: position.lineNumber,
        offset: position.column
      });
      if (!result?.entries) return { suggestions: [] };
      const suggestions = result.entries.map((e) => ({
        label: e.name,
        kind: mapCompletionKind(e.kind),
        detail: e.kind,
        sortText: e.sortText,
        insertText: e.name,
        range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column }
      }));
      return { suggestions };
    } catch {
      return { suggestions: [] };
    }
  }
});
monaco.languages.registerHoverProvider("typescript", {
  provideHover: async (model, position) => {
    const filePath = _currentFilePath;
    if (!filePath) return null;
    try {
      const result = await tsFetch("quickinfo", {
        file: absPath(filePath),
        line: position.lineNumber,
        offset: position.column
      });
      if (!result) return null;
      const contents = [];
      if (result.displayString) {
        contents.push({ value: "```typescript\n" + result.displayString + "\n```" });
      }
      if (result.documentation) {
        contents.push({ value: result.documentation });
      }
      return {
        contents,
        range: result.start ? new monaco.Range(
          result.start.line,
          result.start.offset,
          (result.end || result.start).line,
          (result.end || result.start).offset
        ) : void 0
      };
    } catch {
      return null;
    }
  }
});
monaco.languages.registerDefinitionProvider("typescript", {
  provideDefinition: async (model, position) => {
    const filePath = _currentFilePath;
    if (!filePath) return [];
    try {
      const result = await tsFetch("definition", {
        file: absPath(filePath),
        line: position.lineNumber,
        offset: position.column
      });
      if (!result?.definitions) return [];
      return result.definitions.map((d) => ({
        uri: monaco.Uri.parse("file:///" + encodeURIComponent(d.file.replace(/\\/g, "/"))),
        range: new monaco.Range(d.start?.line || 1, d.start?.offset || 1, d.end?.line || 1, d.end?.offset || 1)
      }));
    } catch {
      return [];
    }
  }
});
monaco.languages.registerReferenceProvider("typescript", {
  provideReferences: async (model, position) => {
    const filePath = _currentFilePath;
    if (!filePath) return [];
    try {
      const result = await tsFetch("references", {
        file: absPath(filePath),
        line: position.lineNumber,
        offset: position.column
      });
      if (!result?.refs) return [];
      return result.refs.map((r) => ({
        uri: monaco.Uri.parse("file:///" + encodeURIComponent(r.file.replace(/\\/g, "/"))),
        range: new monaco.Range(r.start?.line || 1, r.start?.offset || 1, r.end?.line || 1, r.end?.offset || 1)
      }));
    } catch {
      return [];
    }
  }
});
const completionKindMap = {
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
  23: monaco.languages.CompletionItemKind.Deprecated
};
function mapCompletionKind(kind) {
  if (typeof kind === "number") return completionKindMap[kind] || monaco.languages.CompletionItemKind.Text;
  const strMap = {
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
    keyword: monaco.languages.CompletionItemKind.Keyword
  };
  return strMap[kind.toLowerCase()] || monaco.languages.CompletionItemKind.Text;
}
const langMap = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  cs: "csharp",
  sh: "shell",
  bash: "shell",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  svg: "xml",
  vue: "html",
  svelte: "html",
  sql: "sql",
  r: "r",
  pl: "perl",
  lua: "lua",
  scala: "scala",
  hs: "haskell",
  dart: "dart",
  zig: "zig",
  graphql: "graphql",
  toml: "ini",
  env: "dotenv",
  conf: "ini",
  cfg: "ini"
};
function langFromPath(id) {
  const ext = (id.split(".").pop() || "").toLowerCase();
  return langMap[ext] || "plaintext";
}
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
    "minimap.background": "#0A0A0F"
  }
});
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
    "minimap.background": "#FAFAFA"
  }
});
export function monacoCreateEditor(container) {
  if (editor) {
    editor.dispose();
    if (_diagTimer) {
      clearInterval(_diagTimer);
      _diagTimer = null;
    }
  }
  _currentFilePath = "";
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true
  });
  const initUri = monaco.Uri.parse("file:///untitled.ts");
  const initModel = monaco.editor.createModel("", "plaintext", initUri);
  const editorFontSize = parseInt(localStorage.getItem("editor-font-size") || "13", 10);
  const editorTabSize = parseInt(localStorage.getItem("editor-tab-size") || "2", 10);
  const editorUseTabs = localStorage.getItem("editor-use-tabs") === "1";
  const editorTheme = localStorage.getItem("editor-theme") || "vs-dark";
  const isLight = editorTheme === "vs";
  document.documentElement.classList.toggle("theme-light", isLight);
  editor = monaco.editor.create(container, {
    model: initModel,
    theme: isLight ? "app-light" : "app-dark",
    minimap: { enabled: true },
    automaticLayout: true,
    fontSize: editorFontSize,
    fontFamily: "DM Mono, monospace",
    scrollBeyondLastLine: false,
    lineNumbers: "on",
    renderWhitespace: "selection",
    tabSize: editorTabSize,
    indentSize: editorTabSize,
    useTabStops: editorUseTabs,
    wordWrap: "off",
    smoothScrolling: true,
    cursorBlinking: "smooth",
    padding: { top: 12, bottom: 12 },
    quickSuggestions: true,
    suggestOnTriggerCharacters: true,
    parameterHints: { enabled: true },
    bracketPairColorization: { enabled: true }
  });
  editor.onDidChangeModelContent(() => {
    if (!editor?.hasTextFocus()) return;
    if (!_currentFilePath) return;
    const model = editor?.getModel();
    if (!model) return;
    const lang = model.getLanguageId();
    if (lang !== "typescript" && lang !== "javascript") return;
    tsChangeFile(_currentFilePath, model.getValue());
  });
  editor.addAction({
    id: "add-to-chat",
    label: "\u6DFB\u52A0\u5230\u5F53\u524D\u8F93\u5165\u6846",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1,
    run: (ed) => {
      const selection = ed.getSelection();
      if (!selection || selection.isEmpty()) {
        if (!_currentFilePath) {
          return;
        }
        const name2 = _currentFilePath.split("/").pop() || _currentFilePath;
        const App2 = window.App;
        if (App2?.Chat?.addAttachment) {
          App2.Chat.addAttachment({ kind: "file", path: _currentFilePath, name: name2 });
        }
        return;
      }
      const startLine = selection.startLineNumber;
      const endLine = selection.endLineNumber;
      const name = _currentFilePath.split("/").pop() || _currentFilePath;
      const App = window.App;
      if (App?.Chat?.addAttachment) {
        App.Chat.addAttachment({
          kind: "clip",
          path: _currentFilePath,
          name,
          startLine,
          endLine
        });
      }
    }
  });
  const zhFallback = {
    // NLS 可能不覆盖的编辑器菜单项
    "Change All Occurrences": "\u66F4\u6539\u6240\u6709\u5339\u914D\u9879"
  };
  function applyZhFallback() {
    document.querySelectorAll(".monaco-action-bar .action-label, .monaco-menu .action-label").forEach((el) => {
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      const normalized = raw.replace(/\([^)]*\)$/g, "").trim();
      const label = zhFallback[raw] || zhFallback[normalized];
      if (label && raw !== label) el.textContent = label;
    });
  }
  const zhObs = new MutationObserver(() => {
    queueMicrotask(applyZhFallback);
    requestAnimationFrame(applyZhFallback);
  });
  zhObs.observe(document.body, { childList: true, subtree: true, characterData: true });
  _diagTimer = setInterval(pollDiagnostics, 3e3);
}
export function monacoSetValue(val) {
  if (editor) editor.setValue(val);
}
export function monacoGetValue() {
  return editor?.getValue() ?? "";
}
export function monacoSetLanguage(id) {
  if (!editor) return;
  if (id === _currentFilePath) return;
  const lang = langFromPath(id);
  const model = editor.getModel();
  if (!model) return;
  _currentFilePath = id;
  _diagFile = id;
  monaco.editor.setModelLanguage(model, lang);
  if (lang === "typescript" || lang === "javascript") {
    const content = model.getValue();
    tsOpenFile(id, content);
  }
}
export function updateEditorSettings() {
  if (!editor) return;
  const fontSize = parseInt(localStorage.getItem("editor-font-size") || "13", 10);
  const tabSize = parseInt(localStorage.getItem("editor-tab-size") || "2", 10);
  const useTabs = localStorage.getItem("editor-use-tabs") === "1";
  const theme = localStorage.getItem("editor-theme") || "vs-dark";
  editor.updateOptions({ fontSize, tabSize, indentSize: tabSize, useTabStops: useTabs });
  const isLight = theme === "vs";
  document.documentElement.classList.toggle("theme-light", isLight);
  monaco.editor.setTheme(isLight ? "app-light" : "app-dark");
}
export function monacoBlur() {
  editor?.blur();
}
export function monacoPauseDiags() {
  if (_diagTimer) {
    clearInterval(_diagTimer);
    _diagTimer = null;
  }
  _diagFile = "";
}
export function monacoResumeDiags() {
  if (!_diagTimer && editor) {
    _diagTimer = setInterval(pollDiagnostics, 3e3);
  }
}
export function monacoDispose() {
  if (_diagTimer) {
    clearInterval(_diagTimer);
    _diagTimer = null;
  }
  editor?.dispose();
  editor = null;
}
window.__monaco = {
  create: monacoCreateEditor,
  setValue: monacoSetValue,
  getValue: monacoGetValue,
  setLang: monacoSetLanguage,
  dispose: monacoDispose,
  tsOpenFile,
  tsChangeFile,
  tsCloseFile,
  updateSettings: updateEditorSettings,
  blur: monacoBlur,
  pauseDiags: monacoPauseDiags
};
