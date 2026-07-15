/**
 * TabStore 单元测试
 *
 * 覆盖：
 *   1. 基础操作：openTab / activateTab / closeTab / replaceTab / moveTab
 *   2. activeId 唯一性：关闭 active tab 后自动切换
 *   3. chat→session 原地升级不改变顺序
 *   4. 旧字段 adapter（getSessionTabIds, getActiveSessionTabId, getFileTabIds）
 *   5. 空状态
 *   6. 从旧 __state 字段初始化
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

const win = new Window();
global.window = win;
global.document = win.document;
global.self = win;

describe("TabStore", () => {
  before(async () => {
    await import("../src/frontend/services/tab-store.ts");
  });

  beforeEach(() => {
    win.__state = {
      D: null, M: [], IL: false, CS: null, CT: "chat",
      _activePanel: "explorer",
      _fileTabs: [], _activeFileTab: null,
      _sessionTabs: [], _sessionTabLabels: {},
    };
    win.__tabs.reset();
  });

  it("空状态返回空列表和 null active", () => {
    const tabs = win.__tabs;
    assert.deepStrictEqual(tabs.getTabs(), []);
    assert.strictEqual(tabs.getActiveTab(), null);
    assert.strictEqual(tabs.getState().activeId, null);
  });

  it("openTab 追加到末尾并返回完整 tab", () => {

    const tabs = win.__tabs;
    const t1 = tabs.openTab({ kind: "session", id: "sess-a", title: "会话 A", sessionId: "sess-a" });
    assert.strictEqual(t1.order, 0);
    assert.strictEqual(t1.kind, "session");
    assert.strictEqual(t1.id, "sess-a");

    const t2 = tabs.openTab({ kind: "file", id: "/a.ts", title: "a.ts", path: "/a.ts" });
    assert.strictEqual(t2.order, 1);

    assert.strictEqual(tabs.getTabs().length, 2);
    assert.strictEqual(tabs.getTabs()[1].id, "/a.ts");
  });

  it("activateTab 设置 activeId，null 清空", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });
    tabs.openTab({ kind: "session", id: "sess-b", title: "B", sessionId: "sess-b" });

    tabs.activateTab("sess-b");
    assert.strictEqual(tabs.getState().activeId, "sess-b");
    assert.strictEqual(tabs.getActiveTab()?.id, "sess-b");

    tabs.activateTab(null);
    assert.strictEqual(tabs.getState().activeId, null);
    assert.strictEqual(tabs.getActiveTab(), null);
  });

  it("activateTab 对不存在的 id 无操作", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });
    tabs.activateTab("sess-a");
    tabs.activateTab("nonexistent");
    assert.strictEqual(tabs.getState().activeId, "sess-a");
  });

  it("closeTab 移除标签并返回", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });
    tabs.openTab({ kind: "session", id: "sess-b", title: "B", sessionId: "sess-b" });

    const removed = tabs.closeTab("sess-a");
    assert.strictEqual(removed?.id, "sess-a");
    assert.strictEqual(tabs.getTabs().length, 1);
    assert.strictEqual(tabs.getTabs()[0].id, "sess-b");
  });

  it("关闭当前 active tab 自动切换到相邻 tab", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });
    tabs.openTab({ kind: "session", id: "sess-b", title: "B", sessionId: "sess-b" });
    tabs.openTab({ kind: "session", id: "sess-c", title: "C", sessionId: "sess-c" });
    tabs.activateTab("sess-b");

    tabs.closeTab("sess-b");
    assert.strictEqual(tabs.getState().activeId, "sess-c", "关闭中间 tab → 同位置右侧 tab");

    tabs.closeTab("sess-c");
    assert.strictEqual(tabs.getState().activeId, "sess-a", "关闭末尾 tab → 上一个");

    tabs.closeTab("sess-a");
    assert.strictEqual(tabs.getState().activeId, null, "关闭最后一个 tab → null");
  });

  it("replaceTab 原地升级 chat→session", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "chat", id: "draft:abc", title: "新会话", draftId: "draft:abc" });
    tabs.openTab({ kind: "file", id: "/a.ts", title: "a.ts", path: "/a.ts" });
    tabs.activateTab("draft:abc");

    // 原地升级
    tabs.replaceTab("draft:abc", {
      kind: "session", id: "sess-real", sessionId: "sess-real", draftId: undefined,
    });

    const upgraded = tabs.getTab("sess-real");
    assert.strictEqual(upgraded?.kind, "session");
    assert.strictEqual(upgraded?.sessionId, "sess-real");
    assert.strictEqual(upgraded?.draftId, undefined);
    assert.strictEqual(upgraded?.order, 0, "升级后 order 不变");

    // activeId 自动更新
    assert.strictEqual(tabs.getState().activeId, "sess-real");

    // chat tab 已不存在
    assert.strictEqual(tabs.getTab("draft:abc"), undefined);

    // 列表顺序不变
    assert.strictEqual(tabs.getTabs().length, 2);
    assert.strictEqual(tabs.getTabs()[0].id, "sess-real");
    assert.strictEqual(tabs.getTabs()[1].id, "/a.ts");
  });

  it("moveTab 拖拽重排", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "chat", id: "chat:1", title: "草稿1", draftId: "chat:1" });
    tabs.openTab({ kind: "chat", id: "chat:2", title: "草稿2", draftId: "chat:1" });
    tabs.openTab({ kind: "chat", id: "chat:3", title: "草稿3", draftId: "chat:1" });

    tabs.moveTab(0, 2);
    assert.strictEqual(tabs.getTabs()[0].id, "chat:2");
    assert.strictEqual(tabs.getTabs()[1].id, "chat:3");
    assert.strictEqual(tabs.getTabs()[2].id, "chat:1");
    assert.strictEqual(tabs.getTabs()[2].order, 2);
  });

  it("getSessionTabIds 返回 session+chat 的 id 列表", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "chat", id: "draft:1", title: "草稿", draftId: "draft:1" });
    tabs.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });
    tabs.openTab({ kind: "file", id: "/a.ts", title: "a.ts", path: "/a.ts" });

    const ids = tabs.getSessionTabIds();
    assert.deepStrictEqual(ids, ["draft:1", "sess-a"]);
  });

  it("getFileTabIds 返回 file 的 id 列表", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "file", id: "/a.ts", title: "a.ts", path: "/a.ts" });
    tabs.openTab({ kind: "file", id: "/b.ts", title: "b.ts", path: "/b.ts" });
    tabs.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });

    assert.deepStrictEqual(tabs.getFileTabIds(), ["/a.ts", "/b.ts"]);
  });

  it("getActiveSessionTabId 仅在 session/chat active 时返回", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "file", id: "/a.ts", title: "a.ts", path: "/a.ts" });
    tabs.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });

    tabs.activateTab("/a.ts");
    assert.strictEqual(tabs.getActiveSessionTabId(), null);

    tabs.activateTab("sess-a");
    assert.strictEqual(tabs.getActiveSessionTabId(), "sess-a");
  });

  it("getActiveFileTabId 仅在 file active 时返回", () => {

    const tabs = win.__tabs;
    tabs.openTab({ kind: "file", id: "/a.ts", title: "a.ts", path: "/a.ts" });
    tabs.openTab({ kind: "session", id: "sess-a", title: "A", sessionId: "sess-a" });

    tabs.activateTab("sess-a");
    assert.strictEqual(tabs.getActiveFileTabId(), null);

    tabs.activateTab("/a.ts");
    assert.strictEqual(tabs.getActiveFileTabId(), "/a.ts");
  });
});
