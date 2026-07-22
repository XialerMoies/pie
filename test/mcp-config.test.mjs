/**
 * MCP 配置发现 + 校验 单元测试
 *
 * 测试：
 * 1. validateServerConfig — 校验逻辑（正常/异常边界）
 * 2. normalizeServerConfig — 默认值填充
 * 3. getCandidatePaths — 候选路径优先级
 * 4. loadMcpConfig — 多路径合并/错误处理
 * 5. getEnabledServers — 过滤 disabled
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

let mod;
let _origHome, _origProfile, _isolatedHome;

before(async () => {
  // 隔离 HOME，防止真实全局 ~/.pi/agent/mcp.json 污染
  _origHome = process.env.HOME;
  _origProfile = process.env.USERPROFILE;
  _isolatedHome = mkdtempSync(resolve(tmpdir(), "mcp-home-"));
  process.env.HOME = _isolatedHome;
  process.env.USERPROFILE = _isolatedHome;
  mkdirSync(resolve(_isolatedHome, ".pi", "agent"), { recursive: true });

  mod = await import("../src/agent/mcp/config.ts");
});

after(() => {
  process.env.HOME = _origHome;
  process.env.USERPROFILE = _origProfile;
  if (_isolatedHome) {
    try { rmSync(_isolatedHome, { recursive: true, force: true }); } catch {}
  }
});

/** 在临时目录写一个 JSON 配置文件 */
function writeJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

// ─── validateServerConfig ──────────────────────

describe("validateServerConfig", () => {
  it("合法完整配置返回空错误", () => {
    const errs = mod.validateServerConfig("test-server", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { FOO: "bar" },
      cwd: "/tmp",
      transport: "stdio",
      enabled: true,
    });
    assert.strictEqual(errs.length, 0);
  });

  it("仅 command 必填，其他可省略", () => {
    const errs = mod.validateServerConfig("minimal", { command: "node server.js" });
    assert.strictEqual(errs.length, 0);
  });

  it("command 为空时报错", () => {
    const errs = mod.validateServerConfig("bad", { command: "" });
    assert.ok(errs.some((e) => e.message.includes("必填")));
  });

  it("command 缺失时报错", () => {
    const errs = mod.validateServerConfig("bad", {});
    assert.ok(errs.some((e) => e.message.includes("必填")));
  });

  it("非对象时直接返回错误", () => {
    const errs = mod.validateServerConfig("bad", "string");
    assert.strictEqual(errs.length, 1);
    assert.ok(errs[0].message.includes("对象"));
  });

  it("args 必须是字符串数组", () => {
    const errs1 = mod.validateServerConfig("bad", { command: "x", args: "not-array" });
    assert.ok(errs1.some((e) => e.message.includes("字符串数组")));

    const errs2 = mod.validateServerConfig("bad", { command: "x", args: [1, 2] });
    assert.ok(errs2.some((e) => e.message.includes("字符串数组")));

    const errs3 = mod.validateServerConfig("ok", { command: "x", args: ["a", "b"] });
    assert.strictEqual(errs3.length, 0);
  });

  it("env 值必须是字符串", () => {
    const errs = mod.validateServerConfig("bad", { command: "x", env: { FOO: 123 } });
    assert.ok(errs.some((e) => e.message.includes("字符串")));
  });

  it("transport 支持 stdio/http/sse", () => {
    const errs1 = mod.validateServerConfig("bad", { command: "x", transport: "stdio" });
    assert.strictEqual(errs1.length, 0, "stdio 合法");

    const errs2 = mod.validateServerConfig("ok", { transport: "http", url: "http://localhost:8080/mcp" });
    assert.strictEqual(errs2.length, 0, "http 合法");

    const errs3 = mod.validateServerConfig("ok", { transport: "sse", url: "http://localhost:8080/sse" });
    assert.strictEqual(errs3.length, 0, "sse 合法");

    const errs4 = mod.validateServerConfig("ok", { command: "x" });
    assert.strictEqual(errs4.length, 0, "默认 stdio 合法");
  });

  it("不支持的 transport 报错", () => {
    const errs = mod.validateServerConfig("bad", { command: "x", transport: "ws" });
    assert.ok(errs.some((e) => e.message.includes("不支持的传输层")));
  });

  it("http 模式下 url 必填且格式有效", () => {
    const errs1 = mod.validateServerConfig("bad", { transport: "http" });
    assert.ok(errs1.some((e) => e.message.includes("url")));

    const errs2 = mod.validateServerConfig("bad", { transport: "http", url: "" });
    assert.ok(errs2.some((e) => e.message.includes("url")));

    const errs3 = mod.validateServerConfig("bad", { transport: "http", url: "not-a-url" });
    assert.ok(errs3.some((e) => e.message.includes("URL 格式无效")), `got: ${JSON.stringify(errs3)}`);

    const errs4 = mod.validateServerConfig("ok", { transport: "http", url: "https://mcp.example.com/api" });
    assert.strictEqual(errs4.length, 0, "合法 URL 通过");
  });

  it("http 模式下 command 可选", () => {
    const errs = mod.validateServerConfig("ok", { transport: "http", url: "http://localhost/mcp" });
    assert.strictEqual(errs.length, 0);
  });

  it("http headers 必须是字符串对象", () => {
    const errs1 = mod.validateServerConfig("bad", { transport: "http", url: "http://x", headers: "bad" });
    assert.ok(errs1.length > 0, "headers 为字符串时报错");

    const errs2 = mod.validateServerConfig("bad", { transport: "http", url: "http://x", headers: { Authorization: 123 } });
    assert.ok(errs2.length > 0, "headers 值非字符串时报错");

    const errs3 = mod.validateServerConfig("ok", { transport: "http", url: "http://x", headers: { Authorization: "Bearer token" } });
    assert.strictEqual(errs3.length, 0, "headers 字符串值通过");
  });

  it("enabled 必须是布尔值", () => {
    const errs = mod.validateServerConfig("bad", { command: "x", enabled: "yes" });
    assert.ok(errs.some((e) => e.message.includes("布尔值")));
  });
});

