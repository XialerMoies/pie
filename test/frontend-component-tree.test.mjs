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
});
