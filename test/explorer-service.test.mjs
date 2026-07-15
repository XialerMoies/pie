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
      ExplorerService._setTree({ setData: (data) => calls.push(data), render: () => {}, _findNodeById: () => null });
      ExplorerService.setWorkspacePath("/test");

      await ExplorerService.refreshTree();
      await ExplorerService.refreshTree();

      assert.strictEqual(calls.length, 1);
    });
  });
});
