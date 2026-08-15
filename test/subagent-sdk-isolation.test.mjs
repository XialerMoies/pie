/**
 * ④-B 子 agent 真实 SDK 隔离验证（探针固化）
 *
 * 验证"同进程创建多个临时 AgentSession 是否安全"（backlog ④-B 实施顺序第 1 步）。
 * 用真实 SDK createAgentSession + in-memory managers，不发真实 LLM API——
 * 只验证构造与状态隔离，不验证模型行为。
 *
 * 对应子 agent 只读 fan-out 的运行时前提：
 *   1. 每个 session 独立 agent state（可并行，无全局锁）
 *  2. 独立 agent 实例（非共享单例）
 *  3. 只读工具白名单生效（写工具不在池）
 *  4. in-memory session 不写磁盘（无 sessionFile）
 *  5. 多 session 并发创建不互相干扰
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createAgentSession, SessionManager, SettingsManager, ModelRuntime, ModelRegistry, DefaultResourceLoader } from "@xiamol/pi-coding-agent";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const RO = ["read", "grep", "find", "ls"];

describe("④-B 子 agent 真实 SDK 隔离", () => {
  let dir, modelRuntime, registry, settings, loader;
  const sessions = [];

  before(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "pi-subagent-test-"));
    mkdirSync(resolve(dir, ".pi/agent"), { recursive: true });
    modelRuntime = await ModelRuntime.create({
      authPath: resolve(dir, ".pi/agent/auth.json"),
      modelsPath: resolve(dir, ".pi/agent/models.json"),
      refreshOnCreate: false,
    });
    registry = new ModelRegistry(modelRuntime);
    settings = SettingsManager.inMemory();
    loader = new DefaultResourceLoader({ cwd: dir, agentDir: resolve(dir, ".pi/agent"), settingsManager: settings });
    await loader.reload();
  });

  after(() => {
    for (const s of sessions) { try { s.dispose(); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeSub(ws) {
    const sm = SessionManager.inMemory(ws);
    const { session } = await createAgentSession({
      cwd: ws,
      agentDir: resolve(dir, ".pi/agent"),
      modelRuntime,
      settingsManager: settings,
      sessionManager: sm,
      resourceLoader: loader,
      tools: RO, // 只读白名单
    });
    sessions.push(session);
    return session;
  }

  it("两个子 session 的 agent state 相互独立（可并行）", async () => {
    const a = await makeSub("/ws-a");
    const b = await makeSub("/ws-b");
    assert.notStrictEqual(a.state, b.state, "每个 session 应独立 agent state");
    assert.notStrictEqual(a.agent, b.agent, "不应共享 agent 单例");
    assert.notStrictEqual(a.sessionId, b.sessionId, "sessionId 应不同");
  });

  it("只读工具白名单生效", async () => {
    const a = await makeSub("/ws-a");
    const tools = a.getActiveToolNames();
    assert.deepStrictEqual([...tools].sort(), [...RO].sort(), "白名单工具应生效");
    const forbidden = ["command", "file_write", "str_replace_editor", "write_memory", "delegate_tasks"];
    for (const tool of forbidden) {
      assert.ok(!tools.includes(tool), `写工具 ${tool} 不应在子 agent 工具池`);
    }
  });

  it("in-memory session 不写磁盘（无 sessionFile）", async () => {
    const a = await makeSub("/ws-a");
    assert.strictEqual(a.sessionFile, undefined, "in-memory session 不应有 sessionFile");
  });

  it("并发创建多个子 session 互不干扰", async () => {
    const [a, b, c] = await Promise.all([
      makeSub("/ws-a"), makeSub("/ws-b"), makeSub("/ws-c"),
    ]);
    assert.strictEqual(a.isStreaming, false);
    assert.strictEqual(b.isStreaming, false);
    assert.strictEqual(c.isStreaming, false);
    assert.notStrictEqual(a.state, b.state);
    assert.notStrictEqual(b.state, c.state);
  });
});
