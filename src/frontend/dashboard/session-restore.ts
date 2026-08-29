interface SessionRestoreOptions {
  onActiveSession(sessionId: string): Promise<void> | void;
  prefetchSessionIndex(): Promise<void> | void;
}

const DRAFT_SESSION_PREFIX = 'draft:';
const sessionRestoreApp = (window as any).App as AppNamespace;

function _isDraftSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DRAFT_SESSION_PREFIX);
}

function normalizeSessionTabIds(ids: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function _readSessionTabIds(): string[] {
  const tabs = sessionRestoreApp.Tabs;
  return tabs?.getSessionTabIds ? tabs.getSessionTabIds() : [];
}

function _writeSessionTabIds(ids: string[]): void {
  const next = normalizeSessionTabIds(ids);
  const tabs = sessionRestoreApp.Tabs;
  if (tabs) {
    const existing = tabs.getSessionTabIds();
    for (const id of next) {
      if (!existing.includes(id)) {
        const isDraft = id.startsWith(DRAFT_SESSION_PREFIX);
        tabs.openTab({
          kind: isDraft ? 'chat' : 'session',
          id,
          title: '新会话',
          ...(isDraft ? { draftId: id } : { sessionId: id }),
        });
      }
    }
    for (const id of existing) {
      if (!next.includes(id)) tabs.closeTab(id);
    }
  }
  if (typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

function _setActiveSessionTabId(id: string | null): void {
  const tabs = sessionRestoreApp.Tabs;
  if (tabs) tabs.activateTab(id);
  if (!tabs && typeof (window as any)._uiStateSave === 'function') (window as any)._uiStateSave();
}

function _renderSessionTabs(_activeId?: string): void {
  sessionRestoreApp.UI?.renderTabs?.();
}

function _saveUiState(): void {
  const tabs = sessionRestoreApp.Tabs;
  if (tabs) tabs.getState();
  const activeId = tabs?.getActiveSessionTabId?.() || null;
  const activePanel = sessionRestoreApp.State.getSnapshot().panel.active || 'explorer';
  sessionRestoreApp.State.updatePanel({ active: activePanel });
  if (activeId) sessionRestoreApp.State.touchSession(activeId);
  void sessionRestoreApp.State.saveNow();
}

const sessionTabsApi: AppSessionTabs = {
  isDraftSessionId: _isDraftSessionId,
  readSessionTabIds: _readSessionTabIds,
  writeSessionTabIds: _writeSessionTabIds,
  setActiveSessionTabId: _setActiveSessionTabId,
  renderSessionTabs: _renderSessionTabs,
  saveUiState: _saveUiState,
};

sessionRestoreApp.SessionTabs = sessionTabsApi;

let restoreOptions: SessionRestoreOptions | null = null;
let restorePromise: Promise<void> | null = null;
let userInteractedWithTabs = false;

function initSessionRestore(options: SessionRestoreOptions): void {
  restoreOptions = options;
}

function markUserInteraction(): void {
  userInteractedWithTabs = true;
}

function hasUserInteracted(): boolean {
  return userInteractedWithTabs;
}

function _restorePanel(panel: string): void {
  sessionRestoreApp.UI?.restorePanel?.(panel);
}

async function restoreSessionTabsImpl(): Promise<void> {
  const options = restoreOptions;
  if (!options) throw new Error('SessionRestore is not initialized');

  try {
    void Promise.resolve(options.prefetchSessionIndex()).catch(() => {});
  } catch {}

  const store = await sessionRestoreApp.State.hydrate();
  if (hasUserInteracted()) {
    _restorePanel(store.panel.active || 'explorer');
    return;
  }

  const items = store.tabs.items || [];
  const restoredItems = items.filter(tab => tab.kind !== 'mcp-management' && !(tab.kind === 'chat' && _isDraftSessionId(tab.id)));
  const persistedActiveId = store.tabs.activeId
    || (store.activeView.type !== 'chat' ? store.activeView.id : null);
  const preferredActiveId = persistedActiveId && !_isDraftSessionId(persistedActiveId)
    ? persistedActiveId
    : null;
  const activeId = preferredActiveId && restoredItems.some(tab => tab.id === preferredActiveId)
    ? preferredActiveId
    : restoredItems.find(tab => tab.kind === 'session' || tab.kind === 'component')?.id || null;

  sessionRestoreApp.Tabs?.restoreTabs?.(restoredItems, activeId);
  sessionRestoreApp.State.syncTabs?.(restoredItems, activeId);
  sessionRestoreApp.UI?.restoreFileTabs?.();

  const ids = restoredItems
    .filter(tab => tab.kind === 'session' || tab.kind === 'chat')
    .map(tab => tab.id);
  if (!activeId && ids.length === 0 && _readSessionTabIds().length === 0) {
    if (restoredItems.length !== items.length) _saveUiState();
    return;
  }

  _writeSessionTabIds(ids);
  if (activeId) _setActiveSessionTabId(activeId);
  _renderSessionTabs(activeId || '');
  _restorePanel(store.panel.active || 'explorer');

  const activeTab = activeId ? restoredItems.find(tab => tab.id === activeId) : undefined;
  if (activeTab?.kind === 'session') {
    await options.onActiveSession(activeId);
  }
  _saveUiState();
}

function _restoreSessionTabs(): Promise<void> {
  if (!restorePromise) {
    restorePromise = restoreSessionTabsImpl().catch(error => {
      console.warn('[session-restore] failed', error);
    });
  }
  return restorePromise;
}

function _whenSessionRestoreReady(): Promise<void> {
  return restorePromise || Promise.resolve();
}

const sessionRestoreApi: AppSessionRestore = {
  init: initSessionRestore,
  restoreSessionTabs: _restoreSessionTabs,
  whenReady: _whenSessionRestoreReady,
  markUserInteraction,
  hasUserInteracted,
};

sessionRestoreApp.SessionRestore = sessionRestoreApi;

export {};
