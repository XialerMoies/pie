/**
 * MCPClientService 集成测试
 *
 * 覆盖场景：
 * 1. reset / disconnectAll / getServersStatus 初始状态
 * 2. 无配置文件 → 空结果
 * 3. 未信任 server → 跳过（不尝试连接）
 * 4. 已信任但连接失败 → 安全降级 + error 状态
 * 5. 多 server 独立隔离
 * 6. 成功连接 → tools + status + disconnectAll 清理
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

let service, toolsModule, Client, TrustStore, hashServerCommand;
let _origHome, _origProfile, _isolatedHome;

before(async () => {
  // 隔离 HOME/USERPROFILE，防止真实全局 ~/.pi/agent/mcp.json 污染测试
  _origHome = process.env.HOME;
  _origProfile = process.env.USERPROFILE;
  _isolatedHome = mkdtempSync(resolve(tmpdir(), "mcp-home-"));
  process.env.HOME = _isolatedHome;
  process.env.USERPROFILE = _isolatedHome;
  // 确保隔离目录下无全局配置
  mkdirSync(resolve(_isolatedHome, ".pi", "agent"), { recursive: true });

  service = await import("../src/agent/mcp/MCPClientService.ts");
  toolsModule = await import("../src/agent/tools/index.ts");
  ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
  const trust = await import("../src/agent/mcp/trust-store.ts");
  TrustStore = trust.TrustStore;
  hashServerCommand = trust.hashServerCommand;
});

after(() => {
  service.reset();
  process.env.HOME = _origHome;
  process.env.USERPROFILE = _origProfile;
  delete process.env.PI_CONFIG_DIR;
  if (_isolatedHome) {
    try { rmSync(_isolatedHome, { recursive: true, force: true }); } catch {}
  }
});

/** 写 .mcp.json */
function writeConfig(dir, servers) {
  writeFileSync(
    resolve(dir, ".mcp.json"),
    JSON.stringify({ servers }, null, 2),
    "utf-8",
  );
}

/**
 * 在 temp dir 中预写信任记录。
 * 设置 PI_CONFIG_DIR 使 connectAll 内部的 TrustStore 读到同目录。
 */
function withTrust(tempDir) {
  // 创建 pi config 目录
  const configDir = resolve(tempDir, ".pi", "agent");
  mkdirSync(configDir, { recursive: true });
  process.env.PI_CONFIG_DIR = configDir;
  return configDir;
}

async function addTrustForConfig(tempDir, name, config) {
  const hash = hashServerCommand(config);
  const store = new TrustStore();
  await store.addTrust(tempDir, hash, name);
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
  }
  assert.fail(message);
}

async function createTrustedWorkspace(root, name) {
  const workspace = resolve(root, name);
  mkdirSync(workspace, { recursive: true });
  const config = { command: `mock-${name}` };
  writeConfig(workspace, { [name]: config });
  await addTrustForConfig(workspace, name, config);
  return workspace;
}

function installDeferredMcpClients(scripts) {
  const original = {
    connect: Client.prototype.connect,
    listTools: Client.prototype.listTools,
    callTool: Client.prototype.callTool,
    close: Client.prototype.close,
  };
  const attempts = [];
  const scriptByClient = new WeakMap();

  Client.prototype.connect = function () {
    const script = scripts[attempts.length];
    assert.ok(script, `unexpected MCP connection attempt ${attempts.length + 1}`);
    const gate = deferred();
    const attempt = { ...script, gate, client: this, closed: false, calls: [] };
    attempts.push(attempt);
    scriptByClient.set(this, attempt);
    return gate.promise;
  };
  Client.prototype.listTools = async function () {
    const script = scriptByClient.get(this);
    return {
      tools: (script?.tools ?? []).map((name) => ({
        name,
        description: `${name} test tool`,
        inputSchema: { type: "object", properties: {} },
      })),
    };
  };
  Client.prototype.callTool = async function (request) {
    const script = scriptByClient.get(this);
    assert.ok(script, "MCP callTool 必须绑定到已登记的测试 client");
    assert.strictEqual(script.closed, false, "已关闭的 MCP client 不应再接收调用");
    script.calls.push(request);
    return { content: [{ type: "text", text: `${script?.name}:${request.name}` }] };
  };
  Client.prototype.close = async function () {
    const script = scriptByClient.get(this);
    if (script) script.closed = true;
  };

  return {
    attempts,
    restore() {
      Client.prototype.connect = original.connect;
      Client.prototype.listTools = original.listTools;
      Client.prototype.callTool = original.callTool;
      Client.prototype.close = original.close;
    },
  };
}

// ─── 基础行为 ──────────────────────────────────

