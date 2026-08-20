# Spawn 与环境变量治理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每类子进程建立显式、可测试的环境继承策略，阻止无关凭据传播并保持 Windows 开发工具链可用。

**Architecture:** 在 `src/process/env-policy.ts` 放置无状态环境构造和文本脱敏函数。用户命令/CLI、MCP、tsserver、内部 server 分别调用对应策略；构建/测试脚本继续保留其开发工具环境，但通过 catalog 明确归属，并在触及的输出边界统一脱敏。所有策略返回新对象，不修改 `process.env` 或调用方输入。

**Tech Stack:** Node.js `child_process`, TypeScript, MCP SDK `StdioClientTransport`, Node test runner, `tsx`, 生成式 capability catalog。

---

## 文件结构与职责

- Create: `src/process/env-policy.ts` — 六类进程的环境构造、显式秘密键集合、文本/错误脱敏。
- Create: `test/process-env-policy.test.mjs` — 环境策略和脱敏的纯单元测试。
- Modify: `src/agent/tools/command.ts` — 用 `createUserCommandEnv` 替换本地全量复制。
- Modify: `src/server/routes/git.ts` — 用 `createUserCommandEnv` 为 Git 保留用户 Git/SSH 工具变量并移除桌面内部变量。
- Modify: `src/agent/mcp/MCPClientService.ts` — 用 `createMcpProcessEnv`，并脱敏 MCP 错误/URL 日志。
- Modify: `src/server/ts-server.ts` — 用 `createTsserverEnv`，脱敏 stderr/错误文本。
- Modify: `src/electron/server-binding.ts` — 用 `createInternalServerEnv`，脱敏启动失败、stdout/stderr 和停止错误。
- Modify: `src/electron/cli-terminal.ts` — 用 `createUserCommandEnv` 保留开发者 shell 环境，仅移除桌面 token/内部变量并脱敏启动错误。
- Modify: `scripts/generate-capability-catalog.mjs` — 增加 MCP 间接 spawn 事实和 `git.ts` owner/category 映射；增加 owner 门禁。
- Modify: `docs/generated/capability-catalog.json` — 由生成器更新，不手工编辑。
- Modify: `test/capability-catalog.test.mjs` — 校验间接 MCP spawn 和 `unassigned` 为零。
- Modify: `test/command-security.test.mjs`, `test/mcp-client-service.test.mjs`, `test/server-binding.test.mjs`, `test/cli-terminal.test.mjs` — 扩展环境隔离与输出脱敏断言。
- Modify: `test/tsserver.test.mjs` — 新增 tsserver fork 环境和日志边界测试；若该文件不存在则创建它并加入 `package.json` 的 `test:unit`。
- Modify: `package.json` — 仅在新增测试文件时登记测试命令，不改变现有发布门禁顺序。

## Task 1: 建立纯环境策略与脱敏函数

**Files:**
- Create: `src/process/env-policy.ts`
- Create: `test/process-env-policy.test.mjs`

- [ ] **Step 1: Write failing tests for explicit strategy behavior**

在 `test/process-env-policy.test.mjs` 中导入以下函数并先写断言：

```js
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
    const env = createUserCommandEnv({ hostEnv: host, platform: "win32", bashExecutable: "C:\\Git\\bin\\bash.exe" });
    assert.equal(env.CUSTOM_TOOLCHAIN, "clang");
    assert.match(env.Path ?? "", /C:\\Git\\bin/);
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, undefined);
    assert.equal(env.PI_INSTANCE_ID, undefined);
    assert.equal(env.OPENAI_API_KEY, "openai-secret");
  });

  it("only gives MCP the safe base plus explicitly configured values", () => {
    const env = createMcpProcessEnv(host, { GITHUB_TOKEN: "configured-github", MCP_MODE: "readonly" });
    assert.equal(env.PATH, host.PATH);
    assert.equal(env.GITHUB_TOKEN, "configured-github");
    assert.equal(env.MCP_MODE, "readonly");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, undefined);
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
      workspaceData: "C:\\data\\workspace",
      instanceData: "C:\\data\\instance",
    });
    assert.equal(env.MY_CODE_AGENT_DESKTOP_TOKEN, "new-desktop-token");
    assert.equal(env.PI_WORKSPACE, "C:\\repo");
    assert.equal(env.PI_INSTANCE_ID, "new-instance");
    assert.equal(env.OPENAI_API_KEY, "openai-secret");
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
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node scripts/tsx-test.mjs --test test/process-env-policy.test.mjs`

