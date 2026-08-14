import type { BrowserWindow } from "electron";

export async function waitForRendererReady(win: BrowserWindow): Promise<void> {
  const deadline = Date.now() + 30_000;
  let snapshot: unknown = null;
  while (Date.now() < deadline) {
    snapshot = await win.webContents.executeJavaScript(
      `({
        readyState: document.readyState,
        pageUrl: location.href,
        electronApiType: typeof window.electronAPI,
        appChildCount: document.querySelector('#app')?.childElementCount ?? -1,
        bodyText: document.body?.innerText?.slice(0, 300) || '',
        bootstrapApiType: typeof window.bootstrapApi,
        layoutType: typeof window.layout,
        appStateType: typeof window.App?.State,
        scripts: Array.from(document.scripts).map((script) => script.src || '[inline]'),
      })`,
      true,
    );
    const state = snapshot as { electronApiType?: string; appChildCount?: number };
    if (state.electronApiType === "object" && Number(state.appChildCount) > 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Renderer did not finish dashboard bootstrap within 30 seconds: ${JSON.stringify(snapshot)}`);
}

export async function runRendererCookieIsolationProbe(
  first: BrowserWindow,
  second: BrowserWindow,
): Promise<{ firstDashboardStatus: number; secondDashboardStatus: number }> {
  const bootstrap = (win: BrowserWindow) => win.webContents.executeJavaScript(`(async () => {
    if (typeof window.bootstrapApi !== "function") throw new Error("Renderer bootstrap API is unavailable");
    await window.bootstrapApi();
  })()`, true);
  await bootstrap(first);
  await bootstrap(second);
  const dashboard = (win: BrowserWindow) => win.webContents.executeJavaScript(`(async () => {
    const response = await fetch("/api/dashboard", { credentials: "include", cache: "no-store" });
    return response.status;
  })()`, true);
  const [firstDashboardStatus, secondDashboardStatus] = await Promise.all([
    dashboard(first),
    dashboard(second),
  ]);
  return { firstDashboardStatus, secondDashboardStatus };
}

export async function collectRendererE2EResult(
  win: BrowserWindow,
  outsidePath: string,
): Promise<Record<string, unknown>> {
  return win.webContents.executeJavaScript(`(async () => {
    const api = window.electronAPI;
    const preloadMethods = api ? Object.keys(api).sort() : [];
    const token = api?.getDesktopSessionToken ? await api.getDesktopSessionToken() : '';
    const response = await fetch('/api/dashboard', {
      cache: 'no-store',
      headers: token ? { 'X-My-Code-Agent-Token': token } : {},
    });
    const popup = window.open('https://example.com', '_blank');
    const initialUrl = location.href;
    location.href = 'https://example.com/blocked-navigation';
    await new Promise((resolve) => setTimeout(resolve, 100));
    const webview = document.createElement('webview');
    webview.src = 'https://example.com/blocked-webview';
    document.body.appendChild(webview);
    await new Promise((resolve) => setTimeout(resolve, 50));
    let webviewAttached = false;
    try {
      webviewAttached = typeof webview.getWebContentsId === 'function' && webview.getWebContentsId() > 0;
    } catch {}
    webview.remove();
    const outsidePath = ${JSON.stringify(outsidePath)};
    let revealOutsideRejected = false;
    let trashOutsideRejected = false;
    try { await api.showItemInFolder(outsidePath); } catch { revealOutsideRejected = true; }
    try { await api.trashItem(outsidePath); } catch { trashOutsideRejected = true; }
    return {
      appRendered: Boolean(document.querySelector('#app')?.childElementCount),
      apiStatus: response.status,
      desktopTokenPresent: typeof token === 'string' && token.length > 0,
      nodeRequireType: typeof globalThis.require,
      inlineHandlerCount: document.querySelectorAll('[onclick],[onchange],[oninput],[onsubmit]').length,
      popupOpened: popup !== null,
      externalNavigationBlocked: location.href === initialUrl,
      webviewAttached,
      revealOutsideRejected,
      trashOutsideRejected,
      preloadMethods,
    };
  })()`, true);
}
