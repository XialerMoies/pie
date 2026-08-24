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
import {
  readMemoryTool,
  writeMemoryTool,
  listMemoryTool,
  deleteMemoryTool,
  setMemoryEnabledTool,
  validMemoryName,
} from "../src/agent/tools/memory.ts";

// ── 模拟运行时（无副作用，仅验证工具）─────────────────────
function toolCtx(overrides = {}) {
  return {
    toolCallId: "call-1",
    workspace: "/tmp/test-workspace",
    userMemoryRoot: resolve(tmpdir(), "my-code-agent-memory-tests"),
    ...overrides,
  };
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
    assert.ok(result.text.includes("已更新"), "应返回成功提示");

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
describe("agent-md authorization", () => {
  it("create and overwrite both use shared path authorization", async () => {
    const testDir = mkdtempSync(resolve(tmpdir(), "agent-md-auth-"));
    const calls = [];
    const authorizePath = async (root, target, operation, source) => {
      calls.push({ root, target, operation, source });
      return { operation, root, path: target, relativePath: target };
    };
    try {
      const context = toolCtx({ workspace: testDir, authorizePath });
      await writeAgentMdTool.execute({ content: "created" }, context);
      await writeAgentMdTool.execute({ content: "overwritten" }, context);

      assert.deepStrictEqual(calls.map((call) => [call.operation, call.source]), [
        ["create", "agent.agent_md.create"],
        ["write", "agent.agent_md.write"],
      ]);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("authorization denial does not write AGENT.md", async () => {
    const testDir = mkdtempSync(resolve(tmpdir(), "agent-md-denied-"));
    try {
      const result = await writeAgentMdTool.execute(
        { content: "blocked" },
        toolCtx({
          workspace: testDir,
          authorizePath: async () => { throw new Error("permission denied for test"); },
        }),
      );
      assert.ok(result.text.includes("permission denied for test"));
      assert.strictEqual(existsSync(resolve(testDir, "AGENT.md")), false);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

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
      assert.ok(result.text.includes("无效的记忆名称"), "应返回校验提示");
      assert.ok(result.text.includes("../secret"), "应回显输入");
    });

    it("拒绝空名称", async () => {
      const result = await readMemoryTool.execute({ name: "" }, toolCtx());
      assert.ok(result.text.includes("无效的记忆名称"));
    });
  });

  describe("write_memory rejects path traversal", () => {
    it("拒绝 ../x 名称", async () => {
      const result = await writeMemoryTool.execute(
        { name: "../../etc/passwd", content: "hack" },
        toolCtx(),
      );
      assert.ok(result.text.includes("无效的记忆名称"));
    });

    it("拒绝超长名称", async () => {
      const result = await writeMemoryTool.execute(
        { name: "a".repeat(65), content: "test" },
        toolCtx(),
      );
      assert.ok(result.text.includes("无效的记忆名称"));
    });

    it("拒绝以点开头", async () => {
      const result = await writeMemoryTool.execute(
        { name: ".hidden", content: "test" },
        toolCtx(),
      );
      assert.ok(result.text.includes("无效的记忆名称"));
    });
  });
});

describe("scoped memory roots", () => {
  it("resolves the injected user root by default", async () => {
    const { resolveMemoryRoot } = await import("../src/agent/memory-store.ts");
    assert.strictEqual(
      resolveMemoryRoot({ scope: "user", userMemoryRoot: resolve(tmpdir(), "user-memory") }),
      resolve(tmpdir(), "user-memory"),
    );
  });

  it("resolves workspace memory under agent/memory", async () => {
    const { resolveMemoryRoot } = await import("../src/agent/memory-store.ts");
    const workspace = resolve(tmpdir(), "scoped-workspace");
    assert.strictEqual(
      resolveMemoryRoot({ scope: "workspace", workspace }),
      resolve(workspace, "agent", "memory"),
    );
  });

  it("rejects workspace scope without a workspace", async () => {
    const { resolveMemoryRoot } = await import("../src/agent/memory-store.ts");
    assert.throws(
      () => resolveMemoryRoot({ scope: "workspace" }),
      /workspace.*required/i,
    );
  });

  it("migrates legacy Markdown without overwriting the new user memory", async () => {
    const { migrateLegacyMemory, readOrRebuildMemoryIndex } = await import("../src/agent/memory-store.ts");
    const root = mkdtempSync(resolve(tmpdir(), "memory-migration-"));
    const legacy = resolve(root, "legacy");
    const user = resolve(root, "user");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(user, { recursive: true });
    writeFileSync(resolve(legacy, "old.md"), "# Old");
    writeFileSync(resolve(legacy, "conflict.md"), "# Legacy conflict");
    writeFileSync(resolve(user, "conflict.md"), "# New conflict");
    try {
      const first = migrateLegacyMemory(legacy, user);
      assert.deepStrictEqual(first.migrated, ["old"]);
      assert.deepStrictEqual(first.conflicts, ["conflict"]);
      assert.strictEqual(readFileSync(resolve(user, "old.md"), "utf8"), "# Old");
      assert.strictEqual(readFileSync(resolve(user, "conflict.md"), "utf8"), "# New conflict");
      const index = readOrRebuildMemoryIndex(user, "user");
      assert.deepStrictEqual(index.entries.map((entry) => entry.name).sort(), ["conflict", "old"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ===================================================================
// 3. switchWorkspace / _doOpenSession 失败回滚
// ===================================================================
describe("agent memory authorization", () => {
  it("write_memory and read_memory use shared path authorization", async () => {
    const calls = [];
    const snapshots = new Map();
    const authorizePath = async (root, target, operation, source) => {
      if (!snapshots.has(target)) {
        snapshots.set(target, {
          exists: existsSync(target),
          content: existsSync(target) ? readFileSync(target) : null,
        });
      }
      calls.push({ root, target, operation, source });
      return { operation, root, path: target, relativePath: target };
    };
    const name = `permission-test-${Date.now()}`;

    try {
      await writeMemoryTool.execute(
        { name, content: "# permission test" },
        toolCtx({ authorizePath }),
      );
      const result = await readMemoryTool.execute(
        { name },
        toolCtx({ authorizePath }),
      );

      assert.strictEqual(result.text, "# permission test");
      assert.ok(calls.some((call) => call.source === "agent.memory.create"));
      assert.ok(calls.some((call) => call.source === "agent.memory.index.write"));
      assert.ok(calls.some((call) => call.source === "agent.memory.read"));
    } finally {
      for (const [target, snapshot] of snapshots) {
        if (snapshot.exists) writeFileSync(target, snapshot.content);
        else rmSync(target, { force: true });
      }
    }
  });

  it("write_memory returns denial and does not create a file", async () => {
    let target;
    const result = await writeMemoryTool.execute(
      { name: `permission-denied-${Date.now()}`, content: "blocked" },
      toolCtx({
        authorizePath: async (_root, path) => {
          target = path;
          throw new Error("permission denied for test");
        },
      }),
    );

    assert.ok(result.text.includes("permission denied for test"));
    assert.ok(target);
    assert.strictEqual(existsSync(target), false);
  });
});

describe("scoped memory management", () => {
  it("writes and reads a workspace memory without touching the user root", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "memory-scope-"));
    const workspace = resolve(root, "workspace");
    const userRoot = resolve(root, "user-memory");
    try {
      const ctx = toolCtx({ workspace, userMemoryRoot: userRoot });
      const writeResult = await writeMemoryTool.execute(
        { name: "project-style", content: "# Project style", scope: "workspace" },
        ctx,
      );
      assert.ok(writeResult.text.includes("已更新"));
      assert.strictEqual(readFileSync(resolve(workspace, "agent", "memory", "project-style.md"), "utf8"), "# Project style");
      assert.strictEqual(existsSync(resolve(userRoot, "project-style.md")), false);
      const readResult = await readMemoryTool.execute({ name: "project-style", scope: "workspace" }, ctx);
      assert.strictEqual(readResult.text, "# Project style");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists, disables, and deletes a memory", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "memory-manage-"));
    try {
      const ctx = toolCtx({ userMemoryRoot: root });
      await writeMemoryTool.execute({ name: "managed", content: "# Managed" }, ctx);
      const listed = await listMemoryTool.execute({}, ctx);
      assert.ok(listed.text.includes("managed"));
      assert.deepEqual(listed.metadata?.evidenceFields, ["scope", "entry", "enabled", "source"]);
      assert.equal(listed.data?.entries?.[0]?.enabled, true);
      assert.equal(listed.data?.entries?.[0]?.source, "user");
      await setMemoryEnabledTool.execute({ name: "managed", enabled: false }, ctx);
      assert.ok(!readFileSync(resolve(root, "MEMORY.md"), "utf8").includes("managed"));
      await deleteMemoryTool.execute({ name: "managed" }, ctx);
      assert.strictEqual(existsSync(resolve(root, "managed.md")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects workspace operations without a workspace", async () => {
    const result = await writeMemoryTool.execute(
      { name: "project", content: "# Project", scope: "workspace" },
      toolCtx({ workspace: undefined }),
    );
    assert.match(result.text, /workspace.*required/i);
  });
});

describe("switchWorkspace rollback behavior", () => {
  it("notifies workspace observers only after a successful switch", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.config = {};
    runtime.currentWorkspace = "/original";
    runtime.session = { dispose() {}, abort() {} };
    runtime._eventSubscriptions = [];
    runtime._saveAndDispose = async () => ({ workspace: "/original" });
    runtime._initSession = async () => {
      runtime.session = { dispose() {}, abort() {} };
    };
    runtime._rebindEvents = () => {};
    const observed = [];
    runtime.onWorkspaceChange((workspace) => observed.push(workspace));

    await runtime.switchWorkspace("/next");

    assert.deepStrictEqual(observed, ["/next"]);
  });

  it("_initSession 抛出后 currentWorkspace 恢复原值", async () => {
    const { AgentRuntime, setCurrentRuntime } = await import("../src/agent/runtime.ts");

    // 用 Object.create 绕过私有构造函数，mock 内部方法
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.currentWorkspace = "/original";
    runtime.session = null;
    runtime._eventSubscriptions = [];
    runtime._saveAndDispose = async () => ({ workspace: "/original" });
    runtime._initSession = async () => { throw new Error("模拟初始化失败"); };
    runtime._rebindEvents = () => {};
    const observed = [];
    runtime.onWorkspaceChange((workspace) => observed.push(workspace));

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
    assert.deepStrictEqual(observed, []);
    setCurrentRuntime(null);
  });

  it("_doOpenSession 初始化失败回滚 workspace", async () => {
    const { AgentRuntime, setCurrentRuntime } = await import("../src/agent/runtime.ts");

    const runtime = Object.create(AgentRuntime.prototype);
    runtime.currentWorkspace = "/original";
    runtime.session = null;
    runtime._eventSubscriptions = [];
    runtime._saveAndDispose = async () => ({ workspace: "/original" });
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

describe("runtime session transition serialization", () => {
  // 构造可手动放行的异步门，稳定观察并发 transition 的进入顺序。
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };

  // 等待 promise queue 推进一个事件循环，避免依赖计时器延迟。
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

  // 构造可观测订阅和释放状态的最小会话。
  const makeSession = (id, sessionFile = `/${id}.jsonl`) => {
    const listeners = new Set();
    let subscribeCalls = 0;
    return {
      id,
      sessionFile,
      sessionManager: { getSessionId: () => id },
      abort() {},
      dispose() { listeners.clear(); },
      subscribe(listener) {
        subscribeCalls += 1;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      emit(event) {
        for (const listener of [...listeners]) listener(event);
      },
      get listenerCount() { return listeners.size; },
      get subscribeCalls() { return subscribeCalls; },
    };
  };

  // 使用真实 public API，仅替换昂贵的 session 初始化边界。
  const makeRuntime = async (workspace, id) => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.config = {};
    runtime.currentWorkspace = workspace;
    runtime.session = makeSession(id);
    runtime._eventSubscriptions = [];
    return runtime;
  };

  it("serializes concurrent opens with different keys and leaves one final subscription", async () => {
    const runtime = await makeRuntime("/workspace", "old");
    const firstGate = deferred();
    const entered = [];
    const sessions = [];
    let activeInitializations = 0;
    let maxActiveInitializations = 0;
    runtime.onEvent(() => {});
    runtime._initSession = async (_workspace, sessionFile) => {
      entered.push(sessionFile);
      activeInitializations += 1;
      maxActiveInitializations = Math.max(maxActiveInitializations, activeInitializations);
      if (sessionFile === "/first.jsonl") await firstGate.promise;
      const session = makeSession(sessionFile.includes("first") ? "first" : "second", sessionFile);
      sessions.push(session);
      runtime.session = session;
      activeInitializations -= 1;
    };

    const firstOpen = runtime.openSession("/first.jsonl", "/workspace");
    await nextTurn();
    const secondOpen = runtime.openSession("/second.jsonl", "/workspace");
    await nextTurn();

    assert.deepStrictEqual(entered, ["/first.jsonl"]);
    firstGate.resolve();
    await Promise.all([firstOpen, secondOpen]);

    assert.deepStrictEqual(entered, ["/first.jsonl", "/second.jsonl"]);
    assert.strictEqual(maxActiveInitializations, 1);
    assert.strictEqual(runtime.session.id, "second");
    assert.strictEqual(sessions[0].listenerCount, 0);
    assert.strictEqual(sessions[1].listenerCount, 1);
    assert.strictEqual(sessions[1].subscribeCalls, 1);
  });

  it("deduplicates concurrent opens with the same key within one runtime", async () => {
    const runtime = await makeRuntime("/workspace", "old");
    const initGate = deferred();
    let initCalls = 0;
    runtime._initSession = async () => {
      initCalls += 1;
      await initGate.promise;
      runtime.session = makeSession("opened", "/same.jsonl");
    };

    const firstOpen = runtime.openSession("/same.jsonl", "/workspace");
    await nextTurn();
    const duplicateOpen = runtime.openSession("/same.jsonl", "/workspace");
    await nextTurn();

    assert.strictEqual(initCalls, 1);
    initGate.resolve();
    await Promise.all([firstOpen, duplicateOpen]);
    assert.strictEqual(initCalls, 1);
    assert.strictEqual(runtime.session.id, "opened");
  });

  it("skips reopening the active session when Windows path casing differs", async () => {
    const runtime = await makeRuntime("e:\\my-code-agent", "active");
    runtime.session = makeSession("active", "E:\\my-code-agent\\data\\session.jsonl");
    let initCalls = 0;
    runtime._initSession = async () => {
      initCalls += 1;
    };

    await runtime.openSession(
      "e:\\my-code-agent\\data\\session.jsonl",
      "E:\\my-code-agent",
    );

    assert.strictEqual(initCalls, 0);
    assert.strictEqual(runtime.session.id, "active");
  });

  it("serializes switchWorkspace followed by createNewSession in invocation order", async () => {
    const runtime = await makeRuntime("/original", "old");
    const switchGate = deferred();
    const switchEntered = deferred();
    const initCalls = [];
    let activeInitializations = 0;
    let maxActiveInitializations = 0;
    runtime._initSession = async (workspace, sessionFile, forceNew) => {
      initCalls.push({ workspace, sessionFile, forceNew });
      activeInitializations += 1;
      maxActiveInitializations = Math.max(maxActiveInitializations, activeInitializations);
      if (initCalls.length === 1) {
        switchEntered.resolve();
        await switchGate.promise;
      }
      runtime.session = makeSession(forceNew ? "created" : "switched");
      activeInitializations -= 1;
    };

    const switching = runtime.switchWorkspace("/next");
    await switchEntered.promise;
    const creating = runtime.createNewSession();
    await nextTurn();

    assert.strictEqual(initCalls.length, 1);
    switchGate.resolve();
    const [, createdId] = await Promise.all([switching, creating]);

    assert.deepStrictEqual(initCalls, [
      { workspace: "/next", sessionFile: undefined, forceNew: undefined },
      { workspace: "/next", sessionFile: undefined, forceNew: true },
    ]);
    assert.strictEqual(maxActiveInitializations, 1);
    assert.strictEqual(runtime.currentWorkspace, "/next");
    assert.strictEqual(runtime.session.id, "created");
    assert.strictEqual(createdId, "created");
  });

  it("rejects an unknown profile before disposing or replacing the active session", async () => {
    const runtime = await makeRuntime("/workspace", "old");
    const oldSession = runtime.session;
    let initCalls = 0;
    runtime._initSession = async () => { initCalls += 1; };

    await assert.rejects(runtime.createNewSession("unknown-profile"), /Unknown agent profile/);

    assert.strictEqual(runtime.session, oldSession);
    assert.strictEqual(initCalls, 0);
  });

  it("does not deduplicate the same open key across runtime instances", async () => {
    const firstRuntime = await makeRuntime("/workspace", "first-old");
    const secondRuntime = await makeRuntime("/workspace", "second-old");
    const firstGate = deferred();
    let firstCalls = 0;
    let secondCalls = 0;
    firstRuntime._initSession = async () => {
      firstCalls += 1;
      await firstGate.promise;
      firstRuntime.session = makeSession("first-opened", "/shared.jsonl");
    };
    secondRuntime._initSession = async () => {
      secondCalls += 1;
      secondRuntime.session = makeSession("second-opened", "/shared.jsonl");
    };

    const firstOpen = firstRuntime.openSession("/shared.jsonl", "/workspace");
    await nextTurn();
    const secondOpen = secondRuntime.openSession("/shared.jsonl", "/workspace");
    await nextTurn();

    assert.strictEqual(firstCalls, 1);
    assert.strictEqual(secondCalls, 1);
    assert.strictEqual(secondRuntime.session.id, "second-opened");
    firstGate.resolve();
    await Promise.all([firstOpen, secondOpen]);
  });
});

describe("runtime event source binding", () => {
  // 构造可观测 dispose、订阅次数和事件来源的最小会话桩。
  const makeSession = (id, { disposeThrows = false } = {}) => {
    const listeners = new Set();
    let disposed = false;
    let subscribeCalls = 0;
    return {
      id,
      sessionFile: `/${id}.jsonl`,
      sessionManager: { getSessionId: () => id },
      abort() {},
      dispose() {
        disposed = true;
        listeners.clear();
        if (disposeThrows) throw new Error(`cannot dispose ${id}`);
      },
      subscribe(listener) {
        if (disposed) throw new Error(`session ${id} is disposed`);
        subscribeCalls += 1;
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      emit(event) {
        for (const listener of [...listeners]) listener(event);
      },
      get listenerCount() { return listeners.size; },
      get subscribeCalls() { return subscribeCalls; },
      get disposed() { return disposed; },
    };
  };

  it("reinitializes the disposed old session after switchWorkspace initialization fails", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = makeSession("old");
    const restoredSession = makeSession("restored");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.config = {};
    runtime.currentWorkspace = "/original";
    runtime.session = oldSession;
    runtime._eventSubscriptions = [];
    const seen = [];
    runtime.onEvent((event, sourceSession) => seen.push(`${event.type}:${sourceSession?.id}`));
    const initCalls = [];
    const mcpWorkspaceInitCalls = [];
    runtime._initSession = async (workspace, sessionFile, forceNew) => {
      initCalls.push({ workspace, sessionFile, forceNew });
      // 真实 _initSession 会把同一 workspace 传给 getCustomToolsAsync，恢复 MCP/cache。
      mcpWorkspaceInitCalls.push(workspace);
      if (initCalls.length === 1) throw new Error("switch init failed");
      runtime.session = restoredSession;
    };

    await assert.rejects(runtime.switchWorkspace("/next"), /switch init failed/);

    assert.deepStrictEqual(initCalls, [
      { workspace: "/next", sessionFile: undefined, forceNew: undefined },
      { workspace: "/original", sessionFile: "/old.jsonl", forceNew: undefined },
    ]);
    assert.deepStrictEqual(mcpWorkspaceInitCalls, ["/next", "/original"]);
    assert.strictEqual(oldSession.disposed, true);
    assert.strictEqual(runtime.currentWorkspace, "/original");
    assert.strictEqual(runtime.session, restoredSession);
    assert.strictEqual(restoredSession.subscribeCalls, 1);
    restoredSession.emit({ type: "after-rollback" });
    assert.deepStrictEqual(seen, ["after-rollback:restored"]);
  });

  it("uses the same rollback path when same-workspace openSession initialization fails", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = makeSession("open-old");
    const restoredSession = makeSession("open-restored");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.config = {};
    runtime.currentWorkspace = "/workspace";
    runtime.session = oldSession;
    runtime._eventSubscriptions = [];
    const initCalls = [];
    runtime._initSession = async (workspace, sessionFile, forceNew) => {
      initCalls.push({ workspace, sessionFile, forceNew });
      if (initCalls.length === 1) throw new Error("open init failed");
      runtime.session = restoredSession;
    };

    await assert.rejects(
      runtime.openSession("/target.jsonl", "/workspace"),
      /open init failed/,
    );

    assert.deepStrictEqual(initCalls, [
      { workspace: "/workspace", sessionFile: "/target.jsonl", forceNew: undefined },
      { workspace: "/workspace", sessionFile: "/open-old.jsonl", forceNew: undefined },
    ]);
    assert.strictEqual(oldSession.disposed, true);
    assert.strictEqual(runtime.session, restoredSession);
  });

  it("reinitializes rollback after dispose throws with partial side effects", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = makeSession("old", { disposeThrows: true });
    const restoredSession = makeSession("restored");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.config = {};
    runtime.currentWorkspace = "/original";
    runtime.session = oldSession;
    runtime._eventSubscriptions = [];
    const seen = [];
    runtime.onEvent((event, sourceSession) => seen.push(`${event.type}:${sourceSession?.id}`));
    const initCalls = [];
    runtime._initSession = async (workspace, sessionFile, forceNew) => {
      initCalls.push({ workspace, sessionFile, forceNew });
      if (initCalls.length === 1) throw new Error("switch init failed");
      runtime.session = restoredSession;
    };

    await assert.rejects(
      runtime.switchWorkspace("/next"),
      /switch init failed/,
    );

    assert.strictEqual(runtime.currentWorkspace, "/original");
    assert.strictEqual(runtime.session, restoredSession);
    assert.notStrictEqual(runtime.session, oldSession);
    assert.deepStrictEqual(initCalls, [
      { workspace: "/next", sessionFile: undefined, forceNew: undefined },
      { workspace: "/original", sessionFile: "/old.jsonl", forceNew: undefined },
    ]);
    assert.strictEqual(runtime._eventSubscriptions.length, 1);
    assert.strictEqual(oldSession.disposed, true);
    assert.strictEqual(oldSession.listenerCount, 0);
    oldSession.emit({ type: "after-failure" });
    restoredSession.emit({ type: "after-rollback" });
    assert.deepStrictEqual(seen, ["after-rollback:restored"]);
  });

  it("exposes no disposed session after double failure and binds once on the next successful create", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = makeSession("old");
    const newSession = makeSession("new");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.config = {};
    runtime.currentWorkspace = "/original";
    runtime.session = oldSession;
    runtime._eventSubscriptions = [];
    const seen = [];
    runtime.onEvent((event, sourceSession) => seen.push(`${event.type}:${sourceSession?.id}`));
    const initCalls = [];
    runtime._initSession = async (workspace, sessionFile, forceNew) => {
      initCalls.push({ workspace, sessionFile, forceNew });
      if (initCalls.length === 1) throw new Error("create init failed");
      if (initCalls.length === 2) throw new Error("rollback init failed");
      runtime.session = newSession;
    };

    await assert.rejects(runtime.createNewSession(), /create init failed/);
    assert.strictEqual(runtime.currentWorkspace, "/original");
    assert.strictEqual(runtime._eventSubscriptions.length, 1);
    assert.strictEqual(oldSession.listenerCount, 0);
    assert.strictEqual(oldSession.disposed, true);
    assert.throws(() => runtime.session, /没有可用的 Agent session/);
    assert.strictEqual(runtime.getActiveSession(), null);

    await runtime.createNewSession();
    newSession.emit({ type: "ready" });
    assert.deepStrictEqual(initCalls, [
      { workspace: "/original", sessionFile: undefined, forceNew: true },
      { workspace: "/original", sessionFile: "/old.jsonl", forceNew: undefined },
      { workspace: "/original", sessionFile: undefined, forceNew: true },
    ]);
    assert.strictEqual(newSession.subscribeCalls, 1);
    assert.deepStrictEqual(seen, ["ready:new"]);
  });

  it("does not revive a subscription unsubscribed after initialization failure", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = makeSession("old");
    const newSession = makeSession("new");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.config = {};
    runtime.currentWorkspace = "/workspace";
    runtime.session = oldSession;
    runtime._eventSubscriptions = [];
    const seen = [];
    const unsubscribe = runtime.onEvent((event) => seen.push(event.type));
    let attempts = 0;
    runtime._initSession = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("create failed");
      runtime.session = attempts === 2 ? makeSession("recovered") : newSession;
    };

    await assert.rejects(runtime.createNewSession(), /create failed/);
    assert.strictEqual(runtime._eventSubscriptions.length, 1);
    unsubscribe();
    await runtime.createNewSession();
    newSession.emit({ type: "must-not-return" });

    assert.strictEqual(runtime._eventSubscriptions.length, 0);
    assert.strictEqual(newSession.subscribeCalls, 0);
    assert.deepStrictEqual(seen, []);
  });

  it("updates the active unsubscribe on rebind and never revives an inactive subscription", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = makeSession("old");
    const newSession = makeSession("new");
    const thirdSession = makeSession("third");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.session = oldSession;
    runtime._eventSubscriptions = [];
    const seen = [];
    const callback = (event, sourceSession) => {
      seen.push({ type: event.type, source: sourceSession?.id });
    };

    const unsubscribe = runtime.onEvent(callback);
    await runtime._saveAndDispose(true);
    runtime.session = newSession;
    runtime._rebindEvents();
    runtime._rebindEvents();

    oldSession.emit({ type: "detached-old" });
    newSession.emit({ type: "new-session" });
    unsubscribe();
    newSession.emit({ type: "after-unsubscribe" });

    runtime.session = thirdSession;
    runtime._rebindEvents();
    thirdSession.emit({ type: "must-not-return" });

    assert.deepStrictEqual(seen, [
      { type: "new-session", source: "new" },
    ]);
  });

  it("treats duplicate callback registrations as independent subscriptions", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = makeSession("old");
    const newSession = makeSession("new");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.session = oldSession;
    runtime._eventSubscriptions = [];
    const seen = [];
    const callback = (event, sourceSession) => seen.push(`${event.type}:${sourceSession?.id}`);

    const unsubscribeFirst = runtime.onEvent(callback);
    runtime.onEvent(callback);
    oldSession.emit({ type: "twice" });
    unsubscribeFirst();
    oldSession.emit({ type: "once" });

    await runtime._saveAndDispose(true);
    runtime.session = newSession;
    runtime._rebindEvents();
    oldSession.emit({ type: "old-detached" });
    newSession.emit({ type: "new-once" });

    assert.deepStrictEqual(seen, [
      "twice:old",
      "twice:old",
      "once:old",
      "new-once:new",
    ]);
  });

  it("emitEvent accepts an explicit source session while preserving one-argument calls", async () => {
    const { AgentRuntime } = await import("../src/agent/runtime.ts");
    const oldSession = makeSession("old");
    const currentSession = makeSession("current");
    const runtime = Object.create(AgentRuntime.prototype);
    runtime.session = currentSession;
    runtime._eventSubscriptions = [];
    const seen = [];
    runtime.onEvent((event, sourceSession) => seen.push(`${event.type}:${sourceSession?.id}`));

    runtime.emitEvent({ type: "stale-tool" }, oldSession);
    runtime.emitEvent({ type: "current-tool" });

    assert.deepStrictEqual(seen, ["stale-tool:old", "current-tool:current"]);
  });
});