Expected: FAIL because `src/process/env-policy.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal policy module**

Add explicit constants and pure functions with these signatures:

```ts
export interface InternalServerEnvValues {
  token: string;
  workspace: string;
  dataRoot: string;
  instanceId: string;
  userRoot: string;
  workspaceData: string;
  instanceData: string;
}

export function createUserCommandEnv(input: {
  hostEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  bashExecutable?: string;
}): NodeJS.ProcessEnv;
export function createMcpProcessEnv(hostEnv: NodeJS.ProcessEnv, configuredEnv?: Record<string, string>): NodeJS.ProcessEnv;
export function createTsserverEnv(hostEnv: NodeJS.ProcessEnv, tsLibDir: string): NodeJS.ProcessEnv;
export function createInternalServerEnv(hostEnv: NodeJS.ProcessEnv, values: InternalServerEnvValues): NodeJS.ProcessEnv;
export function createElectronHelperEnv(hostEnv: NodeJS.ProcessEnv, values: {
  electronRunAsNode?: boolean;
  workspace?: string;
  dataRoot?: string;
  extra?: Record<string, string | undefined>;
}): NodeJS.ProcessEnv;
export function sanitizeProcessOutput(value: unknown, knownSecrets?: readonly string[]): string;
```

Use an explicit array of known provider credential names (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `BRAVE_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `AZURE_OPENAI_API_KEY`, `COHERE_API_KEY`, `GROQ_API_KEY`) plus `MY_CODE_AGENT_DESKTOP_TOKEN` and the documented `PI_*` internal keys. Do not use a `KEY|TOKEN|SECRET` regex to decide what to remove. User command and CLI policies remove only the desktop token, Electron flag, and internal `PI_*` runtime keys; they intentionally preserve user-supplied provider credentials. MCP and tsserver remove the explicit provider list; internal server intentionally preserves provider credentials it may need to run the agent.

`createMcpProcessEnv` should start from the MCP SDK safe base (`PATH`, platform process basics, and `getDefaultEnvironment()` when available), then merge only string values from `configuredEnv`. `createUserCommandEnv` copies host variables, removes only explicit internal runtime keys, and preserves PATH case on Windows; the user strategy prepends the detected Bash directory exactly once. `createTsserverEnv` copies host variables and removes the explicit provider/internal list. `createInternalServerEnv` copies the host/spec environment because the server may need configured provider credentials, then writes only the documented `PI_*`, desktop token, and Electron flags into a new object; it is never reused for user commands or MCP. `createElectronHelperEnv` is reserved for non-user Electron helpers: it removes desktop/provider/internal secrets and writes only its explicit helper values. The CLI terminal uses the user command policy because it is an interactive developer shell, not a privileged helper.

`sanitizeProcessOutput` must stringify unknown errors without throwing, replace `knownSecrets` first, then redact Bearer values, common `sk-/key-/token-` forms, password/cookie assignment values, and sensitive URL query fields. It returns a bounded, non-secret string and never logs internally.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `node scripts/tsx-test.mjs --test test/process-env-policy.test.mjs`

Expected: PASS for all environment and redaction assertions.

- [ ] **Step 5: Commit the policy boundary**

```bash
git add src/process/env-policy.ts test/process-env-policy.test.mjs
git commit -m "feat: add explicit spawn environment policies"
```

## Task 2: Integrate user command, Git route, and Electron CLI environments

**Files:**
- Modify: `src/agent/tools/command.ts:40-62`
- Modify: `src/server/routes/git.ts:25-35`
- Modify: `src/electron/cli-terminal.ts:70-160`
- Modify: `test/command-security.test.mjs`
- Modify: `test/routes.test.mjs` — 验证 Git 子进程收到用户 Git 环境而不是桌面内部变量。
- Modify: `test/cli-terminal.test.mjs`

