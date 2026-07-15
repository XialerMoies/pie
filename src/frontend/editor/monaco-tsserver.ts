/**
 * tsserver HTTP 通信层 — 纯 API 封装，不依赖 Monaco
 *
 * 将 monaco-setup.ts 中的 tsserver 通信逻辑独立出来，
 * 方便独立测试和模块化加载。
 */

function tsserverRoot(): string {
  return localStorage.getItem(App.Constants.WS_KEY) || "";
}

export function tsserverAbsPath(filePath: string): string {
  const root = tsserverRoot();
  return root ? root + "/" + filePath : filePath;
}

export async function tsFetch(command: string, body: Record<string, unknown>): Promise<unknown> {
  try {
    const r = await fetch("/api/ts/" + command, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

/** 获取诊断（原始数据） */
export async function tsDiagnostics(filePath: string): Promise<unknown[]> {
  try {
    const r = await fetch(`/api/ts/diagnostics?file=${encodeURIComponent(tsserverAbsPath(filePath))}`);
    if (!r.ok) return [];
    const data = await r.json();
    if (data?.success === false) return [];
    return data;
  } catch { return []; }
}

