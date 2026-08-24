import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionManager } from "@xiamol/pi-coding-agent";

import {
  AgentProfileRegistry,
  agentProfileSelection,
  persistAgentProfileSelection,
  readAgentProfileSelection,
  readAgentProfileSelectionFile,
  resolveAgentProfile,
  resolveAgentProfileSelection,
} from "../src/agent/agent-profile.ts";
import { resolveSystemPrompt } from "../src/agent/prompts.ts";
import { getCustomTools, getCustomToolsAsync, toolRegistry } from "../src/agent/tools/index.ts";
import { currentGeneration } from "../src/agent/mcp/MCPClientService.ts";
import { handleSessions } from "../src/server/routes/sessions.ts";
import { wsDir } from "../src/server/routes/session-dir.ts";

function request(method, url, body) {
  const req = {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json" },
    on(event, callback) {
      if (event === "data" && body !== undefined) callback(Buffer.from(JSON.stringify(body)));
      if (event === "end") callback();
      return req;
    },
  };
  return req;
}

async function callSessions(ctx, method, url, body) {
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); return this; },
    end(chunk) { if (chunk) this.body += String(chunk); return this; },
  };
  const handled = await handleSessions(request(method, url, body), res, ctx);
  return { handled, status: res.status, headers: res.headers, body: JSON.parse(res.body || "null") };
}

function createFlowContext(root, workspace) {
  const sessionsRoot = resolve(root, "sessions");
  let manager;
  const engine = {
    session: {
      id: "",
      workspace,
      isStreaming: false,
      profile: { id: "standard", revision: 1 },
    },
    async switchWorkspace(next) { this.session.workspace = next; },
    async createNewSession(profileId) {
      const profile = resolveAgentProfile(profileId);
      const dir = wsDir(sessionsRoot, this.session.workspace);
      mkdirSync(dir, { recursive: true });
      manager = SessionManager.create(this.session.workspace, dir);
      persistAgentProfileSelection(manager, profile);
      // PI intentionally delays JSONL creation until the first assistant result.
      // Drive that real persistence boundary so the route flow can refresh/replay it.
      manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
      this.session = {
        ...this.session,
        id: manager.getSessionId(),
        sessionFile: manager.getSessionFile(),
        profile: agentProfileSelection(profile),
      };
      return this.session.id;
    },
    async openSession(file, nextWorkspace) {
      const selection = readAgentProfileSelectionFile(file) ?? { id: "standard", revision: 1 };
      const profile = resolveAgentProfileSelection(selection);
      manager = SessionManager.open(file, undefined, nextWorkspace);
      this.session = {
        ...this.session,
        id: manager.getSessionId(),
        workspace: nextWorkspace,
        sessionFile: file,
        profile: agentProfileSelection(profile),
      };
    },
  };
  const published = [];
  const paths = {
    APP_ROOT: workspace,
    DATA_DIR: root,
    PI_CONFIG_DIR: resolve(root, "pi"),
    SESSIONS_DIR: sessionsRoot,
  };
  const ctx = {
    engine,
    runtime: {},
    paths,
    appEvents: { publish(type) { published.push(type); } },
  };
  ctx.groups = {
    core: { engine, runtime: ctx.runtime, appEvents: ctx.appEvents },
    storage: { paths },
    providers: { providerReferenceLock: undefined },
    security: {},
  };
  return { ctx, engine, published, get manager() { return manager; } };
}

