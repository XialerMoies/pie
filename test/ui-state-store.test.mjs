/**
 * UiStateStore 测试
 *
 * 覆盖：
 *   1. 服务端返回空 tabs → 不 fallback 到 localStorage 旧数据
 *   2. 不同 workspace 状态隔离
 *   3. panel closed 能正确恢复
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const win = new Window();
global.window = win;
global.document = win.document;
global.self = win;

const storage = {};
global.localStorage = {
  getItem: (k) => storage[k] ?? null,
  setItem: (k, v) => { storage[k] = v; },
  removeItem: (k) => { delete storage[k]; },
};

global.fetch = async () => ({ ok: true, json: async () => ({}) });

before(async () => {
  await import("../src/frontend/services/ui-state-store.ts");
});

function store() { return global.window.App.State; }

describe("UiStateStore", () => {
  it("keeps workspace compatibility storage behind App.State", () => {
    const workspaceConsumers = [
      "src/frontend/dashboard/dashboard-sessions.ts",
      "src/frontend/editor/monaco-setup.ts",
    ];

    for (const file of workspaceConsumers) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      assert.match(source, /App\.State\.getWorkspacePath\(\)/, `${file} must read workspace through App.State`);
      assert.doesNotMatch(source, /localStorage[^\n]*(?:WS_KEY|workspace_path)|(?:WS_KEY|workspace_path)[^\n]*localStorage/, `${file} must not own workspace compatibility storage`);
    }

    const tokenSource = readFileSync(resolve(process.cwd(), "src/frontend/chat/chat-token.ts"), "utf8");
    assert.match(tokenSource, /state:\s*AppStateFacade/);
    assert.match(tokenSource, /tokenState\.getWorkspacePath\(\)/);
    assert.doesNotMatch(tokenSource, /localStorage[^\n]*(?:WS_KEY|workspace_path)|(?:WS_KEY|workspace_path)[^\n]*localStorage/);

    const tsserverSource = readFileSync(resolve(process.cwd(), "src/frontend/editor/monaco-tsserver.ts"), "utf8");
    assert.match(tsserverSource, /function\s+monacoTsserverState\(\):\s*AppStateFacade/);
    assert.match(tsserverSource, /monacoTsserverState\(\)\.getWorkspacePath\(\)/);
    assert.doesNotMatch(tsserverSource, /localStorage[^\n]*(?:WS_KEY|workspace_path)|(?:WS_KEY|workspace_path)[^\n]*localStorage/);

    const dashboardChatSource = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-chat.ts"), "utf8");
    assert.match(dashboardChatSource, /state:\s*AppStateFacade/);
    assert.match(dashboardChatSource, /dashboardChatState\.getWorkspacePath\(\)/);
    assert.doesNotMatch(dashboardChatSource, /localStorage[^\n]*(?:WS_KEY|workspace_path)|(?:WS_KEY|workspace_path)[^\n]*localStorage/);

    const explorerSource = readFileSync(resolve(process.cwd(), "src/frontend/service/explorer-service.ts"), "utf8");
    assert.match(explorerSource, /interface\s+ExplorerServiceDependencies\s*\{/);
    assert.match(explorerSource, /state:\s*AppStateFacade/);
    assert.match(explorerSource, /explorerServiceState\.getWorkspacePath\(\)/);
    assert.match(explorerSource, /explorerServiceState\.setWorkspacePath\(p\)/);

    for (const [file, alias] of [
      ["src/frontend/pane/git/index.ts", "gitPaneState"],
      ["src/frontend/pane/search/index.ts", "searchPaneState"],
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      assert.match(source, /state:\s*AppStateFacade/);
      assert.match(source, new RegExp(`${alias}\\.getWorkspacePath\\(\\)`));
      assert.doesNotMatch(source, /localStorage[^\n]*(?:WS_KEY|workspace_path)|(?:WS_KEY|workspace_path)[^\n]*localStorage/);
    }

    const menuSource = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-menus.ts"), "utf8");
    assert.doesNotMatch(menuSource, /__uiStateStore/, "workspace reset must stay behind App.State");
  });

  it("keeps frontend state consumers behind the public App.State facade", () => {
    const stateConsumers = [
      "src/frontend/services/tab-store.ts",
      "src/frontend/dashboard/dashboard-sessions.ts",
      "src/frontend/dashboard/dashboard-layout.ts",
      "src/frontend/dashboard/layout-tabs.ts",
      "src/frontend/dashboard/layout-panel.ts",
      "src/frontend/dashboard/dashboard-chat.ts",
      "src/frontend/dashboard/dashboard-menus.ts",
    ];

    for (const file of stateConsumers) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      assert.doesNotMatch(source, /__uiStateStore|_uiStateStore/, `${file} must not access UiStateStore internals`);
      assert.doesNotMatch(source, /localStorage[^\n]*(?:session-tabs|active-session-tab|session-tab-labels|last-session-id|last-active-tab|chat-tab-open|panel-width)/, `${file} must not own migrated UI-state storage`);
    }
  });

  it("keeps persisted panel state behind App.State instead of window.__state projections", () => {
    for (const file of [
      "src/frontend/dashboard/dashboard-layout.ts",
      "src/frontend/dashboard/layout-panel.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      assert.doesNotMatch(source, /_activePanel/, `${file} must use App.State for panel state`);
    }
    const panel = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/layout-panel.ts"), "utf8");
    assert.match(panel, /interface\s+LayoutPanelDependencies\s*\{/);
    assert.match(panel, /state:\s*AppStateFacade/);
    assert.match(panel, /layoutPanelState\.getSnapshot\(\)/);
  });

  it("keeps dashboard layout runtime and tab reads behind public facades", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-layout.ts"), "utf8");
    assert.doesNotMatch(source, /window\.__state|window\.__tabs/, "dashboard layout must not read legacy state projections directly");
    assert.doesNotMatch(source, /localStorage/, "dashboard layout must use the public state facade for workspace data");
    assert.match(source, /App\.Tabs\.getState\(\)/);
    assert.match(source, /App\.Chat\?\.isBusy\?\.\(\)/);
  });

  it("keeps tab, session, and panel consumers off legacy window state projections", () => {
    for (const file of [
      "src/frontend/dashboard/layout-tabs.ts",
      "src/frontend/dashboard/layout-shortcuts.ts",
      "src/frontend/dashboard/dashboard-menus.ts",
      "src/frontend/dashboard/dashboard-chat.ts",
      "src/frontend/pane/chat/index.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      assert.doesNotMatch(
        source,
        /(?:window|\(window as any\))\.__state/,
        `${file} must read tab, session, and panel state through public facades`,
      );
    }
  });

  it("keeps session tab metadata out of legacy window state projections", () => {
    const source = readFileSync(resolve(process.cwd(), "src/frontend/dashboard/dashboard-sessions.ts"), "utf8");
    assert.doesNotMatch(source, /window\.__state[^\n]*_(?:sessionTabs|activeSessionTabId|sessionTabLabels|sessionTitleSources)/);
    assert.doesNotMatch(source, /\(window\.__state as any\)\._(?:sessionTabLabels|sessionTitleSources)/);
    assert.match(source, /App\.State\.updateSessionMetadata/);
    assert.match(source, /App\.State\.getSnapshot\(\)\.tabs/);
  });

  it("keeps an explicit workspace reset when the hydration GET resolves late", async () => {
    const puts = [];
    let resolveGet;
    global.fetch = async (url, init) => {
      if (init?.method === "PUT") {
        puts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return new Promise((resolve) => {
        resolveGet = () => resolve({
          ok: true,
          json: async () => ({
            schemaVersion: 2,
            workspacePath: "/A",
            activeView: { type: "chat" },
            tabs: { items: [], activeId: null },
            panel: { active: "explorer", closed: false, width: 260 },
            recent: { sessions: {} },
          }),
        });
      });
    };

    const hydration = store().hydrate();
    store().resetWorkspace("/B");
    resolveGet();
    await hydration;
    await store().saveNow();

    assert.strictEqual(store().getWorkspacePath(), "/B");
    assert.ok(puts.some((state) => state.workspacePath === "/B"));
    assert.ok(puts.every((state) => state.workspacePath !== "/A"));
  });

  it("syncs tabs and session UI data through detached App.State snapshots", async () => {
    global.fetch = async (url, init) => {
      if (init?.method === "PUT") return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 2,
          workspacePath: "/workspace",
          activeView: { type: "chat" },
          tabs: { items: [], activeId: null, labels: {}, titleSources: {}, chatOpen: true },
          panel: { active: "explorer", closed: false, width: 260 },
          recent: { sessions: {} },
        }),
      };
    };
    await window.App.State.hydrate();

    const tabs = [{ id: "sess-a", kind: "session", title: "Session A", order: 0, sessionId: "sess-a" }];
    window.App.State.syncTabs(tabs, "sess-a");
    window.App.State.updateSessionMetadata({ "sess-a": "Renamed" }, { "sess-a": "manual" });
    window.App.State.updatePanel({ active: "git", closed: true, width: 320 });
    window.App.State.setChatOpen(false);
    window.App.State.touchSession("sess-a", 1234);

    tabs[0].title = "mutated input";
    const snapshot = window.App.State.getSnapshot();
    assert.strictEqual(snapshot.tabs.items[0].title, "Session A");
    assert.deepStrictEqual(snapshot.activeView, { type: "session", id: "sess-a" });
    assert.strictEqual(snapshot.tabs.labels["sess-a"], "Renamed");
    assert.strictEqual(snapshot.tabs.titleSources["sess-a"], "manual");
    assert.deepStrictEqual(snapshot.panel, { active: "git", closed: true, width: 320 });
    assert.strictEqual(snapshot.tabs.chatOpen, false);
    assert.strictEqual(snapshot.recent.lastSessionId, "sess-a");
    assert.strictEqual(snapshot.recent.sessions["sess-a"], 1234);

    snapshot.tabs.items[0].title = "mutated snapshot";
    assert.strictEqual(window.App.State.getSnapshot().tabs.items[0].title, "Session A");
  });

  it("exposes the hydrated workspace through the App.State facade", async () => {
    storage["workspace_path"] = "/legacy-workspace";
    global.fetch = async (url, init) => {
      if (init?.method === "PUT") return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 2,
          workspacePath: "/server-workspace",
          tabs: { sessions: [] },
          activeView: { type: "chat" },
          panel: { active: "explorer", closed: false, width: 260 },
          recent: { sessions: {} },
        }),
      };
    };

    await store().hydrate();

    assert.strictEqual(typeof window.App?.State?.getWorkspacePath, "function");
    assert.strictEqual(window.App.State.getWorkspacePath(), "/server-workspace");
  });
  it("服务端空 tabs 有效，不 fallback 到旧 localStorage", async () => {
    storage["session-tabs"] = JSON.stringify(["old-sess"]);
    storage["workspace_path"] = "/ws";

    global.fetch = async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 2, tabs: { sessions: [] }, activeView: { type: "chat" }, panel: { active: "explorer", closed: false, width: 260 } }),
    });

    await store().hydrate();
    const state = store().getSnapshot();
    assert.ok(Array.isArray(state.tabs.sessions));
    assert.strictEqual(state.tabs.sessions.length, 0, "空 tabs 应保留为 []");
    assert.strictEqual(state.activeView.type, "chat");
  });

  it("workspace A/B 隔离", async () => {
    storage["workspace_path"] = "/legacy-workspace";
    storage["session-tabs"] = JSON.stringify([]);

    const fetchUrls = [];
    global.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("/api/ui-state")) {
        if (!init?.method || init.method === "GET") fetchUrls.push(url);
        if (init?.method === "PUT") return { ok: true, json: async () => ({ ok: true }) };
        return { ok: true, json: async () => ({ schemaVersion: 2, tabs: { sessions: [] }, workspacePath: "/server-workspace" }) };
      }
      return { ok: true, json: async () => ({}) };
    };

    await store().hydrate();
    assert.deepStrictEqual(fetchUrls, ["/api/ui-state"]);
    assert.strictEqual(store().getWorkspacePath(), "/server-workspace");
  });

  it("legacy UI state inherits the runtime workspace without consuming the legacy workspace key", async () => {
    storage["workspace_path"] = "/legacy-workspace";
    storage["session-tabs"] = JSON.stringify(["legacy-session"]);
    storage["active-session-tab"] = "legacy-session";
    storage["active-panel"] = "git";

    global.fetch = async (url, init) => {
      if (init?.method === "PUT") return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: true,
        json: async () => ({ workspacePath: "/runtime-workspace", tabs: { sessions: [] } }),
      };
    };

    await store().hydrate();
    const state = store().getSnapshot();
    assert.strictEqual(state.workspacePath, "/runtime-workspace");
    assert.deepStrictEqual(state.tabs.sessions, ["legacy-session"]);
    assert.strictEqual(state.panel.active, "git");
  });

  it("does not use the legacy workspace key when the hydrated state has no workspace path", async () => {
    storage["workspace_path"] = "/legacy-workspace";
    let savedBody = null;
    global.fetch = async (url, init) => {
      if (init?.method === "PUT") {
        savedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 2,
          workspacePath: "",
          tabs: { sessions: [] },
          activeView: { type: "chat" },
          panel: { active: "explorer", closed: false, width: 260 },
          recent: { sessions: {} },
        }),
      };
    };

    await store().hydrate();
    assert.strictEqual(store().getWorkspacePath(), "");
    assert.strictEqual(savedBody.workspacePath, "");
  });

  it("resetWorkspaceState 清空 store 并更新 workspacePath", async () => {
    const workspaceLegacyKeys = [
      "file-tabs",
      "last-active-tab",
      "session-tabs",
      "active-session-tab",
      "session-tab-labels",
      "last-session-id",
      "chat-tab-open",
      "active-panel",
      "panel-width",
    ];
    for (const key of workspaceLegacyKeys) storage[key] = `stale:${key}`;

    // 先设置一些模拟状态
    global.fetch = async (url, init) => {
      if (String(url).includes("/api/ui-state") && init?.method === "PUT") return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ schemaVersion: 2, tabs: { sessions: ["sess-old"] }, activeView: { type: "session", id: "sess-old" }, workspacePath: "/old-ws" }) };
    };
    await store().hydrate();
    assert.strictEqual(store().getSnapshot().tabs.sessions.length, 1, "原工作区应有标签");

    // 模拟工作区切换
    const uis = store();
    uis.resetWorkspace("/new-ws");
    await uis.saveNow();

    const s = uis.getSnapshot();
    assert.strictEqual(s.tabs.sessions.length, 0, "新工作区无标签");
    assert.strictEqual(s.workspacePath, "/new-ws", "workspacePath 已更新");
    assert.strictEqual(s.activeView.type, "chat");
    assert.strictEqual(storage.workspace_path, "/new-ws");
    for (const key of workspaceLegacyKeys) {
      assert.strictEqual(storage[key], undefined, `${key} must not leak into the new workspace`);
    }
  });

  it("saveNow 持久化新 tabs 格式和标题元数据", async () => {
    storage["workspace_path"] = "/project-alpha";
    storage["session-tabs"] = JSON.stringify(["sess-a"]);
    storage["session-tab-labels"] = JSON.stringify({ "sess-a": "手动名称" });

    let savedBody = null;
    global.fetch = async (url, init) => {
      if (String(url).includes("/api/ui-state") && init?.method === "PUT") {
        savedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 2,
          workspacePath: "/project-alpha",
          activeView: { type: "session", id: "sess-a" },
          tabs: { sessions: ["sess-a"], files: [], chatOpen: true, labels: { "sess-a": "手动名称" }, titleSources: { "sess-a": "manual" } },
          panel: { active: "explorer", closed: false, width: 260 },
          recent: { sessions: {} },
        }),
      };
    };

    await store().hydrate();

    assert.ok(savedBody, "hydrate 后应保存一次状态");
    assert.ok(Array.isArray(savedBody.tabs.items), "保存体应携带 tabs.items");
    assert.strictEqual(savedBody.tabs.items.length, 1, "保存体保留标签项");
    assert.strictEqual(savedBody.tabs.activeId, "sess-a", "保存体保留 activeId");
    assert.strictEqual(savedBody.tabs.labels["sess-a"], "手动名称", "保存体保留标题缓存");
    assert.strictEqual(savedBody.tabs.titleSources["sess-a"], "manual", "保存体保留标题来源");
    assert.strictEqual("sessions" in savedBody.tabs, false, "不再写 sessions 旧字段");
    assert.strictEqual("files" in savedBody.tabs, false, "不再写 files 旧字段");
    assert.strictEqual("chatOpen" in savedBody.tabs, false, "不再写 chatOpen 旧字段");
  });

  it("panel.closed 恢复", async () => {
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        schemaVersion: 2,
        panel: { active: "chat", closed: true, width: 200 },
        tabs: { sessions: [] },
        activeView: { type: "chat" },
      }),
    });

    await store().hydrate();
    const state = store().getSnapshot();
    assert.strictEqual(state.panel.active, "chat");
    assert.strictEqual(state.panel.closed, true, "panel closed 应恢复");
    assert.strictEqual(state.panel.width, 200);
  });

  it("并发 saveNow 串行写入，并最终保存最新标签快照", async () => {
    const requests = [];
    let releaseFirst;
    const firstPut = new Promise((resolve) => { releaseFirst = resolve; });
    global.fetch = async (url, init) => {
      if (String(url).includes("/api/ui-state") && init?.method === "PUT") {
        requests.push(JSON.parse(init.body));
        if (requests.length === 1) await firstPut;
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 2,
          workspacePath: "/save-race",
          activeView: { type: "chat" },
          tabs: { items: [], activeId: null },
          panel: { active: "explorer", closed: false, width: 260 },
          recent: { sessions: {} },
        }),
      };
    };

    await store().hydrate();
    store().syncTabs([{ id: "old", kind: "session", title: "old", order: 0 }], "old");
    const first = store().saveNow();
    store().syncTabs([{ id: "new", kind: "session", title: "new", order: 0 }], "new");
    const second = store().saveNow();
    releaseFirst();
    await Promise.all([first, second]);

    assert.strictEqual(requests.length, 2, "新快照应在旧 PUT 完成后补写一次");
    assert.deepStrictEqual(requests.at(-1).tabs.items.map((tab) => tab.id), ["new"]);
    assert.strictEqual(requests.at(-1).tabs.activeId, "new");
  });
});
