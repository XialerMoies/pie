/**
 * AGENT.md + memory/ 工具及运行时测试
 *
 * 覆盖：
 *   1. write_agent_md 写入当前 workspace
 *   2. read_memory / write_memory 拒绝路径穿越 (../x)
 *   3. validMemoryName 边界
 *   4. switchWorkspace 初始化失败回滚
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// ── 工具导入 ──────────────────────────────────────────────
import { writeAgentMdTool } from "../src/agent/tools/agent-md.ts";
import { readMemoryTool, writeMemoryTool, validMemoryName } from "../src/agent/tools/memory.ts";

// ── 模拟运行时（无副作用，仅验证工具）─────────────────────
function toolCtx(overrides = {}) {
  return { toolCallId: "call-1", workspace: "/tmp/test-workspace", ...overrides };
}

// ===================================================================
// 1. write_agent_md
// ===================================================================
describe("write_agent_md", () => {
  let dir;

  before(() => {
    dir = mkdtempSync(resolve(tmpdir(), "agent-md-test-"));
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("写入当前 workspace 根目录的 AGENT.md", async () => {
    const content = "# 测试项目\n\n用 pnpm 构建";
    const ctx = toolCtx({ workspace: dir });

    // verify the file does not exist before calling
    assert.strictEqual(existsSync(resolve(dir, "AGENT.md")), false);

    const result = await writeAgentMdTool.execute({ content }, ctx);
    assert.ok(result.includes("已更新"), "应返回成功提示");

    const written = readFileSync(resolve(dir, "AGENT.md"), "utf-8");
    assert.strictEqual(written, content);
  });

  it("写入不同 workspace 不影响其他项目", async () => {
    const dir2 = mkdtempSync(resolve(tmpdir(), "agent-md-test-2-"));
    try {
      await writeAgentMdTool.execute(
        { content: "# 项目 B" },
        toolCtx({ workspace: dir2 }),
      );
      // 之前 dir 的 AGENT.md 内容不应被影响
      const dirContent = readFileSync(resolve(dir, "AGENT.md"), "utf-8");
      assert.strictEqual(dirContent, "# 测试项目\n\n用 pnpm 构建");
      assert.strictEqual(readFileSync(resolve(dir2, "AGENT.md"), "utf-8"), "# 项目 B");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

// ===================================================================
// 2. read_memory / write_memory 名称白名单
// ===================================================================
describe("memory name validation", () => {
  describe("validMemoryName", () => {
    it("允许字母数字短横线", () => {
      assert.ok(validMemoryName("user-profile"));
      assert.ok(validMemoryName("myMemory1"));
      assert.ok(validMemoryName("a"));
    });

    it("允许点号和下划线", () => {
      assert.ok(validMemoryName("user.profile"));
      assert.ok(validMemoryName("my_memory"));
      assert.ok(validMemoryName("v1.2.3"));
    });

    it("拒绝路径穿越 (../)", () => {
      assert.ok(!validMemoryName("../etc"));
      assert.ok(!validMemoryName("a/../b"));
      assert.ok(!validMemoryName(".."));
      assert.ok(!validMemoryName("."));
    });

    it("拒绝空字符串", () => {
      assert.ok(!validMemoryName(""));
    });

    it("拒绝超长名称（>64 字符）", () => {
      assert.ok(!validMemoryName("a".repeat(65)));
    });

    it("拒绝以非字母数字开头", () => {
      assert.ok(!validMemoryName("-profile"));
      assert.ok(!validMemoryName(".profile"));
      assert.ok(!validMemoryName("_profile"));
    });

    it("拒绝特殊字符", () => {
      assert.ok(!validMemoryName("user profile"));
      assert.ok(!validMemoryName("user/profile"));
      assert.ok(!validMemoryName("user\\profile"));
      assert.ok(!validMemoryName("user%profile"));
    });
  });

  describe("read_memory rejects path traversal", () => {
    it("拒绝 ../x 名称", async () => {
      const result = await readMemoryTool.execute({ name: "../secret" }, toolCtx());
      assert.ok(result.includes("无效的记忆名称"), "应返回校验提示");
      assert.ok(result.includes("../secret"), "应回显输入");
    });

    it("拒绝空名称", async () => {
      const result = await readMemoryTool.execute({ name: "" }, toolCtx());
      assert.ok(result.includes("无效的记忆名称"));
    });
  });

  describe("write_memory rejects path traversal", () => {
    it("拒绝 ../x 名称", async () => {
      const result = await writeMemoryTool.execute(
        { name: "../../etc/passwd", content: "hack" },
        toolCtx(),
      );
      assert.ok(result.includes("无效的记忆名称"));
    });

    it("拒绝超长名称", async () => {
      const result = await writeMemoryTool.execute(
        { name: "a".repeat(65), content: "test" },
        toolCtx(),
      );
      assert.ok(result.includes("无效的记忆名称"));
    });

    it("拒绝以点开头", async () => {
      const result = await writeMemoryTool.execute(
        { name: ".hidden", content: "test" },
        toolCtx(),
      );
      assert.ok(result.includes("无效的记忆名称"));
    });
  });
});

// ===================================================================
// 3. switchWorkspace / _doOpenSession 失败回滚
// ===================================================================
describe("switchWorkspace rollback behavior", () => {
  it("_initSession 抛出后 currentWorkspace 恢复原值", async () => {
    const ts = Date.now();
    const { AgentRuntime, setCurrentRuntime } = await import(`../src/agent/runtime.ts?t=${ts}`);

    // 用 Object.create 绕过私有构造函数，mock 内部方法
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.currentWorkspace = "/original";
    runtime.session = null;
    runtime._eventCallbacks = [];
    runtime._saveAndDispose = async () => [];
    runtime._initSession = async () => { throw new Error("模拟初始化失败"); };
    runtime._rebindEvents = () => {};

    setCurrentRuntime(runtime);
    assert.strictEqual(runtime.currentWorkspace, "/original");

    try {
      await runtime.switchWorkspace("/new-workspace");
      assert.fail("应抛出异常");
    } catch (e) {
      assert.ok(e.message.includes("模拟初始化失败"), "传递原始错误");
    }

    // currentWorkspace 应恢复为 original
    assert.strictEqual(runtime.currentWorkspace, "/original",
      "初始化失败后 currentWorkspace 应恢复原值");
    setCurrentRuntime(null);
  });

  it("_doOpenSession 初始化失败回滚 workspace", async () => {
    const ts = Date.now();
    const { AgentRuntime, setCurrentRuntime } = await import(`../src/agent/runtime.ts?t=${ts}`);

    const runtime = Object.create(AgentRuntime.prototype);
    runtime.currentWorkspace = "/original";
    runtime.session = null;
    runtime._eventCallbacks = [];
    runtime._saveAndDispose = async () => [];
    runtime._initSession = async () => { throw new Error("会话初始化失败"); };
    runtime._rebindEvents = () => {};

    setCurrentRuntime(runtime);

    try {
      // openSession 调 _doOpenSession，传入不同 workspace
      await runtime.openSession("session.json", "/new-workspace");
      assert.fail("应抛出异常");
    } catch (e) {
      assert.ok(e.message.includes("会话初始化失败"), "传递原始错误");
    }

    // _doOpenSession 应在失败后恢复 workspace
    assert.strictEqual(runtime.currentWorkspace, "/original",
      "_doOpenSession 失败后 currentWorkspace 应恢复原值");
    setCurrentRuntime(null);
  });
});
