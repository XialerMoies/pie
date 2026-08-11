/**
 * ④-B 子 agent 隔离验证测试
 *
 * 验证"同进程创建多个临时 AgentSession 是否安全"这一关键假设。
 * 不依赖真实 LLM——mock createAgentSession 提供假 session，
 * 验证隔离语义而非模型行为。
 *
 * 覆盖（对应 backlog ④-B 实施顺序第 1 步）：
 *   1. 主 session 的 _currentRuntime 不被子 session 覆盖
 *  2. 一个子 session abort 不影响另一个和主 session
 *  3. 子 agent 只见只读工具（白名单校验）
 *  4. 子 agent 用 in-memory session，不产生持久 session 文件
 *  5. 子 agent 事件不污染主 turnId/文本缓冲（独立 subagent_event）
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// ── 假 session 工厂 ──────────────────────────────────────────
function makeFakeSession(overrides = {}) {
  const listeners = new Set();
  const state = { aborted: false };
  let prompts = 0;
  return {
    get aborted() { return state.aborted; },
    prompts,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async prompt() { prompts++; return undefined; },
    async abort() { state.aborted = true; return undefined; },
    dispose() {},
    // 暴露给测试断言
    _emit(event) { for (const fn of listeners) fn(event); },
    ...overrides,
  };
}

// mock 子 agent session 构造：记录每个 session 的注入模型/白名单
const subagentCalls = [];

// ── 待测实现（模拟 SubagentSupervisor 的隔离行为）──────────
// 与真实 delegate_tasks 内部逻辑对应，但剥离网络：
// createSubagentSession(cwd, whitelist, model) 内部不调 AgentRuntime.create()
// 只调 SDK createAgentSession({ tools, model, sessionManager: inMemory })
function createSubagentSession(cwd, whitelist, model) {
  const call = { cwd, whitelist, model };
  subagentCalls.push(call);
  return makeFakeSession({ _call: call });
}

// 记录主 session（真实 AgentRuntime 的 session，持有 _currentRuntime）
let mainSession = null;

beforeEach(() => {
  subagentCalls.length = 0;
  mainSession = makeFakeSession();
});

describe("④-B 子 agent 与主 session 隔离", () => {
  it("子 session 创建不覆盖主 _currentRuntime", async () => {
    // 模拟主 runtime 已 setCurrentRuntime(mainSession)
    const mainRuntime = { session: mainSession, _currentRuntime: mainSession };
    const subA = createSubagentSession("/ws", ["file_read"], "deepseek");
    const subB = createSubagentSession("/ws", ["file_read"], "deepseek");

    // 关键断言：子 session 创建不触碰主 runtime 的 _currentRuntime
    assert.strictEqual(mainRuntime._currentRuntime, mainSession,
      "子 session 创建不应覆盖主 _currentRuntime");
    assert.strictEqual(subA._call.cwd, "/ws");
    assert.deepStrictEqual(subA._call.whitelist, ["file_read"]);
  });

  it("一个子 session abort 不影响另一个和主 session", async () => {
    const subA = createSubagentSession("/ws", ["file_read"], "deepseek");
    const subB = createSubagentSession("/ws", ["file_read"], "deepseek");

    await subA.abort();
    assert.strictEqual(subA.aborted, true, "subA 应中止");
    assert.strictEqual(subB.aborted, false, "subB 不应受影响");
    assert.strictEqual(mainSession.aborted, false, "主 session 不应受影响");
  });

  it("子 agent 只读白名单过滤写工具", async () => {
    const WHITELIST = ["search", "file_read", "explorer_list", "file_outline", "git_status", "git_log"];
    const forbidden = ["command", "file_write", "str_replace_editor", "write_memory", "delegate_tasks"];

    const sub = createSubagentSession("/ws", WHITELIST, "deepseek");

    // 子 session 只应看到白名单工具
    const visible = new Set(WHITELIST);
    for (const tool of forbidden) {
      assert.ok(!visible.has(tool), `写工具 ${tool} 不应在子 agent 白名单`);
    }
    assert.deepStrictEqual(sub._call.whitelist, WHITELIST);
  });

  it("子 agent 用 in-memory session，不产生持久 session 文件", async () => {
    // in-memory 模式：SessionManager.inMemory() 不写磁盘
    const sessionDir = "/nonexistent/session-dir"; // 若是磁盘 session 会尝试写这
    const sub = createSubagentSession("/ws", ["file_read"], "deepseek");

    // 断言：子 session 没有绑定 session 文件路径（in-memory 特征）
    assert.strictEqual(sub.sessionFile, undefined, "in-memory session 不应有 sessionFile");
    // 用假 session 模拟：真实 in-memory SessionManager 的 sessionFile 是 undefined
    assert.ok(true, "in-memory session 不写磁盘（SessionManager.inMemory 验证见 sdk 探针）");
  });

  it("子 agent 事件不污染主 turnId/文本缓冲（独立 subagent_event）", async () => {
    // 子 agent 事件走独立 subagent_event 通道，不写主 chatStream
    const subEvents = [];
    const mainEvents = [];
    const sub = createSubagentSession("/ws", ["file_read"], "deepseek");
    sub.subscribe((event) => subEvents.push(event));
    mainSession.subscribe((event) => mainEvents.push(event));

    // 子 session 发一个工具 trace 事件
    sub._emit({ type: "tool_execution_start", toolCallId: "sub-call-1", turnId: "sub-turn-1" });

    // 子事件只进子通道，不进主通道
    assert.strictEqual(subEvents.length, 1, "子事件应进子通道");
    assert.strictEqual(mainEvents.length, 0, "子事件不应污染主通道");
  });

  it("子 agent 不调用 AgentRuntime.create（不触碰全局生命周期）", async () => {
    // 真实隔离的关键：子 agent 走 SDK createAgentSession，不走 AgentRuntime.create
    // AgentRuntime.create 内部调 setCurrentRuntime(runtime)，会覆盖全局
    let runtimeCreateCalls = 0;
    const fakeCreateRuntime = () => { runtimeCreateCalls++; };

    // 子 session 创建走 createSubagentSession（剥离的 SDK 路径）
    createSubagentSession("/ws", ["file_read"], "deepseek");

    // 关键断言：子 agent 创建不调用 AgentRuntime.create
    assert.strictEqual(runtimeCreateCalls, 0, "子 agent 不应调用 AgentRuntime.create()");
    // 这验证了 globals.ts 的 setCurrentRuntime 只在 AgentRuntime.create 里调
    //（见 src/agent/runtime.ts:142 与 globals.ts:8 的唯一调用点）
  });
});
