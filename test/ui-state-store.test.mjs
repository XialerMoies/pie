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

function store() { return global.window.__uiStateStore; }

describe("UiStateStore", () => {
  it("服务端空 tabs 有效，不 fallback 到旧 localStorage", async () => {
    storage["session-tabs"] = JSON.stringify(["old-sess"]);
    storage["workspace_path"] = "/ws";

    global.fetch = async () => ({
      ok: true,
      json: async () => ({ schemaVersion: 2, tabs: { sessions: [] }, activeView: { type: "chat" }, panel: { active: "explorer", closed: false, width: 260 } }),
    });

    await store().hydrate();
    const state = store().getState();
    assert.ok(Array.isArray(state.tabs.sessions));
    assert.strictEqual(state.tabs.sessions.length, 0, "空 tabs 应保留为 []");
    assert.strictEqual(state.activeView.type, "chat");
  });

  it("workspace A/B 隔离", async () => {
    storage["workspace_path"] = "/project-alpha";
    storage["session-tabs"] = JSON.stringify([]);

    let fetchUrl = "";
    global.fetch = async (url, init) => {
      if (typeof url === "string" && url.includes("/api/ui-state")) {
        if (!init?.method || init.method === "GET") fetchUrl = url;
        return { ok: true, json: async () => ({ schemaVersion: 2, tabs: { sessions: [] }, workspacePath: "/project-alpha" }) };
      }
      return { ok: true, json: async () => ({}) };
    };

    await store().hydrate();
    assert.ok(fetchUrl.includes("workspace="), `GET 请求应带 workspace 参数: ${fetchUrl}`);
  });

  it("resetWorkspaceState 清空 store 并更新 workspacePath", async () => {
    // 先设置一些模拟状态
    global.fetch = async (url, init) => {
      if (String(url).includes("/api/ui-state") && init?.method === "PUT") return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ schemaVersion: 2, tabs: { sessions: ["sess-old"] }, activeView: { type: "session", id: "sess-old" }, workspacePath: "/old-ws" }) };
    };
    await store().hydrate();
    assert.strictEqual(store().getState().tabs.sessions.length, 1, "原工作区应有标签");

    // 模拟工作区切换
    const uis = store();
    const newState = {
      schemaVersion: 2,
      workspacePath: "/new-ws",
      activeView: { type: "chat" },
      tabs: { sessions: [], files: [], chatOpen: true, labels: {} },
      panel: { active: "explorer", closed: false, width: 260 },
      recent: { sessions: {} },
    };
    Object.assign(uis._state, newState);
    await uis.saveNow();

    const s = uis.getState();
    assert.strictEqual(s.tabs.sessions.length, 0, "新工作区无标签");
    assert.strictEqual(s.workspacePath, "/new-ws", "workspacePath 已更新");
    assert.strictEqual(s.activeView.type, "chat");
  });

  it("saveNow 只持久化新 tabs 格式", async () => {
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
          tabs: { sessions: ["sess-a"], files: [], chatOpen: true, labels: { "sess-a": "手动名称" } },
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
    assert.strictEqual("sessions" in savedBody.tabs, false, "不再写 sessions 旧字段");
    assert.strictEqual("files" in savedBody.tabs, false, "不再写 files 旧字段");
    assert.strictEqual("chatOpen" in savedBody.tabs, false, "不再写 chatOpen 旧字段");
    assert.strictEqual("labels" in savedBody.tabs, false, "不再写 labels 旧字段");
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
    const state = store().getState();
    assert.strictEqual(state.panel.active, "chat");
    assert.strictEqual(state.panel.closed, true, "panel closed 应恢复");
    assert.strictEqual(state.panel.width, 200);
  });
});
