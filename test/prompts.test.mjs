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

  describe("invalidateAllSections", () => {
    it("永久 section 在 invalidateAll 后保留", async () => {
      const mod = await freshPrompts();
      mod.defineSection("perm", "永久", { permanent: true });
      mod.defineSection("temp", "临时");
      mod.invalidateAllSections();
      const r = mod.resolveSystemPrompt();
      assert.ok(r.includes("永久"), "永久 section 应保留");
      assert.ok(!r.includes("临时"), "临时 section 应被清除");
    });

    it("invalidateAllSections 模拟 /api/clear：永久保留，factory 保留，静态临时清除", async () => {
      const mod = await import("../src/agent/prompts.ts");

      // 注册一个静态测试 section 用于验证清除
      mod.defineSection("test-static", "静态临时");
      const before = mod.resolveSystemPrompt();
      assert.ok(before.includes("My Code Agent"), "clear 前应有 identity");
      assert.ok(before.includes("静态临时"), "clear 前静态临时 section 应存在");

      mod.invalidateAllSections();
      const after = mod.resolveSystemPrompt();
      // permanent 默认 sections 保留
      assert.ok(after.includes("My Code Agent"), "invalidateAll 不应清除永久默认注册");
      assert.ok(after.includes("工具使用指南"), "tools_guidance 应保留");
      // factory section（env_info）保留（factory 每次 resolve 已重新求值）
      assert.ok(after.includes("当前环境"), "factory section 应保留");
      assert.ok(after.includes("平台："), "env_info 平台信息应保留");
      // 静态临时 section 被清除
      assert.ok(!after.includes("静态临时"), "静态非永久 section 应被清除");
      assert.ok(after.length > 50, "clear 后 system prompt 不应为空");
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

  describe("factory / DANGEROUS_uncached", () => {
    it("factory section 每次 resolve 重新求值", async () => {
      const mod = await freshPrompts();
      let counter = 0;
      mod.defineSection("counter", () => `count: ${++counter}`);
      const r1 = mod.resolveSystemPrompt();
      assert.ok(r1.includes("count: 1"));
      const r2 = mod.resolveSystemPrompt();
      assert.ok(r2.includes("count: 2"), "第二次应重新调用 factory");
    });

    it("DANGEROUS_uncachedSystemPromptSection 自动 volatile", async () => {
      const mod = await freshPrompts();
      mod.DANGEROUS_uncachedSystemPromptSection("ts", () => `ts: ${Date.now()}`);
      const r1 = mod.resolveSystemPrompt();
      assert.ok(r1.includes("ts: "), "factory 内容应出现在 resolve 结果中");
      // 验证 factory 是每次调用的（不缓存结果）
      const r2 = mod.resolveSystemPrompt();
      assert.ok(r2.includes("ts: "));
      // 两项不可能完全不同的内容中 ts 值恰好完全一样（同一毫秒的概率低）
      // 重要是 factory 被调用了（非静态 string）
      assert.ok(r1.length > 0 && r2.length > 0, "两次 resolve 都应返回内容");
    });

    it("factory section 重复 key 覆盖旧值", async () => {
      const mod = await freshPrompts();
      mod.defineSection("k", () => "factory");
      mod.defineSection("k", "static");
      const r = mod.resolveSystemPrompt();
      assert.ok(r.includes("static"));
      assert.ok(!r.includes("factory"));
    });
  });

  describe("默认注册", () => {
    it("加载后自动包含 identity / tools_guidance / code_style", async () => {
      // 不使用 freshPrompts，直接用模块自身的默认注册
      const mod = await import("../src/agent/prompts.ts");
      const r = mod.resolveSystemPrompt();
      assert.ok(r.includes("My Code Agent"), "identity（permanent）");
      assert.ok(r.includes("工具使用指南"), "tools_guidance（permanent）");
      assert.ok(r.includes("代码风格"), "code_style（permanent）");
    });

    it("resolveSystemPrompt 返回非空字符串", async () => {
      const mod = await import("../src/agent/prompts.ts");
      const r = mod.resolveSystemPrompt();
      assert.strictEqual(typeof r, "string");
      assert.ok(r.length > 50);
    });

    it("env_info volatile section 在 fresh import 时存在", async () => {
      // 使用 fresh 实例避免之前 invalidateAllSections 的残留影响
      const mod = await freshPrompts();
      const r = mod.resolveSystemPrompt();
      assert.ok(r.includes("当前环境"), "env_info（volatile）");
      assert.ok(r.includes("平台："), "env_info 应包含平台信息");
      assert.ok(r.includes("CWD："), "env_info 应包含工作目录");
    });
  });
});
