import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(file) {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

function assertClass(src, name) {
  assert.match(src, new RegExp(`class\\s+${name}\\b`), `${name} should exist`);
}

function assertDelegates(src, fn, view) {
  const body = src.match(new RegExp(`function\\s+${fn}\\s*\\([^)]*\\)\\s*:\\s*(?:string|void)\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(body, `${fn} should exist`);
  assert.match(body[1], new RegExp(`${view}\\.`), `${fn} should delegate to ${view}`);
}

describe("frontend component tree boundaries", () => {
  it("uses component views for token usage modal panes", () => {
    const src = source("src/frontend/chat/chat-token.ts");
    for (const name of ["UsageModalView", "UsageCurrentView", "UsageSummaryView"]) assertClass(src, name);
    assertDelegates(src, "renderCurrentSessionUsage", "UsageCurrentView");
    assertDelegates(src, "renderSummaryUsage", "UsageSummaryView");
  });

  it("uses component views for settings storage and custom subagents", () => {
    const src = source("src/frontend/dashboard/dashboard-settings.ts");
    for (const name of ["SettingsStorageLocationView", "SettingsCustomSubagentManagerView"]) assertClass(src, name);
    assertDelegates(src, "renderCustomSubagentManager", "SettingsCustomSubagentManagerView");
    assertDelegates(src, "renderStorageLocationSettings", "SettingsStorageLocationView");
  });

  it("uses component views for git pane content", () => {
    const src = source("src/frontend/pane/git/index.ts");
    for (const name of ["GitPanelView", "GitChangeRowView", "GitDiffPreviewView", "GitHistoryView"]) assertClass(src, name);
    assert.match(src, /container\.innerHTML\s*=\s*GitPanelView\.render\(/);
  });

  it("uses component views for search and replace results", () => {
    const src = source("src/frontend/pane/search/index.ts");
    for (const name of ["SearchResultsView", "SearchResultItemView", "ReplacePreviewView"]) assertClass(src, name);
    assert.match(src, /list\.innerHTML\s*=\s*SearchResultsView\.render\(/);
    assert.match(src, /previewContainer\.innerHTML\s*=\s*ReplacePreviewView\.render\(/);
  });

  it("uses component views for session list rows and groups", () => {
    const src = source("src/frontend/dashboard/dashboard-sessions.ts");
    const panel = source("src/frontend/dashboard/session-list-panel.ts");
    for (const name of ["SessionEmptyStateView", "SessionActionsView", "SessionCardView", "SessionGroupView", "SessionListPanelView"]) assertClass(panel, name);
    assert.match(panel, /SessionCardView\.render\(/);
    assert.match(panel, /SessionGroupView\.render\(/);
    assert.match(src, /createSessionListPanel\(/);
    assert.doesNotMatch(src, /class\s+(?:SessionEmptyStateView|SessionActionsView|SessionCardView|SessionGroupView)\b/);
  });

  it("keeps permissions rendering in dedicated component views", () => {
    const controller = source("src/frontend/pane/permissions/index.ts");
    const views = source("src/frontend/pane/permissions/permissions-views.ts");
    for (const name of ["PermissionsPanelView", "PermissionAuditView", "PermissionRulesView", "WorkingDirectoriesView"]) assertClass(views, name);
    assert.match(controller, /App\.PermissionViews\.renderPanel\(/);
    assert.match(controller, /App\.PermissionViews\.renderContent\(/);
    assert.doesNotMatch(controller, /class\s+(?:PermissionsPanelView|PermissionAuditView|PermissionRulesView|WorkingDirectoriesView)\b/);
  });

  it("keeps MCP rendering in dedicated component views", () => {
    const controller = source("src/frontend/pane/mcp/index.ts");
    const views = source("src/frontend/pane/mcp/mcp-views.ts");
    for (const name of ["McpPanelView", "McpServerListView", "McpCatalogView", "McpCustomInstallView"]) assertClass(views, name);
    assert.match(controller, /App\.McpViews\.renderPanel\(/);
    assert.match(controller, /App\.McpViews\.renderServers\(/);
    assert.match(controller, /App\.McpViews\.renderCatalog\(/);
    assert.doesNotMatch(controller, /class\s+(?:McpPanelView|McpServerListView|McpCatalogView|McpCustomInstallView)\b/);
  });

  it("keeps Explorer shell and filter menu in dedicated component views", () => {
    const controller = source("src/frontend/pane/explorer/index.ts");
    const views = source("src/frontend/pane/explorer/explorer-views.ts");
    for (const name of ["ExplorerPanelView", "ExplorerEmptyView", "ExplorerFilterMenuView"]) assertClass(views, name);
    assert.match(controller, /App\.ExplorerViews\.renderEmpty\(/);
    assert.match(controller, /App\.ExplorerViews\.renderPanel\(/);
    assert.match(controller, /App\.ExplorerViews\.showFilterMenu\(/);
    assert.doesNotMatch(controller, /class\s+(?:ExplorerPanelView|ExplorerEmptyView|ExplorerFilterMenuView)\b/);
  });

  it("owns chat timeline state in one lifecycle component", () => {
    const timeline = source("src/frontend/chat/chat-timeline.ts");
    assertClass(timeline, "ChatTimelineView");
    for (const method of ["bind", "sync", "refreshSettings", "handleMessagesScroll", "reset", "dispose"]) {
      assert.match(timeline, new RegExp(`${method}\\s*\\(`), `${method} should belong to ChatTimelineView`);
    }
    assert.doesNotMatch(timeline, /let\s+chatTimeline(?:Items|ActiveIndex|Enabled|WindowSize|Signature|BoundHost|ScrollFrame|LastWheelAt)\b/);
  });

  it("keeps subagent views in their dedicated component module", () => {
    const legacy = source("src/frontend/chat/chat-component-views.ts");
    const subagent = source("src/frontend/chat/chat-subagent-views.ts");
    for (const name of ["SubagentTaskView", "SubagentBatchView"]) assertClass(subagent, name);
    assert.doesNotMatch(legacy, /class\s+(?:SubagentTaskView|SubagentBatchView)\b/);
    assert.doesNotMatch(legacy, /function\s+chatViewNormalizeDelegation\b/);
    assert.doesNotMatch(legacy, /function\s+chatViewRefreshSubagentDelegation\b/);
    assert.match(subagent, /renderSubagentDelegation:\s*chatSubagentRenderDelegation/);
    assert.match(subagent, /refreshSubagentDelegation:\s*chatSubagentRefreshDelegation/);
  });

  it("keeps chat command confirmation in a dedicated component view", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    const confirmation = source("src/frontend/chat/chat-command-confirmation.ts");
    const controller = source("src/frontend/chat/chat-sse-controller.ts");
    for (const name of ["ChatCommandConfirmationView"]) assertClass(confirmation, name);
    assert.match(confirmation, /static async handle\(/);
    assert.match(controller, /ChatCommandConfirmationView/);
    assert.doesNotMatch(chat, /ChatCommandConfirmationView\.handle\(d\)/);
    assert.doesNotMatch(chat, /confirmCommandAsync|\/api\/chat\/command-confirm/);
  });

  it("keeps composer interaction and send/stop state in a dedicated component view", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    const composer = source("src/frontend/chat/chat-composer.ts");
    assertClass(composer, "ChatComposerView");
    assert.match(composer, /onSubmitNote|chat-stop|chat-note-mode/);
    assert.match(chat, /App\.ChatViews\.createComposer\(/);
    assert.match(chat, /chatComposerView\?\.refresh\(\)/);
    assert.doesNotMatch(chat, /function\s+sendOrStop\b|let\s+chatNoteMode\b/);
  });

  it("keeps model picker rendering and lifecycle in a dedicated component view", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    const picker = source("src/frontend/chat/chat-model-picker.ts");
    assertClass(picker, "ChatModelPickerView");
    assert.match(picker, /id = 'model-picker'|id = \"model-picker\"/);
    assert.match(picker, /openModelPicker/);
    assert.match(chat, /App\.ChatViews\.openModelPicker\(e\)/);
    assert.doesNotMatch(chat, /fetch\('\/api\/models'\)|fetch\('\/api\/model\/switch'\)/);
  });

  it("keeps attachment file and drag-drop input in a dedicated component view", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    const attachments = source("src/frontend/chat/chat-attachment-input.ts");
    assertClass(attachments, "ChatAttachmentInputView");
    assert.match(attachments, /selectFile\(|handleDrop\(|dataTransfer/);
    assert.match(chat, /App\.ChatViews\.createAttachmentInput\(/);
    assert.doesNotMatch(chat, /electronAPI.*selectFile|dataTransfer/);
  });

  it("keeps event-node rendering and block reconciliation in a dedicated component view", () => {
    const chat = source("src/frontend/chat/chat-render.ts");
    const eventNode = source("src/frontend/chat/chat-event-node.ts");
    assertClass(eventNode, "ChatEventNodeView");
    for (const method of ["renderEventBlock", "renderBlocks", "renderBlockNode", "replaceBlockContents", "insertBlockNode"]) {
      assert.match(eventNode, new RegExp(`static\\s+${method}\\s*\\(`), `${method} should belong to ChatEventNodeView`);
    }
    assert.match(chat, /ChatEventNodeView\.renderBlocks\(/);
    assert.match(chat, /ChatEventNodeView\.replaceBlockContents\(/);
    assert.doesNotMatch(chat, /function\\s+renderTraceItem\\b/);
    assert.doesNotMatch(chat, /function\\s+renderEventBlock\\b/);
  });

  it("keeps chat rendering dependencies behind one module boundary", () => {
    const chat = source("src/frontend/chat/chat-render.ts");
    assert.match(chat, /type\s+ChatRenderDependencies\s*=\s*\{/);
    assert.match(chat, /chatState:\s*AppChatState/);
    assert.match(chat, /chatViews:\s*AppChatViews/);
    assert.doesNotMatch(chat, /\bApp\./);
  });

  it("keeps chat reading and jump-to-latest state in a dedicated component view", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    const reading = source("src/frontend/chat/chat-reading-controls.ts");
    assertClass(reading, "ChatReadingControlsView");
    for (const method of ["bind", "scrollToLatest", "refreshSettings", "reset", "dispose"]) {
      assert.match(reading, new RegExp(`${method}\\s*\\(`), `${method} should belong to ChatReadingControlsView`);
    }
    assert.match(chat, /createReadingControls\(/);
    assert.doesNotMatch(chat, /let\\s+chatLatest(?:Enabled|Smooth|Threshold|FollowLatest)\\b/);
    assert.doesNotMatch(chat, /function\\s+chatReadLatestSettings\\b/);
  });

  it("keeps SSE event routing in a dedicated controller view", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    const controller = source("src/frontend/chat/chat-sse-controller.ts");
    assertClass(controller, "ChatSseControllerView");
    for (const method of ["bind", "handleMessage", "handleError", "handleOpen"]) {
      assert.match(controller, new RegExp(`${method}\\s*\\(`), `${method} should belong to ChatSseControllerView`);
    }
    assert.match(chat, /createSseController\(/);
    assert.match(controller, /interface\s+ChatSseControllerDependencies\s*\{/);
    for (const dependency of ["chat", "chatState", "chatStream", "chatViews"]) {
      assert.match(controller, new RegExp(`${dependency}:\\s*AppChat`));
    }
    assert.doesNotMatch(controller, /\bApp\./);
    assert.doesNotMatch(chat, /onMessage:\s*\(e:\s*MessageEvent\)/);
    assert.doesNotMatch(chat, /JSON\.parse\(e\.data\)/);
  });

  it("localizes chat mode dependencies at the module boundary", () => {
    const mode = source("src/frontend/chat/chat-mode.ts");
    assert.match(mode, /interface\s+ChatModeDependencies\s*\{/);
    assert.match(mode, /preferences:\s*AppPreferences/);
    assert.match(mode, /permissions\?:\s*AppPermissions/);
    assert.doesNotMatch(mode, /\bApp\./);
  });

  it("loads the subagent component module after shared chat views and before chat rendering", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const sharedIndex = compiler.indexOf('"gen/chat/chat-component-views.js"');
    const subagentIndex = compiler.indexOf('"gen/chat/chat-subagent-views.js"');
    const renderIndex = compiler.indexOf('"gen/chat/chat-render.js"');
    assert.ok(sharedIndex >= 0 && subagentIndex > sharedIndex && renderIndex > subagentIndex);
  });

  it("loads chat command confirmation before dashboard chat", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const confirmationIndex = compiler.indexOf('"gen/chat/chat-command-confirmation.js"');
    const dashboardChatIndex = compiler.indexOf('"gen/dashboard/dashboard-chat.js"');
    assert.ok(confirmationIndex >= 0 && dashboardChatIndex > confirmationIndex);
  });

  it("loads the chat composer before dashboard chat", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const composerIndex = compiler.indexOf('"gen/chat/chat-composer.js"');
    const dashboardChatIndex = compiler.indexOf('"gen/dashboard/dashboard-chat.js"');
    assert.ok(composerIndex >= 0 && dashboardChatIndex > composerIndex);
  });

  it("loads the model picker before dashboard chat", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const pickerIndex = compiler.indexOf('"gen/chat/chat-model-picker.js"');
    const dashboardChatIndex = compiler.indexOf('"gen/dashboard/dashboard-chat.js"');
    assert.ok(pickerIndex >= 0 && dashboardChatIndex > pickerIndex);
  });

  it("loads attachment input before dashboard chat", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const attachmentIndex = compiler.indexOf('"gen/chat/chat-attachment-input.js"');
    const dashboardChatIndex = compiler.indexOf('"gen/dashboard/dashboard-chat.js"');
    assert.ok(attachmentIndex >= 0 && dashboardChatIndex > attachmentIndex);
  });

  it("loads event-node rendering after subagent views and before chat rendering", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const subagentIndex = compiler.indexOf('"gen/chat/chat-subagent-views.js"');
    const eventNodeIndex = compiler.indexOf('"gen/chat/chat-event-node.js"');
    const renderIndex = compiler.indexOf('"gen/chat/chat-render.js"');
    assert.ok(subagentIndex >= 0 && eventNodeIndex > subagentIndex && renderIndex > eventNodeIndex);
  });

  it("loads reading controls before dashboard chat", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const readingIndex = compiler.indexOf('"gen/chat/chat-reading-controls.js"');
    const dashboardChatIndex = compiler.indexOf('"gen/dashboard/dashboard-chat.js"');
    assert.ok(readingIndex >= 0 && dashboardChatIndex > readingIndex);
  });

  it("loads the SSE controller before dashboard chat", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const controllerIndex = compiler.indexOf('"gen/chat/chat-sse-controller.js"');
    const dashboardChatIndex = compiler.indexOf('"gen/dashboard/dashboard-chat.js"');
    assert.ok(controllerIndex >= 0 && dashboardChatIndex > controllerIndex);
  });

  it("loads the session list panel before dashboard sessions", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const panelIndex = compiler.indexOf('"gen/dashboard/session-list-panel.js"');
    const sessionsIndex = compiler.indexOf('"gen/dashboard/dashboard-sessions.js"');
    assert.ok(panelIndex >= 0 && sessionsIndex > panelIndex);
  });

  it("loads permissions views before the permissions controller", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const viewsIndex = compiler.indexOf('"gen/pane/permissions/permissions-views.js"');
    const controllerIndex = compiler.indexOf('"gen/pane/permissions/index.js"');
    assert.ok(viewsIndex >= 0 && controllerIndex > viewsIndex);
  });

  it("loads MCP views after MCP state and before the MCP controller", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const stateIndex = compiler.indexOf('"gen/pane/mcp/mcp-state.js"');
    const viewsIndex = compiler.indexOf('"gen/pane/mcp/mcp-views.js"');
    const controllerIndex = compiler.indexOf('"gen/pane/mcp/index.js"');
    assert.ok(stateIndex >= 0 && viewsIndex > stateIndex && controllerIndex > viewsIndex);
  });

  it("loads Explorer views before the Explorer controller", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const viewsIndex = compiler.indexOf('"gen/pane/explorer/explorer-views.js"');
    const controllerIndex = compiler.indexOf('"gen/pane/explorer/index.js"');
    assert.ok(viewsIndex >= 0 && controllerIndex > viewsIndex);
  });
});
