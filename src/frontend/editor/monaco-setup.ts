/**
 * Monaco Editor 集成 — 语言服务通过 tsserver 子进程提供
 *
 * 不再使用 Monaco 内置的 tsWorker（浏览器沙箱无法读 node_modules），
 * 改为通过 HTTP API 调用 pi-server 的 tsserver 子进程（真实 Node.js 环境）。
 *
 * 特性：
 *   - 诊断（语法/语义错误标注）— 每 2 秒轮询
 *   - 自动补全 — CompletionItemProvider
 *   - 悬停提示 — HoverProvider
 *   - 跳转定义 — DefinitionProvider
 *   - 查找引用 — ReferenceProvider
 *
 * 本地化：NLS 必须在 Monaco 主模块初始化前加载。
 * Vite optimizeDeps.exclude 防止预构建打乱此顺序。
 */
import "monaco-editor/esm/nls.messages.zh-cn.js";
import * as monaco from "monaco-editor";
import { tsFetch, tsOpenFile, tsChangeFile, tsCloseFile, tsDiagnostics, isTypeScriptFile, tsserverAbsPath, tsserverRoot } from "./monaco-tsserver";
import { mapCompletionKind, langFromPath, defineThemes } from "./monaco-theme";
import { ObserverOwner } from "./observer-owner";

// ─── 不再需要 addExtraLib — tsserver 子进程直接读文件系统 node_modules

// ─── Worker 配置 ─────────────────────────────────────────────
// Worker graphs are built in separate Vite processes. Keeping only stable
// URLs in this entry prevents Rollup from retaining all language workers in
// one native-memory peak.
// The dev server serves generated modules from /gen/editor/, so checking only
// for /src/frontend/ incorrectly selects production asset URLs and causes 404
// worker loads. Production entries live under /frontend/js or dist/frontend.
// The dashboard dynamically imports this module as `/editor/monaco-setup.ts`
// in Vite dev, while the standalone compiler emits `/gen/editor/...`. Both
// are development graphs; packaged bundles are emitted below `/assets/`.
const isDevSource = /\/(?:editor|gen\/editor|src\/frontend\/editor)\//.test(new URL(import.meta.url).pathname);
const devWorkerBase = import.meta.url.includes("/gen/editor/") ? "../../editor/workers/" : "./workers/";
const workerBase = isDevSource ? devWorkerBase : "../assets/";
const workerExtension = isDevSource ? ".ts" : ".js";
const workerFile = (productionName: string, devName: string) =>
  `${workerBase}${isDevSource ? devName : productionName}${workerExtension}`;
const workerUrls = {
  editor: new URL(workerFile("editor.worker", "editor"), import.meta.url).href,
  typescript: new URL(workerFile("ts.worker", "typescript"), import.meta.url).href,
  json: new URL(workerFile("json.worker", "json"), import.meta.url).href,
  css: new URL(workerFile("css.worker", "css"), import.meta.url).href,
  html: new URL(workerFile("html.worker", "html"), import.meta.url).href,
};

function createMonacoWorker(url: string, label: string): Worker {
  const worker = new Worker(url, { type: "module", name: label });
  // Chromium only exposes a generic Event for module-worker bootstrap failures;
  // capture the useful fields before Monaco's global error handler consumes it.
  worker.addEventListener("error", (event) => {
    const detail = event instanceof ErrorEvent
      ? `${event.message || "unknown error"} (${event.filename || "unknown source"}:${event.lineno || 0}:${event.colno || 0})`
      : "worker bootstrap failed";
    console.error(`[monaco-worker] ${label} failed url=${url} ${detail}`);
  });
  worker.addEventListener("messageerror", () => {
    console.error(`[monaco-worker] ${label} messageerror url=${url}`);
  });
  return worker;
}

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    switch (label) {
      case "typescript": case "javascript": return createMonacoWorker(workerUrls.typescript, label);
      case "json": return createMonacoWorker(workerUrls.json, label);
      case "css": case "scss": case "less": return createMonacoWorker(workerUrls.css, label);
      case "html": case "handlebars": case "razor": return createMonacoWorker(workerUrls.html, label);
      default: return createMonacoWorker(workerUrls.editor, label);
    }
  },
};

