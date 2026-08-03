import { beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

let importSeq = 0;
let win;
let snapshot;
let calls;
let hydrateImpl;

async function loadSubject() {
  await import(`../src/frontend/dashboard/session-restore.ts?test=${++importSeq}`);
  return {
    tabs: win.App.SessionTabs,
    restore: win.App.SessionRestore,
  };
}

beforeEach(() => {
  win = new Window();
  snapshot = {
    workspacePath: "E:\\workspace",
    activeView: { type: "session", id: "sess-b" },
    tabs: {
      items: [
        { kind: "chat", id: "draft:stale", title: "New", order: 0, draftId: "draft:stale" },
        { kind: "session", id: "sess-a", title: "A", order: 1, sessionId: "sess-a" },
        { kind: "session", id: "sess-b", title: "B", order: 2, sessionId: "sess-b" },
      ],
      activeId: "sess-b",
      sessions: [],
      files: [],
      chatOpen: true,
      labels: {},
      titleSources: {},
    },
    panel: { active: "git", closed: false, width: 260 },
    recent: { sessions: {} },
  };
  calls = [];
  hydrateImpl = async () => snapshot;
  win.App = {
    State: {
      hydrate: () => hydrateImpl(),
      getSnapshot: () => snapshot,
      getWorkspacePath: () => snapshot.workspacePath,
      syncTabs: (items, activeId) => {
        calls.push(["syncTabs", items.map(tab => tab.id), activeId]);
        snapshot.tabs.items = items.map(tab => ({ ...tab }));
        snapshot.tabs.activeId = activeId;
      },
      updatePanel: () => {},
      touchSession: () => {},
      saveNow: async () => {
        calls.push(["saveNow"]);
        return true;
      },
    },
    Tabs: {
      getSessionTabIds: () => snapshot.tabs.items
        .filter(tab => tab.kind === "session" || tab.kind === "chat")
        .map(tab => tab.id),
      getState: () => ({ items: snapshot.tabs.items, activeId: snapshot.tabs.activeId }),
      restoreTabs: (items, activeId) => calls.push(["restoreTabs", items.map(tab => tab.id), activeId]),
      activateTab: id => {
        snapshot.tabs.activeId = id;
        calls.push(["activateTab", id]);
      },
      openTab: () => {},
      closeTab: () => {},
      getTab: () => undefined,
    },
    UI: { restorePanel: panel => calls.push(["restorePanel", panel]) },
  };
  win.restoreFileTabs = () => calls.push(["restoreFileTabs"]);
  win.renderTabs = () => calls.push(["renderTabs"]);
  global.window = win;
  global.document = win.document;
  global.App = win.App;
});

describe("session restore", () => {
  it("filters stale drafts and restores the persisted real session", async () => {
    const { restore } = await loadSubject();
    restore.init({
      prefetchSessionIndex: () => calls.push(["prefetch"]),
      onActiveSession: id => calls.push(["active", id, snapshot.tabs.activeId]),
    });

    await restore.restoreSessionTabs();

    assert.deepStrictEqual(snapshot.tabs.items.map(tab => tab.id), ["sess-a", "sess-b"]);
    assert.strictEqual(snapshot.tabs.activeId, "sess-b");
    assert.deepStrictEqual(calls.find(call => call[0] === "active"), ["active", "sess-b", "sess-b"]);
    assert.ok(calls.findIndex(call => call[0] === "restoreTabs") < calls.findIndex(call => call[0] === "active"));
  });

  it("falls back to the first real session when persisted activeId is invalid", async () => {
    snapshot.tabs.activeId = "draft:stale";
    snapshot.activeView = { type: "chat" };
    const { restore } = await loadSubject();
    restore.init({
      prefetchSessionIndex: () => {},
      onActiveSession: id => calls.push(["active", id]),
    });

    await restore.restoreSessionTabs();

    assert.strictEqual(snapshot.tabs.activeId, "sess-a");
  });

  it("does not overwrite tabs when the user interacts during hydration", async () => {
    let resolveHydrate;
    hydrateImpl = () => new Promise(resolve => { resolveHydrate = resolve; });
    const { restore } = await loadSubject();
    restore.init({
      prefetchSessionIndex: () => {},
      onActiveSession: () => calls.push(["active"]),
    });
    const pending = restore.restoreSessionTabs();

    restore.markUserInteraction();
    resolveHydrate(snapshot);
    await pending;

    assert.strictEqual(calls.some(call => call[0] === "restoreTabs"), false);
    assert.strictEqual(calls.some(call => call[0] === "active"), false);
    assert.deepStrictEqual(calls.find(call => call[0] === "restorePanel"), ["restorePanel", "git"]);
  });

  it("shares one restore promise and one hydrate call", async () => {
    let hydrateCount = 0;
    hydrateImpl = async () => {
      hydrateCount += 1;
      return snapshot;
    };
    const { restore } = await loadSubject();
    restore.init({ prefetchSessionIndex: () => {}, onActiveSession: () => {} });

    const first = restore.restoreSessionTabs();
    const second = restore.restoreSessionTabs();

    assert.strictEqual(first, second);
    await first;
    assert.strictEqual(hydrateCount, 1);
  });

  it("does not wait for session-index prefetch before hydrating", async () => {
    let hydrateCount = 0;
    let resolvePrefetch;
    hydrateImpl = async () => {
      hydrateCount += 1;
      return snapshot;
    };
    const { restore } = await loadSubject();
    restore.init({
      prefetchSessionIndex: () => new Promise(resolve => { resolvePrefetch = resolve; }),
      onActiveSession: () => {},
    });

    const pending = restore.restoreSessionTabs();
    await Promise.resolve();

    assert.strictEqual(hydrateCount, 1);
    resolvePrefetch();
    await pending;
  });

  it("resolves readiness after restore failure", async () => {
    hydrateImpl = async () => { throw new Error("hydrate failed"); };
    const { restore } = await loadSubject();
    restore.init({ prefetchSessionIndex: () => {}, onActiveSession: () => {} });

    const originalWarn = console.warn;
    let warning;
    console.warn = (...args) => { warning = args; };
    try {
      await assert.doesNotReject(restore.restoreSessionTabs());
      await assert.doesNotReject(restore.whenReady());
    } finally {
      console.warn = originalWarn;
    }
    assert.strictEqual(warning?.[0], "[session-restore] failed");
  });
});