// ─── normalizeServerConfig ─────────────────────

describe("normalizeServerConfig", () => {
  it("填充默认值", () => {
    const { config, errors } = mod.normalizeServerConfig("t", { command: "npx foo" });
    assert.strictEqual(errors.length, 0);
    assert.deepStrictEqual(config.args, []);
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.transport, "stdio");
  });

  it("合法配置透传", () => {
    const { config, errors } = mod.normalizeServerConfig("t", {
      command: "npx",
      args: ["-y", "pkg"],
      enabled: false,
      transport: "stdio",
    });
    assert.strictEqual(errors.length, 0);
    assert.deepStrictEqual(config.args, ["-y", "pkg"]);
    assert.strictEqual(config.enabled, false);
  });

  it("http 配置正确解析", () => {
    const { config, errors } = mod.normalizeServerConfig("t", {
      transport: "http",
      url: "https://mcp.example.com",
      headers: { Authorization: "Bearer abc" },
    });
    assert.strictEqual(errors.length, 0);
    assert.strictEqual(config.transport, "http");
    assert.strictEqual(config.url, "https://mcp.example.com");
    assert.strictEqual(config.headers.Authorization, "Bearer abc");
  });
});

// ─── getCandidatePaths ─────────────────────────

describe("getCandidatePaths", () => {
  it("返回 3 个候选路径按优先级从高到低", () => {
    const candidates = mod.getCandidatePaths("/project", "/global/config");
    assert.strictEqual(candidates.length, 3);
    // 第 0 优先级: 项目根 .mcp.json
    assert.ok(candidates[0].path.endsWith(".mcp.json"), `path=${candidates[0].path}`);
    assert.ok(candidates[0].path.includes("project") || candidates[0].path.includes("PROJECT"), `path=${candidates[0].path}`);
    assert.strictEqual(candidates[0].priority, 0);

    // 第 1 优先级: .vscode/mcp.json
    assert.ok(candidates[1].path.includes(".vscode"), `path=${candidates[1].path}`);
    assert.strictEqual(candidates[1].priority, 1);

    // 第 2 优先级: 全局配置
    assert.ok(candidates[2].path.includes("global"), `path=${candidates[2].path}`);
    assert.strictEqual(candidates[2].priority, 2);
  });

  it("无 globalConfigDir 时使用默认路径", () => {
    const candidates = mod.getCandidatePaths("/project");
    assert.strictEqual(candidates.length, 3);
    assert.ok(candidates[2].path.includes(".pi"));
  });
});

// ─── loadMcpConfig ─────────────────────────────