// ─── 编辑器实例 ─────────────────────────────────────────────────

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let _currentFilePath = "";
let _diagTimer: ReturnType<typeof setInterval> | null = null;
let _typescriptContributionStop: (() => void) | null = null;
const translationObserver = new ObserverOwner();

// ─── 诊断轮询 ──────────────────────────────────────────────────

let _diagFile = "";
let _diagInFlight = false;
let _diagFailureCount = 0;
let _diagNextAttemptAt = 0;

/** 将 tsserver 诊断转换为 Monaco markers + ProblemItem 列表 */
function _diagnosticsToState(filePath: string, diags: any[]): { markers: monaco.editor.IMarkerData[]; problems: ProblemItem[] } {
  const markers: monaco.editor.IMarkerData[] = [];
  const problems: ProblemItem[] = [];

  for (const d of diags || []) {
    const line = d.start?.line || d.line || 1;
    const col = d.start?.offset || d.column || 1;
    const endLine = d.end?.line || d.line || 1;
    const endCol = d.end?.offset || d.column || 1;
    const sev = d.severity === "error" || d.category === "error"
      ? monaco.MarkerSeverity.Error
      : d.category === "warning"
        ? monaco.MarkerSeverity.Warning
        : monaco.MarkerSeverity.Info;

    const marker: monaco.editor.IMarkerData = {
      severity: sev,
      message: d.text || d.message || "",
      startLineNumber: line,
      startColumn: col,
      endLineNumber: endLine,
      endColumn: endCol,
    };
    // CodeActionProvider 依赖 marker.code 来获取 errorCodes
    if (d.code != null) (marker as any).code = String(d.code);
    markers.push(marker);

    const problemSev: ProblemItem["severity"] = sev === monaco.MarkerSeverity.Error ? "error"
      : sev === monaco.MarkerSeverity.Warning ? "warning" : "info";

    problems.push({
      filePath,
      line,
      column: col,
      endLine,
      endColumn: endCol,
      severity: problemSev,
      message: d.text || d.message || "",
      code: d.code,
      fixCount: 0,
      source: "typescript",
    });
  }

  return { markers, problems };
}

async function pollDiagnostics(): Promise<void> {
  if (!_diagFile || !editor) return;
  if (!isTypeScriptFile(_diagFile)) return;
  if (Date.now() < _diagNextAttemptAt) return;
  if (_diagInFlight) return;
  const model = editor.getModel();
  if (!model) return;
  const filePath = _diagFile;
  _diagInFlight = true;

  try {
    const result = await tsDiagnostics(filePath);
    // The active editor can change while tsserver is responding. Do not let a
    // stale response overwrite the newly selected file's markers/problems.
    if (filePath !== _diagFile || editor?.getModel() !== model) return;
    if (result.status !== "ok") {
      if (result.status === "stale") return;
      _diagFailureCount = Math.min(_diagFailureCount + 1, 5);
      _diagNextAttemptAt = Date.now() + Math.min(60_000, 3_000 * (2 ** (_diagFailureCount - 1)));
      console.warn(`[tsserver] diagnostics ${result.status} for ${filePath}: ${result.code || "unknown"}`);
      return;
    }
    _diagFailureCount = 0;
    _diagNextAttemptAt = 0;
    if (result.diagnostics.length > 0) console.log(`[tsserver] ${result.diagnostics.length} diagnostics for ${filePath}`);
    const { markers, problems } = _diagnosticsToState(filePath, result.diagnostics as any[]);
    monaco.editor.setModelMarkers(model, "typescript", markers);

    // 同步写入 ProblemsStore
    const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
    if (store) store.setProblems(filePath, problems);
  } catch {
    // ignore
  } finally {
    _diagInFlight = false;
  }
}

// ─── 自定义 Language Service Providers ─────────────────────────