- [ ] **Step 1: Add regression assertions for preserved toolchain and removed secrets**

Extend the existing command environment test with `CUSTOM_TOOLCHAIN`, `OPENAI_API_KEY`, `PI_INSTANCE_ID`, and `MY_CODE_AGENT_DESKTOP_TOKEN`, then assert the command child receives both the custom variable and the user Provider key, while desktop token and internal `PI_INSTANCE_ID` are absent. Add a Git route harness assertion that the `execFileSync("git", ...)` options contain the user `GIT_ASKPASS`/`SSH_AUTH_SOCK` values but not desktop/internal variables. Extend the CLI tests to assert `PRESERVED_ENV` and a user `OPENAI_API_KEY` remain, while desktop token and unrelated `PI_INSTANCE_ID` are absent from `launch.options.env` on Linux and Windows.

- [ ] **Step 2: Run the focused suites and verify the new assertions fail**

Run: `node scripts/tsx-test.mjs --test test/command-security.test.mjs test/routes.test.mjs test/cli-terminal.test.mjs`

Expected: the new secret-removal assertions fail because command and CLI currently copy the full input environment.

- [ ] **Step 3: Replace local environment copies with policy calls**

Import `createUserCommandEnv` in `command.ts`, `git.ts`, and `cli-terminal.ts`. Make `commandExecutionEnv()` call it with `process.env`, `process.platform`, and the resolved Bash executable. In `git.ts`, pass a fresh `env: createUserCommandEnv({ hostEnv: process.env, platform: process.platform })` to `execFileSync`; this preserves Git credential helpers without exposing desktop runtime variables. In `cli-terminal.ts`, construct the launch environment from the same user policy, then add only the existing CLI entry/loader variables through the `extra` input. Keep Windows Terminal/Git Bash selection, command text, cwd, detached mode, and fallback behavior unchanged; provider variables remain available to the interactive developer shell.

The three call sites should have this shape:

```ts
const env = createUserCommandEnv({
  hostEnv: process.env,
  platform: process.platform,
  bashExecutable,
});
// command spawn uses env

execFileSync("git", args, { cwd, encoding: "utf-8", timeout, env, stdio: ["pipe", "pipe", "pipe"] });

const env = createUserCommandEnv({ hostEnv: input.env, platform: input.platform });
Object.assign(env, { ELECTRON_RUN_AS_NODE: "1", PI_WORKSPACE: input.workspace, PI_DATA_ROOT: input.dataRoot });
```

- [ ] **Step 4: Run focused suites and typecheck**

Run: `node scripts/tsx-test.mjs --test test/command-security.test.mjs test/routes.test.mjs test/cli-terminal.test.mjs` and `npm run typecheck`.

Expected: both suites PASS and typecheck exits 0; existing shell dialect and Git Bash tests remain unchanged.

- [ ] **Step 5: Commit the integrations**

```bash
git add src/agent/tools/command.ts src/server/routes/git.ts src/electron/cli-terminal.ts test/command-security.test.mjs test/routes.test.mjs test/cli-terminal.test.mjs
git commit -m "feat: isolate command and cli terminal environments"
```

## Task 3: Integrate MCP process and transport logging boundaries

**Files:**
- Modify: `src/agent/mcp/MCPClientService.ts:170-285`
- Modify: `test/mcp-client-service.test.mjs`
- Modify: `test/mcp-client.test.mjs` when transport construction is covered there

- [ ] **Step 1: Add MCP environment and credential-leak tests**