describe("基础行为", () => {
  afterEach(() => { service.reset(); delete process.env.PI_CONFIG_DIR; });

  it("reset 清空状态后 status 为空", () => {
    service.reset();
    assert.strictEqual(service.getServersStatus().length, 0);
  });

  it("disconnectAll 在无连接时幂等", () => {
    service.disconnectAll();
    assert.strictEqual(service.getServersStatus().length, 0);
  });

  it("getServersStatus 初始返回空", () => {
    assert.strictEqual(service.getServersStatus().length, 0);
  });

  it("stdio transport uses the explicit MCP environment policy", () => {
    const source = readFileSync(resolve(process.cwd(), "src/agent/mcp/MCPClientService.ts"), "utf8");
    assert.match(source, /createMcpProcessEnv/);
    assert.match(source, /env:\s*createMcpProcessEnv\(process\.env, config\.env\)/);
    assert.doesNotMatch(source, /env:\s*config\.env/);
  });

  it("隔离 listener 和 getter 对嵌套 snapshot 的修改", () => {
    service._setStatus("nested", "connected", undefined, {
      command: "node",
      args: ["--safe"],
      env: { TOKEN: "secret" },
      headers: { Authorization: "secret" },
      enabled: true,
    }, ["mcp__nested__read"]);

    let nextListenerSnapshot;
    const unsubscribeMutator = service.subscribeStatusChanges((snapshot) => {
      snapshot[0].tools.push("listener-tool");
      snapshot[0].config.args?.push("listener-arg");
      if (snapshot[0].config.env) snapshot[0].config.env.TOKEN = "listener-env";
      if (snapshot[0].config.headers) snapshot[0].config.headers.Authorization = "listener-header";
    });
    const unsubscribeObserver = service.subscribeStatusChanges((snapshot) => {
      nextListenerSnapshot = snapshot;
    });

    try {
      service._setStatus("nested", "error", "changed", undefined, undefined);
      assert.deepStrictEqual(nextListenerSnapshot?.[0], {
        name: "nested",
        state: "error",
        tools: ["mcp__nested__read"],
        error: "changed",
        config: {
          command: "node",
          args: ["--safe"],
          env: { TOKEN: "secret" },
          headers: { Authorization: "secret" },
          enabled: true,
        },
      });

      const getterSnapshot = service.getServersStatus();
      getterSnapshot[0].tools.push("getter-tool");
      getterSnapshot[0].config.args?.push("getter-arg");
      const internalSnapshot = service.getServersStatus();
      assert.deepStrictEqual(internalSnapshot[0].tools, ["mcp__nested__read"]);
      assert.deepStrictEqual(internalSnapshot[0].config.args, ["--safe"]);
      assert.deepStrictEqual(internalSnapshot[0].config.env, { TOKEN: "secret" });
      assert.deepStrictEqual(internalSnapshot[0].config.headers, { Authorization: "secret" });
    } finally {
      unsubscribeMutator();
      unsubscribeObserver();
    }
  });

  it("structuredClone 缺失时使用 JSON-like fallback 并保留 undefined", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "structuredClone");
    Object.defineProperty(globalThis, "structuredClone", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const snapshots = [];
    const unsubscribe = service.subscribeStatusChanges((snapshot) => snapshots.push(snapshot));
    try {
      assert.doesNotThrow(() => {
        service._setStatus("fallback", "connected", undefined, {
          command: "node",
          args: undefined,
          env: { TOKEN: "secret" },
        }, ["mcp__fallback__read"]);
      });
      const status = service.getServersStatus()[0];
      assert.strictEqual(Object.hasOwn(status.config, "args"), true);
      assert.strictEqual(status.config.args, undefined);
      assert.deepStrictEqual(status.config.env, { TOKEN: "secret" });
      assert.deepStrictEqual(snapshots.at(-1)[0].tools, ["mcp__fallback__read"]);
    } finally {
      unsubscribe();
      if (descriptor) Object.defineProperty(globalThis, "structuredClone", descriptor);
      else delete globalThis.structuredClone;
    }
  });

  it("不可克隆扩展值不会破坏状态写入、getter 或 listener fan-out", () => {
    const config = {
      command: "node",
      args: ["--safe"],
      env: { TOKEN: "secret" },
      extensionFn: () => "ignored",
      extensionSymbol: Symbol("ignored"),
    };
    const tools = ["mcp__uncloneable__read", () => "ignored", Symbol("ignored")];
    const observed = [];
    const unsubscribeFirst = service.subscribeStatusChanges((snapshot) => observed.push(snapshot));
    const unsubscribeSecond = service.subscribeStatusChanges((snapshot) => observed.push(snapshot));
    try {
      assert.doesNotThrow(() => {
        service._setStatus("uncloneable", "connected", undefined, config, tools);
      });
      assert.doesNotThrow(() => service.getServersStatus());
      assert.strictEqual(observed.length, 2);
      assert.deepStrictEqual(observed[0][0].tools, ["mcp__uncloneable__read"]);
      assert.deepStrictEqual(observed[1][0].tools, ["mcp__uncloneable__read"]);
      assert.deepStrictEqual(service.getServersStatus()[0].config, {
        command: "node",
        args: ["--safe"],
        env: { TOKEN: "secret" },
      });
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  it("circular config 在 clone fallback 下不抛出、泄漏扩展值或污染其他快照", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "structuredClone");
    Object.defineProperty(globalThis, "structuredClone", {
      value() { throw new TypeError("clone unavailable"); },
      configurable: true,
      writable: true,
    });
    const config = {
      command: "node",
      args: ["--safe"],
      env: { TOKEN: "internal-secret" },
    };
    config.circular = config;
    const snapshots = [];
    const unsubscribeMutator = service.subscribeStatusChanges((snapshot) => {
      snapshot[0].config.args.push("mutated");
      snapshot[0].config.env.TOKEN = "mutated";
    });
    const unsubscribeObserver = service.subscribeStatusChanges((snapshot) => snapshots.push(snapshot));
    try {
      assert.doesNotThrow(() => service._setStatus("circular", "connected", undefined, config, ["safe-tool"]));
      assert.deepStrictEqual(snapshots[0][0].config, {
        command: "node",
        args: ["--safe"],
        env: { TOKEN: "internal-secret" },
      });
      assert.strictEqual("circular" in snapshots[0][0].config, false);
      assert.deepStrictEqual(service.getServersStatus()[0].config.args, ["--safe"]);
      assert.deepStrictEqual(service.getServersStatus()[0].config.env, { TOKEN: "internal-secret" });
    } finally {
      unsubscribeMutator();
      unsubscribeObserver();
      if (descriptor) Object.defineProperty(globalThis, "structuredClone", descriptor);
      else delete globalThis.structuredClone;
    }
  });
});

