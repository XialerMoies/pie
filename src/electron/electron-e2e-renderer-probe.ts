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

/**
 * Exercise the production dashboard bundle inside the packaged BrowserWindow
 * with the same canonical block presentation frames used by the dist flow.
 * This intentionally observes each frame, node identity and refresh replay;
 * a final DOM snapshot alone would not catch streaming replacement regressions.
 */
export async function runPackagedChatEventFlowProbe(
  win: BrowserWindow,
): Promise<Record<string, unknown>> {
  return win.webContents.executeJavaScript(`(async () => {
    const chatState = window.App?.ChatState;
    const chat = window.App?.Chat;
    const views = window.App?.ChatViews;
    if (!chatState || !chat || !views?.ChatSseControllerView) throw new Error('chat event flow APIs are unavailable');
    const ms = document.querySelector('#ms');
    if (!ms) throw new Error('chat message container is unavailable');
    const blocks = [
      { type: 'thinking', status: 'streaming', text: '先分析', blockId: 'packaged-thought-1', seq: 1, turnId: 'packaged-turn' },
      { type: 'tool', status: 'running', name: 'file_read', input: { path: 'SKILL.md' }, toolCallId: 'packaged-tool', blockId: 'packaged-tool', seq: 2, turnId: 'packaged-turn' },
      { type: 'tool', status: 'success', name: 'file_read', input: { path: 'SKILL.md' }, output: '事实内容', toolCallId: 'packaged-tool', blockId: 'packaged-tool', seq: 2, turnId: 'packaged-turn' },
      { type: 'thinking', status: 'streaming', text: '再验证', blockId: 'packaged-thought-2', seq: 3, turnId: 'packaged-turn' },
      { type: 'text', text: '最终正文', blockId: 'packaged-text', seq: 4, turnId: 'packaged-turn' },
    ];
    // Replay is a canonical snapshot: repeated frames for one logical block
    // must collapse to its final state before the session is rendered again.
    const terminalBlocks = Array.from(
      blocks.reduce((byId, block) => byId.set(block.blockId, block), new Map()),
      ([, block]) => block,
    );
    let closed = 0;
    let fullRenders = 0;
    let scheduled = 0;
    chatState.replaceMessages([{ role: 'assistant', content: '', streaming: true, blocks: [] }]);
    ms.innerHTML = chat.msgs();
    const root = ms.querySelector('.m');
    const identities = {};
    for (const block of blocks) {
      const controller = flowController();
      controller.handleMessage(1, { data: JSON.stringify({ type: 'block', block }) });
      const node = ms.querySelector('[data-block-id="' + block.blockId + '"]');
      if (!node) throw new Error('block did not mount: ' + block.blockId);
      if (identities[block.blockId] && identities[block.blockId] !== node) throw new Error('block identity changed: ' + block.blockId);
      identities[block.blockId] = node;
      if (ms.querySelector('.m') !== root) throw new Error('assistant root changed during stream');
    }
    const liveSnapshot = Array.from(ms.querySelectorAll('[data-block-id]')).map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
    const controller = flowController();
    controller.handleMessage(1, { data: JSON.stringify({ type: 'done', turnId: 'packaged-turn', text: '最终正文', blocks: terminalBlocks.map((block) => block.type === 'thinking' ? { ...block, status: 'done' } : block) }) });
    await Promise.resolve();
    const terminalSnapshot = Array.from(ms.querySelectorAll('[data-block-id]')).map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
    chatState.replaceMessages([{ role: 'assistant', content: '最终正文', streaming: false, blocks: terminalBlocks.map((block) => block.type === 'thinking' ? { ...block, status: 'done' } : block) }]);
    ms.innerHTML = chat.msgs();
    const refreshSnapshot = Array.from(ms.querySelectorAll('[data-block-id]')).map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
    return {
      blockIds: liveSnapshot.map((item) => item.id),
      terminalBlockIds: terminalSnapshot.map((item) => item.id),
      refreshMatches: JSON.stringify(terminalSnapshot) === JSON.stringify(refreshSnapshot),
      assistantRootStable: Boolean(root),
      closed,
      fullRenders,
      scheduled,
      visibleText: terminalSnapshot.map((item) => item.text).join(' '),
    };

    function flowController() {
      const controller = new views.ChatSseControllerView({
        scheduleMessagesRender: () => { scheduled += 1; },
        updateUI: () => {},
        markLastMessageRendered: () => {},
        renderMessages: () => { fullRenders += 1; },
        refreshComposer: () => {},
        setAssistantError: () => {},
        completeSend: () => {},
        failSend: () => {},
      }, {
        chat,
        chatState,
        chatStream: { isCurrent: () => true, setHandlers: () => true, close: () => { closed += 1; } },
        chatViews: views,
      });
      controller.bind(1);
      return controller;
    }
  })()`, true);
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
    const diagnosticsResponse = await fetch('/api/diagnostics', {
      cache: 'no-store',
      headers: token ? { 'X-My-Code-Agent-Token': token } : {},
    });
    let diagnosticsPayload = null;
    try { diagnosticsPayload = await diagnosticsResponse.json(); } catch {}
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
      diagnosticsStatus: diagnosticsResponse.status,
      diagnosticsOk: diagnosticsPayload?.ok === true,
      diagnosticsCorrelationShape: Boolean(
        diagnosticsPayload?.correlation
        && typeof diagnosticsPayload.correlation === 'object'
        && Number.isInteger(diagnosticsPayload.correlation.total)
        && Number.isInteger(diagnosticsPayload.correlation.traces)
        && Number.isInteger(diagnosticsPayload.correlation.turns)
        && Array.isArray(diagnosticsPayload.correlation.records),
      ),
      diagnosticsHasSensitiveFields: JSON.stringify(diagnosticsPayload || {}).match(
        /(?:api[_-]?key|authorization|cookie|password|secret|token|credential|private[_-]?key)/i,
      ) !== null,
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
