import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

function frontendTypeScriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "gen" ? [] : frontendTypeScriptFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

describe("dashboard DOM event ownership", () => {
  it("binds dynamic dashboard controls through event listeners", () => {
    for (const file of [
      "src/frontend/dashboard/layout-tabs.ts",
      "src/frontend/dashboard/layout-panel.ts",
      "src/frontend/dashboard/dashboard-layout.ts",
      "src/frontend/dashboard/dashboard-chat.ts",
      "src/frontend/dashboard/dashboard-sessions.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      assert.doesNotMatch(
        source,
        /\.on[a-z]+\s*=/,
        `${file} must not assign DOM event-handler properties`,
      );
    }
  });
});

describe("frontend state ownership", () => {
  it("keeps legacy window state and tab projections out of production TypeScript", () => {
    const root = resolve(process.cwd(), "src/frontend");
    for (const file of frontendTypeScriptFiles(root)) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /(?:window|\(window as any\))\.__(?:state|tabs)\b/, `${file} must use an App facade`);
    }
  });

  it("reads the active session directly from the TabStore facade", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-sessions.ts"), "utf8");
    assert.doesNotMatch(source, /_getActiveSessionTabIdDepth/);
    assert.doesNotMatch(source, /function getActiveSessionTabId\s*\(/);
    assert.doesNotMatch(source, /(?<![\w.])getActiveSessionTabId\(\)/);
    assert.match(source, /App\.Tabs\.getActiveSessionTabId\(\)/);
  });

  it("owns startup restoration outside dashboard-sessions", () => {
    const sessions = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-sessions.ts"), "utf8");
    const layout = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-layout.ts"), "utf8");
    const compiler = readFileSync(resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"), "utf8");

    assert.doesNotMatch(sessions, /function restoreSessionTabsImpl\s*\(/);
    assert.doesNotMatch(sessions, /hasUserInteractedWithTabs/);
    assert.doesNotMatch(sessions, /_markUserTabInteraction/);
    assert.doesNotMatch(layout, /hasUserInteractedWithTabs/);
    assert.match(sessions, /App\.SessionRestore\.init\s*\(/);
    assert.match(layout, /App\.SessionRestore\.hasUserInteracted\s*\(\)/);

    const restoreIndex = compiler.indexOf('"gen/dashboard/session-restore.js"');
    const sessionsIndex = compiler.indexOf('"gen/dashboard/dashboard-sessions.js"');
    assert.notStrictEqual(restoreIndex, -1, "session restore must be included in the dashboard bundle");
    assert.ok(restoreIndex < sessionsIndex, "session restore must load before dashboard sessions");
  });

  it("owns message activation outside dashboard-sessions", () => {
    const sessions = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-sessions.ts"), "utf8");
    const activation = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/session-activation.ts"), "utf8");
    const compiler = readFileSync(resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"), "utf8");

    assert.doesNotMatch(sessions, /function _sessionActivate\s*\(/);
    assert.doesNotMatch(sessions, /function _applySessionMessages\s*\(/);
    assert.doesNotMatch(sessions, /let _sessionActivationSeq\b/);
    assert.match(sessions, /App\.SessionActivation\.init\s*\(/);
    assert.match(activation, /let sessionActivationSeq\s*=\s*0/);
    assert.match(activation, /if \(seq !== sessionActivationSeq\) return/);

    const restoreIndex = compiler.indexOf('"gen/dashboard/session-restore.js"');
    const activationIndex = compiler.indexOf('"gen/dashboard/session-activation.js"');
    const sessionsIndex = compiler.indexOf('"gen/dashboard/dashboard-sessions.js"');
    assert.ok(restoreIndex < activationIndex, "session restore must load before activation");
    assert.ok(activationIndex < sessionsIndex, "session activation must load before dashboard sessions");
  });
});

describe("non-Markdown HTML boundaries", () => {
  it("escapes server session ids before placing them in data attributes", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-sessions.ts"), "utf8");
    assert.doesNotMatch(source, /data-session-id="\$\{session\.id\}"/);
    assert.match(source, /data-session-id="\$\{E\(session\.id\)\}"/);
  });

  it("normalizes server match positions and usage counts before HTML interpolation", () => {
    const conversations = readFileSync(resolve(process.cwd(), "src/frontend/pane/chat/index.ts"), "utf8");
    const usage = readFileSync(resolve(process.cwd(), "src/frontend/chat/chat-token.ts"), "utf8");
    assert.match(conversations, /function normalizeMatchIndex\(/);
    assert.doesNotMatch(conversations, /data-msg-index="\$\{m\.msgIndex/);
    assert.doesNotMatch(conversations, /data-match-ordinal="\$\{m\.matchOrdinal/);
    assert.doesNotMatch(usage, />\$\{d\.compactCount\}</);
    assert.doesNotMatch(usage, />\$\{s\.sessions\}</);
  });
});
