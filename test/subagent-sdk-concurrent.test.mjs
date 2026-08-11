/**
 * ④-B 子 agent 真实并发执行验证（确定性 fake provider，离线可重复）
 *
 * 对应 backlog ④-B 实施顺序第 1 步的运行时验证。
 * 用 registerProvider + streamSimple 注册确定性 fake provider（不发网络），
 * 让两个真实 SDK session 同时 prompt()，验证：
 *
 *   1. 并发执行：两个 session 同时跑，总耗时 < 单 session 串行（并行非阻塞）
 *  2. 各自产出：每个 session 独立产生自己的 assistant 消息
 *  3. 状态隔离：A.state !== B.state，A.agent !== B.agent（非共享单例）
 *  4. in-memory：无 sessionFile（不写磁盘）
 *  5. abort 隔离：流式中止 A，B 继续完成
 *
 * 关键约束（探针发现）：registerApiProvider 是进程级全局、按 api 类型互斥
 * （@earendil-works/pi-ai/compat）。所以并发子 agent 必须共用同一 provider
 * （继承主 agent 模型），不能在运行期给不同子 agent 挂不同 provider 实例。
 * 这正是 backlog "默认继承主 agent 模型" 的运行时依据。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createAgentSession, SessionManager, SettingsManager, AuthStorage, ModelRegistry, DefaultResourceLoader } from "@xiamol/pi-coding-agent";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const CONCURRENT_PROVIDER = "conc-provider";
const ABORT_PROVIDER = "abort-provider";

// 确定性 streamSimple：async-iterable + result()，带可选延迟/块数
function makeStreamSimple(reply, { blockMs = 0, blocks = 1 } = {}) {
  return async (model, context, options) => {
    const mk = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
    const gen = (async function* () {
      yield { type: "start", partial: mk("") };
      yield { type: "text_start", contentIndex: 0, partial: mk("") };
      for (let i = 0; i < blocks; i++) {
        if (blockMs) await new Promise((r) => setTimeout(r, blockMs));
        if (options?.signal?.aborted) return;
        yield { type: "text_delta", contentIndex: 0, delta: reply, partial: mk(reply) };
      }
      yield { type: "text_end", contentIndex: 0, content: reply, partial: mk(reply) };
      yield { type: "done", reason: "stop", message: mk(reply) };
    })();
    gen.result = async () => mk(reply);
    return gen;
  };
}

describe("④-B 子 agent 真实并发执行", () => {
  let dir, auth, registry, settings, loader;
  const sessions = [];

  before(async () => {
    dir = mkdtempSync(resolve(tmpdir(), "pi-subagent-conc-"));
    mkdirSync(resolve(dir, ".pi/agent"), { recursive: true });
    auth = AuthStorage.create(resolve(dir, ".pi/agent/auth.json"));
    registry = ModelRegistry.create(auth, resolve(dir, ".pi/agent/models.json"));
    settings = SettingsManager.inMemory({ defaultProvider: CONCURRENT_PROVIDER, defaultModel: "c-1", defaultThinkingLevel: "off" });

    // 并发 provider：150ms 一块、1 块 → 单次 ~150ms
    registry.registerProvider(CONCURRENT_PROVIDER, {
      api: "anthropic-messages", baseUrl: "https://fake-conc.local", apiKey: "fake-key",
      models: [{ id: "c-1", name: "Conc", input: ["text"], contextWindow: 100000, maxTokens: 4000, thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" } }],
      streamSimple: makeStreamSimple("并发回复", { blockMs: 150, blocks: 1 }),
    });

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
      cwd: ws, agentDir: resolve(dir, ".pi/agent"),
      authStorage: auth, modelRegistry: registry, settingsManager: settings,
      sessionManager: sm, resourceLoader: loader, tools: ["read", "ls"],
    });
    sessions.push(session);
    return session;
  }

  it("两个 session 并发 prompt，各自产出，总耗时 < 串行", async () => {
    const a = await makeSub("/ws-a");
    const b = await makeSub("/ws-b");
    const t0 = Date.now();
    await Promise.all([a.prompt("A 任务"), b.prompt("B 任务")]);
    const elapsed = Date.now() - t0;

    // 单次 150ms；若串行应 ≥300ms；并行应 ≈150ms。给 280ms 余量（CI 慢机留缓冲）。
    assert.ok(elapsed < 280, `应并发（并行≈150ms），实测 ${elapsed}ms（若串行应≥300ms）`);

    const aHas = a.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("并发回复"));
    const bHas = b.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("并发回复"));
    assert.ok(aHas, "A 应产出 assistant 回复");
    assert.ok(bHas, "B 应产出 assistant 回复");
  });

  it("A/B 状态隔离（非共享 agent 单例）+ in-memory 不写磁盘", async () => {
    const a = await makeSub("/ws-a");
    const b = await makeSub("/ws-b");
    assert.notStrictEqual(a.state, b.state, "每个 session 独立 agent state");
    assert.notStrictEqual(a.agent, b.agent, "不应共享 agent 单例");
    assert.strictEqual(a.sessionFile, undefined, "in-memory 无 sessionFile");
    assert.strictEqual(b.sessionFile, undefined, "in-memory 无 sessionFile");
  });

  it("流式中止 A 不影响 B 完成", async () => {
    // A 用独立 api 类型注册长流（不覆盖 CONCURRENT，A 真走 10×100ms 长流，可中途 abort）。
    // B 用 CONCURRENT（150ms 单块）快速完成。
    registry.registerProvider(ABORT_PROVIDER, {
      // 独立 api 类型：确保 resolveApiProvider 解析到 A 自己的长流 handler，不被 CONCURRENT 覆盖
      api: "anthropic-messages-abort", baseUrl: "https://fake-abort.local", apiKey: "fake-key",
      models: [{ id: "ab-1", name: "Abort", input: ["text"], contextWindow: 100000, maxTokens: 4000, thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" } }],
      streamSimple: makeStreamSimple("[ABORT] 长流", { blockMs: 100, blocks: 10 }),
    });

    const settingsA = SettingsManager.inMemory({ defaultProvider: ABORT_PROVIDER, defaultModel: "ab-1", defaultThinkingLevel: "off" });
    const smA = SessionManager.inMemory("/ws-abort");
    const { session: a } = await createAgentSession({
      cwd: "/ws-abort", agentDir: resolve(dir, ".pi/agent"),
      authStorage: auth, modelRegistry: registry, settingsManager: settingsA,
      sessionManager: smA, resourceLoader: loader, tools: ["read", "ls"],
    });
    sessions.push(a);

    const b = await makeSub("/ws-b");
    const pa = a.prompt("A 长任务");
    const pb = b.prompt("B 短任务");

    await new Promise((r) => setTimeout(r, 300)); // A 流式中（10×100ms 才 3 块，仍在流式）
    assert.strictEqual(a.isStreaming, true, "abort 前 A 应仍在流式（未完成）");
    await a.abort();
    await Promise.allSettled([pa, pb]);

    // A 被中止：最终 assistant 消息的 stopReason 应为 "aborted"（而非完整走完的 "stop"）
    const aAssistant = a.messages.filter((m) => m.role === "assistant");
    const aFinal = aAssistant[aAssistant.length - 1];
    assert.strictEqual(aFinal?.stopReason, "aborted", "A 应被中止（stopReason=aborted）而非正常完成");
    // B 不受影响，完成且带回复
    const bHas = b.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("并发回复"));
    assert.ok(bHas, "A 中止后 B 应继续完成");
    assert.strictEqual(b.sessionFile, undefined, "B 不写磁盘");
  });
});
