import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createEmbeddedSubagentSessionFactory,
  SUBAGENT_PROFILE_PROMPTS,
} from "../src/server/subagent-session.ts";
import { READ_ONLY_SUBAGENT_TOOLS } from "../src/server/subagent-supervisor.ts";

function createHarness() {
  const inheritedModel = { provider: "main", id: "main-model" };
  const overrideModel = { provider: "review", id: "review-model" };
  const modelFinds = [];
  const loaderOptions = [];
  const sessionOptions = [];
  let promptResolutions = 0;

  const runtime = {
    authStorage: { kind: "shared-auth" },
    modelRegistry: {
      find(provider, id) {
        modelFinds.push({ provider, id });
        if (provider === overrideModel.provider && id === overrideModel.id) return overrideModel;
        return undefined;
      },
    },
    config: {
      agentDir: "/agent",
      desktopApiToken: "desktop-token",
    },
    session: { model: inheritedModel },
  };

  const factory = createEmbeddedSubagentSessionFactory({
    runtime,
    resolvePrompt() {
      promptResolutions += 1;
      return "PARENT SYSTEM PROMPT";
    },
    createResourceLoader(options) {
      loaderOptions.push(options);
      return {
        async reload() {},
        getExtensions: () => ({ extensions: [], errors: [], runtime: undefined }),
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => options.systemPrompt,
        getAppendSystemPrompt: () => [],
        extendResources() {},
      };
    },
    async createSession(options) {
      sessionOptions.push(options);
      return { session: { kind: "embedded-session", options } };
    },
  });

  return {
    factory,
    modelRegistry: runtime.modelRegistry,
    inheritedModel,
    overrideModel,
    modelFinds,
    loaderOptions,
    sessionOptions,
    get promptResolutions() { return promptResolutions; },
  };
}

function factoryInput(overrides = {}) {
  return {
    batchId: "batch-1",
    taskId: "task-1",
    workspace: "/repo",
    task: {
      profile: "reviewer",
      prompt: "Review the implementation",
      focusPaths: ["src/server"],
      deliverable: "Return concrete findings",
    },
    tools: READ_ONLY_SUBAGENT_TOOLS,
    limits: { timeoutSeconds: 300, maxTurns: 20, maxToolCalls: 50 },
    ...overrides,
  };
}

describe("embedded subagent session factory", () => {
  it("pre-resolves the parent prompt and creates an isolated read-only in-memory session", async () => {
    const harness = createHarness();
    assert.strictEqual(harness.promptResolutions, 1, "parent prompt must be resolved before concurrent tasks start");

    const session = await harness.factory(factoryInput());

    assert.strictEqual(session.kind, "embedded-session");
    assert.strictEqual(harness.promptResolutions, 1);
    assert.strictEqual(harness.loaderOptions.length, 1);
    const loader = harness.loaderOptions[0];
    assert.strictEqual(loader.cwd, "/repo");
    assert.strictEqual(loader.agentDir, "/agent");
    assert.strictEqual(loader.noExtensions, true);
    assert.strictEqual(loader.noSkills, true);
    assert.strictEqual(loader.noPromptTemplates, true);
    assert.strictEqual(loader.noThemes, true);
    assert.strictEqual(loader.noContextFiles, true);
    assert.match(loader.systemPrompt, /PARENT SYSTEM PROMPT/);
    assert.match(loader.systemPrompt, new RegExp(SUBAGENT_PROFILE_PROMPTS.reviewer.slice(0, 20)));
    assert.match(loader.systemPrompt, /read-only/i);
    assert.match(loader.systemPrompt, /summary.*findings.*evidence/is);

    const options = harness.sessionOptions[0];
    assert.strictEqual(options.cwd, "/repo");
    assert.strictEqual(options.agentDir, "/agent");
    assert.strictEqual(options.authStorage.kind, "shared-auth");
    assert.strictEqual(options.modelRegistry, harness.modelRegistry);
    assert.strictEqual(options.model, harness.inheritedModel);
    assert.strictEqual(options.thinkingLevel, "off");
    assert.deepStrictEqual(options.tools, READ_ONLY_SUBAGENT_TOOLS);
    assert.strictEqual(options.sessionManager.isPersisted(), false);
    assert.strictEqual(options.sessionManager.getSessionFile(), undefined);
    assert.deepStrictEqual(
      options.customTools.map((tool) => tool.name),
      READ_ONLY_SUBAGENT_TOOLS,
    );
  });

  it("uses a host-validated model override without mutating the parent session model", async () => {
    const harness = createHarness();
    const input = factoryInput({ model: { provider: "review", id: "review-model" } });

    await harness.factory(input);

    assert.deepStrictEqual(harness.modelFinds, [{ provider: "review", id: "review-model" }]);
    assert.strictEqual(harness.sessionOptions[0].model, harness.overrideModel);
    assert.strictEqual(harness.inheritedModel.id, "main-model");
  });

  it("applies a configured agent prompt and narrows the read-only tool set", async () => {
    const harness = createHarness();
    await harness.factory(factoryInput({
      task: {
        profile: "reviewer",
        prompt: "Review the implementation",
        agentId: "security-reviewer",
        agent: {
          id: "security-reviewer",
          name: "Security reviewer",
          description: "Security review",
          prompt: "Prioritize authentication and input validation.",
          tools: ["search", "file_read"],
        },
      },
    }));

    assert.match(harness.loaderOptions[0].systemPrompt, /Prioritize authentication and input validation/);
    assert.deepStrictEqual(harness.sessionOptions[0].tools, ["search", "file_read"]);
    assert.deepStrictEqual(harness.sessionOptions[0].customTools.map((tool) => tool.name), ["search", "file_read"]);
  });

  it("rejects an unknown model instead of accepting arbitrary provider strings", async () => {
    const harness = createHarness();

    await assert.rejects(
      harness.factory(factoryInput({ model: { provider: "missing", id: "unknown" } })),
      /Unknown subagent model: missing\/unknown/,
    );
    assert.strictEqual(harness.sessionOptions.length, 0);
  });

  it("rejects an unknown profile instead of silently changing the role", async () => {
    const harness = createHarness();
    const input = factoryInput({ task: { prompt: "test", profile: "explore" } });

    await assert.rejects(harness.factory(input), /Unknown subagent profile: explore/);
    assert.strictEqual(harness.sessionOptions.length, 0);
  });
});
