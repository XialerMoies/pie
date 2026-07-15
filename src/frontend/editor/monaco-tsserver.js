function tsserverRoot() {
  return localStorage.getItem(App.Constants.WS_KEY) || "";
}
export function tsserverAbsPath(filePath) {
  const root = tsserverRoot();
  return root ? root + "/" + filePath : filePath;
}
export async function tsFetch(command, body) {
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
    await tsFetch("open", { file: tsserverAbsPath(filePath), content, scriptKindName: "TS" });
  } catch {
  }
}
export async function tsChangeFile(filePath, content) {
  try {
    await tsFetch("change", { file: tsserverAbsPath(filePath), content });
  } catch {
  }
}
export async function tsCloseFile(filePath) {
  try {
    await tsFetch("close", { file: tsserverAbsPath(filePath) });
  } catch {
  }
}
export async function tsDiagnostics(filePath) {
  try {
    const r = await fetch(`/api/ts/diagnostics?file=${encodeURIComponent(tsserverAbsPath(filePath))}`);
    if (!r.ok) return [];
    const data = await r.json();
    if (data?.success === false) return [];
    return data;
  } catch {
    return [];
  }
}
