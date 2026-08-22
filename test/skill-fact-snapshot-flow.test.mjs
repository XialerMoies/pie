import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { SkillService } = await import("../src/agent/skills/skill-service.ts");
const { AgentRuntime } = await import("../src/agent/runtime.ts");

const document = (id, body = "# Body A") => `---\nname: ${id}\ndescription: Snapshot test\ntools:\n  - command\n---\n\n${body}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mca-a06-flow-"));
  const userRoot = join(root, "user");
  const workspace = join(root, "workspace");
  const workspaceRoot = join(workspace, "agent", "skills");
  await mkdir(join(userRoot, "verify"), { recursive: true });
  await mkdir(join(workspaceRoot, "verify"), { recursive: true });
  await writeFile(join(workspaceRoot, "verify", "SKILL.md"), document("verify"));
  const service = new SkillService({
    userRoot,
    workspaceRoot: () => workspaceRoot,
    statePath: join(root, "skill-state.json"),
    knownTools: new Set(["command"]),
  });
  await service.trust("workspace", "verify");
  await service.enable("workspace", "verify");
  return { root, workspace, workspaceRoot, service };
}

function runtimeFor(service, workspace) {
  const runtime = Object.create(AgentRuntime.prototype);
  runtime.config = { skillService: service };
  runtime.currentWorkspace = workspace;
  runtime._skillPromptRefreshTail = Promise.resolve();
  const loader = { prompts: [], setAppendSystemPrompt(value) { this.prompts.push(value); } };
  runtime._session = { _resourceLoader: loader, refreshSystemPromptCalls: 0, refreshSystemPrompt() { this.refreshSystemPromptCalls++; } };
  return { runtime, loader };
}

describe("A-06 skill fact snapshot cross-layer flow", () => {
  it("uses the same scoped revision for service facts and runtime prompt injection", async () => {
    const { service, workspace, workspaceRoot } = await fixture();
    const snapshot = await service.snapshot(workspaceRoot);
    const promptInput = await service.promptInput(workspaceRoot, snapshot);
    const { runtime, loader } = runtimeFor(service, workspace);
    const prompt = await runtime._buildSystemPrompt(workspace);
    const status = runtime.getSkillPromptStatus();
    assert.equal(status.status, "ready");
    assert.equal(status.revision, snapshot.revision);
    assert.equal(promptInput.revision, status.revision);
    assert.match(prompt, /# Body A/);
    assert.equal(loader.prompts.length, 0, "building a prompt must not mutate the active loader");
  });

  it("changes the prompt revision and removes the body after a refresh/recovery observes changed content", async () => {
    const { service, workspace, workspaceRoot } = await fixture();
    const { runtime } = runtimeFor(service, workspace);
    const firstPrompt = await runtime._buildSystemPrompt(workspace);
    const firstRevision = runtime.getSkillPromptStatus().revision;
    assert.match(firstPrompt, /# Body A/);
    await writeFile(join(workspaceRoot, "verify", "SKILL.md"), document("verify", "# Body B"));
    const recoveredPrompt = await runtime._buildSystemPrompt(workspace);
    const recoveredStatus = runtime.getSkillPromptStatus();
    assert.notEqual(recoveredStatus.revision, firstRevision);
    assert.doesNotMatch(recoveredPrompt, /# Body A|# Body B/);
    assert.equal(recoveredStatus.status, "ready");
  });

  it("reports refresh failure explicitly and preserves the previous successful revision", async () => {
    const { service, workspace } = await fixture();
    const { runtime, loader } = runtimeFor(service, workspace);
    const first = await runtime.refreshSystemPrompt();
    assert.equal(first.ok, true);
    const revision = first.revision;
    service.snapshot = async () => { throw new Error("skill state unavailable"); };
    const failed = await runtime.refreshSystemPrompt();
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "skill_prompt_unavailable");
    assert.equal(failed.previousRevision, revision);
    assert.equal(runtime.getSkillPromptStatus().status, "error");
    assert.equal(loader.prompts.length, 1, "failed refresh must not overwrite the last valid loader prompt");
  });

  it("serializes concurrent refreshes so an older snapshot cannot overwrite a newer one", async () => {
    const calls = [];
    const service = {
      snapshot: async () => {
        const revision = `r-${calls.length + 1}`;
        calls.push(revision);
        await new Promise((resolve) => setTimeout(resolve, revision === "r-1" ? 15 : 1));
        return { revision, workspaceRoot: "C:/workspace/agent/skills", workspaceKey: "k", result: { skills: [], diagnostics: [] }, entries: [] };
      },
      promptInput: async (_root, snapshot) => ({ summaries: [], bodies: new Map(), revision: snapshot.revision, workspaceKey: snapshot.workspaceKey, diagnostics: [] }),
    };
    const { runtime, loader } = runtimeFor(service, "C:/workspace");
    const [first, second] = await Promise.all([runtime.refreshSystemPrompt(), runtime.refreshSystemPrompt()]);
    assert.deepEqual(calls, ["r-1", "r-2"]);
    assert.equal(first.revision, "r-1");
    assert.equal(second.revision, "r-2");
    assert.equal(runtime.getSkillPromptStatus().revision, "r-2");
    assert.equal(loader.prompts.length, 2);
  });
});
