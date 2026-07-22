/**
 * MCP 信任存储单元测试
 *
 * 测试：
 * 1. hashServerCommand — hash 确定性/变化检测/env 排序/cwd/transport 敏感
 * 2. TrustStore — 添加/检查/移除/清空/持久化
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

let TrustStore, hashServerCommand;

before(async () => {
  const mod = await import("../src/agent/mcp/trust-store.ts");
  TrustStore = mod.TrustStore;
  hashServerCommand = mod.hashServerCommand;
});

// ─── hashServerCommand ──────────────────────────

describe("hashServerCommand", () => {
  it("相同 config 产生相同 hash", () => {
    const cfg = { command: "npx", args: ["-y", "server"] };
    assert.strictEqual(hashServerCommand(cfg), hashServerCommand(cfg));
  });

  it("不同 args 产生不同 hash", () => {
    const a = hashServerCommand({ command: "npx", args: ["-y", "server-a"] });
    const b = hashServerCommand({ command: "npx", args: ["-y", "server-b"] });
    assert.notStrictEqual(a, b);
  });

  it("不同 command 产生不同 hash", () => {
    const a = hashServerCommand({ command: "node", args: ["server.js"] });
    const b = hashServerCommand({ command: "npx", args: ["server.js"] });
    assert.notStrictEqual(a, b);
  });

  it("args 顺序影响 hash", () => {
    const a = hashServerCommand({ command: "cmd", args: ["a", "b"] });
    const b = hashServerCommand({ command: "cmd", args: ["b", "a"] });
    assert.notStrictEqual(a, b);
  });

  it("env 变化影响 hash", () => {
    const base = { command: "node", args: ["server.js"] };
    const withEnv = { command: "node", args: ["server.js"], env: { FOO: "bar" } };
    assert.notStrictEqual(
      hashServerCommand(base),
      hashServerCommand(withEnv),
    );
  });

  it("env key 顺序不影响 hash", () => {
    const a = hashServerCommand({ command: "x", args: [], env: { A: "1", B: "2" } });
    const b = hashServerCommand({ command: "x", args: [], env: { B: "2", A: "1" } });
    assert.strictEqual(a, b);
  });

  it("cwd 变化影响 hash", () => {
    const a = hashServerCommand({ command: "node", args: ["s.js"] });
    const b = hashServerCommand({ command: "node", args: ["s.js"], cwd: "/other" });
    assert.notStrictEqual(a, b);
  });

  it("transport 默认值与显式 stdio 等值", () => {
    const a = hashServerCommand({ command: "x", args: [] });
    const b = hashServerCommand({ command: "x", args: [], transport: "stdio" });
    assert.strictEqual(a, b);
  });

  it("http server hash 基于 url + headers", () => {
    const hash = hashServerCommand({ transport: "http", url: "https://mcp.example.com/api" });
    assert.ok(typeof hash === "string" && hash.length > 0);
  });

  it("不同 http url 产生不同 hash", () => {
    const a = hashServerCommand({ transport: "http", url: "https://mcp.example.com/a" });
    const b = hashServerCommand({ transport: "http", url: "https://mcp.example.com/b" });
    assert.notStrictEqual(a, b);
  });

  it("http headers 顺序不影响 hash", () => {
    const a = hashServerCommand({ transport: "http", url: "https://x.com", headers: { A: "1", B: "2" } });
    const b = hashServerCommand({ transport: "http", url: "https://x.com", headers: { B: "2", A: "1" } });
    assert.strictEqual(a, b);
  });

  it("空 args / url 也能工作", () => {
    const hash = hashServerCommand({ command: "node server.js", args: [] });
    assert.ok(typeof hash === "string" && hash.length > 0);

    const h2 = hashServerCommand({ transport: "http", url: "https://x.com" });
    assert.ok(typeof h2 === "string" && h2.length > 0);
  });
});

// ─── TrustStore ────────────────────────────────

function tmpPath() {
  return resolve(mkdtempSync(resolve(tmpdir(), "mcp-trust-test-")), "trust.json");
}
function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

describe("TrustStore", () => {
  it("新建空 store 无信任记录", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      assert.strictEqual(store.getAllRecords().length, 0);
    } finally { cleanup(dirname(p)); }
  });

  it("添加信任后 isTrusted 返回 true", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      const hash = hashServerCommand({ command: "npx", args: ["foo"] });
      store.addTrust("/workspace", hash, "test-server");
      assert.ok(store.isTrusted("/workspace", hash));
    } finally { cleanup(dirname(p)); }
  });

  it("未添加的信任返回 false", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      assert.strictEqual(
        store.isTrusted("/workspace", hashServerCommand({ command: "npx", args: ["foo"] })),
        false,
      );
    } finally { cleanup(dirname(p)); }
  });

  it("不同 workspace 的信任隔离", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      const hash = hashServerCommand({ command: "npx", args: ["foo"] });
      store.addTrust("/workspace-a", hash, "server");
      assert.ok(store.isTrusted("/workspace-a", hash));
      assert.strictEqual(store.isTrusted("/workspace-b", hash), false);
    } finally { cleanup(dirname(p)); }
  });

  it("hash 变化后不再信任", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      const hash1 = hashServerCommand({ command: "npx", args: ["old"] });
      const hash2 = hashServerCommand({ command: "npx", args: ["new"] });
      store.addTrust("/workspace", hash1, "server");
      assert.ok(store.isTrusted("/workspace", hash1));
      assert.strictEqual(store.isTrusted("/workspace", hash2), false);
    } finally { cleanup(dirname(p)); }
  });

  it("removeTrust 正确移除", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      const hash = hashServerCommand({ command: "npx", args: ["foo"] });
      store.addTrust("/workspace", hash, "server");
      assert.ok(store.isTrusted("/workspace", hash));
      store.removeTrust("/workspace", hash);
      assert.strictEqual(store.isTrusted("/workspace", hash), false);
    } finally { cleanup(dirname(p)); }
  });

  it("addTrust 更新已有记录且不重复", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      const hash = hashServerCommand({ command: "npx", args: ["foo"] });
      store.addTrust("/workspace", hash, "server");
      const t1 = store.getAllRecords()[0].trustedAt;
      store.addTrust("/workspace", hash, "server");
      const t2 = store.getAllRecords()[0].trustedAt;
      assert.ok(t2 >= t1);
      assert.strictEqual(store.getWorkspaceRecords("/workspace").length, 1);
    } finally { cleanup(dirname(p)); }
  });

  it("clearWorkspace 只清除指定 workspace", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      const hash = hashServerCommand({ command: "npx", args: ["foo"] });
      store.addTrust("/ws1", hash, "s1");
      store.addTrust("/ws2", hash, "s2");
      store.clearWorkspace("/ws1");
      assert.strictEqual(store.getWorkspaceRecords("/ws1").length, 0);
      assert.strictEqual(store.getWorkspaceRecords("/ws2").length, 1);
    } finally { cleanup(dirname(p)); }
  });

  it("clearAll 清空所有", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      const hash = hashServerCommand({ command: "npx", args: ["foo"] });
      store.addTrust("/ws1", hash, "s1");
      store.addTrust("/ws2", hash, "s2");
      store.clearAll();
      assert.strictEqual(store.getAllRecords().length, 0);
    } finally { cleanup(dirname(p)); }
  });

  it("持久化：写入文件后重新加载可读", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mcp-trust-test-"));
    try {
      const filePath = resolve(dir, "trust.json");
      const store = new TrustStore({ filePath });
      const hash = hashServerCommand({ command: "npx", args: ["persist-test"] });
      store.addTrust("/ws", hash, "persisted-server");

      const store2 = new TrustStore({ filePath });
      assert.ok(store2.isTrusted("/ws", hash));
      assert.strictEqual(store2.getAllRecords().length, 1);
      assert.strictEqual(store2.getAllRecords()[0].label, "persisted-server");
    } finally { cleanup(dir); }
  });

  it("持久化：文件损坏时从空记录开始", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mcp-trust-test-"));
    try {
      const filePath = resolve(dir, "corrupt.json");
      writeFileSync(filePath, "not-json", "utf-8");
      const store = new TrustStore({ filePath });
      assert.strictEqual(store.getAllRecords().length, 0);
    } finally { cleanup(dir); }
  });

  it("文件不存在时从空记录开始", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mcp-trust-test-"));
    try {
      const filePath = resolve(dir, "nonexistent.json");
      const store = new TrustStore({ filePath });
      assert.strictEqual(store.getAllRecords().length, 0);
    } finally { cleanup(dir); }
  });

  it("getWorkspaceRecords 只返回指定 workspace", () => {
    const p = tmpPath();
    try {
      const store = new TrustStore({ filePath: p });
      const h1 = hashServerCommand({ command: "npx", args: ["a"] });
      const h2 = hashServerCommand({ command: "npx", args: ["b"] });
      store.addTrust("/ws1", h1, "s1");
      store.addTrust("/ws2", h2, "s2");
      store.addTrust("/ws1", h2, "s3");

      assert.strictEqual(store.getWorkspaceRecords("/ws1").length, 2);
      assert.strictEqual(store.getWorkspaceRecords("/ws2").length, 1);
    } finally { cleanup(dirname(p)); }
  });
});