describe("AP-01 profile registry and projection", () => {
  it("fails closed on duplicate, unknown, and unsupported profile revisions", () => {
    const registry = new AgentProfileRegistry();
    const profile = {
      id: "test",
      revision: 1,
      description: "test",
      toolNames: [],
      promptSections: [],
      allowMcp: false,
      includeSkills: false,
    };
    registry.register(profile);
    assert.throws(() => registry.register(profile), /already registered/);
    assert.throws(() => registry.require("missing"), /Unknown agent profile/);
    assert.throws(() => resolveAgentProfileSelection({ id: "minimal", revision: 99 }), /Unsupported agent profile revision/);
    assert.throws(() => readAgentProfileSelection([{ type: "custom", customType: "my-code-agent.profile", data: { id: "minimal" } }]), /Invalid persisted/);
    assert.throws(() => readAgentProfileSelection([
      { type: "custom", customType: "my-code-agent.profile", data: { id: "minimal", revision: 1 } },
      { type: "custom", customType: "my-code-agent.profile", data: { id: "standard", revision: 1 } },
    ]), /Conflicting persisted/);
  });

  it("projects deterministic tools and prompts without mutating standard behavior or starting MCP", async () => {
    const standard = resolveAgentProfile("standard");
    const minimal = resolveAgentProfile("minimal");
    const allNames = toolRegistry.getAll().map((tool) => tool.name);
    assert.deepStrictEqual(getCustomTools(undefined, undefined, undefined, standard).map((tool) => tool.name), allNames);
    assert.deepStrictEqual(getCustomTools(undefined, undefined, undefined, minimal).map((tool) => tool.name), ["command", "str_replace_editor"]);

    const fullBefore = resolveSystemPrompt();
    const minimalPrompt = resolveSystemPrompt(minimal.promptSections);
    const generationBefore = currentGeneration();
    const asyncMinimal = await getCustomToolsAsync(resolve(tmpdir(), "profile-no-mcp"), undefined, undefined, minimal);
    assert.deepStrictEqual(asyncMinimal.map((tool) => tool.name), ["command", "str_replace_editor"]);
    assert.strictEqual(currentGeneration(), generationBefore, "minimal must not start or invalidate MCP discovery");
    assert.strictEqual(resolveSystemPrompt(), fullBefore, "profile projection must not mutate the global prompt registry");
    assert.ok(minimalPrompt.length > 0);
    assert.ok(minimalPrompt.length < fullBefore.length);
  });

  it("persists profile selections through the real PI SessionManager and defaults legacy sessions to standard", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agent-profile-session-"));
    try {
      const manager = SessionManager.create(root, root);
      persistAgentProfileSelection(manager, resolveAgentProfile("minimal"));
      manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
      const file = manager.getSessionFile();
      assert.ok(file);
      const reopened = SessionManager.open(file, undefined, root);
      assert.deepStrictEqual(readAgentProfileSelection(reopened.getEntries()), { id: "minimal", revision: 1 });
      assert.deepStrictEqual(readAgentProfileSelectionFile(file), { id: "minimal", revision: 1 });

      const legacy = SessionManager.create(root, root);
      assert.strictEqual(readAgentProfileSelection(legacy.getEntries()), undefined);
      assert.deepStrictEqual(agentProfileSelection(resolveAgentProfile("standard")), { id: "standard", revision: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("AP-02 fact-verification profile projection", () => {
  it("exposes only bounded read tools, a focused prompt, and no MCP or skill injection", async () => {
    const profile = resolveAgentProfile("fact-verification");
    assert.deepStrictEqual(
      getCustomTools(undefined, undefined, undefined, profile).map((tool) => tool.name),
      ["file_read", "explorer_list", "read_memory", "list_memory", "skill_facts"],
    );
    const generationBefore = currentGeneration();
    const asyncTools = await getCustomToolsAsync(resolve(tmpdir(), "fact-profile-no-mcp"), undefined, undefined, profile);
    assert.deepStrictEqual(asyncTools.map((tool) => tool.name), ["file_read", "explorer_list", "read_memory", "list_memory", "skill_facts"]);
    assert.strictEqual(currentGeneration(), generationBefore);
    assert.strictEqual(profile.allowMcp, false);
    assert.strictEqual(profile.includeSkills, false);
    const prompt = resolveSystemPrompt(profile.promptSections);
    assert.match(prompt, /事实核验 Profile/);
    assert.match(prompt, /“未验证”是合法且完整的终态/);
    assert.doesNotMatch(prompt, /Edit\/Write/);
    assert.doesNotMatch(prompt, /主动更新记忆/);
  });
});

describe("AP-01 sessions route cross-layer flow", () => {
  it("keeps minimal across create, list, branch, activate, and isolates a standard session", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "agent-profile-route-"));
    const workspace = resolve(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const flow = createFlowContext(root, workspace);
    try {
      const createdMinimal = await callSessions(flow.ctx, "POST", "/api/sessions/new", { workspace, profileId: "minimal" });
      assert.strictEqual(createdMinimal.status, 200);
      assert.deepStrictEqual(createdMinimal.body.profile, { id: "minimal", revision: 1 });
      const minimalId = createdMinimal.body.id;
      const minimalFile = flow.engine.session.sessionFile;
      assert.deepStrictEqual(readAgentProfileSelectionFile(minimalFile), { id: "minimal", revision: 1 });

      const listed = await callSessions(flow.ctx, "GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`);
      assert.strictEqual(listed.status, 200);
      assert.deepStrictEqual(listed.body.sessions.find((session) => session.id === minimalId).profile, { id: "minimal", revision: 1 });

      const branched = await callSessions(flow.ctx, "POST", "/api/sessions/branch", { id: minimalId, workspace });
      assert.strictEqual(branched.status, 200);
      assert.deepStrictEqual(branched.body.profile, { id: "minimal", revision: 1 });
      assert.deepStrictEqual(readAgentProfileSelectionFile(flow.engine.session.sessionFile), { id: "minimal", revision: 1 });

      const createdStandard = await callSessions(flow.ctx, "POST", "/api/sessions/new", { workspace, profileId: "standard" });
      assert.strictEqual(createdStandard.status, 200);
      assert.deepStrictEqual(createdStandard.body.profile, { id: "standard", revision: 1 });

      const activated = await callSessions(flow.ctx, "POST", "/api/sessions/activate", { id: minimalId, workspace });
      assert.strictEqual(activated.status, 200);
      assert.deepStrictEqual(activated.body.profile, { id: "minimal", revision: 1 });
      assert.strictEqual(flow.engine.session.sessionFile, minimalFile);
      assert.ok(flow.published.length >= 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown requested profiles without replacing the active session", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "agent-profile-unknown-"));
    const workspace = resolve(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const flow = createFlowContext(root, workspace);
    try {
      const baseline = await callSessions(flow.ctx, "POST", "/api/sessions/new", { workspace, profileId: "standard" });
      const before = { ...flow.engine.session };
      const rejected = await callSessions(flow.ctx, "POST", "/api/sessions/new", { workspace, profileId: "does-not-exist" });
      assert.strictEqual(rejected.status, 400);
      assert.match(rejected.body.error, /Unknown agent profile/);
      assert.deepStrictEqual(flow.engine.session, before);
      assert.strictEqual(baseline.body.id, before.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists and restores fact-verification independently across concurrent session hosts", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "agent-fact-profile-concurrent-"));
    const firstWorkspace = resolve(root, "first-workspace");
    const secondWorkspace = resolve(root, "second-workspace");
    mkdirSync(firstWorkspace, { recursive: true });
    mkdirSync(secondWorkspace, { recursive: true });
    const first = createFlowContext(resolve(root, "first-host"), firstWorkspace);
    const second = createFlowContext(resolve(root, "second-host"), secondWorkspace);
    try {
      const [factCreated, standardCreated] = await Promise.all([
        callSessions(first.ctx, "POST", "/api/sessions/new", { workspace: firstWorkspace, profileId: "fact-verification" }),
        callSessions(second.ctx, "POST", "/api/sessions/new", { workspace: secondWorkspace, profileId: "standard" }),
      ]);
      assert.deepStrictEqual(factCreated.body.profile, { id: "fact-verification", revision: 1 });
      assert.deepStrictEqual(standardCreated.body.profile, { id: "standard", revision: 1 });
      const factFile = first.engine.session.sessionFile;
      assert.deepStrictEqual(readAgentProfileSelectionFile(factFile), { id: "fact-verification", revision: 1 });

      await callSessions(first.ctx, "POST", "/api/sessions/new", { workspace: firstWorkspace, profileId: "standard" });
      const restored = await callSessions(first.ctx, "POST", "/api/sessions/activate", { id: factCreated.body.id, workspace: firstWorkspace });
      assert.deepStrictEqual(restored.body.profile, { id: "fact-verification", revision: 1 });
      assert.strictEqual(first.engine.session.sessionFile, factFile);
      assert.deepStrictEqual(second.engine.session.profile, { id: "standard", revision: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
