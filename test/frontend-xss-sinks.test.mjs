import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const FRONTEND_ROOT = resolve(process.cwd(), "src/frontend");
const SINK_PROPERTIES = new Set(["innerHTML", "outerHTML"]);
const SINK_CALLS = new Set(["insertAdjacentHTML"]);
const SINK_ASSIGNMENTS = new Map([
  [ts.SyntaxKind.EqualsToken, ""],
  [ts.SyntaxKind.PlusEqualsToken, "+="],
]);
const ALLOWED_CLASSIFICATIONS = new Set([
  "dom-reset",
  "escaped-template",
  "hardened-markdown",
  "static-markup",
  "trusted-renderer",
  "trusted-ui-primitive",
]);

const REVIEW = Object.freeze({
  clear: ["dom-reset", "Clears a controlled container or replaces it with a fixed empty state."],
  escaped: ["escaped-template", "Dynamic text is entity-escaped before entering the reviewed HTML template."],
  markdown: ["hardened-markdown", "Content passes through the hardened Markdown renderer and URL allowlist."],
  static: ["static-markup", "Markup and interpolated values are fixed application-owned UI literals."],
  renderer: ["trusted-renderer", "HTML comes from a reviewed renderer that escapes its external input fields."],
  primitive: ["trusted-ui-primitive", "HTML is an application-owned icon or constrained UI primitive, not external text."],
});

function approved(count, digest, [classification, reason]) {
  return { count, digest, classification, reason };
}

