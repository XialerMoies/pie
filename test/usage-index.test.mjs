/**
 * usage-index 单元测试
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

let mod;

function ts() { return new Date().toISOString(); }

function mkSessionFile(dir, id, lines) {
  const f = resolve(dir, id + ".jsonl");
  writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

before(async () => {
  mod = await import("../src/server/usage-index.ts");
});

describe("scanSessionFile", () => {
  it("解析正常 session 返回 id 和 usage", () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    const f = mkSessionFile(root, "s1", [
      JSON.stringify({ type: "session", id: "s1", cwd: "/w" }),
      JSON.stringify({ type: "session_info", name: "My Session" }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1.0 } } } }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } } }),
      JSON.stringify({ type: "compaction", summary: "compact!", timestamp: ts() }),
    ]);
    const result = mod.scanSessionFile(f);
    assert.ok(result, "应有解析结果");
    assert.strictEqual(result.id, "s1");
    assert.strictEqual(result.usage.name, "My Session");
    assert.strictEqual(result.usage.workspace, "/w");
    assert.strictEqual(result.usage.input, 11);
    assert.strictEqual(result.usage.output, 22);
    assert.strictEqual(result.usage.cacheRead, 33);
    assert.strictEqual(result.usage.cacheWrite, 44);
    assert.strictEqual(result.usage.cost, 1.5, "cost 总和 1.0 + 0.5");
    assert.strictEqual(result.usage.compactCount, 1);
  });

  it("无 id 时返回 null", () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    const f = mkSessionFile(root, "bad", [
      JSON.stringify({ type: "unknown" }),
    ]);
    const result = mod.scanSessionFile(f);
    assert.strictEqual(result, null);
  });

  it("空 cost 为 0", () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    const f = mkSessionFile(root, "s3", [
      JSON.stringify({ type: "session", id: "s3" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
    ]);
    const result = mod.scanSessionFile(f);
    assert.ok(result);
    assert.strictEqual(result.usage.cost, 0);
    assert.strictEqual(result.usage.input, 0);
  });

  it("无显式名称时使用最新有效 assistant 标题", () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    const f = mkSessionFile(root, "s4", [
      JSON.stringify({ type: "session", id: "s4" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "你好！有什么需要帮助的吗？今天要在 pay 项目上做什么？" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "可以，先看核心问题\n\n1. 支付回调签名校验风险\n2. 订单状态并发更新问题" }], usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: { total: 0.2 } } } }),
    ]);
    const result = mod.scanSessionFile(f);
    assert.ok(result);
    assert.strictEqual(result.usage.name, "支付回调签名校验风险");
  });
});

describe("fullScan", () => {
  it("扫描多文件返回正确 key", () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    mkdirSync(resolve(root, "proj"), { recursive: true });
    mkSessionFile(resolve(root, "proj"), "s1", [
      JSON.stringify({ type: "session", id: "s1" }),
    ]);
    mkSessionFile(resolve(root, "proj"), "s2", [
      JSON.stringify({ type: "session", id: "s2" }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 2.0 } } } }),
    ]);
    const idx = mod.fullScan(root);
    assert.strictEqual(Object.keys(idx.sessions).length, 2);
    assert.ok(idx.sessions.s1);
    assert.ok(idx.sessions.s2);
    assert.strictEqual(idx.sessions.s2.input, 100);
    // key 是 session id 不是文件名
    assert.ok(!idx.sessions.proj);
  });

  it("同名文件不同目录不同 session id 不覆盖", () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    mkdirSync(resolve(root, "a"), { recursive: true });
    mkdirSync(resolve(root, "b"), { recursive: true });
    // 两个文件名都是 same.jsonl，但 session id 不同
    mkSessionFile(resolve(root, "a"), "same", [
      JSON.stringify({ type: "session", id: "s1", cwd: "/a" }),
    ]);
    mkSessionFile(resolve(root, "b"), "same", [
      JSON.stringify({ type: "session", id: "s2", cwd: "/b" }),
    ]);
    const idx = mod.fullScan(root);
    assert.strictEqual(Object.keys(idx.sessions).length, 2, "两个 session 都保留");
    assert.ok(idx.sessions.s1, "s1 存在");
    assert.ok(idx.sessions.s2, "s2 存在");
    assert.strictEqual(idx.sessions.s1.workspace, "/a");
    assert.strictEqual(idx.sessions.s2.workspace, "/b");
  });
});

describe("incrementalScan", () => {
  it("只更新 mtime 更新的文件", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    const f = mkSessionFile(root, "s1", [
      JSON.stringify({ type: "session", id: "s1" }),
    ]);
    const idx = mod.fullScan(root);
    assert.strictEqual(idx.sessions.s1.input, 0);

    // 追加内容
    writeFileSync(f, [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 99, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } } }),
    ].join("\n") + "\n");

    const next = mod.incrementalScan(root, idx);
    assert.strictEqual(next.sessions.s1.input, 99);

    // 再次增量扫描（无变化）应为相同
    const stable = mod.incrementalScan(root, next);
    assert.strictEqual(stable.sessions.s1.input, 99);
  });

  it("清理已删除文件", () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    const f = mkSessionFile(root, "s1", [
      JSON.stringify({ type: "session", id: "s1" }),
    ]);
    const idx = mod.fullScan(root);
    assert.ok(idx.sessions.s1);

    unlinkSync(f);
    const next = mod.incrementalScan(root, idx);
    assert.strictEqual(next.sessions.s1, undefined, "已删除 session 应被清除");
  });
});

describe("updateSessionInIndex", () => {
  it("fullScan / incrementalScan 缺目录不抛异常", () => {
    const root = resolve(tmpdir(), "definitely-missing-" + Date.now());
    const idx = mod.fullScan(root);
    assert.strictEqual(Object.keys(idx.sessions).length, 0, "缺目录返回空索引");
    const next = mod.incrementalScan(root, { version: 2, updatedAt: "x", sessions: {} });
    assert.strictEqual(Object.keys(next.sessions).length, 0, "缺目录增量扫描返回空");
  });

  it("单文件更新", () => {
    const root = mkdtempSync(resolve(tmpdir(), "usage-test-"));
    mkSessionFile(root, "s1", [
      JSON.stringify({ type: "session", id: "s1" }),
    ]);
    const f2 = mkSessionFile(root, "s2", [
      JSON.stringify({ type: "session", id: "s2" }),
      JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } } }),
    ]);
    const idx = mod.fullScan(root);
    assert.strictEqual(Object.keys(idx.sessions).length, 2);

    const updated = mod.updateSessionInIndex(root, f2, idx);
    assert.strictEqual(Object.keys(updated.sessions).length, 2);
    assert.strictEqual(updated.sessions.s2.input, 50);
    assert.ok(updated.updatedAt >= idx.updatedAt);
  });
});