// 自动补全
monaco.languages.registerCompletionItemProvider("typescript", {
  triggerCharacters: [".", "\"", "'", "/", "@", "<"],
  provideCompletionItems: async (model, position) => {
    const filePath = _currentFilePath;
    if (!filePath) return { suggestions: [] };

    try {
      const result = await tsFetch("completions", {
        file: tsserverAbsPath(filePath),
        line: position.lineNumber,
        offset: position.column,
      });
      if (!result?.entries) return { suggestions: [] };

      const suggestions: monaco.languages.CompletionItem[] = result.entries.map((e: { name: string; kind: string | number; sortText: string }) => ({
        label: e.name,
        kind: mapCompletionKind(e.kind),
        detail: e.kind,
        sortText: e.sortText,
        insertText: e.name,
        range: { startLineNumber: position.lineNumber, startColumn: position.column, endLineNumber: position.lineNumber, endColumn: position.column },
      }));
      return { suggestions };
    } catch {
      return { suggestions: [] };
    }
  },
});

// 悬停提示
monaco.languages.registerHoverProvider("typescript", {
  provideHover: async (model, position) => {
    const filePath = _currentFilePath;
    if (!filePath) return null;

    try {
      const result = await tsFetch("quickinfo", {
        file: tsserverAbsPath(filePath),
        line: position.lineNumber,
        offset: position.column,
      });
      if (!result) return null;

      const contents: monaco.IMarkdownString[] = [];
      if (result.displayString) {
        contents.push({ value: "```typescript\n" + result.displayString + "\n```" });
      }
      if (result.documentation) {
        contents.push({ value: result.documentation });
      }

      return {
        contents,
        range: result.start
          ? new monaco.Range(
              result.start.line, result.start.offset,
              (result.end || result.start).line, (result.end || result.start).offset
            )
          : undefined,
      };
    } catch {
      return null;
    }
  },
});

// 跳转定义
monaco.languages.registerDefinitionProvider("typescript", {
  provideDefinition: async (model, position) => {
    const filePath = _currentFilePath;
    if (!filePath) return [];

    try {
      const result = await tsFetch("definition", {
        file: tsserverAbsPath(filePath),
        line: position.lineNumber,
        offset: position.column,
      });
      if (!result?.definitions) return [];

      return (result as any).definitions.map((d: { file: string; start?: { line: number; offset: number }; end?: { line: number; offset: number } }) => ({
        uri: monaco.Uri.parse("file:///" + encodeURIComponent(d.file.replace(/\\/g, "/"))),
        range: new monaco.Range(d.start?.line || 1, d.start?.offset || 1, d.end?.line || 1, d.end?.offset || 1),
      }));
    } catch {
      return [];
    }
  },
});

// 查找引用
monaco.languages.registerReferenceProvider("typescript", {
  provideReferences: async (model, position) => {
    const filePath = _currentFilePath;
    if (!filePath) return [];

    try {
      const result = await tsFetch("references", {
        file: tsserverAbsPath(filePath),
        line: position.lineNumber,
        offset: position.column,
      });
      if (!result?.refs) return [];

      return (result as any).refs.map((r: { file: string; start?: { line: number; offset: number }; end?: { line: number; offset: number } }) => ({
        uri: monaco.Uri.parse("file:///" + encodeURIComponent(r.file.replace(/\\/g, "/"))),
        range: new monaco.Range(r.start?.line || 1, r.start?.offset || 1, r.end?.line || 1, r.end?.offset || 1),
      }));
    } catch {
      return [];
    }
  },
});

// ─── Code Actions Provider ──────────────────────────────────

function _markerErrorCodes(marker?: monaco.editor.IMarkerData): number[] {
  const rawCode = marker?.code;
  if (rawCode == null) return [];
  const text = typeof rawCode === "object" ? (rawCode as any).value : rawCode;
  const code = Number(text);
  return Number.isFinite(code) ? [code] : [];
}