const APPROVED_SINKS = new Map([
  ["src/frontend/chat/chat-attachments.ts|renderAttachments|innerHTML|bar", approved(2, "4377ea26a75b", REVIEW.escaped)],
  ["src/frontend/chat/chat-component-views.ts|chatViewBindDelegatedActions|innerHTML|toggle", approved(1, "4e1f38b9b13e", REVIEW.primitive)],
  ["src/frontend/chat/chat-component-views.ts|chatViewElementFromHtml|innerHTML|template", approved(1, "e8007c14f740", REVIEW.renderer)],
  ["src/frontend/chat/chat-component-views.ts|syncDisclosure|innerHTML|toggle", approved(1, "50bf206492dc", REVIEW.primitive)],
  ["src/frontend/chat/chat-component-views.ts|update|innerHTML|total", approved(1, "5df02dfb7a10", REVIEW.static)],
  ["src/frontend/chat/chat-composer.ts|refresh|innerHTML|sendButton", approved(1, "48357cfd3546", REVIEW.primitive)],
  ["src/frontend/chat/chat-event-node.ts|chatEventNodeRenderNode|innerHTML|node", approved(1, "e5e239560bc1", REVIEW.renderer)],
  ["src/frontend/chat/chat-event-node.ts|chatEventNodeReplaceContents|innerHTML|target", approved(1, "e5e239560bc1", REVIEW.renderer)],
  ["src/frontend/chat/chat-mode.ts|mountThinkingControl|innerHTML|control", approved(1, "06c24c524da3", REVIEW.escaped)],
  ["src/frontend/chat/chat-mode.ts|showModePopup|innerHTML|popup", approved(1, "e5e239560bc1", REVIEW.renderer)],
  ["src/frontend/chat/chat-render.ts|appendDelta|innerHTML|cd", approved(1, "55611ee5694f", REVIEW.markdown)],
  ["src/frontend/chat/chat-render.ts|appendDelta|innerHTML|msgsEl", approved(1, "57ab068e4f07", REVIEW.renderer)],
  ["src/frontend/chat/chat-render.ts|finalizeLastMessage|innerHTML|contentElement", approved(3, "33a94ef512ee", REVIEW.markdown)],
  ["src/frontend/chat/chat-render.ts|finalizeLastMessage|innerHTML|textBody", approved(1, "81486ebbce39", REVIEW.markdown)],
  ["src/frontend/chat/chat-render.ts|finalizeLastMessage|innerHTML|textElement", approved(1, "81486ebbce39", REVIEW.markdown)],
  ["src/frontend/chat/chat-render.ts|finalizeLastMessage|insertAdjacentHTML|contentElement", approved(1, "e5e239560bc1", REVIEW.markdown)],
  ["src/frontend/chat/chat-render.ts|finalizeLastMessage|outerHTML|thinkingElement", approved(1, "e5e239560bc1", REVIEW.markdown)],
  ["src/frontend/chat/chat-render.ts|updateLastBlock|innerHTML|contentElement", approved(1, "6ad0a91196a7", REVIEW.renderer)],
  ["src/frontend/chat/chat-render.ts|updateLastBlock|innerHTML|textBody", approved(1, "81486ebbce39", REVIEW.markdown)],
  ["src/frontend/chat/chat-render.ts|updateLastBlock|innerHTML|textElement", approved(1, "81486ebbce39", REVIEW.markdown)],
  ["src/frontend/chat/chat-subagent-views.ts|chatSubagentElementFromHtml|innerHTML|template", approved(1, "e8007c14f740", REVIEW.renderer)],
  ["src/frontend/chat/chat-timeline.ts|render|innerHTML|host", approved(1, "d1a53a10b6b8", REVIEW.escaped)],
  ["src/frontend/chat/chat-token.ts|doCompact|innerHTML|msgsEl", approved(1, "30e4b2cf8e32", REVIEW.renderer)],
  ["src/frontend/chat/chat-token.ts|openCompactModal|innerHTML|overlay", approved(1, "3eb8f295e3a7", REVIEW.static)],
  ["src/frontend/chat/chat-token.ts|openUsagePanel|innerHTML|overlay", approved(1, "82f29cfd90cb", REVIEW.static)],
  ["src/frontend/chat/chat-token.ts|render|innerHTML|container", approved(4, "ebb2a44a7623", REVIEW.escaped)],
  ["src/frontend/chat/chat-token.ts|renderCurrentSessionUsage|innerHTML|container", approved(2, "96c1fcd75aca", REVIEW.escaped)],
  ["src/frontend/chat/chat-token.ts|renderSummaryUsage|innerHTML|container", approved(2, "c792918e9587", REVIEW.escaped)],
  ["src/frontend/dashboard/dashboard-chat.ts|_applyMsgsDiff|innerHTML|msgsEl", approved(2, "1687c4a84f98", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-chat.ts|_applyMsgsDiff|innerHTML|wrapper", approved(1, "2bf2cec0ee22", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-helpers.ts|activate|innerHTML|editorEl", approved(1, "6f49cdbd80e1", REVIEW.clear)],
  ["src/frontend/dashboard/dashboard-helpers.ts|clearActiveCommandConfirm|innerHTML|host", approved(1, "6f49cdbd80e1", REVIEW.clear)],
  ["src/frontend/dashboard/dashboard-helpers.ts|confirmAsync|innerHTML|overlay", approved(1, "449a55837dab", REVIEW.escaped)],
  ["src/frontend/dashboard/dashboard-helpers.ts|confirmCommandAsync|innerHTML|inlineHost", approved(1, "43c136d19681", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-helpers.ts|confirmCommandAsync|innerHTML|overlay", approved(1, "063ac7f19297", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-helpers.ts|confirmPermissionAsync|innerHTML|inlineHost", approved(1, "cc507bb21b34", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-helpers.ts|confirmPermissionAsync|innerHTML|overlay", approved(1, "a1605e9530be", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-layout.ts|_renderProblemsList|innerHTML|body", approved(2, "b1c9a9cc73f9", REVIEW.escaped)],
  ["src/frontend/dashboard/dashboard-layout.ts|_updateProblemsBar|innerHTML|counts", approved(1, "8eb3db397fb4", REVIEW.escaped)],
  ["src/frontend/dashboard/dashboard-layout.ts|layout|innerHTML|app", approved(1, "a9579fc07582", REVIEW.static)],
  ["src/frontend/dashboard/dashboard-layout.ts|layout|innerHTML|pc", approved(1, "6f49cdbd80e1", REVIEW.clear)],
  ["src/frontend/dashboard/dashboard-layout.ts|renderTabs|innerHTML|el", approved(1, "fc7c3fc3cb53", REVIEW.escaped)],
  ["src/frontend/dashboard/dashboard-menus.ts|toggleFileMenu|innerHTML|menu", approved(1, "6147bc58aa47", REVIEW.static)],
  ["src/frontend/dashboard/dashboard-sessions.ts|_sessionClose|innerHTML|msgsEl", approved(1, "30e4b2cf8e32", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-sessions.ts|_setupDraftSession|innerHTML|msgsEl", approved(1, "a11a739db5da", REVIEW.static)],
  ["src/frontend/dashboard/dashboard-sessions.ts|branchSession|innerHTML|msgsEl", approved(1, "30e4b2cf8e32", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-sessions.ts|closeSessionTab|innerHTML|msgsEl", approved(1, "30e4b2cf8e32", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-sessions.ts|deleteSession|innerHTML|cs", approved(1, "d7ae83e1f95b", REVIEW.primitive)],
  ["src/frontend/dashboard/dashboard-sessions.ts|deleteSession|innerHTML|msgsEl", approved(1, "30e4b2cf8e32", REVIEW.renderer)],
  ["src/frontend/dashboard/dashboard-sessions.ts|renameSession|innerHTML|nameEl", approved(1, "6f49cdbd80e1", REVIEW.clear)],
  ["src/frontend/dashboard/dashboard-settings.ts|openSettingsModal|innerHTML|overlay", approved(1, "0d1532c12e1d", REVIEW.static)],
  ["src/frontend/dashboard/dashboard-settings.ts|switchSettingsModal|innerHTML|sc", approved(2, "acd6957ac823", REVIEW.static)],
  ["src/frontend/dashboard/layout-panel.ts|renderPanel|innerHTML|pc", approved(2, "62e6e6d65bde", REVIEW.escaped)],
  ["src/frontend/dashboard/layout-shortcuts.ts|quickOpenFile|innerHTML|overlay", approved(1, "ad0a8b4a01fc", REVIEW.static)],
  ["src/frontend/dashboard/layout-shortcuts.ts|quickOpenFile|innerHTML|results", approved(5, "89255a92821f", REVIEW.escaped)],
  ["src/frontend/dashboard/layout-shortcuts.ts|showShortcutsHelp|innerHTML|overlay", approved(1, "746aee8bc5f4", REVIEW.static)],
  ["src/frontend/dashboard/layout-tabs.ts|_fileActivate|innerHTML|editorEl", approved(3, "9d41b34a4edb", REVIEW.primitive)],
  ["src/frontend/dashboard/layout-tabs.ts|renderFileTextFallback|innerHTML|editorEl", approved(1, "2fcb6340dce1", REVIEW.escaped)],
  ["src/frontend/dashboard/layout-tabs.ts|switchTab|innerHTML|editorEl", approved(1, "6f49cdbd80e1", REVIEW.clear)],
  ["src/frontend/dashboard/layout-tabs.ts|tabMoreMenu|innerHTML|item", approved(1, "b3e8c31cd0e3", REVIEW.escaped)],
  ["src/frontend/dashboard/session-activation.ts|activateFailReset|innerHTML|send", approved(1, "0bad4dec5642", REVIEW.primitive)],
  ["src/frontend/dashboard/session-activation.ts|renderMessages|innerHTML|messagesElement", approved(1, "3fda5ff999f0", REVIEW.renderer)],
  ["src/frontend/dashboard/session-list-panel.ts|load|innerHTML|list", approved(1, "4af39681ccf9", REVIEW.renderer)],
  ["src/frontend/dashboard/session-list-panel.ts|render|innerHTML|element", approved(2, "11946cdeaf2a", REVIEW.renderer)],
  ["src/frontend/dashboard/settings-custom-subagents.ts|load|innerHTML|list", approved(1, "f1a3f62d3955", REVIEW.static)],
  ["src/frontend/dashboard/settings-custom-subagents.ts|mount|insertAdjacentHTML|container", approved(1, "065fc11c73be", REVIEW.static)],
  ["src/frontend/dashboard/settings-custom-subagents.ts|render|innerHTML|editor", approved(2, "45e0805a7395", REVIEW.escaped)],
  ["src/frontend/dashboard/settings-custom-subagents.ts|render|innerHTML|list", approved(1, "e587b641983f", REVIEW.escaped)],
  ["src/frontend/dashboard/settings-general.ts|renderGeneralTab|innerHTML|container", approved(1, "ddb6c319c780", REVIEW.static)],
  ["src/frontend/dashboard/settings-general.ts|renderSubagentLimits|innerHTML|container", approved(1, "106ecbc73847", REVIEW.static)],
  ["src/frontend/dashboard/settings-provider-model.ts|renderTab|innerHTML|container", approved(1, "47d706d3044f", REVIEW.static)],
  ["src/frontend/dashboard/settings-storage.ts|mount|insertAdjacentHTML|container", approved(1, "7dbaa78485c6", REVIEW.static)],
  ["src/frontend/pane/chat/index.ts|chatPaneRender|innerHTML|container", approved(1, "772eb1f8e30d", REVIEW.static)],
  ["src/frontend/pane/chat/index.ts|chatPaneRender|innerHTML|list", approved(1, "2efb387f77d0", REVIEW.static)],
  ["src/frontend/pane/chat/index.ts|doConvSearch|innerHTML|list", approved(2, "269b7740a622", REVIEW.escaped)],
  ["src/frontend/pane/chat/index.ts|renderConvResults|innerHTML|list", approved(2, "599d6c9009ec", REVIEW.escaped)],
  ["src/frontend/pane/explorer/explorer-views.ts|show|innerHTML|item", approved(1, "83122a0a0032", REVIEW.primitive)],
  ["src/frontend/pane/explorer/index.ts|explorerRender|innerHTML|container", approved(2, "e27766353b01", REVIEW.renderer)],
  ["src/frontend/pane/explorer/index.ts|initTree|innerHTML+=|container", approved(3, "e0f22a654d33", REVIEW.static)],
  ["src/frontend/pane/git/index.ts|gitPaneRender|innerHTML|container", approved(1, "ab0070f7c191", REVIEW.renderer)],
  ["src/frontend/pane/git/index.ts|renderGit|innerHTML|container", approved(1, "a0f534bb8b33", REVIEW.renderer)],
  ["src/frontend/pane/mcp/index.ts|fetchMcpServers|innerHTML|content", approved(2, "495a414edef2", REVIEW.escaped)],
  ["src/frontend/pane/mcp/index.ts|mcpPaneRender|innerHTML|container", approved(1, "f0b3e51caad8", REVIEW.renderer)],
  ["src/frontend/pane/mcp/index.ts|renderExploreTab|innerHTML|container", approved(3, "1a52e6cd2596", REVIEW.renderer)],
  ["src/frontend/pane/mcp/index.ts|switchMcpTab|innerHTML|content", approved(1, "5dbb519c6ed8", REVIEW.static)],
  ["src/frontend/pane/permissions/index.ts|confirmYesMode|innerHTML|overlay", approved(1, "7f6253141631", REVIEW.static)],
  ["src/frontend/pane/permissions/index.ts|mountPermissionsPanel|innerHTML|root", approved(1, "70a7ff30c8a4", REVIEW.renderer)],
  ["src/frontend/pane/permissions/index.ts|refreshPermissionsPanel|innerHTML|content", approved(1, "fa24d176e7c0", REVIEW.renderer)],
  ["src/frontend/pane/permissions/index.ts|syncPermissionsPanel|innerHTML|content", approved(1, "582046a78775", REVIEW.renderer)],
  ["src/frontend/pane/search/index.ts|clearReplaceUI|innerHTML|prevEl", approved(1, "12ae32cb1ec0", REVIEW.clear)],
  ["src/frontend/pane/search/index.ts|doReplaceAll|innerHTML|arrowEl", approved(1, "36677a6d0bbc", REVIEW.static)],
  ["src/frontend/pane/search/index.ts|doReplaceAll|innerHTML|prevEl", approved(1, "12ae32cb1ec0", REVIEW.clear)],
  ["src/frontend/pane/search/index.ts|doReplacePreview|innerHTML|previewContainer", approved(2, "e7020142994c", REVIEW.escaped)],
  ["src/frontend/pane/search/index.ts|doSearch|innerHTML|list", approved(1, "c3db2817abde", REVIEW.escaped)],
  ["src/frontend/pane/search/index.ts|renderReplacePreview|innerHTML|previewContainer", approved(1, "bf43fb8f32f1", REVIEW.renderer)],
  ["src/frontend/pane/search/index.ts|renderResults|innerHTML|list", approved(1, "13b3d37e6276", REVIEW.renderer)],
  ["src/frontend/pane/search/index.ts|searchPaneRender|innerHTML|container", approved(1, "6922d951cffa", REVIEW.renderer)],
  ["src/frontend/pane/search/index.ts|toggleReplaceSection|innerHTML|arrow", approved(1, "c1b2e53f77fb", REVIEW.static)],
  ["src/frontend/service/explorer-service.ts|selectWorkspace|innerHTML|ov", approved(1, "012a826d31a4", REVIEW.escaped)],
  ["src/frontend/services/file-diff-render.ts|createRoot|innerHTML|template", approved(1, "8af4a31c3bd8", REVIEW.renderer)],
  ["src/frontend/ui/tree-render.ts|T.prototype.buildRow|innerHTML|row", approved(1, "3cdb78076b6c", REVIEW.escaped)],
  ["src/frontend/ui/tree-render.ts|T.prototype.render|innerHTML|this.el", approved(1, "6f49cdbd80e1", REVIEW.clear)],
  ["src/frontend/ui/tree.ts|inlineRename|innerHTML|nameEl", approved(1, "6f49cdbd80e1", REVIEW.clear)],
]);

function frontendTypeScriptFiles(directory = FRONTEND_ROOT) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "gen") return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return frontendTypeScriptFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function containingOwner(node, sourceFile) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if (ts.isMethodDeclaration(current) && current.name) return current.name.getText(sourceFile);
    if (!ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) continue;
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent)) return parent.name.getText(sourceFile);
    if (ts.isBinaryExpression(parent)) return parent.left.getText(sourceFile);
    if (ts.isPropertyAssignment(parent)) return parent.name.getText(sourceFile);
  }
  return "<top-level>";
}

function sinkIdentity(file, node, kind, target, sourceFile) {
  const normalizedFile = relative(process.cwd(), file).replaceAll("\\", "/");
  return [normalizedFile, containingOwner(node, sourceFile), kind, target].join("|");
}

function sourceDigest(sources) {
  const normalized = sources.map((source) => source.replace(/\s+/g, " ").trim()).sort().join("\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function collectHtmlSinks() {
  const sinks = new Map();
  const add = (identity, source) => {
    const current = sinks.get(identity) || [];
    current.push(source);
    sinks.set(identity, current);
  };

  for (const file of frontendTypeScriptFiles()) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (node) => {
      if (
        ts.isBinaryExpression(node)
        && SINK_ASSIGNMENTS.has(node.operatorToken.kind)
        && ts.isPropertyAccessExpression(node.left)
        && SINK_PROPERTIES.has(node.left.name.text)
      ) {
        const operatorSuffix = SINK_ASSIGNMENTS.get(node.operatorToken.kind);
        add(
          sinkIdentity(file, node, `${node.left.name.text}${operatorSuffix}`, node.left.expression.getText(sourceFile), sourceFile),
          node.right.getText(sourceFile),
        );
      }
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && SINK_CALLS.has(node.expression.name.text)
      ) {
        add(
          sinkIdentity(file, node, node.expression.name.text, node.expression.expression.getText(sourceFile), sourceFile),
          node.arguments[1]?.getText(sourceFile) || "<missing-html-argument>",
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return new Map([...sinks].map(([identity, sources]) => [identity, {
    count: sources.length,
    digest: sourceDigest(sources),
  }]));
}

describe("frontend HTML sink boundary", () => {
  it("renders ListAddAction labels through textContent instead of an HTML sink", () => {
    const source = readFileSync(resolve(FRONTEND_ROOT, "ui/list-add-action.ts"), "utf8");

    assert.match(source, /label\.textContent\s*=\s*options\.label/);
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
  });

  it("keeps the custom provider editor on DOM APIs with no direct HTML sinks", () => {
    const source = readFileSync(resolve(FRONTEND_ROOT, "dashboard/settings-custom-provider-editor.ts"), "utf8");

    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    assert.match(source, /\.textContent\s*=/);
    assert.match(source, /\.value\s*=/);
  });

  it("requires every direct HTML sink to remain in the reviewed structural baseline", () => {
    const actual = [...collectHtmlSinks()].sort(([left], [right]) => left.localeCompare(right));
    const expected = [...APPROVED_SINKS].map(([identity, approval]) => [identity, {
      count: approval.count,
      digest: approval.digest,
    }])
      .sort(([left], [right]) => left.localeCompare(right));

    assert.deepEqual(
      actual,
      expected,
      "A direct HTML sink changed. Review its trust boundary, add a malicious-payload test when it accepts external data, then update APPROVED_SINKS.",
    );
  });

  it("documents why every approved sink may receive HTML", () => {
    for (const [identity, approval] of APPROVED_SINKS) {
      assert.ok(ALLOWED_CLASSIFICATIONS.has(approval.classification), `${identity} has an unknown classification`);
      assert.ok(approval.reason.length >= 12, `${identity} needs a specific review reason`);
    }
  });
});
