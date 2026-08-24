import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createContext, Script } from "node:vm";
import { transform } from "esbuild";
import { buildTestManifest } from "../scripts/test-manifest.mjs";

function frontendTypeScriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "gen" ? [] : frontendTypeScriptFiles(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function relativeFrontendPath(file) {
  return file.slice(resolve(process.cwd(), "src/frontend").length + 1).replaceAll("\\", "/");
}

function createLocalStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem(key) { return values.get(String(key)) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(String(key)); },
    setItem(key, value) { values.set(String(key), String(value)); },
  };
}

describe("dashboard bundle global ownership", () => {
  it("keeps UI-state and preference hydration independent in the production scope", async () => {
    const root = resolve(process.cwd(), "src/frontend/services");
    const source = (await Promise.all(["ui-state-store.ts", "preferences.ts"].map(async (file) => {
      const compiled = await transform(readFileSync(resolve(root, file), "utf8"), { loader: "ts", minify: false });
      return compiled.code.replace(/^export\s+/gm, "");
    }))).join("\n");
    const expectedState = {
      schemaVersion: 2,
      workspacePath: "E:\\workspace",
      activeView: { type: "chat" },
      tabs: { sessions: ["session-1"], files: [], chatOpen: true, labels: {}, titleSources: {}, items: [], activeId: "session-1" },
      panel: { active: "explorer", closed: false, width: 260 },
      recent: { sessions: {} },
    };
    const localStorage = createLocalStorage();
    const context = createContext({
      AbortController,
      Response,
      clearTimeout,
      console,
      fetch: async (url) => new Response(JSON.stringify(
        url === "/api/ui-state" ? expectedState : { preferences: {} },
      ), { status: 200, headers: { "Content-Type": "application/json" } }),
      localStorage,
      setTimeout,
      window: { App: {} },
    });

    new Script(source).runInContext(context);

    assert.notStrictEqual(context.window.App.State.hydrate, context.window.App.Preferences.hydrate);
    const restored = await context.window.App.State.hydrate();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(restored.tabs)), expectedState.tabs);
  });

  it("checks duplicate top-level functions before writing the dashboard bundle", () => {
    const compiler = readFileSync(resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"), "utf8");
    assert.match(compiler, /assertUniqueTopLevelFunctionDeclarations\(parts, bundleFiles\)/);
    assert.match(compiler, /isFunctionDeclaration/);
  });
});

describe("obsolete frontend compatibility hooks", () => {
  it("does not retain no-op focus or initialization hooks", () => {
    const sessions = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-sessions.ts"), "utf8");
    const activation = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/session-activation.ts"), "utf8");
    const tabStore = readFileSync(resolve(process.cwd(), "src/frontend/services/tab-store.ts"), "utf8");

    assert.doesNotMatch(sessions, /\bfocusChatView\b/);
    assert.doesNotMatch(activation, /\bfocusChatView\b/);
    assert.doesNotMatch(tabStore, /\b_ensureInit\b/);
  });
});

