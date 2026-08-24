/**
 * tsserver HTTP 通信层 — 纯 API 封装，不依赖 Monaco
 *
 * 将 monaco-setup.ts 中的 tsserver 通信逻辑独立出来，
 * 方便独立测试和模块化加载。
 */

function monacoTsserverState(): AppStateFacade {
  const monacoTsserverApp = (globalThis as any).App;
  return monacoTsserverApp.State;
}

export function tsserverRoot(): string {
  return monacoTsserverState().getWorkspacePath();
}

export function tsserverAbsPath(filePath: string): string {
  const root = tsserverRoot();
  return root ? root + "/" + filePath : filePath;
}

export async function tsFetch(command: string, body: Record<string, unknown>): Promise<unknown> {
  try {
    const projectRoot = tsserverRoot();
    const payload = projectRoot && !body.projectRoot ? { ...body, projectRoot } : body;
    const r = await fetch("/api/ts/" + command, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data && data.success === false) return null;
    return data;
  } catch {
    return null;
  }
}

/** 打开文件（在 tsserver 中注册） */
export async function tsOpenFile(filePath: string, content: string): Promise<void> {
  try {
    await tsFetch("open", { file: tsserverAbsPath(filePath), content, scriptKindName: "TS" });
  } catch {}
}

/** 内容变更（同步到 tsserver） */
export async function tsChangeFile(filePath: string, content: string): Promise<void> {
  try {
    await tsFetch("change", { file: tsserverAbsPath(filePath), content });
  } catch {}
}

/** 关闭文件（释放 tsserver 资源） */
export async function tsCloseFile(filePath: string): Promise<void> {
  try {
    await tsFetch("close", { file: tsserverAbsPath(filePath) });
  } catch {}
}

export type TsDiagnosticsStatus = "ok" | "pending" | "timeout" | "failed" | "skipped" | "stale";
export interface TsDiagnosticsResult {
  status: TsDiagnosticsStatus;
  diagnostics: unknown[];
  code?: string;
  error?: string;
}

/** Diagnostics are meaningful only for files handled by tsserver. */
export function isTypeScriptFile(filePath: string): boolean {
  return /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(filePath.split(/[?#]/, 1)[0]);
}

/** 获取诊断（保留 pending/timeout/failed，不伪装成空诊断） */
const diagnosticsRequests = new Map<string, { controller: AbortController; generation: number }>();

/** Per-file latest-wins diagnostics. A stale request is actively cancelled. */
export async function tsDiagnostics(filePath: string): Promise<TsDiagnosticsResult> {
  if (!isTypeScriptFile(filePath)) return { status: "skipped", code: "unsupported_file", diagnostics: [] };
  const absoluteFile = tsserverAbsPath(filePath);
  const previous = diagnosticsRequests.get(absoluteFile);
  previous?.controller.abort();
  const controller = new AbortController();
  const generation = (previous?.generation ?? 0) + 1;
  diagnosticsRequests.set(absoluteFile, { controller, generation });
  try {
    const params = new URLSearchParams({ file: absoluteFile });
    const projectRoot = tsserverRoot();
    if (projectRoot) params.set("projectRoot", projectRoot);
    const r = await fetch(`/api/ts/diagnostics?${params.toString()}`, { signal: controller.signal });
    const data = await r.json().catch(() => null);
    const current = diagnosticsRequests.get(absoluteFile);
    if (!current || current.generation !== generation || controller.signal.aborted) {
      return { status: "stale", diagnostics: [] };
    }
    if (data?.status === "ok" && Array.isArray(data.diagnostics)) {
      return { status: "ok", diagnostics: data.diagnostics };
    }
    const status = data?.status === "pending" || data?.status === "timeout" || data?.status === "failed"
      ? data.status : "failed";
    return { status, code: data?.code, error: data?.error, diagnostics: [] };
  } catch {
    if (controller.signal.aborted) return { status: "stale", diagnostics: [] };
    return { status: "failed", code: "diagnostics_transport_error", diagnostics: [] };
  } finally {
    if (diagnosticsRequests.get(absoluteFile)?.generation === generation) diagnosticsRequests.delete(absoluteFile);
  }
}

