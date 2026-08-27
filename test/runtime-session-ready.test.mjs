import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime } from "../src/agent/runtime.ts";

/**
 * 构造一个最小 AgentRuntime 实例（跳过真实 PI session 初始化），
 * 直接注入私有字段来测试 waitForSessionReady / syncModelProviders 的
 * 会话就绪语义。
 *
 * 背景：engine.prompt 的整个 turn 通过 runWithStableSession 占用
 * _transitionTail。修复前 waitForSessionReady 会等待完整 tail，导致
 * 长 tool 执行期间 /api/dashboard 等 session 读取路由一直挂起、侧边栏/
 * 设置页卡在加载中。修复后只在真正替换 session 的切换进行中时等待。
 */
function runtimeWith(session, options = {}) {
  const runtime = Object.create(AgentRuntime.prototype);
  runtime._session = session;
  runtime._sessionSwitching = options.switching ?? false;
  runtime._transitionTail = options.tail ?? Promise.resolve();
  runtime.config = options.config ?? {};
  const providerRuntime = options.modelRuntime ?? {};
  const modelRegistry = options.modelRegistry ?? {
    find: () => session?.model,
  };
  runtime._modelRouterSession = {
    providerRuntime,
    modelRegistry,
    syncProviders: options.syncProviders ?? (async () => options.config?.syncModelProviders?.(providerRuntime) ?? 0),
    listModels: () => modelRegistry.getAvailable?.() ?? [],
    findModel: (provider, id) => modelRegistry.find(provider, id),
    providerAuthStatus: () => undefined,
    refreshProviders: async () => ({ errors: new Map() }),
    dispose() {},
  };
  runtime.currentWorkspace = options.workspace ?? "/workspace";
  return runtime;
}

describe("AgentRuntime session readiness", () => {
  it("returns the current session immediately when no session swap is in progress", async () => {
    const session = { id: "session-1" };
    const runtime = runtimeWith(session);
    // 即使 tail 被 prompt turn 长时间占用，也不应等待
    let releaseTail;
    const blockedTail = new Promise((resolve) => { releaseTail = resolve; });
    runtime._transitionTail = blockedTail;

    const result = await runtime.waitForSessionReady();
    assert.strictEqual(result, session);
    releaseTail();
  });

  it("waits for the transition tail only while a session swap is in progress", async () => {
    const nextSession = { id: "session-2" };
    let releaseTail;
    let tailDone = false;
    const tail = new Promise((resolve) => { releaseTail = resolve; }).then(() => { tailDone = true; });
    const runtime = runtimeWith(nextSession, { switching: true, tail });

    const pending = runtime.waitForSessionReady();
    // tail 未完成前不应 resolve
    let settled = false;
    pending.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(settled, false, "切换进行中时必须等待 tail");
    releaseTail();
    const result = await pending;
    assert.strictEqual(result, nextSession);
    assert.strictEqual(tailDone, true);
  });

  it("keeps fail-closed when no session is available", async () => {
    const runtime = runtimeWith(undefined);
    await assert.rejects(() => runtime.waitForSessionReady(), /没有可用的 Agent session/);
  });

  it("syncModelProviders does not wait for idle on read-only calls", async () => {
    const calls = [];
    let waitForIdleCalls = 0;
    const session = {
      isStreaming: true,
      model: { provider: "openai", id: "gpt-test" },
      async waitForIdle() {
        waitForIdleCalls += 1;
        // 模拟 tool 长执行：idle 永不结束（read-only 调用不应等待它）
        return new Promise(() => {});
      },
      async setModel() {},
    };
    const runtime = runtimeWith(session, {
      config: {
        syncModelProviders: async () => {
          calls.push("sync");
          return 7;
        },
      },
    });

    const result = await Promise.race([
      runtime.syncModelProviders({ waitForIdle: false }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    assert.strictEqual(result, 7, "read-only sync 不应等待 streaming idle");
    assert.deepStrictEqual(calls, ["sync"]);
    assert.strictEqual(waitForIdleCalls, 0, "waitForIdle:false 不应调用 waitForIdle");
  });

  it("syncModelProviders waits for idle by default (mutation paths)", async () => {
    let waitForIdleCalls = 0;
    let releaseIdle;
    const session = {
      isStreaming: true,
      model: { provider: "openai", id: "gpt-test" },
      async waitForIdle() {
        waitForIdleCalls += 1;
        await new Promise((resolve) => { releaseIdle = resolve; });
      },
      async setModel() {},
    };
    const runtime = runtimeWith(session, {
      config: {
        syncModelProviders: async () => 5,
      },
    });

    const pending = runtime.syncModelProviders();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(waitForIdleCalls, 1, "默认应等待 idle");
    releaseIdle();
    const result = await pending;
    assert.strictEqual(result, 5);
  });

  it("read-only sync bypasses an in-flight idle-waiting sync", async () => {
    let releaseIdle;
    const session = {
      isStreaming: true,
      model: { provider: "openai", id: "gpt-test" },
      async waitForIdle() {
        await new Promise((resolve) => { releaseIdle = resolve; });
      },
      async setModel() {},
    };
    const runtime = runtimeWith(session, {
      config: { syncModelProviders: async () => 3 },
    });

    // 先发起一个默认（等 idle）的 sync，它会在 waitForIdle 上挂住
    const idleSync = runtime.syncModelProviders();
    // 再发起 read-only sync，不应复用这个挂住的 in-flight，应立即返回
    const readOnlyResult = await Promise.race([
      runtime.syncModelProviders({ waitForIdle: false }),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    assert.strictEqual(readOnlyResult, 3, "read-only sync 不应被 in-flight idle sync 阻塞");
    releaseIdle();
    await idleSync;
  });
});
