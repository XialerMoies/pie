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

before(async () => {
  service = await import("../src/agent/mcp/MCPClientService.ts");
  const trust = await import("../src/agent/mcp/trust-store.ts");
  TrustStore = trust.TrustStore;
  hashServerCommand = trust.hashServerCommand;
});

after(() => {
  service.reset();
  delete process.env.PI_CONFIG_DIR;
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
});
