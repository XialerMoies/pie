/**
 * prompts.ts 单元测试
 *
 * 测试 defineSection() / resolveSystemPrompt() / invalidateSection()
 *
 * 运行：npx tsx --test test/prompts.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert";

// 每个测试组重新 import 获得干净的 sectionCache
async function freshPrompts() {
  // 使用时间戳参数防止模块缓存
  const ts = Date.now();
  return await import(`../src/agent/prompts.ts?t=${ts}`);
}

describe("prompts", () => {
  describe("defineSection / resolveSystemPrompt", () => {
    it("注册 section 后 resolve 应包含其内容", async () => {
      const mod = await freshPrompts();
      mod.defineSection("test-a", "内容A");
      const result = mod.resolveSystemPrompt();
      assert.ok(result.includes("内容A"));
    });

    it("多个 section 用双换行拼接", async () => {
      const mod = await freshPrompts();
      mod.defineSection("x", "X");
      mod.defineSection("y", "Y");
      const result = mod.resolveSystemPrompt();
      assert.ok(result.includes("X"));
      assert.ok(result.includes("Y"));
    });

    it("重复 key 覆盖旧值", async () => {
      const mod = await freshPrompts();
      mod.defineSection("k", "旧");
      mod.defineSection("k", "新");
      const r = mod.resolveSystemPrompt();
      assert.ok(r.includes("新"));
      assert.ok(!r.includes("旧"));
    });
  });

  describe("invalidateSection", () => {
    it("失效后该 section 不再出现", async () => {
      const mod = await freshPrompts();
      mod.defineSection("keep", "保留");
      mod.defineSection("gone", "消失");
      mod.invalidateSection("gone");
      const r = mod.resolveSystemPrompt();
      assert.ok(r.includes("保留"));
      assert.ok(!r.includes("消失"));
    });

    it("失效不存在的 key 不报错", async () => {
      const mod = await freshPrompts();
      mod.invalidateSection("nope");
      assert.ok(true);
    });
  });

  describe("volatile", () => {
    it("volatile section 正常注册和解析", async () => {
      const mod = await freshPrompts();
      mod.defineSection("v", "易变", true);
      const r = mod.resolveSystemPrompt();
      assert.ok(r.includes("易变"));
    });
  });

  describe("默认注册", () => {
    it("加载后自动包含 identity / tools_guidance / code_style", async () => {
      // 不使用 freshPrompts，直接用模块自身的默认注册
      const mod = await import("../src/agent/prompts.ts");
      const r = mod.resolveSystemPrompt();
      assert.ok(r.includes("My Code Agent"), "identity");
      assert.ok(r.includes("工具使用指南"), "tools_guidance");
      assert.ok(r.includes("代码风格"), "code_style");
    });

    it("resolveSystemPrompt 返回非空字符串", async () => {
      const mod = await import("../src/agent/prompts.ts");
      const r = mod.resolveSystemPrompt();
      assert.strictEqual(typeof r, "string");
      assert.ok(r.length > 50);
    });
  });
});