monaco.languages.registerCodeActionProvider("typescript", {
  provideCodeActions: async (model, range, context) => {
    const filePath = _currentFilePath;
    if (!filePath || !_diagFile) return { actions: [], dispose: () => {} };

    const marker = context.markers?.[0];
    const requestedKind = (context as any)?.only?.value as string | undefined;
    const refactorRequested = requestedKind?.startsWith("refactor") ?? false;
    const quickfixRequested = requestedKind?.startsWith("quickfix") ?? false;
    const sourceRequested = requestedKind?.startsWith("source") ?? false;

    if (!marker && (quickfixRequested || sourceRequested)) return { actions: [], dispose: () => {} };

    const useRefactorFlow = refactorRequested || !marker;
    const requestRange = !marker || useRefactorFlow
      ? range
      : new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn);
    const errorCodes = marker && !useRefactorFlow ? _markerErrorCodes(marker) : [];

    try {
      const resp = await fetch("/api/ts/code-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: tsserverAbsPath(filePath),
          projectRoot: tsserverRoot(),
          line: requestRange.startLineNumber,
          offset: requestRange.startColumn,
          endLine: requestRange.endLineNumber,
          endOffset: requestRange.endColumn,
          errorCodes,
          kind: requestedKind,
        }),
      });
      const data = await resp.json();
      if (!data?.actions?.length) return { actions: [], dispose: () => {} };

      const actions: monaco.languages.CodeAction[] = data.actions
        .filter((a: any) => a.changes?.length > 0)
        .map((a: any) => ({
          title: a.description,
          kind: (a.kind || (useRefactorFlow ? "refactor" : "quickfix")) as monaco.languages.CodeActionKind,
          diagnostics: marker ? [marker] : undefined,
          edit: _buildWorkspaceEdit(a.changes!),
          command: {
            id: "code-action-persist",
            title: "",
            arguments: [a.changes],
          },
        }));

      return { actions, dispose: () => {} };
    } catch {
      return { actions: [], dispose: () => {} };
    }
  },
});

function _buildWorkspaceEdit(changes: any[]): monaco.languages.WorkspaceEdit | undefined {
  if (!changes?.length) return undefined;
  const edits: any[] = [];
  for (const change of changes) {
    if (!change.textChanges) continue;
    for (const tc of change.textChanges) {
      const uri = monaco.Uri.parse("file:///" + encodeURIComponent(change.fileName.replace(/\\/g, "/")));
      edits.push({
        resource: uri,
        textEdit: {
          range: new monaco.Range(
            tc.span.start.line, tc.span.start.offset,
            tc.span.end.line, tc.span.end.offset,
          ),
          text: tc.newText,
          forceMoveMarkers: true,
        } as any,
      });
    }
  }
  return edits.length ? { edits } : undefined;
}

// ─── 主题注册（加载时执行一次）──────────────────────────────────
defineThemes();

// ─── 编辑器创建 ─────────────────────────────────────────────────