// ─── 无配置 ────────────────────────────────────

describe("无配置", () => {
  afterEach(() => { service.reset(); delete process.env.PI_CONFIG_DIR; });

  it("没有 .mcp.json 时返回空列表", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-"));
    try {
      const tools = await service.connectAll(tmpDir);
      assert.strictEqual(tools.length, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 未信任跳过 ────────────────────────────────

describe("未信任跳过", () => {
  afterEach(() => { service.reset(); delete process.env.PI_CONFIG_DIR; });

  it("未信任的 server 被跳过，不尝试连接", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-"));
    try {
      writeConfig(tmpDir, { "untrusted-srv": { command: "will-not-run" } });
      const tools = await service.connectAll(tmpDir);
      assert.strictEqual(tools.length, 0);

      const statuses = service.getServersStatus();
      assert.strictEqual(statuses.length, 1);
      assert.strictEqual(statuses[0].state, "error");
      assert.ok(statuses[0].error?.includes("未信任"), statuses[0].error);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 已信任但连接失败 ───────────────────────────

describe("已信任但连接失败", () => {
  afterEach(() => { service.reset(); delete process.env.PI_CONFIG_DIR; });

  it("已信任但命令不存在时不抛异常", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-"));
    try {
      writeConfig(tmpDir, { "broken-srv": { command: "cmd-x-xxxx-does-not-exist" } });
      withTrust(tmpDir);
      const { loadMcpConfig } = await import("../src/agent/mcp/config.ts");
      const cfg = loadMcpConfig({ projectRoot: tmpDir }).servers[0];
      await addTrustForConfig(tmpDir, "broken-srv", cfg.config);

      const tools = await service.connectAll(tmpDir);
      assert.strictEqual(tools.length, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("已信任失败后 status 为 error", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-"));
    try {
      writeConfig(tmpDir, { "bad-srv": { command: "nonexistent-xxx" } });
      withTrust(tmpDir);
      const { loadMcpConfig } = await import("../src/agent/mcp/config.ts");
      const cfg = loadMcpConfig({ projectRoot: tmpDir }).servers[0];
      await addTrustForConfig(tmpDir, "bad-srv", cfg.config);

      await service.connectAll(tmpDir);

      const statuses = service.getServersStatus();
      assert.strictEqual(statuses.length, 1);
      assert.strictEqual(statuses[0].name, "bad-srv");
      assert.strictEqual(statuses[0].state, "error");
      assert.ok(statuses[0].error, "应有错误信息");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("连接错误和状态错误不会泄漏 MCP 配置凭据", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-"));
    const originalConnect = Client.prototype.connect;
    const originalLog = console.log;
    const logs = [];
    try {
      writeConfig(tmpDir, {
        "secret-srv": {
          command: "mock-secret-server",
          env: { TOKEN: "configured-secret" },
        },
      });
      withTrust(tmpDir);
      const { loadMcpConfig } = await import("../src/agent/mcp/config.ts");
      const cfg = loadMcpConfig({ projectRoot: tmpDir }).servers[0];
      await addTrustForConfig(tmpDir, "secret-srv", cfg.config);
      Client.prototype.connect = () => Promise.reject(new Error("transport failed configured-secret"));
      console.log = (...args) => logs.push(args.join(" "));

      await service.connectAll(tmpDir);

      assert.ok(logs.length > 0);
      assert.ok(logs.every((line) => !line.includes("configured-secret")), logs);
      assert.ok(!service.getServersStatus()[0].error?.includes("configured-secret"));
    } finally {
      console.log = originalLog;
      Client.prototype.connect = originalConnect;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 多 server 隔离 ────────────────────────────

describe("多 server 隔离", () => {
  afterEach(() => { service.reset(); delete process.env.PI_CONFIG_DIR; });

  it("一个失败不影响其他", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-"));
    try {
      writeConfig(tmpDir, {
        "srv-a": { command: "no-such-cmd-aaa" },
        "srv-b": { command: "no-such-cmd-bbb" },
      });
      withTrust(tmpDir);
      const { loadMcpConfig } = await import("../src/agent/mcp/config.ts");
      const result = loadMcpConfig({ projectRoot: tmpDir });
      for (const s of result.servers) {
        await addTrustForConfig(tmpDir, s.name, s.config);
      }

      const tools = await service.connectAll(tmpDir);
      assert.strictEqual(tools.length, 0);

      const statuses = service.getServersStatus();
      assert.strictEqual(statuses.length, 2);
      assert.ok(statuses.every((s) => s.state === "error"));
      assert.ok(statuses.find((s) => s.name === "srv-a"));
      assert.ok(statuses.find((s) => s.name === "srv-b"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── 状态管理不变式（失败路径验证） ──────────────

/**
 * 注：真正的 MCP stdio 成功连接测试受限于 SDK StdioClientTransport
 * 在部分 Windows 环境的兼容性问题，无法在 CI 中可靠运行。
 * 以下测试通过失败路径和状态清理不变式验证集成质量。
 * 正向链路（connect → tools/list → status.tools → disconnectAll）
 * 在非 Windows 环境下可通过 adapter 测试 + 手动探针覆盖。
 */
describe("状态管理不变式", () => {
  afterEach(() => { service.reset(); delete process.env.PI_CONFIG_DIR; });

  it("连接失败后 status 保留 config 信息", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-"));
    try {
      writeConfig(tmpDir, { "cfg-test": { command: "does-not-exist-xxx", cwd: "/tmp" } });
      withTrust(tmpDir);
      const { loadMcpConfig } = await import("../src/agent/mcp/config.ts");
      const cfg = loadMcpConfig({ projectRoot: tmpDir }).servers[0];
      await addTrustForConfig(tmpDir, "cfg-test", cfg.config);

      await service.connectAll(tmpDir);
      const statuses = service.getServersStatus();
      assert.strictEqual(statuses.length, 1);
      assert.ok(statuses[0].config, "失败 server 仍有 config");
      // config 应包含原始配置字段（cwd 等透传）
      assert.strictEqual(statuses[0].config.cwd, "/tmp");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("两次 connectAll 不会残留旧状态（reset 隔离）", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-"));
    try {
      // 第一次：失败的 server
      writeConfig(tmpDir, { "first": { command: "no-such-cmd-111" } });
      withTrust(tmpDir);
      const { loadMcpConfig } = await import("../src/agent/mcp/config.ts");
      for (const s of loadMcpConfig({ projectRoot: tmpDir }).servers) {
        await addTrustForConfig(tmpDir, s.name, s.config);
      }
      await service.connectAll(tmpDir);
      assert.ok(service.getServersStatus().length > 0);

      // 第二次：不同目录，reset 清空旧状态
      service.reset();
      delete process.env.PI_CONFIG_DIR;
      const tmpDir2 = mkdtempSync(resolve(tmpdir(), "mcp-svc-2-"));
      try {
        writeConfig(tmpDir2, { "second": { command: "no-such-cmd-222" } });
        withTrust(tmpDir2);
        for (const s of loadMcpConfig({ projectRoot: tmpDir2 }).servers) {
          await addTrustForConfig(tmpDir2, s.name, s.config);
        }
        await service.connectAll(tmpDir2);
        const statuses = service.getServersStatus();
        assert.strictEqual(statuses.length, 1);
        assert.strictEqual(statuses[0].name, "second");
      } finally {
        rmSync(tmpDir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stale 连接失败不写 error 状态", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-stale-"));
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const originalConnect = Client.prototype.connect;
    let rejectConnect;
    try {
      writeConfig(tmpDir, { "stale-srv": { command: "mock-cmd" } });
      withTrust(tmpDir);
      const { loadMcpConfig } = await import("../src/agent/mcp/config.ts");
      const cfg = loadMcpConfig({ projectRoot: tmpDir }).servers[0];
      await addTrustForConfig(tmpDir, "stale-srv", cfg.config);

      Client.prototype.connect = function () {
        return new Promise((_, reject) => {
          rejectConnect = reject;
        });
      };

      const pending = service.connectAll(tmpDir);
      await waitFor(() => typeof rejectConnect === "function", "stale connection did not start");
      service.bumpGeneration();
      rejectConnect(new Error("mock stale fail"));

      const tools = await pending;
      assert.strictEqual(tools.length, 0);
      assert.strictEqual(service.getServersStatus().length, 0);
    } finally {
      Client.prototype.connect = originalConnect;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("stale refresh returns an incomplete report without clearing current generation status", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-svc-stale-refresh-"));
    const originalRefresh = TrustStore.prototype.refresh;
    const refreshGate = deferred();
    let refreshStarted = false;
    try {
      TrustStore.prototype.refresh = function () {
        refreshStarted = true;
        return refreshGate.promise;
      };

      const pending = service.connectAllWithReport(tmpDir);
      await waitFor(() => refreshStarted, "stale trust refresh did not start");
      service.bumpGeneration();
      service._setStatus("current-generation", "connected", undefined, { command: "current" }, ["current-tool"]);
      refreshGate.resolve();

      const report = await pending;
      assert.strictEqual(report.complete, false);
      assert.deepStrictEqual(service.getServersStatus().map((status) => status.name), ["current-generation"]);
    } finally {
      refreshGate.resolve();
      TrustStore.prototype.refresh = originalRefresh;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("tools MCP discovery concurrency", () => {
  async function setup(scripts, workspaceNames) {
    const root = mkdtempSync(resolve(tmpdir(), "mcp-tools-discovery-"));
    await toolsModule.disconnectMcp();
    service.reset();
    withTrust(root);
    const workspaces = Object.fromEntries(await Promise.all(
      workspaceNames.map(async (name) => [name, await createTrustedWorkspace(root, name)]),
    ));
    const clients = installDeferredMcpClients(scripts);
    return { root, workspaces, clients };
  }

  async function cleanup(state) {
    for (const attempt of state.clients.attempts) attempt.gate.resolve();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    await toolsModule.disconnectMcp();
    state.clients.restore();
    service.reset();
    delete process.env.PI_CONFIG_DIR;
    rmSync(state.root, { recursive: true, force: true });
  }

  it("coalesces same-workspace discovery and caches an empty result", async () => {
    const state = await setup([{ name: "same", tools: [] }], ["same"]);
    try {
      const generationBeforeWorkspace = service.currentGeneration();
      await Promise.all([
        toolsModule.getCustomToolsAsync(state.workspaces.same),
        toolsModule.getCustomToolsAsync(state.workspaces.same),
      ]);
      await waitFor(() => state.clients.attempts.length === 1, "same workspace should start one discovery");
      assert.ok(service.currentGeneration() > generationBeforeWorkspace, "workspace activation must advance generation");

      state.clients.attempts[0].gate.resolve();
      await waitFor(
        () => service.getServersStatus()[0]?.state === "connected",
        "empty discovery should still complete and publish connection status",
      );
      const settledGeneration = service.currentGeneration();
      await toolsModule.getCustomToolsAsync(state.workspaces.same);
      await toolsModule.getCustomToolsAsync(state.workspaces.same);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

      assert.strictEqual(state.clients.attempts.length, 1, "initialized [] must be a valid cache hit");
      const cachedTools = await toolsModule.getCustomToolsAsync(state.workspaces.same);
      assert.ok(!cachedTools.some((tool) => tool.name.startsWith("mcp__")), "empty discovery must expose no MCP tools");
      assert.strictEqual(service.currentGeneration(), settledGeneration, "same workspace cache hits must keep generation");
    } finally {
      await cleanup(state);
    }
  });

  it("retries config discovery after a malformed config is repaired", async () => {
    const state = await setup([{ name: "config-repaired", tools: ["echo"] }], ["config"]);
    try {
      writeFileSync(resolve(state.workspaces.config, ".mcp.json"), "{ invalid json", "utf-8");

      await toolsModule.getCustomToolsAsync(state.workspaces.config);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      assert.strictEqual(state.clients.attempts.length, 0, "invalid config must not connect a server");

      const failedReport = await service.connectAllWithReport(state.workspaces.config);
      assert.strictEqual(failedReport.complete, false);
      assert.strictEqual(failedReport.tools.length, 0);
      assert.ok(failedReport.configErrors.length > 0, "report must retain this call's config errors");

      writeConfig(state.workspaces.config, { config: { command: "mock-config" } });
      await toolsModule.getCustomToolsAsync(state.workspaces.config);
      await waitFor(() => state.clients.attempts.length === 1, "repaired config must be retried");
      state.clients.attempts[0].gate.resolve();
      await waitFor(
        () => service.getServersStatus()[0]?.state === "connected",
        "repaired config discovery did not complete",
      );

      const currentTools = await toolsModule.getCustomToolsAsync(state.workspaces.config);
      assert.ok(currentTools.some((tool) => tool.name === "mcp__config__echo"));
      await toolsModule.getCustomToolsAsync(state.workspaces.config);
      assert.strictEqual(state.clients.attempts.length, 1, "successful retry must initialize the empty-cache state");
    } finally {
      await cleanup(state);
    }
  });

  it("retries a transient failed discovery instead of caching an empty result", async () => {
    const state = await setup([
      { name: "retry-failed", tools: ["echo"] },
      { name: "retry-success", tools: ["echo"] },
    ], ["retry"]);
    try {
      await toolsModule.getCustomToolsAsync(state.workspaces.retry);
      await waitFor(() => state.clients.attempts.length === 1, "first discovery did not start");
      state.clients.attempts[0].gate.reject(new Error("temporary MCP failure"));
      await waitFor(
        () => service.getServersStatus()[0]?.state === "error",
        "failed discovery did not publish error status",
      );

      await toolsModule.getCustomToolsAsync(state.workspaces.retry);
      await waitFor(() => state.clients.attempts.length === 2, "failed discovery must be retried");
      state.clients.attempts[1].gate.resolve();
      await waitFor(
        () => service.getServersStatus()[0]?.state === "connected",
        "retry did not publish connected status",
      );

      const currentTools = await toolsModule.getCustomToolsAsync(state.workspaces.retry);
      assert.ok(currentTools.some((tool) => tool.name === "mcp__retry__echo"));
    } finally {
      await cleanup(state);
    }
  });

  it("keeps partial tools but retries while any enabled server failed", async () => {
    const state = await setup([
      { name: "healthy-first", tools: ["healthy_tool"] },
      { name: "flaky-failed", tools: ["flaky_tool"] },
      { name: "healthy-retry", tools: ["healthy_tool"] },
      { name: "flaky-retry", tools: ["flaky_tool"] },
    ], ["mixed"]);
    try {
      const healthyConfig = { command: "mock-healthy" };
      const flakyConfig = { command: "mock-flaky" };
      writeConfig(state.workspaces.mixed, { healthy: healthyConfig, flaky: flakyConfig });
      await addTrustForConfig(state.workspaces.mixed, "healthy", healthyConfig);
      await addTrustForConfig(state.workspaces.mixed, "flaky", flakyConfig);

      await toolsModule.getCustomToolsAsync(state.workspaces.mixed);
      await waitFor(() => state.clients.attempts.length === 1, "healthy server did not start");
      state.clients.attempts[0].gate.resolve();
      await waitFor(() => state.clients.attempts.length === 2, "flaky server did not start");
      state.clients.attempts[1].gate.reject(new Error("temporary flaky failure"));
      await waitFor(
        () => service.getServersStatus().some((status) => status.state === "error"),
        "partial discovery did not publish error status",
      );
      await waitFor(
        () => service.getServersStatus().some((status) => status.state === "connected"),
        "successful partial discovery did not publish a connected server",
      );
      const partialCachedTools = await toolsModule.getCustomToolsAsync(state.workspaces.mixed);
      assert.ok(partialCachedTools.some((tool) => tool.name === "mcp__healthy__healthy_tool"), "successful partial tool was not retained");

      const allowTool = { authorizeTool: async () => ({ allow: true }) };
      const [partialSessionA, partialSessionB] = await Promise.all([
        toolsModule.getCustomToolsAsync(state.workspaces.mixed, undefined, allowTool),
        toolsModule.getCustomToolsAsync(state.workspaces.mixed, undefined, allowTool),
      ]);
      await waitFor(() => state.clients.attempts.length === 3, "partial discovery must be retried");
      assert.strictEqual(state.clients.attempts.length, 3, "same-key partial retry must be single-flight");
      const partialToolA = partialSessionA.find((tool) => tool.name === "mcp__healthy__healthy_tool");
      const partialToolB = partialSessionB.find((tool) => tool.name === "mcp__healthy__healthy_tool");
      assert.ok(partialToolA, "healthy partial tool must be returned through getCustomToolsAsync");
      assert.ok(partialToolB, "each session must receive the healthy partial tool");
      assert.notStrictEqual(partialToolA, partialToolB, "partial raw tools must be wrapped per session");
      assert.ok(!partialSessionA.some((tool) => tool.name === "mcp__flaky__flaky_tool"));
      await partialToolA.execute("partial-call", {});
      assert.strictEqual(state.clients.attempts[0].calls.length, 1, "partial tool must remain callable during retry");

      state.clients.attempts[2].gate.resolve();
      await waitFor(() => state.clients.attempts.length === 4, "retry did not continue to flaky server");
      state.clients.attempts[3].gate.resolve();
      await waitFor(
        () => service.getServersStatus().length === 2
          && service.getServersStatus().every((status) => status.state === "connected"),
        "partial retry did not complete successfully",
      );

      const currentTools = await toolsModule.getCustomToolsAsync(state.workspaces.mixed);
      assert.ok(currentTools.some((tool) => tool.name === "mcp__healthy__healthy_tool"));
      assert.ok(currentTools.some((tool) => tool.name === "mcp__flaky__flaky_tool"));
      assert.strictEqual(state.clients.attempts[0].closed, true, "replaced partial client must be closed");
    } finally {
      await cleanup(state);
    }
  });

  it("starts workspace B while A is pending and rejects A's late completion", async () => {
    const state = await setup([
      { name: "a", tools: ["tool_a"] },
      { name: "b", tools: ["tool_b"] },
    ], ["a", "b"]);
    try {
      await toolsModule.getCustomToolsAsync(state.workspaces.a);
      await waitFor(() => state.clients.attempts.length === 1, "workspace A discovery did not start");
      const generationA = service.currentGeneration();

      await toolsModule.getCustomToolsAsync(state.workspaces.b);
      await waitFor(() => state.clients.attempts.length === 2, "workspace B must start while A is pending");
      assert.ok(service.currentGeneration() > generationA, "workspace B must receive a new generation");

      state.clients.attempts[1].gate.resolve();
      await waitFor(
        () => service.getServersStatus()[0]?.name === "b" && service.getServersStatus()[0]?.state === "connected",
        "workspace B connection did not become current",
      );
      state.clients.attempts[0].gate.resolve();
      await waitFor(() => state.clients.attempts[0].closed, "stale workspace A client must be closed");

      const currentTools = await toolsModule.getCustomToolsAsync(state.workspaces.b);
      assert.ok(currentTools.some((tool) => tool.name === "mcp__b__tool_b"));
      assert.ok(!currentTools.some((tool) => tool.name === "mcp__a__tool_a"));
      assert.deepStrictEqual(service.getServersStatus().map((status) => status.name), ["b"]);
      assert.strictEqual(state.clients.attempts[1].closed, false, "current workspace B connection must remain open");
    } finally {
      await cleanup(state);
    }
  });

  it("invalidates a pending discovery on disconnect and allows a fresh discovery", async () => {
    const state = await setup([
      { name: "stale", tools: ["stale_tool"] },
      { name: "fresh", tools: ["fresh_tool"] },
    ], ["stale"]);
    try {
      await toolsModule.getCustomToolsAsync(state.workspaces.stale);
      await waitFor(() => state.clients.attempts.length === 1, "initial discovery did not start");
      const pendingGeneration = service.currentGeneration();

      await toolsModule.disconnectMcp();
      assert.ok(service.currentGeneration() > pendingGeneration, "disconnect must advance generation first");
      state.clients.attempts[0].gate.resolve();
      await waitFor(() => state.clients.attempts[0].closed, "invalidated client must close on late completion");
      const staleTools = await toolsModule.getCustomToolsAsync(state.workspaces.stale);
      assert.ok(!staleTools.some((tool) => tool.name.startsWith("mcp__")), "invalidated discovery must expose no stale MCP tools");
      assert.deepStrictEqual(service.getServersStatus(), []);

      await toolsModule.getCustomToolsAsync(state.workspaces.stale);
      await waitFor(() => state.clients.attempts.length === 2, "a fresh discovery must start after disconnect");
      state.clients.attempts[1].gate.resolve();
      await waitFor(
        () => service.getServersStatus()[0]?.state === "connected",
        "fresh discovery did not complete",
      );
      const currentTools = await toolsModule.getCustomToolsAsync(state.workspaces.stale);
      assert.ok(currentTools.some((tool) => tool.name === "mcp__stale__fresh_tool"));
      assert.ok(!currentTools.some((tool) => tool.name === "mcp__stale__stale_tool"));
    } finally {
      await cleanup(state);
    }
  });

  it("rewraps cached raw tools with each call's current emitter and context", async () => {
    const state = await setup([{ name: "session", tools: ["echo"] }], ["session"]);
    try {
      await toolsModule.getCustomToolsAsync(state.workspaces.session);
      await waitFor(() => state.clients.attempts.length === 1, "discovery did not start");
      state.clients.attempts[0].gate.resolve();
      await waitFor(
        () => service.getServersStatus()[0]?.state === "connected",
        "discovery did not complete",
      );

      const tracesA = [];
      const tracesB = [];
      const authorizationsA = [];
      const authorizationsB = [];
      const sessionA = await toolsModule.getCustomToolsAsync(
        state.workspaces.session,
        (event) => tracesA.push(event),
        { authorizeTool: async (request) => { authorizationsA.push(request); return { allow: true }; } },
      );
      const sessionB = await toolsModule.getCustomToolsAsync(
        state.workspaces.session,
        (event) => tracesB.push(event),
        { authorizeTool: async (request) => { authorizationsB.push(request); return { allow: true }; } },
      );
      const toolA = sessionA.find((tool) => tool.name === "mcp__session__echo");
      const toolB = sessionB.find((tool) => tool.name === "mcp__session__echo");

      assert.notStrictEqual(toolA, toolB);
      await toolA.execute("call-a", {});
      assert.strictEqual(authorizationsA.length, 1);
      assert.strictEqual(authorizationsB.length, 0);
      assert.deepStrictEqual(tracesA.map((event) => event.toolCallId), ["call-a", "call-a"]);
      assert.deepStrictEqual(tracesB, []);

      await toolB.execute("call-b", {});
      assert.strictEqual(authorizationsB.length, 1);
      assert.deepStrictEqual(tracesB.map((event) => event.toolCallId), ["call-b", "call-b"]);
    } finally {
      await cleanup(state);
    }
  });

  it("invalidates cached wrappers before reconnecting the same workspace", async () => {
    const state = await setup([
      { name: "old-client", tools: ["echo"] },
      { name: "new-client", tools: ["echo"] },
    ], ["refresh"]);
    try {
      await toolsModule.getCustomToolsAsync(state.workspaces.refresh);
      await waitFor(() => state.clients.attempts.length === 1, "initial discovery did not start");
      state.clients.attempts[0].gate.resolve();
      await waitFor(
        () => service.getServersStatus()[0]?.state === "connected",
        "initial discovery did not complete",
      );

      const allowTool = { authorizeTool: async () => ({ allow: true }) };
      const beforeRefresh = await toolsModule.getCustomToolsAsync(
        state.workspaces.refresh,
        undefined,
        allowTool,
      );
      const oldWrapper = beforeRefresh.find((tool) => tool.name === "mcp__refresh__echo");
      assert.ok(oldWrapper, "initial wrapper should be available");
      await oldWrapper.execute("old-call", {});
      assert.strictEqual(state.clients.attempts[0].calls.length, 1);

      await toolsModule.reconnectMcp(state.workspaces.refresh);
      assert.strictEqual(state.clients.attempts[0].closed, true, "reconnect must close the old client");
      const duringRefresh = await toolsModule.getCustomToolsAsync(state.workspaces.refresh);
      assert.ok(
        !duringRefresh.some((tool) => tool.name === "mcp__refresh__echo"),
        "new sessions must not receive a wrapper bound to the closed client",
      );
      assert.strictEqual(state.clients.attempts[0].calls.length, 1, "closed client must not receive another call");

      await waitFor(() => state.clients.attempts.length === 2, "refresh discovery did not start");
      state.clients.attempts[1].gate.resolve();
      await waitFor(
        () => service.getServersStatus()[0]?.state === "connected",
        "refresh discovery did not complete",
      );
      const afterRefresh = await toolsModule.getCustomToolsAsync(
        state.workspaces.refresh,
        undefined,
        allowTool,
      );
      const newWrapper = afterRefresh.find((tool) => tool.name === "mcp__refresh__echo");
      assert.ok(newWrapper, "refreshed wrapper should be available");
      await newWrapper.execute("new-call", {});
      assert.strictEqual(state.clients.attempts[0].calls.length, 1);
      assert.strictEqual(state.clients.attempts[1].calls.length, 1);
    } finally {
      await cleanup(state);
    }
  });
});
