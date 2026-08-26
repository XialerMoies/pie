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

/** Capture metadata-only renderer evidence for a cross-layer failure artifact.
 * Message text, thinking content, tool arguments and form values are excluded. */
export async function capturePackagedFailureEvidence(
  win: BrowserWindow,
): Promise<Record<string, unknown>> {
  const evidence = await win.webContents.executeJavaScript(`(async () => {
    const messages = window.App?.ChatState?.getMessages?.() || [];
    const eventTrace = [];
    for (const [messageIndex, message] of messages.entries()) {
      for (const block of message.blocks || []) {
        eventTrace.push({
          messageIndex,
          type: block.type || 'unknown',
          status: block.status || null,
          blockId: block.blockId || null,
          seq: Number.isFinite(block.seq) ? block.seq : null,
          toolCallId: block.toolCallId || null,
        });
      }
    }
    const nodes = Array.from(document.querySelectorAll('[id], [role], [aria-busy], [data-block-id]')).slice(0, 2_048).map((node) => ({
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      role: node.getAttribute('role'),
      ariaBusy: node.getAttribute('aria-busy'),
      ariaHidden: node.getAttribute('aria-hidden'),
      blockId: node.getAttribute('data-block-id'),
      disabled: 'disabled' in node ? Boolean(node.disabled) : null,
      hidden: node instanceof HTMLElement ? (node.hidden || getComputedStyle(node).display === 'none') : null,
    }));
    let correlation = { unavailable: true };
    try {
      const response = await fetch('/api/diagnostics', { cache: 'no-store' });
      const payload = await response.json();
      correlation = payload?.correlation || correlation;
    } catch {}
    return {
      eventTrace,
      domAria: {
        readyState: document.readyState,
        activeElementId: document.activeElement?.id || null,
        messageCount: messages.length,
        nodes,
      },
      requestCorrelation: correlation,
    };
  })()`, true);
  const redactionStyleId = "my-code-agent-e2e-screenshot-redaction";
  await win.webContents.executeJavaScript(`(() => {
    const style = document.createElement('style');
    style.id = ${JSON.stringify(redactionStyleId)};
    style.textContent = 'body *, body *::before, body *::after { color: transparent !important; text-shadow: none !important; caret-color: transparent !important; background-image: none !important; } input, textarea, [contenteditable] { visibility: hidden !important; } svg, img, canvas, video { visibility: hidden !important; }';
    document.head.appendChild(style);
  })()`, true);
  let screenshotBase64 = "";
  try {
    screenshotBase64 = (await win.webContents.capturePage()).toPNG().toString("base64");
  } finally {
    await win.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(redactionStyleId)})?.remove()`, true).catch(() => {});
  }
  return { ...evidence, screenshotBase64 };
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

/**
 * Run the packaged dashboard while a deterministic long tool event is active.
 * The probe records request timing, stream-to-DOM timing, loading states and
 * node identity so a final DOM snapshot cannot hide starvation or replacement.
 */
export async function runPackagedConcurrencyProbe(
  win: BrowserWindow,
): Promise<Record<string, unknown>> {
  return win.webContents.executeJavaScript(`(async () => {
    const startedAt = performance.now();
    const requests = [
      ['diagnostics', '/api/diagnostics'],
      ['sessions', '/api/sessions'],
      ['uiState', '/api/ui-state'],
      ['tokenUsage', '/api/token-usage'],
      ['explorer', '/api/explorer'],
      ['skills', '/api/settings/skills'],
      ['tsDiagnostics', '/api/ts/diagnostics?file=index.ts'],
    ];
    const requestRecords = [];
    const timedFetch = async (name, url) => {
      const start = performance.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        const firstByte = performance.now();
        await response.text();
        const completed = performance.now();
        const record = { name, status: response.status, firstByteMs: firstByte - start, completedMs: completed - start, state: response.headers.get('X-Request-State') || 'complete' };
        requestRecords.push(record);
        return record;
      } catch (error) {
        const completed = performance.now();
        const record = { name, status: 0, firstByteMs: null, completedMs: completed - start, state: error?.name === 'AbortError' ? 'timeout' : 'failed' };
        requestRecords.push(record);
        return record;
      } finally {
        clearTimeout(timeout);
      }
    };

    const chatState = window.App?.ChatState;
    const chat = window.App?.Chat;
    chatState?.replaceMessages?.([]);
    chat?.updateUI?.();
    let messageContainer = document.querySelector('#ms');
    if (!messageContainer) throw new Error('chat message container is unavailable');
    messageContainer.innerHTML = '';
    let assistantRoot = null;
    const nodeIdentities = {};
    const nodeOrder = [];
    const mutationSummary = { removedExisting: 0, addedExisting: 0, rootReplaced: false };
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node.nodeType === 1 && node.matches?.('[data-block-id]')) mutationSummary.removedExisting += 1;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && node.matches?.('[data-block-id]')) mutationSummary.addedExisting += 1;
        }
      }
      if (assistantRoot && messageContainer.querySelector('.m') !== assistantRoot) mutationSummary.rootReplaced = true;
    });
    observer.observe(messageContainer, { childList: true, subtree: true });

    const streamStarted = performance.now();
    const input = document.querySelector('#ci');
    const send = document.querySelector('#cs');
    if (!(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLElement)) throw new Error('chat composer is unavailable');
    input.value = '__my_code_agent_e2e_long_tool__';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-side="chat"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const chatPaneOpened = Boolean(document.querySelector('#sl'));
    const settings = window.App?.Settings;
    settings?.openSettingsModal?.();
    document.querySelector('.ms-item[data-st="skills"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const settingsOpened = Boolean(document.querySelector('#settings-modal'));
    send.click();

    const streamDeadline = performance.now() + 15_000;
    let firstBlockAt = null;
    let terminalAt = null;
    let independentStarted = null;
    let independent = null;
    while (performance.now() < streamDeadline) {
      const nodes = Array.from(messageContainer.querySelectorAll('[data-block-id]'));
      for (const node of nodes) {
        const id = node.dataset.blockId;
        if (!id) continue;
        if (!nodeIdentities[id]) { nodeIdentities[id] = node; nodeOrder.push(id); }
        else if (nodeIdentities[id] !== node) mutationSummary.removedExisting += 1;
      }
      if (!firstBlockAt && nodeOrder.length > 0) {
        firstBlockAt = performance.now();
        assistantRoot = messageContainer.querySelector('.m');
        independentStarted = performance.now();
        independent = Promise.all(requests.map(([name, url]) => timedFetch(name, url)));
      }
      if (nodeOrder.includes('e2e-text') && messageContainer.textContent?.includes('长工具执行完成')) { terminalAt = performance.now(); break; }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const records = await (independent || Promise.all(requests.map(([name, url]) => timedFetch(name, url))));
    observer.disconnect();
    const loadingDeadline = performance.now() + 3_000;
    while (performance.now() < loadingDeadline) {
      const sessionLoading = document.querySelector('#sl')?.classList.contains('is-loading') || /加载中/.test(document.querySelector('#sl')?.textContent || '');
      const settingsLoading = /加载中/.test(document.querySelector('#mc-settings')?.textContent || '');
      if (!sessionLoading && !settingsLoading) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const loadingStates = {
      sessionListLoading: document.querySelector('#sl')?.classList.contains('is-loading') || /加载中/.test(document.querySelector('#sl')?.textContent || ''),
      settingsLoading: /加载中/.test(document.querySelector('#mc-settings')?.textContent || ''),
      workspaceLoading: document.documentElement.classList.contains('preferences-loading'),
    };
    return {
      requestRecords: records.sort((a, b) => a.name.localeCompare(b.name)),
      requestCount: records.length,
      independentStartedMs: independentStarted === null ? null : independentStarted - startedAt,
      firstBlockMs: firstBlockAt === null ? null : firstBlockAt - streamStarted,
      terminalMs: terminalAt === null ? null : terminalAt - streamStarted,
      streamOverlappedIndependentRequests: independentStarted !== null && terminalAt !== null && independentStarted < terminalAt && records.length === requests.length,
      nodeOrder,
      stableNodeIdentity: Object.keys(nodeIdentities).length === nodeOrder.length,
      mutationSummary,
      chatPaneOpened,
      settingsOpened,
      loadingStates,
      withinDeadline: terminalAt !== null,
    };
  })()`, true);
}

/** Exercise the real packaged dashboard against the test-only replay provider.
 * The provider is selected by the renderer's normal send path; this probe then
 * verifies live DOM identity, SSE reconnect replay, and a real page reload. */
export async function runPackagedReplayProviderProbe(
  win: BrowserWindow,
): Promise<Record<string, unknown>> {
  const live = await win.webContents.executeJavaScript(`(async () => {
    const chatState = window.App?.ChatState;
    const chat = window.App?.Chat;
    const messageContainer = document.querySelector('#ms');
    const input = document.querySelector('#ci');
    const send = document.querySelector('#cs');
    if (!messageContainer || !(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLElement)) throw new Error('replay chat controls are unavailable');
    document.querySelector('.modal-close')?.click?.();
    document.querySelector('[data-side="chat"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const readyDeadline = performance.now() + 5_000;
    while (performance.now() < readyDeadline && chatState?.isBusy?.()) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (chatState?.isBusy?.()) throw new Error('replay composer did not become ready after the preceding turn');
    // The preceding terminal frame can still have a queued animation-frame
    // render after its text first appears. Let that settle before establishing
    // the replay flow's empty baseline.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    chatState?.replaceMessages?.([]);
    chat?.updateUI?.();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (messageContainer.querySelector('[data-block-id]')) throw new Error('replay baseline retained nodes from the preceding turn');
    const identities = {};
    const order = [];
    const mutations = { removed: 0, rootReplaced: false };
    let root = null;
    const observer = new MutationObserver((records) => {
      for (const record of records) mutations.removed += [...record.removedNodes].filter((node) => node.nodeType === 1 && node.matches?.('[data-block-id]')).length;
      if (root && messageContainer.querySelector('.m') !== root) mutations.rootReplaced = true;
    });
    observer.observe(messageContainer, { childList: true, subtree: true });
    input.value = '__my_code_agent_e2e_replay__';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (send.hasAttribute('disabled')) throw new Error('replay composer did not enable after entering the provider message');
    const started = performance.now();
    send.click();
    let terminalAt = null;
    while (performance.now() - started < 15_000) {
      for (const node of messageContainer.querySelectorAll('[data-block-id]')) {
        const id = node.dataset.blockId;
        if (!id) continue;
        if (!identities[id]) { identities[id] = node; order.push(id); root ||= messageContainer.querySelector('.m'); }
        else if (identities[id] !== node) mutations.removed += 1;
      }
      if (order.includes('replay-text') && messageContainer.textContent?.includes('Replay answer')) { terminalAt = performance.now(); break; }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    const replayResponse = await fetch('/api/chat/stream', { headers: { 'Last-Event-ID': '0' }, cache: 'no-store' });
    const reader = replayResponse.body?.getReader();
    let replayBody = '';
    const replayDeadline = performance.now() + 3_000;
    while (reader && performance.now() < replayDeadline && !replayBody.includes('replay-text')) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), 250)),
      ]);
      if (chunk?.done) break;
      if (chunk?.value) replayBody += new TextDecoder().decode(chunk.value);
    }
    try { await reader?.cancel(); } catch {}
    let activeSessionId = null;
    try {
      const sessionsResponse = await fetch('/api/sessions?other=1', { cache: 'no-store' });
      const sessionsPayload = await sessionsResponse.json();
      activeSessionId = sessionsPayload?.activeSessionId || sessionsPayload?.sessions?.[0]?.id || null;
    } catch {}
    observer.disconnect();
    return {
      order,
      liveSnapshot: [...messageContainer.querySelectorAll('[data-block-id]')].map((node) => ({ id: node.dataset.blockId, text: node.textContent })),
      terminalAt: terminalAt === null ? null : terminalAt - started,
      rootStable: !mutations.rootReplaced,
      removedExisting: mutations.removed,
      reconnectStatus: replayResponse.status,
      reconnectMatches: replayBody.includes('replay-text') && replayBody.includes('Replay answer'),
      activeSessionId,
      withinDeadline: terminalAt !== null,
    };
  })()`, true);

  await win.webContents.reload();
  await waitForRendererReady(win);
  const refreshed = await win.webContents.executeJavaScript(`(async () => {
    const expected = ${JSON.stringify((live as { liveSnapshot?: unknown }).liveSnapshot || [])};
    const sessionId = ${JSON.stringify((live as { activeSessionId?: unknown }).activeSessionId || null)};
    if (sessionId && window.App?.SessionActivation?.activateById) await window.App.SessionActivation.activateById(sessionId, { silent: true });
    const deadline = performance.now() + 10_000;
    let snapshot = [];
    while (performance.now() < deadline) {
      snapshot = [...document.querySelectorAll('#ms [data-block-id]')].map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
      if (snapshot.some((entry) => entry.id === 'replay-text')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const matched = JSON.stringify(snapshot) === JSON.stringify(expected);
    if (!matched || !sessionId || !window.App?.Session?.newSession || !window.App?.SessionActivation?.activateById) {
      return { snapshot, matched, draftCleared: false, sessionSwitchMatches: false };
    }
    window.App.Session.newSession();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const draftCleared = document.querySelectorAll('#ms [data-block-id]').length === 0;
    await window.App.SessionActivation.activateById(sessionId, { silent: true });
    const switchDeadline = performance.now() + 10_000;
    let switchedSnapshot = [];
    while (performance.now() < switchDeadline) {
      switchedSnapshot = [...document.querySelectorAll('#ms [data-block-id]')].map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
      if (switchedSnapshot.some((entry) => entry.id === 'replay-text')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return {
      snapshot,
      matched,
      draftCleared,
      sessionSwitchMatches: JSON.stringify(switchedSnapshot) === JSON.stringify(expected),
    };
  })()`, true);
  return {
    ...live,
    refreshSnapshot: refreshed.snapshot,
    refreshMatches: refreshed.matched,
    draftCleared: refreshed.draftCleared,
    sessionSwitchMatches: refreshed.sessionSwitchMatches,
  };
}

/** Verify the AP-14 capability selector and request-scoped evidence overlay
 * inside the packaged production renderer. Profile switching is exercised
 * against the real non-empty session; evidence frames use the same
 * ChatSseControllerView that handles live/reconnect SSE in production. */
export async function runPackagedCapabilitySelectorProbe(
  win: BrowserWindow,
): Promise<Record<string, unknown>> {
  return win.webContents.executeJavaScript(`(async () => {
    const chat = window.App?.Chat;
    const chatState = window.App?.ChatState;
    const messageContainer = document.querySelector('#ms');
    const modeButton = document.querySelector('#fi-mode-btn');
    if (!chat || !chatState || !messageContainer || !(modeButton instanceof HTMLElement)) {
      throw new Error('capability selector controls are unavailable');
    }
    await chat.syncProfiles?.();
    const catalogResponse = await fetch('/api/profiles', { cache: 'no-store' });
    const catalog = await catalogResponse.json();
    const catalogIds = Array.isArray(catalog?.catalogs) ? catalog.catalogs.map((entry) => entry?.id).filter(Boolean) : [];
    const expectedIds = ['standard', 'minimal'];
    const selectorCatalogMatches = JSON.stringify([...catalogIds].sort()) === JSON.stringify([...expectedIds].sort());
    chat.showModePopup(modeButton);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const popup = document.querySelector('#mode-popup');
    const selectorOptions = popup ? [...popup.querySelectorAll('[data-profile]')].map((node) => node.dataset.profile).filter(Boolean) : [];
    const selectedBefore = chat.getProfile?.() || null;
    const otherProfile = selectedBefore === 'standard' ? 'minimal' : 'standard';
    const otherOption = popup?.querySelector('[data-profile="' + otherProfile + '"]');
    otherOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    const selectedAfterRejectedSwitch = chat.getProfile?.() || null;
    const nonEmptySwitchRejected = selectedAfterRejectedSwitch === selectedBefore
      && Boolean(document.querySelector('#mode-popup'));
    document.querySelector('#mode-popup')?.remove();

    const evidenceStates = [];
    chatState.replaceMessages([{ role: 'assistant', content: '', streaming: true, blocks: [] }]);
    chat.updateUI?.();
    const views = window.App?.ChatViews;
    if (!views?.ChatSseControllerView) throw new Error('ChatSseControllerView is unavailable');
    const controller = new views.ChatSseControllerView({
      scheduleMessagesRender: () => {}, updateUI: () => {}, markLastMessageRendered: () => {},
      renderMessages: () => {}, refreshComposer: () => {}, setAssistantError: () => {},
      completeSend: () => {}, failSend: () => {},
    }, {
      chat, chatState,
      chatStream: { isCurrent: () => true, setHandlers: () => true, close: () => {} },
      chatViews: views,
    });
    controller.bind(14);
    const badge = () => ({
      text: document.querySelector('#fi-evidence-state')?.textContent || '',
      hidden: document.querySelector('#fi-evidence-state')?.hidden !== false,
    });
    controller.handleMessage(14, { data: JSON.stringify({ type: 'stream_ready', evidenceState: { status: 'active', kind: 'fact_verification', revision: 1 } }) });
    const activeAfterBaseline = badge();
    controller.handleMessage(14, { data: JSON.stringify({ type: 'evidence_state', state: { status: 'active', kind: 'fact_verification', revision: 1 } }) });
    const activeAfterReconnect = badge();
    controller.handleMessage(14, { data: JSON.stringify({ type: 'done', text: 'verified', blocks: [] }) });
    const clearedAfterTerminal = badge();

    chat.applyEvidenceState?.({ status: 'active', kind: 'fact_verification', revision: 2 });
    const activeBeforeSessionSwitch = badge();
    const sessionsResponse = await fetch('/api/sessions?other=1', { cache: 'no-store' });
    const sessionsPayload = await sessionsResponse.json();
    const activeSessionId = sessionsPayload?.activeSessionId || sessionsPayload?.sessions?.[0]?.id || null;
    if (activeSessionId && window.App?.SessionActivation?.activateById) {
      await window.App.SessionActivation.activateById(activeSessionId, { silent: true });
    }
    const clearedAfterSessionSwitch = badge();
    return {
      status: catalogResponse.status,
      catalogIds,
      selectorCatalogMatches,
      selectorOptions,
      selectorOptionsMatch: JSON.stringify([...selectorOptions].sort()) === JSON.stringify([...expectedIds].sort()),
      selectedBefore,
      selectedAfterRejectedSwitch,
      nonEmptySwitchRejected,
      activeAfterBaseline,
      activeAfterReconnect,
      clearedAfterTerminal,
      activeBeforeSessionSwitch,
      clearedAfterSessionSwitch,
      profileUnchangedByEvidence: (chat.getProfile?.() || null) === selectedBefore,
    };
  })()`, true);
}

/** Cancel a real long-tool send through the packaged UI and verify that the
 * abort request completes and no late terminal frame mutates the cancelled DOM. */
export async function runPackagedCancellationProbe(
  win: BrowserWindow,
): Promise<Record<string, unknown>> {
  return win.webContents.executeJavaScript(`(async () => {
    const chatState = window.App?.ChatState;
    const chat = window.App?.Chat;
    let messageContainer = document.querySelector('#ms');
    if (!chatState || !chat || !messageContainer) {
      throw new Error('cancellation controls are unavailable');
    }
    await window.App?.Session?.whenReady?.();
    const readyDeadline = performance.now() + 5_000;
    while (performance.now() < readyDeadline && chatState.isBusy()) await new Promise((resolve) => setTimeout(resolve, 25));
    if (chatState.isBusy()) throw new Error('cancellation composer did not become ready');
    chatState.replaceMessages([]);
    chat.updateUI?.();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    let input = null;
    let send = null;
    const bindingDeadline = performance.now() + 5_000;
    while (performance.now() < bindingDeadline) {
      input = document.querySelector('#ci');
      send = document.querySelector('#cs');
      if (input instanceof HTMLTextAreaElement && send instanceof HTMLButtonElement) {
        input.value = '__my_code_agent_e2e_cancel_tool__';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (!send.disabled) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement) || send.disabled) {
      throw new Error('cancellation composer did not bind before the deadline');
    }
    document.querySelector('[data-side="chat"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    input = document.querySelector('#ci');
    send = document.querySelector('#cs');
    messageContainer = document.querySelector('#ms');
    if (!(input instanceof HTMLTextAreaElement) || !(send instanceof HTMLButtonElement) || !messageContainer) {
      throw new Error('cancellation controls were replaced without a usable chat pane');
    }
    input.value = '__my_code_agent_e2e_cancel_tool__';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    if (send.disabled) throw new Error('cancellation send remained disabled in the active chat pane');
    send.click();
    const toolDeadline = performance.now() + 10_000;
    while (performance.now() < toolDeadline && !messageContainer.querySelector('[data-block-id="cancel-e2e-tool"]')) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const toolMounted = Boolean(messageContainer.querySelector('[data-block-id="cancel-e2e-tool"]'));
    const stop = document.querySelector('#chat-stop');
    if (!(stop instanceof HTMLElement) || !stop.isConnected || getComputedStyle(stop).display === 'none') {
      throw new Error('active cancellation control is unavailable');
    }
    stop.click();
    const snapshotAfterAbort = [...messageContainer.querySelectorAll('[data-block-id]')].map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const lateSnapshot = [...messageContainer.querySelectorAll('[data-block-id]')].map((node) => ({ id: node.dataset.blockId, text: node.textContent }));
    return {
      toolMounted,
      busyAfterAbort: chatState.isBusy(),
      stopHidden: getComputedStyle(stop).display === 'none',
      lateTerminalVisible: messageContainer.textContent?.includes('取消场景不应出现的迟到正文') || false,
      domStableAfterAbort: JSON.stringify(snapshotAfterAbort) === JSON.stringify(lateSnapshot),
    };
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
