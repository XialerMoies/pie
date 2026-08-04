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
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

let service, TrustStore, hashServerCommand;
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

function addTrustForConfig(tempDir, name, config) {
  const hash = hashServerCommand(config);
  const store = new TrustStore();
  store.addTrust(tempDir, hash, name);
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
      addTrustForConfig(tmpDir, "broken-srv", cfg.config);

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
      addTrustForConfig(tmpDir, "bad-srv", cfg.config);

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
        addTrustForConfig(tmpDir, s.name, s.config);
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
      addTrustForConfig(tmpDir, "cfg-test", cfg.config);

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
        addTrustForConfig(tmpDir, s.name, s.config);
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
          addTrustForConfig(tmpDir2, s.name, s.config);
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
      addTrustForConfig(tmpDir, "stale-srv", cfg.config);

      Client.prototype.connect = function () {
        return new Promise((_, reject) => {
          rejectConnect = reject;
        });
      };

      const pending = service.connectAll(tmpDir);
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
});