describe("application event stream ownership", () => {
  it("has exactly one /api/events EventSource owner", () => {
    const root = resolve(process.cwd(), "src/frontend");
    const owners = [];
    for (const file of frontendTypeScriptFiles(root)) {
      const source = readFileSync(file, "utf8");
      const count = (source.match(/new\s+EventSource\s*\(\s*["']\/api\/events["']\s*\)/g) || []).length;
      for (let index = 0; index < count; index += 1) owners.push(relativeFrontendPath(file));
    }

    assert.deepStrictEqual(owners, ["services/app-events.ts"]);
    const explorer = readFileSync(resolve(root, "service/explorer-service.ts"), "utf8");
    assert.doesNotMatch(explorer, /new\s+EventSource\s*\(/);
  });

  it("keeps the event bus before every application-event consumer in the bundle", () => {
    const compiler = readFileSync(resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"), "utf8");
    const eventsIndex = compiler.indexOf('"gen/services/app-events.js"');
    assert.notStrictEqual(eventsIndex, -1);
    for (const consumer of [
      '"gen/service/explorer-service.js"',
      '"gen/chat/chat-token.js"',
      '"gen/pane/mcp/index.js"',
    ]) {
      const consumerIndex = compiler.indexOf(consumer);
      assert.notStrictEqual(consumerIndex, -1, `${consumer} must be bundled`);
      assert.ok(eventsIndex < consumerIndex, `app-events.js must load before ${consumer}`);
    }
  });

  it("keeps the application event contracts in the normal test suites", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const manifest = buildTestManifest();
    assert.strictEqual(pkg.scripts["test:unit"], "node scripts/test-suite.mjs unit");
    assert.strictEqual(pkg.scripts["test:frontend"], "node scripts/test-suite.mjs frontend");
    assert.ok(manifest.suites.unit.includes("test/app-events-server.test.mjs"));
    assert.ok(manifest.suites.frontend.includes("test/app-events-frontend.test.mjs"));
  });

  it("keeps route tests isolated with bounded parallelism and memory", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    assert.strictEqual(pkg.scripts["test:routes"], "node scripts/test-routes.mjs");
    const runner = readFileSync(resolve(process.cwd(), "scripts/test-routes.mjs"), "utf8");
    const manifest = buildTestManifest();
    assert.match(runner, /runFile\(file, 4\)/);
    assert.match(runner, /runFile\(file, 1\)/);
    assert.match(runner, /processTreeRssMb/);
    assert.match(runner, /MY_CODE_AGENT_TEST_MEMORY_MB \|\| 2048/);
    assert.deepEqual(manifest.suites.routesSerial, ["test/multi-instance-e2e.mjs", "test/multi-instance-launch.test.mjs", "test/workspace-lock.test.mjs"]);
  });

  it("keeps build and runtime memory budgets separate and builds Monaco in its own graph", () => {
    const buildScript = readFileSync(resolve(process.cwd(), "scripts/build-frontend.mjs"), "utf8");
    const viteConfig = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");
    const buildRunner = readFileSync(resolve(process.cwd(), "scripts/test-build.mjs"), "utf8");
    const distRunner = readFileSync(resolve(process.cwd(), "scripts/dist-dir.mjs"), "utf8");
    assert.match(buildScript, /for \(const worker of \["editor", "typescript", "json", "css", "html"\]\)/);
    assert.match(buildScript, /runVite\("dashboard"\)/);
    assert.match(buildScript, /esbuildBin/);
    assert.match(buildScript, /monaco-entry\.js/);
    assert.match(buildScript, /monaco-entry\.css/);
    assert.match(buildScript, /--loader:\.ttf=file/);
    assert.match(viteConfig, /emptyOutDir: !buildWorker/);
    assert.match(viteConfig, /reportCompressedSize: false/);
    assert.match(buildRunner, /MY_CODE_AGENT_BUILD_MEMORY_MB \|\| 3584/);
    assert.match(buildRunner, /MY_CODE_AGENT_TEST_MEMORY_MB \|\| 2048/);
    assert.match(buildRunner, /label === "build frontend" \? BUILD_LIMIT_MB : TEST_LIMIT_MB/);
    assert.match(distRunner, /MY_CODE_AGENT_BUILD_MEMORY_MB \|\| 3584/);
    assert.match(distRunner, /electron-builder.*TEST_LIMIT_MB/);
    assert.match(buildRunner, /peak RSS=/);
    assert.match(distRunner, /peak RSS=/);
  });

  it("selects generated worker URLs in Vite development modules", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/editor/monaco-setup.ts"), "utf8");
    assert.ok(source.includes("const isDevSource = /\\/(?:editor|gen\\/editor|src\\/frontend\\/editor)\\//.test"));
    assert.ok(source.includes('const devWorkerBase = import.meta.url.includes("/gen/editor/")'));
    assert.ok(source.includes('new Worker(url, { type: "module", name: label })'));
  });
});

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

describe("dashboard workspace endpoint ownership", () => {
  it("keeps workspace switching out of the renderer and delegates folder selection to Electron", () => {
    const startup = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-startup.ts"), "utf8");
    const helpers = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-helpers.ts"), "utf8");
    const menus = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-menus.ts"), "utf8");

    assert.doesNotMatch(startup, /\/api\/workspace\/switch/);
    assert.doesNotMatch(helpers, /\/api\/workspace\/switch/);
    assert.doesNotMatch(menus, /\/api\/workspace\/switch/);
    assert.match(menus, /api\.openWorkspaceFolder\(\)/);
  });
});

describe("frontend state ownership", () => {
  it("narrows the shared App facade once at the initialization boundary", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/frontend/dashboard/dashboard-helpers.ts"),
      "utf8",
    );
    assert.match(source, /const App:\s*AppNamespace\s*=\s*window\.App\s*;/);
    assert.doesNotMatch(source, /const App\s*=\s*\(window as any\)\.App/);
  });

  it("reads session tab labels through App.Session", () => {
    const root = resolve(process.cwd(), "src/frontend");
    for (const file of [
      "dashboard/dashboard-layout.ts",
      "dashboard/layout-tabs.ts",
    ]) {
      const source = readFileSync(resolve(root, file), "utf8");
      assert.doesNotMatch(source, /(?:window|\(window as any\))\.sessionTabLabel/);
      assert.match(source, /App\.Session\.getTabLabel\(/);
    }
  });

  it("keeps session consumers off legacy global entry points", () => {
    const root = resolve(process.cwd(), "src/frontend");
    const legacyWindowSessionAccess = /(?:window|\(window as any\))\.(?:loadSessions|bumpSessionListSeq|isCurrentSessionListSeq|sessionTabLabel|switchSession|getActiveSessionTabId|renderSessionTabs)/;
    const bareSessionCall = /(?<![.\w])(?:loadSessions|bumpSessionListSeq|isCurrentSessionListSeq)\s*\(/;
    for (const file of [
      "dashboard/dashboard-startup.ts",
      "dashboard/dashboard-menus.ts",
      "dashboard/dashboard-helpers.ts",
      "dashboard/dashboard-chat.ts",
      "chat/chat-token.ts",
      "pane/chat/index.ts",
    ]) {
      const source = readFileSync(resolve(root, file), "utf8");
      assert.doesNotMatch(source, legacyWindowSessionAccess, `${file} must not read a legacy session global`);
      assert.doesNotMatch(source, bareSessionCall, `${file} must call session APIs through App`);
    }
  });

  it("does not publish or declare legacy session globals", () => {
    const legacySessionGlobals = [
      "loadSessions", "bumpSessionListSeq", "isCurrentSessionListSeq",
      "readSessionTabIds", "writeSessionTabIds", "sessionTabLabel",
      "commitSessionTab", "maybeAutoTitleSession", "getActiveSessionTabId",
      "setActiveSessionTabId", "ensureDraftSessionTab", "whenSessionRestoreReady",
      "renderSessionTabs", "migrateSessionTabLabels", "switchSession",
      "newSession", "renameSession", "deleteSession", "pinSession", "branchSession",
    ];
    const root = resolve(process.cwd(), "src/frontend");
    for (const file of frontendTypeScriptFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const name of legacySessionGlobals) {
        assert.doesNotMatch(
          source,
          new RegExp(`(?:window|\\(window as any\\))\\.${name}\\s*(?:=|\\()`),
          `${relativeFrontendPath(file)} must not publish or read window.${name}`,
        );
      }
    }
    const declarations = readFileSync(resolve(root, "types/dashboard-runtime.d.ts"), "utf8");
    for (const name of legacySessionGlobals) {
      assert.doesNotMatch(declarations, new RegExp(`declare function ${name}\\b`), `${name} must not be a global declaration`);
      assert.doesNotMatch(declarations, new RegExp(`\\b${name}\\?:`), `${name} must not be a Window property`);
    }
  });

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
    const helpersIndex = compiler.indexOf('"gen/dashboard/dashboard-helpers.js"');
    const sessionsIndex = compiler.indexOf('"gen/dashboard/dashboard-sessions.js"');
    assert.notStrictEqual(helpersIndex, -1, "dashboard helpers must be included in the dashboard bundle");
    assert.notStrictEqual(restoreIndex, -1, "session restore must be included in the dashboard bundle");
    assert.ok(helpersIndex < sessionsIndex, "dashboard helpers must load before dashboard sessions");
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

describe("Permissions settings bundle ownership", () => {
  it("protects the Permissions-before-Settings bundle boundary", () => {
    const compiler = readFileSync(resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"), "utf8");
    const permissionsIndex = compiler.indexOf('"gen/pane/permissions/index.js"');
    const settingsIndex = compiler.indexOf('"gen/dashboard/dashboard-settings.js"');
    assert.notStrictEqual(permissionsIndex, -1, "Permissions must be an explicit bundle entry");
    assert.notStrictEqual(settingsIndex, -1, "Settings must be an explicit bundle entry");
    assert.ok(permissionsIndex < settingsIndex, "Permissions must load before Settings");
    assert.match(compiler, /REQUIRED_BUNDLE_ENTRIES/);
    assert.match(compiler, /missingBundleEntries/);
  });
});

describe("dashboard event refresh ownership", () => {
  it("does not install a Dashboard polling interval", () => {
    for (const file of [
      "src/frontend/dashboard/dashboard-startup.ts",
      "src/frontend/dashboard.html",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      assert.doesNotMatch(source, /setInterval\s*\(/, `${file} must use application events`);
    }
  });
});

describe("token usage event refresh ownership", () => {
  it("does not retain Token polling names or a six-second interval", () => {
    const usage = readFileSync(resolve(process.cwd(), "src/frontend/chat/chat-token.ts"), "utf8");
    const chat = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-chat.ts"), "utf8");
    assert.doesNotMatch(usage, /\b(?:startTokenPoll|stopTokenPoll|pollTokenUsage|_pollTimer)\b/);
    assert.doesNotMatch(usage, /setInterval\s*\([^,]+,\s*6000\s*\)/);
    assert.match(usage, /tokenEvents\.subscribe\(['"]usage\.changed['"]/);
    assert.match(usage, /tokenEvents\.subscribe\(['"]resync['"]/);
    assert.match(chat, /startTokenUpdates/);
    assert.doesNotMatch(chat, /startTokenPoll/);
  });
});

describe("MCP pane event refresh ownership", () => {
  it("does not retain the MCP refresh timer", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/pane/mcp/index.ts"), "utf8");
    assert.doesNotMatch(source, /\b_mcpRefreshTimer\b/);
    assert.doesNotMatch(source, /setInterval\s*\(/);
    assert.match(source, /events:\s*AppEvents/);
    assert.match(source, /mcpPaneEvents\.subscribe\(['"]mcp\.changed['"]/);
    assert.match(source, /mcpPaneEvents\.subscribe\(['"]resync['"]/);
  });
});

describe("non-Markdown HTML boundaries", () => {
  it("escapes server session ids before placing them in data attributes", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/session-list-panel.ts"), "utf8");
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