export function monacoCreateEditor(container: HTMLElement): void {
  translationObserver.clear();
  _typescriptContributionStop?.();
  _typescriptContributionStop = null;
  if (editor) {
    editor.dispose();
    if (_diagTimer) { clearInterval(_diagTimer); _diagTimer = null; }
  }
  _currentFilePath = "";

  // 禁用 Monaco 内置 TS 诊断，仅用 tsserver（避免两个来源抢 marker 控制权）
  // 内置 Worker 不读 node_modules，报的"cannot find module"是误报
  // tsserver 能读文件系统，诊断更准确
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });

  // 创建初始模型
  const initUri = monaco.Uri.parse("file:///untitled.ts");
  const initModel = monaco.editor.createModel("", "plaintext", initUri);

  // 从统一偏好 facade 加载用户设置
  const editorFontSize = App.Preferences.getNumber('editor-font-size', 13, 10, 24);
  const editorTabSize = App.Preferences.getNumber('editor-tab-size', 2, 1, 16);
  const editorUseTabs = App.Preferences.getBoolean('editor-use-tabs');
  const editorTheme = App.Preferences.get('editor-theme', 'vs-dark');

  const isLight = editorTheme === 'vs';
  document.documentElement.classList.toggle('theme-light', isLight);
  editor = monaco.editor.create(container, {
    model: initModel,
    theme: isLight ? 'app-light' : 'app-dark',
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
    bracketPairColorization: { enabled: true },
  });

  // 内容变更时同步到 tsserver（初始内容已通过 tsOpenFile 发送，此处只响应用户输入）
  editor.onDidChangeModelContent(() => {
    if (!editor?.hasTextFocus()) return; // 跳过程序化 setValue，只响应用户输入
    if (!_currentFilePath) return;
    const model = editor?.getModel();
    if (!model) return;
    const lang = model.getLanguageId();
    if (lang !== "typescript" && lang !== "javascript") return;
    tsChangeFile(_currentFilePath, model.getValue());
  });

  // ─── 右键菜单：“添加到当前输入框” ─────────────────────
  editor.addAction({
    id: "add-to-chat",
    label: "添加到当前输入框",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1,
    run: (ed) => {
      const selection = ed.getSelection();
      if (!selection || selection.isEmpty()) {
        // 无选中内容：整个文件作为引用
        if (!_currentFilePath) { /* toast handled by caller */ return; }
        const name = _currentFilePath.split('/').pop() || _currentFilePath;
        const App = (window as any).App;
        if (App?.Chat?.addAttachment) {
          App.Chat.addAttachment({ kind: "file", path: _currentFilePath, name });
        }
        return;
      }
      // 有选中内容：clip 引用
      const startLine = selection.startLineNumber;
      const endLine = selection.endLineNumber;
      const name = _currentFilePath.split('/').pop() || _currentFilePath;
      const App = (window as any).App;
      if (App?.Chat?.addAttachment) {
        App.Chat.addAttachment({
          kind: "clip",
          path: _currentFilePath,
          name,
          startLine,
          endLine,
        });
      }
    },
  });

  // ─── 汉化兜底：未被 NLS 覆盖的菜单项 ─────────────────
  const zhFallback: Record<string, string> = {
    // NLS 可能不覆盖的编辑器菜单项
    'Change All Occurrences': '更改所有匹配项',
  };
  function applyZhFallback(): void {
    document.querySelectorAll('.monaco-action-bar .action-label, .monaco-menu .action-label').forEach(el => {
      const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const normalized = raw.replace(/\([^)]*\)$/g, '').trim();
      const label = zhFallback[raw] || zhFallback[normalized];
      if (label && raw !== label) el.textContent = label;
    });
  }
  const nextObserver = new MutationObserver(() => {
    queueMicrotask(applyZhFallback);
    requestAnimationFrame(applyZhFallback);
  });
  translationObserver.replace(nextObserver);
  nextObserver.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ─── Code Action 持久化命令 ─────────────────────────
  const _rootCache = () => App.State.getWorkspacePath();
  const _toast = (msg: string, type?: 'info' | 'error' | 'success') =>
    (window as any).App?.UI?.toast?.(msg, type);

  editor.addAction({
    id: "code-action-persist",
    label: "persist code action to disk",
    run: (_ed, changes: any) => {
      if (!changes) return;
      fetch("/api/ts/apply-code-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ changes, projectRoot: tsserverRoot() }),
      })
        .then(r => r.json())
        .then((data: any) => {
          if (!data) { _toast('代码修复返回为空', 'error'); return; }

          if (data.ok || data.partial) {
            const root = _rootCache();
            const refreshes: Promise<void>[] = [];

            // 先刷新所有受影响文件的编辑器模型和缓存
            if (data.files?.length && root) {
              for (const changedFile of data.files) {
                const url = `/api/file/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(changedFile)}`;
                const p = fetch(url)
                  .then(r => r.json())
                  .then((d: any) => {
                    if (typeof d?.content !== 'string') return;
                    const tabs = App.Tabs;
                    if (tabs?.replaceTab) tabs.replaceTab(changedFile, { content: d.content });
                    if (changedFile === _currentFilePath && editor) {
                      if (editor.getValue() !== d.content) editor.setValue(d.content);
                    } else {
                      // 清除非当前文件的 ProblemsStore（pollDiagnostics 只刷新 _diagFile）
                      const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
                      if (store) store.clearFile(changedFile);
                      // 如果有 Monaco model，同步更新并清除过期 markers
                      const uri = monaco.Uri.parse("file:///" + encodeURIComponent(changedFile.replace(/\\/g, "/")));
                      const model = monaco.editor.getModel(uri);
                      if (model && model.getValue() !== d.content) {
                        model.setValue(d.content);
                        monaco.editor.setModelMarkers(model, "typescript", []);
                      }
                    }
                  })
                  .catch(() => {});
                refreshes.push(p);
              }
            }

            // 等所有重载完成后统一刷新诊断，避免与 setValue 竞态
            Promise.all(refreshes).then(() => pollDiagnostics());

            if (data.partial) _toast('部分文件代码修复失败，请检查', 'error');
          } else {
            _toast(data.errors?.[0] || '代码修复应用失败', 'error');
          }
        })
        .catch(() => { _toast('代码修复请求失败', 'error'); });
    },
  });

  // ─── Format Document ────────────────────────────
  editor.addAction({
    id: "format-document",
    label: "格式化文档",
    keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
    run: async (ed) => {
      const file = _currentFilePath;
      if (!file) return;
      const model = ed.getModel();
      if (!model) return;
      const lang = model.getLanguageId();
      if (lang !== "typescript" && lang !== "javascript") return;

      try {
        const r = await fetch("/api/ts/format", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            file,
            projectRoot: tsserverRoot(),
            tabSize: App.Preferences.getNumber('editor-tab-size', 2, 1, 16),
            useTabs: App.Preferences.getBoolean('editor-use-tabs'),
          }),
        });
        const data = await r.json();
        if (!r.ok) { _toast("格式化请求失败", "error"); return; }
        if (!data.edits?.length) { _toast("文档已符合格式规范", "info"); return; }

        const edits = data.edits as any[];
        // 用 model 计算偏移量用于反向排序，保证位置正确
        const ops = edits
          .map((e: any) => ({
            range: new monaco.Range(
              e.span.start.line, e.span.start.offset,
              e.span.end.line, e.span.end.offset,
            ),
            text: e.newText,
          }))
          .sort((a: any, b: any) => {
            const aOff = model.getOffsetAt({ lineNumber: a.range.startLineNumber, column: a.range.startColumn });
            const bOff = model.getOffsetAt({ lineNumber: b.range.startLineNumber, column: b.range.startColumn });
            return bOff - aOff;
          });

        // 用 editor.executeEdits 进入撤销栈，前后加 undo stop 使一次格式化为单独撤销步
        ed.pushUndoStop();
        ed.executeEdits("format-document", ops);
        ed.pushUndoStop();
        _toast(`已格式化 (${edits.length} 处变更)`, "success");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        _toast("格式化失败: " + msg, "error");
      }
    },
  });

  reconcileTypeScriptContribution();
}

