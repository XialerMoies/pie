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
global.App = {
  State: {
    getWorkspacePath: () => workspacePath,
    setWorkspacePath: (path) => { workspacePath = path; },
  },
  Preferences: {
    getBoolean: (key, fallback = false) => {
      const value = store[key];
      return value == null ? fallback : value === true || value === "true";
    },
    setBoolean: (key, value) => { store[key] = Boolean(value); },
  },
};
global.window = global;
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

  before(async () => {
    const mod = await import("../src/frontend/service/explorer-service.ts");
    ExplorerService = mod.ExplorerService;
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

  describe("events permission confirmation", () => {
    function createMockEventSource(onCreate) {
      return class {
        constructor(url) {
          this.url = url;
          this.closed = false;
          this.listeners = new Map();
          onCreate(this);
        }
        addEventListener(type, listener) {
          this.listeners.set(type, listener);
        }
        removeEventListener(type, listener) {
          if (this.listeners.get(type) === listener) this.listeners.delete(type);
        }
        emit(type, event = {}) {
          this.listeners.get(type)?.(event);
        }
        close() {
          this.closed = true;
        }
      };
    }

    it("does not connect until startEvents is called", async () => {
      let eventSource;
      const oldEventSource = global.EventSource;
      try {
        global.EventSource = createMockEventSource((source) => { eventSource = source; });

        await import(`../src/frontend/service/explorer-service.ts?event-gate=${Date.now()}`);
        assert.equal(eventSource, undefined);
        const ready = ExplorerService.startEvents();
        assert.ok(eventSource, "EventSource should be created after authentication");
        assert.strictEqual(eventSource.url, "/api/events");
        assert.strictEqual(typeof eventSource.listeners.get("open"), "function");
        eventSource.emit("open");
        await ready;
      } finally {
        ExplorerService.stopEvents();
        global.EventSource = oldEventSource;
      }
    });

    it("POSTs permission confirmation decisions back to the server", async () => {
      let eventSource;
      const calls = [];
      const oldEventSource = global.EventSource;
      const oldConfirmPermissionAsync = global.confirmPermissionAsync;
      const oldConfirmAsync = global.confirmAsync;
      const oldFetch = global.fetch;
      const oldRefreshPermissionsPanel = global.refreshPermissionsPanel;
      try {
        global.EventSource = createMockEventSource((source) => { eventSource = source; });
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

        const ready = ExplorerService.startEvents();
        assert.ok(eventSource, "EventSource should be created");
        assert.strictEqual(eventSource.url, "/api/events");
        eventSource.emit("open");
        await ready;

        eventSource.emit("message", {
          data: JSON.stringify({
            type: "permission_confirm",
            id: "perm-test",
            source: "file.write",
            operation: "write",
            root: "E:\\\\workspace",
            path: "E:\\\\outside\\\\file.txt",
            reason: "Write path is outside workspace/authorized roots",
            permissionSuggestions: [{ type: "addPathRule", rule: { ruleContent: "Write(E:\\\\outside\\\\**)" } }],
          }),
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
        ExplorerService.stopEvents();
        global.EventSource = oldEventSource;
        global.confirmPermissionAsync = oldConfirmPermissionAsync;
        global.confirmAsync = oldConfirmAsync;
        global.fetch = oldFetch;
        global.refreshPermissionsPanel = oldRefreshPermissionsPanel;
      }
    });

    it("detaches stopped listeners and ignores stale events after restart", async () => {
      const streams = [];
      const oldEventSource = global.EventSource;
      const oldFetch = global.fetch;
      try {
        global.EventSource = createMockEventSource((source) => { streams.push(source); });
        const refreshes = [];
        const originalRefresh = ExplorerService.refreshTree;
        ExplorerService.refreshTree = async () => { refreshes.push("refresh"); };
        global.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });

        const firstReady = ExplorerService.startEvents();
        streams[0].emit("open");
        await firstReady;
        const staleMessage = streams[0].listeners.get("message");

        ExplorerService.stopEvents();
        assert.equal(streams[0].closed, true);
        assert.equal(streams[0].listeners.size, 0);

        const secondReady = ExplorerService.startEvents();
        streams[1].emit("open");
        await secondReady;
        staleMessage?.({ data: JSON.stringify({ type: "refresh" }) });
        streams[1].emit("message", { data: JSON.stringify({ type: "refresh" }) });
        await new Promise((resolve) => setTimeout(resolve, 0));

        assert.deepStrictEqual(refreshes, ["refresh"]);
        ExplorerService.refreshTree = originalRefresh;
      } finally {
        ExplorerService.stopEvents();
        global.EventSource = oldEventSource;
        global.fetch = oldFetch;
      }
    });

    it("disposes listeners after a startup error and permits a clean retry", async () => {
      const streams = [];
      const oldEventSource = global.EventSource;
      try {
        global.EventSource = createMockEventSource((source) => { streams.push(source); });

        const failed = ExplorerService.startEvents();
        streams[0].emit("error");
        await assert.rejects(failed, /event channel failed/);
        assert.equal(streams[0].closed, true);
        assert.equal(streams[0].listeners.size, 0);

        const retried = ExplorerService.startEvents();
        streams[1].emit("open");
        await retried;
        assert.equal(ExplorerService._eventSource, streams[1]);
      } finally {
        ExplorerService.stopEvents();
        global.EventSource = oldEventSource;
      }
    });
  });

  describe("refreshTree", () => {
    it("快照未变化时跳过整棵树重绘", async () => {
      const calls = [];
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
        setData: (data) => calls.push(data),
        render: () => {},
        _findNodeById: () => null,
      });
      ExplorerService.setWorkspacePath("/test");

      await ExplorerService.refreshTree();
      await ExplorerService.refreshTree();

      assert.strictEqual(calls.length, 1);
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
