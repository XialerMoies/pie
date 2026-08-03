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
