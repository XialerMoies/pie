import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

function source(file) {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

function stringArrayInitializer(src, variableName) {
  const sourceFile = ts.createSourceFile("source.mjs", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== variableName) continue;
      assert.ok(ts.isArrayLiteralExpression(declaration.initializer), `${variableName} must be an array literal`);
      return declaration.initializer.elements.map((element) => {
        assert.ok(ts.isStringLiteral(element), `${variableName} entries must be string literals`);
        return element.text;
      });
    }
  }
  assert.fail(`${variableName} array should exist`);
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
  it("keeps custom-provider form DOM and validation in a dedicated view", () => {
    const form = source("src/frontend/dashboard/settings-custom-provider-form.ts");
    const editor = source("src/frontend/dashboard/settings-custom-provider-editor.ts");
    assertClass(form, "CustomProviderFormView");
    assert.doesNotMatch(form, /\bApp\./);
    assert.doesNotMatch(form, /\bfetch\s*\(/);
    assert.match(editor, /formType/);
    assert.doesNotMatch(editor, /createModelRow|createHeaderRow|readDraft\s*\(/);
  });

  it("loads the custom-provider form before its editor and provider controller", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const bundleOrder = stringArrayInitializer(compiler, "bundleOrder");
    const formIndex = bundleOrder.indexOf("gen/dashboard/settings-custom-provider-form.js");
    const editorIndex = bundleOrder.indexOf("gen/dashboard/settings-custom-provider-editor.js");
    const providerIndex = bundleOrder.indexOf("gen/dashboard/settings-provider-model.js");
    assert.ok(formIndex >= 0 && formIndex < editorIndex && editorIndex < providerIndex);
  });

  it("shares the DOM-backed ListAddAction across chat and subagent consumers", () => {
    const action = source("src/frontend/ui/list-add-action.ts");
    const chat = source("src/frontend/pane/chat/index.ts");
    const subagents = source("src/frontend/dashboard/settings-custom-subagents.ts");
    const styles = source("src/frontend/dashboard.css");

    assertClass(action, "ListAddAction");
    assert.match(action, /export\s+class\s+ListAddAction/);
    assert.match(action, /\.Ui\.ListAddAction\s*=\s*ListAddAction/);
    assert.match(chat, /ListAddAction\.create\(\{/);
    assert.match(chat, /id:\s*["']ch-new-btn["']/);
    assert.match(chat, /label:\s*["']开启新对话["']/);
    assert.match(subagents, /ListAddAction\.create\(\{/);
    assert.match(subagents, /label:\s*["']新建 Agent["']/);
    assert.doesNotMatch(chat, /class=["'][^"']*\bch-new(?:-icon)?\b/);
    assert.doesNotMatch(subagents, /sa-add-btn/);
    assert.doesNotMatch(styles, /\.ch-new(?:-icon)?|\.sa-add-btn/);
  });

  it("loads ListAddAction before chat, subagent, and settings consumers", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const bundleOrder = stringArrayInitializer(compiler, "bundleOrder");
    const actionIndex = bundleOrder.indexOf("gen/ui/list-add-action.js");
    assert.ok(actionIndex >= 0, "ListAddAction must be included in the dashboard bundle");
    for (const consumer of [
      "gen/pane/chat/index.js",
      "gen/dashboard/settings-custom-subagents.js",
      "gen/dashboard/dashboard-settings.js",
    ]) {
      const consumerIndex = bundleOrder.indexOf(consumer);
      assert.ok(consumerIndex > actionIndex, `${consumer} must load after ListAddAction`);
    }
  });

  it("keeps low-reference frontend modules free of direct App access", () => {
    const files = [
      "src/frontend/ui/tree.ts",
      "src/frontend/editor/monaco-tsserver.ts",
      "src/frontend/chat/chat-component-views.ts",
      "src/frontend/services/chat-runtime-store.ts",
      "src/frontend/chat/chat-model-picker.ts",
      "src/frontend/services/app-events.ts",
      "src/frontend/services/tab-store.ts",
      "src/frontend/dashboard/dashboard-menus.ts",
      "src/frontend/dashboard/session-list-panel.ts",
      "src/frontend/chat/chat-timeline.ts",
      "src/frontend/pane/mcp/mcp-views.ts",
      "src/frontend/pane/permissions/index.ts",
      "src/frontend/chat/chat-event-node.ts",
      "src/frontend/dashboard/layout-panel.ts",
      "src/frontend/pane/mcp/index.ts",
      "src/frontend/pane/explorer/index.ts",
      "src/frontend/chat/chat-attachment-input.ts",
      "src/frontend/pane/search/index.ts",
      "src/frontend/service/explorer-service.ts",
      "src/frontend/pane/git/index.ts",
    ];
    for (const file of files) {
      assert.doesNotMatch(source(file), /\bApp(?:\.|\s+as\s+any)/, `${file} must localize App dependencies at its boundary`);
    }
  });

  it("localizes dashboard chat dependencies and keeps late registrations lazy", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    assert.match(chat, /interface\s+DashboardChatDependencies\s*\{/);
    for (const dependency of [
      "chat: AppChat",
      "chatState: AppChatState",
      "chatStream: AppChatStream",
      "chatViews: AppChatViews",
      "tabs: AppTabs",
      "state: AppStateFacade",
      "session: AppSession",
    ]) {
      assert.match(chat, new RegExp(dependency));
    }
    assert.match(chat, /getSessionTabs:\s*\(\)\s*=>\s*AppSessionTabs/);
    assert.match(chat, /getSessionRestore:\s*\(\)\s*=>\s*AppSessionRestore/);
    assert.match(chat, /getGit:\s*\(\)\s*=>\s*AppGit\s*\|\s*undefined/);
    assert.doesNotMatch(chat, /\bApp(?:\.|\s+as\s+any)/);
  });

  it("uses component views for token usage modal panes", () => {
    const src = source("src/frontend/chat/chat-token.ts");
    for (const name of ["UsageModalView", "UsageCurrentView", "UsageSummaryView"]) assertClass(src, name);
    assertDelegates(src, "renderCurrentSessionUsage", "UsageCurrentView");
    assertDelegates(src, "renderSummaryUsage", "UsageSummaryView");
    assert.match(src, /interface\s+ChatTokenDependencies\s*\{/);
    for (const dependency of ["tabs: AppTabs", "events: AppEvents", "state: AppStateFacade", "chat?: AppChat", "chatState: AppChatState"]) {
      assert.match(src, new RegExp(dependency.replace("?", "\\?")));
    }
    for (const alias of ["tabs: tokenTabs", "events: tokenEvents", "state: tokenState", "chat: tokenChat", "chatState: tokenChatState"]) {
      assert.match(src, new RegExp(alias));
    }
    assert.doesNotMatch(src, /\bApp\./);
  });

  it("keeps settings responsibilities in dedicated component owners", () => {
    const shell = source("src/frontend/dashboard/dashboard-settings.ts");
    const general = source("src/frontend/dashboard/settings-general.ts");
    const customProviderEditor = source("src/frontend/dashboard/settings-custom-provider-editor.ts");
    const providers = source("src/frontend/dashboard/settings-provider-model.ts");
    const subagents = source("src/frontend/dashboard/settings-custom-subagents.ts");
    const storage = source("src/frontend/dashboard/settings-storage.ts");

    assertClass(general, "SettingsGeneralController");
    assertClass(customProviderEditor, "SettingsCustomProviderEditor");
    assertClass(providers, "SettingsProviderModelController");
    assertClass(subagents, "SettingsCustomSubagentController");
    assertClass(storage, "SettingsStorageController");

    assert.match(customProviderEditor, /interface\s+SettingsCustomProviderEditorDependencies\s*\{/);
    for (const dependency of ["notify: typeof toast", "listAddAction: typeof ListAddAction", "onSaved(snapshot", "onDeleted(snapshot"]) {
      assert.ok(customProviderEditor.includes(dependency), `custom provider editor must declare ${dependency}`);
    }
    assert.match(providers, /customEditor:\s*SettingsCustomProviderEditor/);
    for (const owner of [general, customProviderEditor, providers, subagents, storage]) {
      assert.doesNotMatch(owner, /\bApp\./, "settings owners must localize App dependencies at their boundary");
    }
    assert.match(shell, /settingsComponents\.providers\.renderTab\(sc\)/);
    assert.match(shell, /settingsComponents\.general\.renderGeneralTab\(sc\)/);
    assert.match(shell, /settingsComponents\.general\.renderSubagentLimits\(sc\)/);
    assert.match(shell, /settingsComponents\.subagents\.mount\(sc\)/);
    assert.match(shell, /settingsComponents\.storage\.mount\(sc\)/);
    assert.doesNotMatch(shell, /class\s+(?:SettingsGeneralController|SettingsCustomProviderEditor|SettingsProviderModelController|SettingsCustomSubagentController|SettingsStorageController)\b/);
    assert.doesNotMatch(shell, /\/api\/(?:auth|models|model\/switch|subagents|storage-location|storage-migration)/);
    assert.doesNotMatch(shell, /let\s+(?:_selectedProvider|_provKeys|_customSubagents|_storageMigrationPreviewId|_dragIdx)\b/);
    assert.ok(shell.split(/\r?\n/).length <= 400, "dashboard-settings.ts must remain a thin modal and event facade");
  });

  it("keeps provider settings rendering in DOM-only component views", () => {
    const views = source("src/frontend/dashboard/settings-provider-views.ts");
    for (const name of ["ProviderIdentityView", "ProviderCardListView", "ProviderPickerView", "OfficialProviderEditorView"]) {
      assertClass(views, name);
    }
    assert.doesNotMatch(views, /\bApp\./);
    assert.doesNotMatch(views, /\bfetch\s*\(/);
    assert.doesNotMatch(views, /\.innerHTML\s*=/);
  });

  it("loads settings component owners before the settings facade", () => {
    const compiler = source("scripts/compile-frontend-ts.mjs");
    const facadeIndex = compiler.indexOf('"gen/dashboard/dashboard-settings.js"');
    for (const entry of [
      "settings-general",
      "settings-custom-provider-editor",
      "settings-provider-model",
      "settings-custom-subagents",
      "settings-storage",
    ]) {
      const ownerIndex = compiler.indexOf(`"gen/dashboard/${entry}.js"`);
      assert.ok(ownerIndex >= 0, `${entry} must be included in the dashboard bundle`);
      assert.ok(ownerIndex < facadeIndex, `${entry} must load before dashboard-settings`);
    }
    const actionIndex = compiler.indexOf('"gen/ui/list-add-action.js"');
    const utilsIndex = compiler.indexOf('"gen/dashboard/settings-provider-utils.js"');
    const viewsIndex = compiler.indexOf('"gen/dashboard/settings-provider-views.js"');
    const editorIndex = compiler.indexOf('"gen/dashboard/settings-custom-provider-editor.js"');
    const providerIndex = compiler.indexOf('"gen/dashboard/settings-provider-model.js"');
    assert.ok(
      actionIndex < utilsIndex && utilsIndex < viewsIndex && viewsIndex < editorIndex && editorIndex < providerIndex,
      "provider views must load after shared UI dependencies and before settings owners",
    );
  });

  it("keeps provider settings responsive above the Electron minimum window width", () => {
    const css = source("src/frontend/dashboard.css");
    const electronMain = source("src/electron/electron-main.ts");
    const narrowMatch = css.match(/@media\s*\(max-width:\s*(\d+)px\)\s*\{\s*\.model-split([\s\S]*?)\n\}/);
    const narrowBreakpoint = Number(narrowMatch?.[1] ?? 0);
    const minimumWindowWidth = Number(electronMain.match(/minWidth:\s*(\d+)/)?.[1] ?? 0);
    const narrow = narrowMatch?.[2] ?? "";

    assert.ok(narrow, "provider settings need a dedicated narrow breakpoint");
    assert.ok(minimumWindowWidth > 0, "Electron BrowserWindow.minWidth must remain explicit");
    assert.ok(narrowBreakpoint > minimumWindowWidth, "narrow breakpoint must remain reachable above BrowserWindow.minWidth");
    assert.match(`.model-split${narrow}`, /\.model-split\s*\{[^}]*flex-direction:\s*column/);
    assert.match(narrow, /\.ms-left\s*\{[^}]*width:\s*100%/);
    assert.match(narrow, /\.ms-right\s*\{[^}]*min-width:\s*0/);
    assert.match(narrow, /\.cpe-actions\s*\{[^}]*flex-wrap:\s*wrap/);
    assert.match(narrow, /\.cpe-(?:inline-row|header-row|model-main)[^\{]*\{[^}]*min-width:\s*0/);
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
    assert.match(controller, /interface\s+PermissionsPaneDependencies\s*\{/);
    assert.match(controller, /views:\s*AppPermissionViews/);
    assert.match(controller, /permissionsPaneViews\.renderPanel\(/);
    assert.match(controller, /permissionsPaneViews\.renderContent\(/);
    assert.doesNotMatch(controller, /class\s+(?:PermissionsPanelView|PermissionAuditView|PermissionRulesView|WorkingDirectoriesView)\b/);
  });

  it("keeps MCP rendering in dedicated component views", () => {
    const controller = source("src/frontend/pane/mcp/index.ts");
    const views = source("src/frontend/pane/mcp/mcp-views.ts");
    for (const name of ["McpPanelView", "McpServerListView", "McpCatalogView", "McpCustomInstallView"]) assertClass(views, name);
    assert.match(controller, /interface\s+McpPaneDependencies\s*\{/);
    assert.match(controller, /events:\s*AppEvents/);
    assert.match(controller, /views:\s*AppMcpViews/);
    assert.match(controller, /mcpPaneViews\.renderPanel\(/);
    assert.match(controller, /mcpPaneViews\.renderServers\(/);
    assert.match(controller, /mcpPaneViews\.renderCatalog\(/);
    assert.doesNotMatch(controller, /class\s+(?:McpPanelView|McpServerListView|McpCatalogView|McpCustomInstallView)\b/);
  });

  it("keeps Explorer shell and filter menu in dedicated component views", () => {
    const controller = source("src/frontend/pane/explorer/index.ts");
    const views = source("src/frontend/pane/explorer/explorer-views.ts");
    for (const name of ["ExplorerPanelView", "ExplorerEmptyView", "ExplorerFilterMenuView"]) assertClass(views, name);
    assert.match(controller, /interface\s+ExplorerPaneDependencies\s*\{/);
    assert.match(controller, /views:\s*AppExplorerViews/);
    assert.match(controller, /tabs:\s*AppTabs/);
    assert.match(controller, /explorerPaneViews\.renderEmpty\(/);
    assert.match(controller, /explorerPaneViews\.renderPanel\(/);
    assert.match(controller, /explorerPaneViews\.showFilterMenu\(/);
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
    assert.match(chat, /dashboardChatViews\.createComposer\(/);
    assert.match(chat, /chatComposerView\?\.refresh\(\)/);
    assert.doesNotMatch(chat, /function\s+sendOrStop\b|let\s+chatNoteMode\b/);
  });

  it("keeps model picker rendering and lifecycle in a dedicated component view", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    const picker = source("src/frontend/chat/chat-model-picker.ts");
    assertClass(picker, "ChatModelPickerView");
    assert.match(picker, /id = 'model-picker'|id = \"model-picker\"/);
    assert.match(picker, /openModelPicker/);
    assert.match(chat, /dashboardChatViews\.openModelPicker\(e\)/);
    assert.doesNotMatch(chat, /fetch\('\/api\/models'\)|fetch\('\/api\/model\/switch'\)/);
  });

  it("keeps attachment file and drag-drop input in a dedicated component view", () => {
    const chat = source("src/frontend/dashboard/dashboard-chat.ts");
    const attachments = source("src/frontend/chat/chat-attachment-input.ts");
    assertClass(attachments, "ChatAttachmentInputView");
    assert.match(attachments, /interface\s+ChatAttachmentInputDependencies\s*\{/);
    assert.match(attachments, /chat\?:\s*AppChat/);
    assert.match(attachments, /attachmentInputChat\?\.addAttachment\?\./);
    assert.match(attachments, /selectFile\(|handleDrop\(|dataTransfer/);
    assert.match(chat, /dashboardChatViews\.createAttachmentInput\(/);
    assert.doesNotMatch(chat, /electronAPI.*selectFile|dataTransfer/);
  });

  it("keeps event-node rendering and block reconciliation in a dedicated component view", () => {
    const chat = source("src/frontend/chat/chat-render.ts");
    const eventNode = source("src/frontend/chat/chat-event-node.ts");
    assertClass(eventNode, "ChatEventNodeView");
    assert.match(eventNode, /interface\s+ChatEventNodeDependencies\s*\{/);
    assert.match(eventNode, /chatViews:\s*AppChatViews/);
    assert.match(eventNode, /fileDiff:\s*AppFileDiff/);
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