describe("loadMcpConfig", () => {
  it("无配置文件时返回空", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      const result = mod.loadMcpConfig({ projectRoot: tmpDir });
      assert.strictEqual(result.servers.length, 0);
      assert.strictEqual(result.errors.length, 0);
      assert.strictEqual(result.loadedPaths.length, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("读取 .mcp.json 中的 server", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      writeJson(`${tmpDir}/.mcp.json`, {
        servers: { "fs": { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } },
      });
      const result = mod.loadMcpConfig({ projectRoot: tmpDir });
      assert.strictEqual(result.servers.length, 1);
      assert.strictEqual(result.servers[0].name, "fs");
      assert.strictEqual(result.servers[0].config.command, "npx");
      assert.strictEqual(result.servers[0].priority, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("高优先级覆盖低优先级同名 server", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      writeJson(`${tmpDir}/.mcp.json`, {
        servers: { "my-tool": { command: "npx", args: ["old"] } },
      });
      const globalDir = resolve(tmpDir, "global");
      writeJson(`${globalDir}/mcp.json`, {
        servers: { "my-tool": { command: "npx", args: ["new"] } },
      });

      const result = mod.loadMcpConfig({ projectRoot: tmpDir, globalConfigDir: globalDir });
      assert.strictEqual(result.servers.length, 1);
      assert.deepStrictEqual(result.servers[0].config.args, ["old"]);
      assert.strictEqual(result.servers[0].priority, 0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("不同名 server 合并", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      writeJson(`${tmpDir}/.mcp.json`, {
        servers: { "server-a": { command: "a" } },
      });
      const globalDir = resolve(tmpDir, "global");
      writeJson(`${globalDir}/mcp.json`, {
        servers: { "server-b": { command: "b" } },
      });

      const result = mod.loadMcpConfig({ projectRoot: tmpDir, globalConfigDir: globalDir });
      assert.strictEqual(result.servers.length, 2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("无效 server 不阻断其他 server", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      writeJson(`${tmpDir}/.mcp.json`, {
        servers: {
          "good": { command: "ok" },
          "bad": { command: "" },
        },
      });
      const result = mod.loadMcpConfig({ projectRoot: tmpDir });
      assert.strictEqual(result.servers.length, 1);
      assert.strictEqual(result.servers[0].name, "good");
      assert.ok(result.errors.some((e) => e.path.includes("bad")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("缺少 servers 产生错误", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      writeJson(`${tmpDir}/.mcp.json`, { notServers: {} });
      const result = mod.loadMcpConfig({ projectRoot: tmpDir });
      assert.strictEqual(result.servers.length, 0);
      assert.ok(result.errors.some((e) => e.message.includes("servers")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("JSON 解析错误产生错误", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      writeFileSync(`${tmpDir}/.mcp.json`, "not json", "utf-8");
      const result = mod.loadMcpConfig({ projectRoot: tmpDir });
      assert.strictEqual(result.servers.length, 0);
      assert.ok(result.errors.some((e) => e.message.includes("JSON 解析失败")));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("servers 为数组时产生错误（必须为对象）", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      writeJson(`${tmpDir}/.mcp.json`, { servers: [] });
      const result = mod.loadMcpConfig({ projectRoot: tmpDir });
      assert.strictEqual(result.servers.length, 0);
      assert.ok(result.errors.some((e) => e.message.includes("servers")), JSON.stringify(result.errors));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("结果按优先级排序", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      const globalDir = resolve(tmpDir, "global");
      writeJson(`${globalDir}/mcp.json`, {
        servers: { "low": { command: "low-pri" } },
      });
      writeJson(`${tmpDir}/.mcp.json`, {
        servers: { "high-a": { command: "high-a" }, "high-b": { command: "high-b" } },
      });

      const result = mod.loadMcpConfig({ projectRoot: tmpDir, globalConfigDir: globalDir });
      assert.strictEqual(result.servers[0].priority, 0);
      assert.strictEqual(result.servers[1].priority, 0);
      assert.strictEqual(result.servers[2].priority, 2);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── getEnabledServers ─────────────────────────

describe("getEnabledServers", () => {
  it("过滤出 enabled 的 server", () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "mcp-config-test-"));
    try {
      writeJson(`${tmpDir}/.mcp.json`, {
        servers: {
          "enabled-one": { command: "a", enabled: true },
          "disabled-one": { command: "b", enabled: false },
          "implicit-enabled": { command: "c" },
        },
      });
      const result = mod.loadMcpConfig({ projectRoot: tmpDir });
      const enabled = mod.getEnabledServers(result);
      assert.strictEqual(enabled.length, 2);
      assert.ok(enabled.every((s) => s.config.enabled !== false));
      assert.strictEqual(enabled[0].name, "enabled-one");
      assert.strictEqual(enabled[1].name, "implicit-enabled");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
