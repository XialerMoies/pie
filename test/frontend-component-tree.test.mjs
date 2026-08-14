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
    for (const name of ["SessionEmptyStateView", "SessionActionsView", "SessionCardView", "SessionGroupView"]) assertClass(src, name);
    assertDelegates(src, "renderSessionCard", "SessionCardView");
    assertDelegates(src, "renderSessionGroup", "SessionGroupView");
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
    for (const name of ["ChatCommandConfirmationView"]) assertClass(confirmation, name);
    assert.match(confirmation, /static async handle\(/);
    assert.match(chat, /ChatCommandConfirmationView\.handle\(d\)/);
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
});
