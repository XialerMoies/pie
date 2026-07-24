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
import { tsFetch, tsOpenFile, tsChangeFile, tsCloseFile, tsDiagnostics, tsserverAbsPath } from "./monaco-tsserver";
import { mapCompletionKind, langFromPath, defineThemes } from "./monaco-theme";

// ─── 不再需要 addExtraLib — tsserver 子进程直接读文件系统 node_modules

// ─── Worker 配置 ─────────────────────────────────────────────
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker?url";
import tsWorkerUrl from "monaco-editor/esm/vs/language/typescript/ts.worker?url";
import jsonWorkerUrl from "monaco-editor/esm/vs/language/json/json.worker?url";
import cssWorkerUrl from "monaco-editor/esm/vs/language/css/css.worker?url";
import htmlWorkerUrl from "monaco-editor/esm/vs/language/html/html.worker?url";

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    let url: string;
    switch (label) {
      case "typescript": case "javascript": url = tsWorkerUrl; break;
      case "json": url = jsonWorkerUrl; break;
      case "css": case "scss": case "less": url = cssWorkerUrl; break;
      case "html": case "handlebars": case "razor": url = htmlWorkerUrl; break;
      default: url = editorWorkerUrl;
    }
    return new Worker(url, { type: "module", name: label });
  },
};

// ─── 编辑器实例 ─────────────────────────────────────────────────

let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let _currentFilePath = "";
let _diagTimer: ReturnType<typeof setInterval> | null = null;

// ─── 诊断轮询 ──────────────────────────────────────────────────

let _diagFile = "";

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
  const model = editor.getModel();
  if (!model) return;

  try {
    const diags = await tsDiagnostics(_diagFile);
    if (diags && diags.length > 0) console.log(`[tsserver] ${diags.length} diagnostics for ${_diagFile}`);
    const { markers, problems } = _diagnosticsToState(_diagFile, diags as any[]);
    monaco.editor.setModelMarkers(model, "typescript", markers);

    // 同步写入 ProblemsStore
    const store = (window as any).__problemsStore as ProblemsStoreAPI | undefined;
    if (store) store.setProblems(_diagFile, problems);
  } catch {
    // ignore
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

  // 从 localStorage 加载用户设置
  const editorFontSize = parseInt(localStorage.getItem('editor-font-size') || '13', 10);
  const editorTabSize = parseInt(localStorage.getItem('editor-tab-size') || '2', 10);
  const editorUseTabs = localStorage.getItem('editor-use-tabs') === '1';
  const editorTheme = localStorage.getItem('editor-theme') || 'vs-dark';

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
  const zhObs = new MutationObserver(() => {
    queueMicrotask(applyZhFallback);
    requestAnimationFrame(applyZhFallback);
  });
  zhObs.observe(document.body, { childList: true, subtree: true, characterData: true });

  // ─── Code Action 持久化命令 ─────────────────────────
  const _rootCache = () => {
    const ws = (window as any).App?.Constants?.WS_KEY;
    return ws ? (window as any).localStorage?.getItem?.(ws) || "" : "";
  };
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
        body: JSON.stringify({ changes }),
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
                    const tabs = (window as any).__tabs;
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

  // 启动诊断轮询（每 3 秒轮询当前文件）
  _diagTimer = setInterval(pollDiagnostics, 3000);
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
  _diagFile = id;
  monaco.editor.setModelLanguage(model, lang);

  // 通知 tsserver 打开文件（仅 TS/JS 文件）
  if (lang === "typescript" || lang === "javascript") {
    const content = model.getValue();
    tsOpenFile(id, content);
  }
}

/** 从设置页更新编辑器配置 */
export function updateEditorSettings(): void {
  if (!editor) return;
  const fontSize = parseInt(localStorage.getItem('editor-font-size') || '13', 10);
  const tabSize = parseInt(localStorage.getItem('editor-tab-size') || '2', 10);
  const useTabs = localStorage.getItem('editor-use-tabs') === '1';
  const theme = localStorage.getItem('editor-theme') || 'vs-dark';
  editor.updateOptions({ fontSize, tabSize, indentSize: tabSize, useTabStops: useTabs });
  const isLight = theme === 'vs';
  document.documentElement.classList.toggle('theme-light', isLight);
  monaco.editor.setTheme(isLight ? 'app-light' : 'app-dark');
}

/** 释放 Monaco 焦点（防止它阻塞 UI 事件） */
export function monacoBlur(): void {
  editor?.blur();
}

/** 为指定文件刷新诊断并更新 ProblemsStore */
async function _refreshDiagnosticsForFile(filePath: string, model?: monaco.editor.ITextModel | null): Promise<void> {
  const diags = await tsDiagnostics(filePath);
  const { markers, problems } = _diagnosticsToState(filePath, diags as any[]);
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
  _diagFile = "";
}

/** 恢复 diagnostics 轮询 */
export function monacoResumeDiags(): void {
  if (!_diagTimer && editor) {
    _diagTimer = setInterval(pollDiagnostics, 3000);
  }
}

export async function monacoRefreshDiagnosticsForFile(filePath: string): Promise<void> {
  if (!filePath) return;
  const model = filePath === _currentFilePath ? editor?.getModel() : null;
  await _refreshDiagnosticsForFile(filePath, model);
}

export function monacoDispose(): void {
  if (_diagTimer) { clearInterval(_diagTimer); _diagTimer = null; }
  editor?.dispose();
  editor = null;
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
  refreshDiagnosticsForFile: monacoRefreshDiagnosticsForFile,
  revealPosition: monacoRevealPosition,
  getCurrentFile: monacoGetCurrentFile,
  isReady: monacoIsReady,
};
