/**
 * ExplorerService 测试
 *
 * mock fetch 测 fetchDir() / fileOp() / toTreeNodes() / refreshTree()
 *
 * 运行：npx tsx --test test/explorer-service.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";

// 全局 mock
const store = {};
global.localStorage = {
  getItem: (key) => store[key] ?? null,
  setItem: (key, val) => { store[key] = val; },
  removeItem: (key) => { delete store[key]; },
};
let workspacePath = "";
let preferenceReads = 0;
const eventSubscriptions = new Map();
const subscriptionRecords = [];
let eventSourceConstructed = 0;
let openFolderCalls = 0;
const appEvents = {
  subscribe: (type, handler) => {
    let handlers = eventSubscriptions.get(type);
    if (!handlers) eventSubscriptions.set(type, handlers = new Set());
    handlers.add(handler);
    const unsubscribe = () => handlers.delete(handler);
    subscriptionRecords.push({ type, handler, unsubscribe });
    return unsubscribe;
  },
  start: async () => {},
  stop: () => {},
};
global.App = {
  File: {
    fileAction: (action) => { if (action === "openFolder") openFolderCalls += 1; },
  },
  State: {
    getWorkspacePath: () => workspacePath,
    setWorkspacePath: (path) => { workspacePath = path; },
  },
  Preferences: {
    getBoolean: (key, fallback = false) => {
      preferenceReads += 1;
      const value = store[key];
      return value == null ? fallback : value === true || value === "true";
    },
    setBoolean: (key, value) => { store[key] = Boolean(value); },
  },
  Events: appEvents,
};
global.window = global;
global.EventSource = class {
  constructor() { eventSourceConstructed += 1; }
};
global.AbortController = class {
  constructor() { this.signal = {}; }
  abort() {}
};
global.fetch = async (url, opts) => {
  throw new Error("fetch not mocked: " + url);
};

// iconFor 的 fallback 调用全局 S()
global.S = (name, size) => `<svg><use href="#${name}"/></svg>`;
global.document = { createElement: () => ({ textContent: "", innerHTML: "" }), };

describe("ExplorerService", () => {
  let ExplorerService;

  function emitAppEvent(event) {
    for (const handler of eventSubscriptions.get(event.type) || []) handler(event);
  }

  before(async () => {
    const mod = await import("../src/frontend/service/explorer-service.ts");
    ExplorerService = mod.ExplorerService;
  });

  it("defers explorer preference reads until the startup consumer applies hydration", () => {
    assert.strictEqual(preferenceReads, 0);
    store["explorer-filter"] = "0";
    global.applyExplorerPreferences = global.window.applyExplorerPreferences;
    assert.strictEqual(typeof global.applyExplorerPreferences, "function");

    global.applyExplorerPreferences();

    assert.strictEqual(preferenceReads, 1);
    assert.strictEqual(ExplorerService.getFilterEnabled(), false);
    delete store["explorer-filter"];
    ExplorerService._filterEnabled = true;
  });

  describe("getWorkspacePath / setWorkspacePath", () => {
    it("默认返回空字符串", () => {
      assert.strictEqual(ExplorerService.getWorkspacePath(), "");
    });

    it("setWorkspacePath 后 getWorkspacePath 返回对应值", () => {
      ExplorerService.setWorkspacePath("/test/path");
      assert.strictEqual(ExplorerService.getWorkspacePath(), "/test/path");
    });
  });

  it("delegates workspace selection to the authoritative File switch flow", async () => {
    workspacePath = "/current-workspace";
    openFolderCalls = 0;

    await ExplorerService.applyWorkspace();

    assert.strictEqual(openFolderCalls, 1);
    assert.strictEqual(workspacePath, "/current-workspace");
  });

  describe("getFilterEnabled / setFilterEnabled", () => {
    it("默认开启过滤", () => {
      assert.strictEqual(ExplorerService.getFilterEnabled(), true);
    });

    it("关闭过滤后返回 false", () => {
      ExplorerService.setFilterEnabled(false);
      assert.strictEqual(ExplorerService.getFilterEnabled(), false);
      ExplorerService.setFilterEnabled(true);
    });
  });

  describe("toTreeNodes", () => {
    it("空数组返回空数组", () => {
      const result = ExplorerService.toTreeNodes([]);
      assert.deepStrictEqual(result, []);
    });

    it("转换 items 为 TreeNode 格式", () => {
      const items = [
        { path: "src", name: "src", isDir: true },
        { path: "package.json", name: "package.json", isDir: false },
      ];
      const result = ExplorerService.toTreeNodes(items);
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].id, "src");
      assert.strictEqual(result[0].isDir, true);
      assert.strictEqual(result[1].label, "package.json");
      assert.ok(typeof result[1].icon === "string");
    });

    it("null/undefined 返回空数组", () => {
      assert.deepStrictEqual(ExplorerService.toTreeNodes(null), []);
      assert.deepStrictEqual(ExplorerService.toTreeNodes(undefined), []);
    });
  });

  describe("iconFor", () => {
    it("目录返回文件夹图标", () => {
      const icon = ExplorerService.iconFor("any", true);
      assert.ok(icon.includes("default_folder") || icon.includes("svg"));
    });

    it("已知文件类型返回对应图标", () => {
      const icon = ExplorerService.iconFor("main.ts", false);
      assert.ok(icon.includes("typescript") || icon.includes("svg"));
    });

    it("未知文件类型返回 fallback", () => {
      const icon = ExplorerService.iconFor("unknown.xyz", false);
      assert.ok(typeof icon === "string");
    });
  });

  describe("fetchDir", () => {
    it("成功获取目录内容", async () => {
      const mockData = { items: [{ path: "a.ts", name: "a.ts", isDir: false }], rootDir: "/test", relativePath: "" };
      global.fetch = async (url) => {
        assert.ok(url.includes("/api/explorer"));
        assert.ok(url.includes("root="));
        return { ok: true, json: async () => mockData };
      };
      const result = await ExplorerService.fetchDir("/test", "");
      assert.strictEqual(result.items.length, 1);
      assert.strictEqual(result.items[0].name, "a.ts");
    });

    it("服务器错误时抛出异常", async () => {
      global.fetch = async () => ({ ok: false, status: 500, statusText: "Internal Server Error", json: async () => ({ error: "读取失败" }) });
      try {
        await ExplorerService.fetchDir("/test", "");
        assert.fail("应该抛出异常");
      } catch (e) {
        assert.ok(e.message.includes("读取失败"));
      }
    });

    it("超时抛出 TIMEOUT 错误", async () => {
      global.fetch = async (url, opts) => {
        const signal = opts?.signal;
        if (signal) {
          // 模拟 AbortController 触发
          const handler = signal.onabort;
          if (handler) setTimeout(handler, 0);
        }
        throw new DOMException("The operation was aborted", "AbortError");
      };
      try {
        await ExplorerService.fetchDir("/test", "");
        assert.fail("应该抛出 TIMEOUT");
      } catch (e) {
        assert.ok(e.message === "TIMEOUT");
      }
    });
  });

  describe("fileOp", () => {
    it("成功操作不抛出异常", async () => {
      global.fetch = async (url, opts) => {
        assert.ok(url.includes("/api/file/"));
        assert.strictEqual(opts.method, "POST");
        return { ok: true, json: async () => ({ success: true }) };
      };
      await ExplorerService.fileOp("rename", "/root", "old.ts", "new.ts");
      // 不抛出异常即通过
    });

    it("失败时抛出异常", async () => {
      global.fetch = async () => ({ ok: false, json: async () => ({ error: "权限不足" }) });
      try {
        await ExplorerService.fileOp("delete", "/root", "x.ts");
        assert.fail("应该抛出异常");
      } catch (e) {
        assert.ok(e.message.includes("权限不足"));
      }
    });
  });

  describe("shared events", () => {
    it("does not construct an EventSource when Explorer is imported", () => {
      assert.strictEqual(eventSourceConstructed, 0);
      assert.strictEqual(typeof ExplorerService.startEvents, "undefined");
    });

    it("refreshes the mounted tree on explorer.changed", async () => {
      const refreshes = [];
      const originalRefresh = ExplorerService.refreshTree;
      ExplorerService.refreshTree = async () => { refreshes.push("refresh"); };
      try {
        ExplorerService._setTree({});
        emitAppEvent({ type: "explorer.changed", revision: 1, payload: { file: "a.ts" } });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepStrictEqual(refreshes, ["refresh"]);
      } finally {
        ExplorerService._setTree(null);
        ExplorerService.refreshTree = originalRefresh;
      }
    });

    it("refreshes the mounted tree on resync", async () => {
      const refreshes = [];
      const originalRefresh = ExplorerService.refreshTree;
      ExplorerService.refreshTree = async () => { refreshes.push("refresh"); };
      try {
        ExplorerService._setTree({});
        emitAppEvent({ type: "resync", revision: 0 });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepStrictEqual(refreshes, ["refresh"]);
      } finally {
        ExplorerService._setTree(null);
        ExplorerService.refreshTree = originalRefresh;
      }
    });

    it("POSTs permission confirmation decisions back to the server", async () => {
      const calls = [];
      const oldConfirmPermissionAsync = global.confirmPermissionAsync;
      const oldConfirmAsync = global.confirmAsync;
      const oldFetch = global.fetch;
      const oldRefreshPermissionsPanel = global.refreshPermissionsPanel;
      try {
        global.confirmPermissionAsync = async (input) => {
          calls.push({ type: "confirm", input });
          return "workspace";
        };
        global.confirmAsync = async () => false;
        global.refreshPermissionsPanel = async () => {
          calls.push({ type: "refreshPermissionsPanel" });
        };
        global.fetch = async (url, options = {}) => {
          calls.push({ type: "fetch", url: String(url), options });
          return { ok: true, json: async () => ({ ok: true }) };
        };

        emitAppEvent({
          type: "permission.confirm",
          revision: 2,
          payload: {
            id: "perm-test",
            source: "file.write",
            operation: "write",
            root: "E:\\\\workspace",
            path: "E:\\\\outside\\\\file.txt",
            reason: "Write path is outside workspace/authorized roots",
            permissionSuggestions: [{ type: "addPathRule", rule: { ruleContent: "Write(E:\\\\outside\\\\**)" } }],
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        const confirm = calls.find((call) => call.type === "confirm");
        assert.strictEqual(confirm.input.source, "file.write");
        assert.strictEqual(confirm.input.operation, "write");
        assert.strictEqual(confirm.input.path, "E:\\\\outside\\\\file.txt");

        const post = calls.find((call) => call.type === "fetch" && call.url === "/api/permissions/confirm");
        assert.ok(post, "confirmation POST should be sent");
        assert.strictEqual(post.options.method, "POST");
        assert.deepStrictEqual(JSON.parse(post.options.body), {
          id: "perm-test",
          allow: true,
          scope: "workspace",
        });
        assert.ok(calls.some((call) => call.type === "refreshPermissionsPanel"));
      } finally {
        global.confirmPermissionAsync = oldConfirmPermissionAsync;
        global.confirmAsync = oldConfirmAsync;
        global.fetch = oldFetch;
        global.refreshPermissionsPanel = oldRefreshPermissionsPanel;
      }
    });

    it("does not let a stale tree unsubscribe the current tree", async () => {
      const firstTree = {};
      const secondTree = {};
      const refreshes = [];
      const originalRefresh = ExplorerService.refreshTree;
      ExplorerService.refreshTree = async () => { refreshes.push(ExplorerService._getTree()); };
      try {
        ExplorerService._setTree(firstTree);
        const staleUnsubscribe = subscriptionRecords.at(-1).unsubscribe;
        ExplorerService._setTree(secondTree);
        staleUnsubscribe?.();
        emitAppEvent({ type: "explorer.changed", revision: 3, payload: {} });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.deepStrictEqual(refreshes, [secondTree]);
      } finally {
        ExplorerService._setTree(null);
        ExplorerService.refreshTree = originalRefresh;
      }
    });

    it("ignores a stale resync callback after dispose and remount", async () => {
      const firstTree = {};
      const secondTree = {};
      const refreshes = [];
      const originalRefresh = ExplorerService.refreshTree;
      ExplorerService.refreshTree = async () => { refreshes.push(ExplorerService._getTree()); };
      try {
        ExplorerService._setTree(firstTree);
        const staleSubscription = subscriptionRecords.findLast((record) => record.type === "resync");
        assert.ok(staleSubscription, "resync should be subscribed for the mounted tree");
        ExplorerService._setTree(null);
        ExplorerService._setTree(secondTree);

        staleSubscription.handler({ type: "resync", revision: 0 });
        emitAppEvent({ type: "resync", revision: 0 });
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.deepStrictEqual(refreshes, [secondTree]);
      } finally {
        ExplorerService._setTree(null);
        ExplorerService.refreshTree = originalRefresh;
      }
    });
  });

  describe("refreshTree", () => {
    it("does not apply an old refresh after remounting a new tree", async () => {
      let resolveOldFetch;
      const oldTreeWrites = [];
      const newTreeWrites = [];
      global.fetch = () => new Promise((resolve) => { resolveOldFetch = resolve; });
      ExplorerService.setWorkspacePath("/workspace");
      ExplorerService._setTree({
        clearChildCache: () => {},
        setData: (data) => oldTreeWrites.push(data),
      });

      const pending = ExplorerService.refreshTree();
      ExplorerService._setTree({
        clearChildCache: () => {},
        setData: (data) => newTreeWrites.push(data),
      });
      resolveOldFetch({
        ok: true,
        json: async () => ({ items: [], rootDir: "/workspace", relativePath: "" }),
      });
      await pending;

      assert.deepStrictEqual(oldTreeWrites, []);
      assert.deepStrictEqual(newTreeWrites, []);
      ExplorerService._setTree(null);
    });

    it("does not apply an old refresh after switching workspace", async () => {
      let resolveOldFetch;
      const writes = [];
      global.fetch = () => new Promise((resolve) => { resolveOldFetch = resolve; });
      ExplorerService.setWorkspacePath("/old-workspace");
      ExplorerService._setTree({
        clearChildCache: () => {},
        setData: (data) => writes.push(data),
      });

      const pending = ExplorerService.refreshTree();
      ExplorerService.setWorkspacePath("/new-workspace");
      resolveOldFetch({
        ok: true,
        json: async () => ({ items: [], rootDir: "/old-workspace", relativePath: "" }),
      });
      await pending;

      assert.deepStrictEqual(writes, []);
      ExplorerService._setTree(null);
    });

    it("does not apply an old refresh after remounting the same tree instance", async () => {
      let resolveOldFetch;
      const writes = [];
      const tree = {
        clearChildCache: () => {},
        setData: (data) => writes.push(data),
      };
      global.fetch = () => new Promise((resolve) => { resolveOldFetch = resolve; });
      ExplorerService.setWorkspacePath("/workspace");
      ExplorerService._setTree(tree);

      const pending = ExplorerService.refreshTree();
      ExplorerService._setTree(null);
      ExplorerService._setTree(tree);
      resolveOldFetch({
        ok: true,
        json: async () => ({ items: [], rootDir: "/workspace", relativePath: "" }),
      });
      await pending;

      assert.deepStrictEqual(writes, []);
      ExplorerService._setTree(null);
    });

    it("coalesces concurrent changed and resync events into one trailing refresh", async () => {
      const deferredFetches = [];
      const writes = [];
      global.fetch = () => new Promise((resolve) => { deferredFetches.push(resolve); });
      ExplorerService.setWorkspacePath("/test");
      ExplorerService._setTree({
        clearChildCache: () => {},
        setData: (data) => writes.push(data),
      });

      const pending = ExplorerService.refreshTree();
      emitAppEvent({ type: "explorer.changed", revision: 4, payload: { file: "old.ts" } });
      emitAppEvent({ type: "resync", revision: 0 });
      assert.strictEqual(deferredFetches.length, 1);

      deferredFetches[0]({
        ok: true,
        json: async () => ({
          items: [{ path: "old.ts", name: "old.ts", isDir: false }],
          rootDir: "/test",
          relativePath: "",
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.strictEqual(deferredFetches.length, 2);
      assert.deepStrictEqual(writes, []);

      deferredFetches[1]({
        ok: true,
        json: async () => ({
          items: [{ path: "latest.ts", name: "latest.ts", isDir: false }],
          rootDir: "/test",
          relativePath: "",
        }),
      });
      await pending;

      assert.strictEqual(deferredFetches.length, 2);
      assert.strictEqual(writes.length, 1);
      assert.strictEqual(writes[0][0].id, "latest.ts");
      ExplorerService._setTree(null);
    });

    it("快照未变化时跳过整棵树重绘", async () => {
      const calls = [];
      let expandedRefreshes = 0;
      global.document = {
        createElement: () => ({ textContent: "", innerHTML: "" }),
        getElementById: () => null,
      };
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          items: [
            { path: "src", name: "src", isDir: true, mtime: "2026-07-13T00:00:00.000Z" },
            { path: "package.json", name: "package.json", isDir: false, mtime: "2026-07-13T00:00:00.000Z" },
          ],
          rootDir: "/test",
          relativePath: "",
        }),
      });
      ExplorerService._setTree({
        clearChildCache: () => {},
        refreshExpandedChildren: async () => { expandedRefreshes += 1; },
        setData: (data) => calls.push(data),
        render: () => {},
        _findNodeById: () => null,
      });
      ExplorerService.setWorkspacePath("/test");

      await ExplorerService.refreshTree();
      await ExplorerService.refreshTree();

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(expandedRefreshes, 1);
    });

    it("刷新时过滤刚删除但被 stale fetch 拉回的节点", async () => {
      const calls = [];
      global.fetch = async () => ({
        ok: true,
        json: async () => ({
          items: [{ path: "647", name: "647", isDir: true }],
          rootDir: "/test",
          relativePath: "",
        }),
      });
      ExplorerService._setTree({
        clearChildCache: () => {},
        setData: (data) => calls.push(data),
        render: () => {},
        _findNodeById: () => null,
      });
      ExplorerService.setWorkspacePath("/test");
      ExplorerService._pendingDeletedPaths.clear();
      ExplorerService.markDeleted("647");

      await ExplorerService.refreshTree();

      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], []);
      assert.strictEqual(ExplorerService._pendingDeletedPaths.has("647"), true);
    });

    it("父目录确认节点不存在后清理删除标记", async () => {
      const calls = [];
      global.fetch = async () => ({
        ok: true,
        json: async () => ({ items: [], rootDir: "/test", relativePath: "" }),
      });
      ExplorerService._setTree({
        clearChildCache: () => {},
        setData: (data) => calls.push(data),
        render: () => {},
        _findNodeById: () => null,
      });
      ExplorerService.setWorkspacePath("/test");
      ExplorerService._pendingDeletedPaths.clear();
      ExplorerService.markDeleted("647");

      await ExplorerService.refreshTree();

      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], []);
      assert.strictEqual(ExplorerService._pendingDeletedPaths.has("647"), false);
    });
  });
});