Add a test configuration with host `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and desktop token values, while the MCP config explicitly contains `GITHUB_TOKEN: "configured"`. Assert the created stdio transport receives `GITHUB_TOKEN: "configured"` and none of the host secrets. Capture `console.log`/`console.error` during a failed connection and assert the output contains the server name and sanitized error but not any secret or Authorization value. Assert HTTP/SSE status and errors do not serialize headers or sensitive URL query values.

- [ ] **Step 2: Run the MCP focused tests and verify the new tests fail**

Run: `node scripts/tsx-test.mjs --test test/mcp-client-service.test.mjs test/mcp-client.test.mjs`

Expected: the transport/environment capture and raw-error assertions fail before the integration.

- [ ] **Step 3: Pass an explicit MCP environment and sanitize diagnostics**

Import `createMcpProcessEnv` and `sanitizeProcessOutput`. In `createTransport`, for stdio pass `env: createMcpProcessEnv(process.env, config.env)`. Do not pass the host environment directly. For HTTP/SSE, keep headers only in the transport request and never include them in status snapshots or log arguments. Wrap connection error text and all MCP connection log messages with `sanitizeProcessOutput`, passing configured environment values as known secrets without printing the configuration object.

The stdio branch must remain a small transport construction:

```ts
return new StdioClientTransport({
  command: config.command!,
  args: config.args ?? [],
  env: createMcpProcessEnv(process.env, config.env),
  ...(config.cwd ? { cwd: config.cwd } : {}),
});
```

- [ ] **Step 4: Run MCP tests and typecheck**

Run: `node scripts/tsx-test.mjs --test test/mcp-client-service.test.mjs test/mcp-client.test.mjs` and `npm run typecheck`.

Expected: PASS with no secret in captured logs or status output.

- [ ] **Step 5: Commit MCP isolation**

```bash
git add src/agent/mcp/MCPClientService.ts test/mcp-client-service.test.mjs test/mcp-client.test.mjs
git commit -m "feat: restrict mcp child process environment"
```

## Task 4: Integrate tsserver environment and diagnostics

**Files:**
- Modify: `src/server/ts-server.ts:60-180`
- Create or modify: `test/tsserver.test.mjs`
- Modify: `package.json` only if the new test file is created

- [ ] **Step 1: Add fork environment and stderr/error redaction tests**

Inject a fake `fork` dependency or use the existing module seam if present; capture the options passed to `fork`. Assert `PATH`, `CUSTOM_TOOLCHAIN`, `TS_INTERNAL`, and project cwd are preserved, while desktop token and provider keys are absent. Emit stderr and an error containing a known key and assert captured diagnostics contain `[redacted]` but not the original key.

- [ ] **Step 2: Run the tsserver focused test and verify it fails**

Run: `node scripts/tsx-test.mjs --test test/tsserver.test.mjs`

Expected: FAIL on the environment and raw diagnostic assertions because `ts-server.ts` currently spreads `process.env` and prints raw chunks/errors.

- [ ] **Step 3: Use the tsserver policy and sanitized diagnostics**

Import `createTsserverEnv` and `sanitizeProcessOutput`. Pass `env: createTsserverEnv(process.env, tsLibDir)` to `fork`. Sanitize stderr chunks, startup errors, response error messages, and init failure output before logging or rejecting. Preserve IPC arguments, readiness timing, pending request behavior, and stop semantics.

The fork options must retain the existing IPC configuration while replacing only the environment expression:

```ts
this.process = fork(tsserverPath, args, {
  cwd: projectRoot,
  env: createTsserverEnv(process.env, tsLibDir),
  stdio: ["pipe", "pipe", "pipe", "ipc"],
});
```

- [ ] **Step 4: Run tsserver tests and typecheck**

Run: `node scripts/tsx-test.mjs --test test/tsserver.test.mjs` and `npm run typecheck`.

Expected: PASS and no raw provider/desktop secret in output.

- [ ] **Step 5: Commit tsserver isolation**

```bash
git add src/server/ts-server.ts test/tsserver.test.mjs package.json
git commit -m "feat: isolate tsserver environment and diagnostics"
```

## Task 5: Integrate internal server environment and Electron helper diagnostics

**Files:**
- Modify: `src/electron/server-binding.ts:400-480`
- Modify: `src/electron/cli-terminal.ts` error callback if not completed in Task 2
- Modify: `test/server-binding.test.mjs`
- Modify: `test/cli-terminal.test.mjs`

- [ ] **Step 1: Add internal server environment and startup failure tests**

Extend `makeSpec()` with provider keys, desktop token, and unrelated `PI_UNRELATED`. Assert the spawned internal server receives the replacement desktop token and all required layout variables, retains `PRESERVED_ENV` and the provider key needed by the server, and does not share the same mutable environment object with user/MCP policies. Feed stdout/stderr/error strings containing the test secret and assert startup rejection, write callbacks, and unexpected-exit diagnostics contain no raw secret.

- [ ] **Step 2: Run focused server-binding and CLI tests and verify failures**

Run: `node scripts/tsx-test.mjs --test test/server-binding.test.mjs test/cli-terminal.test.mjs`

Expected: new environment and diagnostic assertions fail because `spawnOptions()` merges `spec.env` directly and errors concatenate raw output.

- [ ] **Step 3: Apply internal/helper policies and sanitize all error paths**

Import `createInternalServerEnv` and `sanitizeProcessOutput`. In `spawnOptions`, replace the inline environment object with `createInternalServerEnv(spec.env, values)`, retaining every existing `PI_*` value required by `server-binding` and provider credentials needed by the server. Sanitize text before `writeStdout`, `writeStderr`, startup timeout errors, stop-before-ready errors, force-kill errors, and `onUnexpectedExit` error details. Keep the desktop token only in the internal server environment; the interactive CLI terminal continues to use the user command policy.

The environment construction remains explicit and immutable:

```ts
const env = createInternalServerEnv(spec.env, {
  token: spec.token,
  workspace: spec.workspace,
  dataRoot: spec.dataRoot,
  instanceId: spec.instanceId,
  userRoot: spec.layout.userRoot,
  workspaceData: spec.layout.workspaceRoot,
  instanceData: spec.layout.instanceRoot,
});
return { script, args, options: { env, stdio: ["pipe", "pipe", "pipe"], cwd, shell: false } };
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node scripts/tsx-test.mjs --test test/server-binding.test.mjs test/cli-terminal.test.mjs` and `npm run typecheck`.

Expected: PASS, including existing process lifecycle and retry tests.

- [ ] **Step 5: Commit internal server and helper boundaries**

```bash
git add src/electron/server-binding.ts src/electron/cli-terminal.ts test/server-binding.test.mjs test/cli-terminal.test.mjs
git commit -m "feat: separate internal server and electron helper environments"
```

## Task 6: Make the generated spawn catalog complete and owned

**Files:**
- Modify: `scripts/generate-capability-catalog.mjs`
- Modify: `docs/generated/capability-catalog.json`
- Modify: `test/capability-catalog.test.mjs`
- Modify: `.github/workflows/windows-governance.yml` only if the existing catalog gate lacks the owner assertion

- [ ] **Step 1: Add failing catalog assertions**

Extend `test/capability-catalog.test.mjs` with:

```js
it("records indirect MCP stdio spawn and assigns every spawn owner", async () => {
  const catalog = await buildCapabilityCatalog();
  assert.ok(catalog.spawnPoints.some((point) =>
    point.file === "src/agent/mcp/MCPClientService.ts"
      && point.api === "StdioClientTransport"
      && point.category === "mcp"
      && point.indirect === true
  ));
  assert.equal(catalog.spawnPoints.some((point) => point.owner === "unassigned"), false);
  assert.ok(catalog.spawnPoints.some((point) =>
    point.file === "src/server/routes/git.ts" && point.owner === "server"
  ));
});
```

- [ ] **Step 2: Run the catalog test and verify it fails**

Run: `node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs`

Expected: FAIL because MCP is indirect and `git.ts` currently has no explicit owner mapping.

- [ ] **Step 3: Implement deterministic fact mappings**

Add a small `SPAWN_FACT_OVERRIDES` table in the generator. Record the MCP `StdioClientTransport` call as `{ file: "src/agent/mcp/MCPClientService.ts", api: "StdioClientTransport", category: "mcp", owner: "mcp-client", indirect: true }`; map `src/server/routes/git.ts` to category `server`, owner `server`; retain the existing scan for direct child-process imports. Include `indirect: false` only for direct points if needed for stable schema, and make `spawnOwner` return no `unassigned` for known server routes. Add an owner assertion to the generator/check path so CI fails before writing a catalog with an unowned point.

The override merge must be deterministic and must not inspect environment values:

```js
const SPAWN_FACT_OVERRIDES = [
  { file: "src/agent/mcp/MCPClientService.ts", api: "StdioClientTransport", category: "mcp", owner: "mcp-client", indirect: true },
  { file: "src/server/routes/git.ts", category: "server", owner: "server" },
];
```

- [ ] **Step 4: Regenerate and run catalog tests**

Run: `npm run capabilities:generate` then `node scripts/tsx-test.mjs --test test/capability-catalog.test.mjs` and `npm run capabilities:check`.

Expected: generated JSON is deterministic, tests PASS, and the check reports no drift.

- [ ] **Step 5: Commit catalog governance**

```bash
git add scripts/generate-capability-catalog.mjs docs/generated/capability-catalog.json test/capability-catalog.test.mjs .github/workflows/windows-governance.yml
git commit -m "chore: assign owners to all spawn facts"
```

## Task 7: Verify output boundaries, tooling children, and release gates

**Files:**
- Modify: `scripts/dev.mjs`, `scripts/release-check.mjs`, `scripts/test-parallel.mjs` only where raw child output/errors are emitted.
- Modify: `src/server/routes/git.ts` only if its caught `stderr`/error response leaks credentials.
- Modify: `src/server/observability.ts` only if `sanitizeProcessOutput` needs a narrowly shared text entry point; preserve existing metadata behavior.
- Modify: `test/observability.test.mjs` and relevant route tests for redacted child output.

- [ ] **Step 1: Add output leak regression tests**

Add assertions that a string containing a provider key, Bearer token, password assignment, cookie, and sensitive URL query is absent from tooling failure output, Git route errors, and structured diagnostics. Add a tooling-env test proving `PATH`, `npm_config_*`, and explicitly required provider-matrix variables remain available to release/test children; this is the trusted developer-tool category and is not reused for MCP or agent processes.

- [ ] **Step 2: Run the focused observability/route tests and verify failures**

Run: `node scripts/tsx-test.mjs --test test/observability.test.mjs test/routes.test.mjs test/diagnostics-route.test.mjs`

Expected: newly added raw-secret assertions fail at the current console/error boundaries.

- [ ] **Step 3: Sanitize only touched tooling and route output**

Import the policy sanitizer at the existing child-output/error boundaries. Keep tooling children on their current host environment so npm, Vite, TypeScript, Electron, and optional live provider matrices continue working; do not invent an allowlist. Wrap failure messages before printing or returning them. Do not change command arguments, cwd, process lifecycle, or release gate ordering.

- [ ] **Step 4: Run the complete verification set**

Run, in order:

```powershell
npm run typecheck
npm run capabilities:check
npm run test:unit
npm run test:routes
npm run test:frontend
npm run test:build
```

Expected: every command exits 0; the catalog check is byte-for-byte clean; existing command/MCP/server-binding/CLI suites remain green.

- [ ] **Step 5: Commit final Task 2 implementation**

```bash
git add scripts/dev.mjs scripts/release-check.mjs scripts/test-parallel.mjs src/server/routes/git.ts src/server/observability.ts test/observability.test.mjs test/routes.test.mjs test/diagnostics-route.test.mjs
git commit -m "feat: complete spawn environment governance"
```

## Self-review checklist

- Spec coverage: Tasks 1–5 implement every per-process environment boundary; Task 6 covers indirect MCP facts, `git.ts`, owner checks, and generated synchronization; Task 7 covers credentials in output/errors and trusted tooling behavior.
- Scope: no AST parser, environment DSL, secret discovery service, sandbox, provider auth rewrite, or external-agent implementation is introduced.
- Type consistency: every integration imports the exact exports defined in Task 1; `InternalServerEnvValues` matches the existing `server-binding` layout fields; `createElectronHelperEnv` remains available only for a future non-user Electron helper and is not confused with the interactive CLI policy.
- No raw placeholder steps: every task names files, tests, commands, expected outcomes, and the implementation boundary.
- Failure policy: any environment construction failure rejects that child start and never falls back to `process.env`.