export function monacoSetValue(val: string): void {
  if (editor) editor.setValue(val);
}

export function monacoGetValue(): string {
  return editor?.getValue() ?? "";
}

export function monacoSetLanguage(id: string): void {
  if (!editor) return;
  if (id === _currentFilePath) return;

  const lang = langFromPath(id);
  const model = editor.getModel();
  if (!model) return;

  _currentFilePath = id;
  monaco.editor.setModelLanguage(model, lang);

  // 通知 tsserver 打开文件（仅 TS/JS 文件）
  if (lang === "typescript" || lang === "javascript") {
    _diagFile = id;
    _diagFailureCount = 0;
    _diagNextAttemptAt = 0;
    const content = model.getValue();
    tsOpenFile(id, content);
  } else {
    _diagFile = "";
    _diagFailureCount = 0;
    _diagNextAttemptAt = 0;
    monaco.editor.setModelMarkers(model, "typescript", []);
    const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
    store?.clearFile(id);
  }
}

/** 从设置页更新编辑器配置 */
export function updateEditorSettings(): void {
  const fontSize = App.Preferences.getNumber('editor-font-size', 13, 10, 24);
  const tabSize = App.Preferences.getNumber('editor-tab-size', 2, 1, 16);
  const useTabs = App.Preferences.getBoolean('editor-use-tabs');
  const theme = App.Preferences.get('editor-theme', 'vs-dark');
  const isLight = theme === 'vs';
  document.documentElement.classList.toggle('theme-light', isLight);
  monaco.editor.setTheme(isLight ? 'app-light' : 'app-dark');
  if (!editor) return;
  editor.updateOptions({ fontSize, tabSize, indentSize: tabSize, useTabStops: useTabs });
}

