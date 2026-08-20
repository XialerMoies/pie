import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createUserCommandEnv,
  createMcpProcessEnv,
  createTsserverEnv,
  createInternalServerEnv,
  createElectronHelperEnv,
  sanitizeProcessOutput,
} from "../src/process/env-policy.ts";

const host = {
  PATH: "C:\\Tools;C:\\Windows\\System32",
  Path: "C:\\Tools;C:\\Windows\\System32",
  CUSTOM_TOOLCHAIN: "clang",
  OPENAI_API_KEY: "openai-secret",
  ANTHROPIC_API_KEY: "anthropic-secret",
  GITHUB_TOKEN: "github-secret",
  BRAVE_API_KEY: "brave-secret",
  MY_CODE_AGENT_DESKTOP_TOKEN: "desktop-secret",
  PI_INSTANCE_ID: "internal-instance",
  TEMP: "C:\\Temp",
  USERPROFILE: "C:\\Users\\user",
};

describe("process environment policy", () => {
  it("keeps user toolchain and provider variables but removes internal runtime variables", () => {
    const env = createUserCommandEnv({
      hostEnv: host,
      platform: "win32",
      bashExecutable: "C:\\Git\\bin\\bash.exe",
    });
    assert.equal(env.CUSTOM_TOOLCHAIN, "clang");
    assert.match(env.PATH ?? "", /C:\\Git\\bin/);
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, undefined);
    assert.equal(env.PI_INSTANCE_ID, undefined);
    assert.equal(env.OPENAI_API_KEY, "openai-secret");
    assert.notStrictEqual(env, host);
  });

  it("only gives MCP the safe base plus explicitly configured values", () => {
    const env = createMcpProcessEnv(host, {
      GITHUB_TOKEN: "configured-github",
      MCP_MODE: "readonly",
    });
    assert.equal(env.PATH, host.PATH);
    assert.equal(env.GITHUB_TOKEN, "configured-github");
    assert.equal(env.MCP_MODE, "readonly");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, undefined);
    assert.equal(env.PI_INSTANCE_ID, undefined);
  });

  it("keeps tsserver runtime variables without provider credentials", () => {
    const env = createTsserverEnv(host, "C:\\repo\\node_modules\\typescript\\lib");
    assert.equal(env.PATH, host.PATH);
    assert.equal(env.TS_INTERNAL, "C:\\repo\\node_modules\\typescript\\lib");
    assert.equal(env.CUSTOM_TOOLCHAIN, "clang");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, undefined);
  });

  it("keeps provider access and adds only the required internal server values", () => {
    const env = createInternalServerEnv(host, {
      token: "new-desktop-token",
      workspace: "C:\\repo",
      dataRoot: "C:\\data",
      instanceId: "new-instance",
      userRoot: "C:\\config",
      sessionsDir: "C:\\data\\sessions",
      workspaceData: "C:\\data\\workspace",
      instanceData: "C:\\data\\instance",
    });
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, "new-desktop-token");
    assert.equal(env.PI_WORKSPACE, "C:\\repo");
    assert.equal(env.PI_INSTANCE_ID, "new-instance");
    assert.equal(env.PI_DESKTOP_SESSIONS, "C:\\data\\sessions");
    assert.equal(env.OPENAI_API_KEY, "openai-secret");
    assert.notStrictEqual(env, host);
  });

  it("keeps non-user Electron helpers free of host credentials", () => {
    const env = createElectronHelperEnv(host, {
      electronRunAsNode: true,
      workspace: "C:\\repo",
      dataRoot: "C:\\data",
      extra: { HELPER_MODE: "probe" },
    });
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.PI_WORKSPACE, "C:\\repo");
    assert.equal(env.HELPER_MODE, "probe");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, undefined);
  });

  it("sanitizes known values and common credential formats", () => {
    const output = sanitizeProcessOutput(
      "Authorization: Bearer abc123\nkey=secret-value\nopenai-secret",
      ["openai-secret", "secret-value"],
    );
    assert.doesNotMatch(output, /abc123|secret-value|openai-secret/);
    assert.match(output, /\[redacted\]/);
  });
});