/** 释放 Monaco 焦点（防止它阻塞 UI 事件） */
export function monacoBlur(): void {
  editor?.blur();
}

/** 为指定文件刷新诊断并更新 ProblemsStore */
async function _refreshDiagnosticsForFile(filePath: string, model?: monaco.editor.ITextModel | null): Promise<void> {
  if (!isTypeScriptFile(filePath)) return;
  const result = await tsDiagnostics(filePath);
  if (result.status !== "ok") return;
  const { markers, problems } = _diagnosticsToState(filePath, result.diagnostics as any[]);
  if (model) monaco.editor.setModelMarkers(model, "typescript", markers);
  const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
  if (store) store.setProblems(filePath, problems);
}

/** 定位到指定行列（Problems 面板点问题时跳转） */
export function monacoRevealPosition(line: number, col: number): void {
  if (!editor) return;
  editor.revealPositionInCenter({ lineNumber: line, column: col });
  editor.setPosition({ lineNumber: line, column: col });
  editor.focus();
}

/** 获取当前编辑器打开的路径（Problems 跳转用） */
export function monacoGetCurrentFile(): string {
  return _currentFilePath;
}

/** 检查编辑器是否已初始化 */
export function monacoIsReady(): boolean {
  return editor !== null && editor.getModel() !== null;
}

/** 暂停 diagnostics 轮询 */
export function monacoPauseDiags(): void {
  if (_diagTimer) { clearInterval(_diagTimer); _diagTimer = null; }
}

/** 恢复 diagnostics 轮询 */
export function monacoResumeDiags(): void {
  if (!_diagTimer && editor) {
    _diagTimer = setInterval(pollDiagnostics, 3000);
  }
}

/** Keep TypeScript diagnostics attached to its host-managed component state. */
export function reconcileTypeScriptContribution(): void {
  const contributions = (window as any).App?.UIContributions;
  const handle = contributions?.get?.('language-service.typescript');
  const active = !handle || contributions.isActive?.('language-service.typescript') !== false;
  if (!active) {
    _typescriptContributionStop?.();
    _typescriptContributionStop = null;
    monacoPauseDiags();
    return;
  }
  if (!editor || _typescriptContributionStop) return;
  if (handle) _typescriptContributionStop = handle.activate();
  else monacoResumeDiags();
}

export async function monacoRefreshDiagnosticsForFile(filePath: string): Promise<void> {
  if (!filePath) return;
  const model = filePath === _currentFilePath ? editor?.getModel() : null;
  await _refreshDiagnosticsForFile(filePath, model);
}

export function monacoDispose(): void {
  _typescriptContributionStop?.();
  _typescriptContributionStop = null;
  monacoPauseDiags();
  _diagFile = "";
  translationObserver.clear();
  editor?.dispose();
  editor = null;
}

const tsContributions = (window as any).App?.UIContributions;
if (tsContributions?.register && !tsContributions.get?.('language-service.typescript')) {
  tsContributions.register({
    id: 'language-service.typescript', componentId: 'language-service.typescript', kind: 'language-service',
    activate: () => {
      monacoResumeDiags();
      return () => monacoPauseDiags();
    },
  });
}

// 暴露到全局
(window as any).__monaco = {
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
  pauseDiags: monacoPauseDiags,
  resumeDiags: monacoResumeDiags,
  reconcileTypeScriptContribution,
  refreshDiagnosticsForFile: monacoRefreshDiagnosticsForFile,
  revealPosition: monacoRevealPosition,
  getCurrentFile: monacoGetCurrentFile,
  isReady: monacoIsReady,
};
