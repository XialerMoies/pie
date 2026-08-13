import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  delegateTasksTool,
  validateDelegateTasksInput,
} from "../src/agent/tools/delegate-tasks.ts";
import { agentToolToPIToolDefinition } from "../src/agent/types.ts";

const MODEL_A = { provider: "openai", id: "gpt-5" };
const MODEL_B = { provider: "anthropic", id: "claude-sonnet-4" };

function batchResult(overrides = {}) {
  return {
    batchId: "batch-1",
    status: "partial",
    tasks: [
      {
        taskId: "task-1",
        status: "completed",
        summary: "done",
        findings: [],
        evidence: [],
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1 },
      },
      {
        taskId: "task-2",
        status: "failed",
        summary: "",
        findings: [],
        evidence: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, toolCalls: 0 },
        error: "provider failed",
      },
    ],
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 1 },
    ...overrides,
  };
}

function hostContext(overrides = {}) {
  return {
    cwd: "/repo",
    sessionId: "parent-session",
    workspace: "/repo",
    validateSubagentModel: async ({ provider, id }) =>
      (provider === MODEL_A.provider && id === MODEL_A.id)
      || (provider === MODEL_B.provider && id === MODEL_B.id),
    confirmCommand: async () => true,
    delegateTasks: async () => batchResult(),
    ...overrides,
  };
}

function diagnosticCode(result) {
  assert.equal(typeof result, "object");
  return result.diagnostics?.[0]?.code;
}

describe("delegate_tasks input validation", () => {
  it("declares the complete public schema without exposing host capabilities", () => {
    const schema = delegateTasksTool.parameters;
    assert.deepEqual(schema.required, ["tasks"]);
    assert.equal(schema.properties.tasks.minItems, 1);
    assert.equal(schema.properties.tasks.maxItems, 30);
    assert.deepEqual(schema.properties.tasks.items.properties.profile.enum, [
      "general",
      "explorer",
      "reviewer",
      "planner",
    ]);
    assert.deepEqual(schema.properties.tasks.items.required, ["profile", "prompt"]);
    assert.ok(schema.properties.tasks.items.properties.agentId);
    assert.ok(schema.properties.defaultModel);
    assert.ok(schema.properties.timeoutSeconds);
    assert.ok(schema.properties.maxTurns);
    assert.ok(schema.properties.maxToolCalls);
    assert.ok(schema.properties.maxConcurrent);
    assert.equal(schema.properties.delegateTasks, undefined);
    assert.equal(schema.properties.validateSubagentModel, undefined);
  });

  for (const [name, value, message] of [
    ["non-object input", null, "object"],
    ["missing tasks", {}, "tasks"],
    ["empty tasks", { tasks: [] }, "1 to 30"],
    ["more than thirty tasks", { tasks: Array.from({ length: 31 }, () => ({ profile: "general", prompt: "x" })) }, "1 to 30"],
    ["blank prompt", { tasks: [{ profile: "general", prompt: "   " }] }, "prompt"],
    ["unknown profile", { tasks: [{ profile: "writer", prompt: "x" }] }, "profile"],
    ["invalid model shape", { tasks: [{ profile: "general", prompt: "x", model: { provider: "openai" } }] }, "model"],
  ]) {
    it(`rejects ${name} with a friendly validation error`, async () => {
      await assert.rejects(
        () => validateDelegateTasksInput(value, async () => true),
        new RegExp(message, "i"),
      );
    });
  }

  it("applies task model precedence, defaults, trimming, and clamps limits", async () => {
    const validated = await validateDelegateTasksInput({
      tasks: [
        { profile: " explorer ", prompt: " inspect ", focusPaths: [" src ", "test"], deliverable: " notes " },
        { profile: "reviewer", prompt: "review", model: MODEL_B },
      ],
      defaultModel: MODEL_A,
      maxConcurrent: 99,
      timeoutSeconds: 1,
      maxTurns: 1000,
      maxToolCalls: -5,
    }, async () => true);

    assert.deepEqual(validated, {
      tasks: [
        { profile: "explorer", prompt: "inspect", focusPaths: ["src", "test"], deliverable: "notes", model: MODEL_A },
        { profile: "reviewer", prompt: "review", model: MODEL_B },
      ],
      maxConcurrent: 30,
      timeoutSeconds: 30,
      maxTurns: 100,
      maxToolCalls: 1,
    });
  });

  it("uses documented defaults", async () => {
    const validated = await validateDelegateTasksInput({
      tasks: [{ profile: "general", prompt: "inspect" }],
    }, async () => true);

    assert.deepEqual(validated, {
      tasks: [{ profile: "general", prompt: "inspect" }],
      maxConcurrent: 2,
      timeoutSeconds: 300,
      maxTurns: 20,
      maxToolCalls: 50,
    });
  });

  it("resolves a configured agent before confirmation while preserving an explicit task model", async () => {
    let delegatedRequest;
    await delegateTasksTool.execute({
      tasks: [
        { profile: "reviewer", prompt: "inspect", agentId: " security-reviewer " },
        { profile: "explorer", prompt: "trace", agentId: "security-reviewer", model: MODEL_B },
      ],
    }, hostContext({
      getSubagentDefinitions: () => [{
        id: "security-reviewer",
        name: "Security reviewer",
        description: "Review security boundaries",
        prompt: "Prioritize authentication and validation.",
        tools: ["search", "file_read"],
        model: MODEL_A,
      }],
      delegateTasks: async (request) => {
        delegatedRequest = request;
        return batchResult({ status: "completed" });
      },
    }));

    assert.equal(delegatedRequest.tasks[0].agent.id, "security-reviewer");
    assert.deepStrictEqual(delegatedRequest.tasks[0].model, MODEL_A);
    assert.deepStrictEqual(delegatedRequest.tasks[1].model, MODEL_B);
  });

  it("rejects an unknown configured agent before confirmation", async () => {
    let confirmed = false;
    const result = await delegateTasksTool.execute({
      tasks: [{ profile: "general", prompt: "inspect", agentId: "missing" }],
    }, hostContext({
      getSubagentDefinitions: () => [],
      confirmCommand: async () => { confirmed = true; return true; },
    }));

    assert.equal(diagnosticCode(result), "invalid_delegate_tasks_input");
    assert.match(result.text, /configured agent.*missing/i);
    assert.equal(confirmed, false);
  });

  it("applies the user task and concurrency ceilings before confirmation and execution", async () => {
    let confirmationReason = "";
    let delegatedRequest;
    const tasks = Array.from({ length: 10 }, (_, index) => ({
      profile: "general",
      prompt: `task-${index + 1}`,
    }));

    await delegateTasksTool.execute({ tasks, maxConcurrent: 8 }, hostContext({
      getSubagentLimits: () => ({ maxTasks: 6, maxConcurrent: 3 }),
      confirmCommand: async (_command, reason) => {
        confirmationReason = reason;
        return true;
      },
      delegateTasks: async (request) => {
        delegatedRequest = request;
        return batchResult({ status: "completed" });
      },
    }));

    assert.equal(delegatedRequest.tasks.length, 6);
    assert.deepEqual(delegatedRequest.tasks.map((task) => task.prompt), tasks.slice(0, 6).map((task) => task.prompt));
    assert.equal(delegatedRequest.maxConcurrent, 3);
    assert.match(confirmationReason, /Delegate 6 tasks/);
  });

  it("rejects an unknown model through the host validator", async () => {
    await assert.rejects(
      () => validateDelegateTasksInput({
        tasks: [{ profile: "general", prompt: "inspect", model: MODEL_A }],
      }, async () => false),
      /model.*openai\/gpt-5/i,
    );
  });

  it("validates an explicitly supplied default model even when every task overrides it", async () => {
    const seen = [];
    await assert.rejects(
      () => validateDelegateTasksInput({
        tasks: [{ profile: "general", prompt: "inspect", model: MODEL_B }],
        defaultModel: MODEL_A,
      }, async (model) => {
        seen.push(model);
        return model.id !== MODEL_A.id;
      }),
      /model.*openai\/gpt-5/i,
    );
    assert.deepEqual(seen, [MODEL_A]);
  });

  for (const [name, input] of [
    ["top-level host capability", { tasks: [{ profile: "general", prompt: "inspect" }], delegateTasks: async () => {} }],
    ["unknown task field", { tasks: [{ profile: "general", prompt: "inspect", executor: "spoof" }] }],
    ["unknown model field", { tasks: [{ profile: "general", prompt: "inspect", model: { ...MODEL_A, executor: "spoof" } }] }],
  ]) {
    it(`rejects ${name} at runtime`, async () => {
      await assert.rejects(
        () => validateDelegateTasksInput(input, async () => true),
        /unknown field/i,
      );
    });
  }
});

describe("delegate_tasks execution", () => {
  it("forwards the host tool call id outside model-controlled input", async () => {
    let receivedToolCallId;
    const result = await delegateTasksTool.execute({
      tasks: [{ profile: "general", prompt: "inspect" }],
    }, hostContext({
      toolCallId: "delegate-call-parent",
      delegateTasks: async (_request, _signal, toolCallId) => {
        receivedToolCallId = toolCallId;
        return batchResult();
      },
    }));

    assert.equal(receivedToolCallId, "delegate-call-parent");
    assert.equal(result.data?.batchId, "batch-1");
  });

  it("is non-read-only, serialized, specialized, and structured", () => {
    assert.equal(delegateTasksTool.name, "delegate_tasks");
    assert.equal(delegateTasksTool.isReadOnly, false);
    assert.equal(delegateTasksTool.isConcurrencySafe, false);
    assert.equal(delegateTasksTool.authorizationMode, "specialized");
    assert.equal(delegateTasksTool.resultFormat, "structured");
  });

  it("exposes configured Agents in the host tool description", () => {
    const piTool = agentToolToPIToolDefinition(delegateTasksTool, "/repo", undefined, {
      getSubagentDefinitions: () => [{
        id: "security-reviewer",
        name: "Security reviewer",
        description: "Review authentication boundaries",
        prompt: "Review security.",
        tools: ["search"],
      }],
    });

    assert.match(piTool.description, /security-reviewer/);
    assert.match(piTool.description, /Security reviewer/);
    assert.match(piTool.description, /Review authentication boundaries/);
  });

  it("confirms the whole batch once with task count and deduplicated models", async () => {
    const confirmations = [];
    const executions = [];
    const result = await delegateTasksTool.execute({
      tasks: [
        { profile: "general", prompt: "one", model: MODEL_A },
        { profile: "reviewer", prompt: "two", model: MODEL_A },
        { profile: "planner", prompt: "three", model: MODEL_B },
      ],
    }, hostContext({
      confirmCommand: async (command, reason) => {
        confirmations.push({ command, reason });
        return { allow: true };
      },
      delegateTasks: async (request) => {
        executions.push(request);
        return batchResult();
      },
    }));

    assert.equal(confirmations.length, 1);
    const confirmationText = `${confirmations[0].command}\n${confirmations[0].reason}`;
    assert.match(confirmationText, /3 tasks/i);
    assert.equal((confirmationText.match(/openai\/gpt-5/g) || []).length, 1);
    assert.equal((confirmationText.match(/anthropic\/claude-sonnet-4/g) || []).length, 1);
    assert.equal(executions.length, 1);
    assert.equal(result.data.status, "partial");
    assert.equal(result.data.tasks[1].error, "provider failed");
  });

  it("deduplicates models by provider/id tuple without slash-key collisions", async () => {
    const collidingA = { provider: "blocked", id: "x/y" };
    const collidingB = { provider: "blocked/x", id: "y" };
    const validatedModels = [];
    let confirmationReason = "";

    await delegateTasksTool.execute({
      tasks: [
        { profile: "general", prompt: "one", model: collidingA },
        { profile: "reviewer", prompt: "two", model: collidingB },
      ],
    }, hostContext({
      validateSubagentModel: async (model) => {
        validatedModels.push(model);
        return true;
      },
      confirmCommand: async (_command, reason) => {
        confirmationReason = reason;
        return true;
      },
    }));

    assert.deepEqual(validatedModels, [collidingA, collidingB]);
    assert.equal((confirmationReason.match(/blocked\/x\/y/g) || []).length, 2);
  });

  it("records specialized allow and deny outcomes in emitted trace metadata", async () => {
    for (const [name, confirmCommand, expectedStatus, expectedOutcome, reasonPattern] of [
      ["allow", async () => true, "allow", "completed", /confirm/i],
      ["reject", async () => false, "deny", "denied", /reject/i],
      ["error", async () => { throw new Error("dialog failed"); }, "deny", "denied", /failed/i],
    ]) {
      const events = [];
      const piTool = agentToolToPIToolDefinition(
        delegateTasksTool,
        "/repo",
        (event) => events.push(event),
        {
          confirmCommand,
          delegateTasks: async () => batchResult({ status: "completed" }),
        },
      );

      await piTool.execute(`call-${name}`, {
        tasks: [{ profile: "general", prompt: "inspect" }],
      });

      const end = events.find((event) => event.type === "tool_execution_end");
      assert.ok(end, `${name} should emit a terminal trace`);
      const authorization = end.metadata.authorization;
      assert.equal(authorization.status, expectedStatus);
      assert.equal(authorization.source, "confirmation");
      assert.equal(authorization.specialized.status, expectedStatus);
      assert.equal(authorization.reason, authorization.specialized.reason);
      assert.match(authorization.reason, reasonPattern);
      assert.equal(end.metadata.outcome, expectedOutcome);
    }
  });

  it("passes the same host AbortSignal to the delegate executor", async () => {
    const controller = new AbortController();
    let receivedSignal;
    await delegateTasksTool.execute({
      tasks: [{ profile: "general", prompt: "inspect" }],
    }, hostContext({
      signal: controller.signal,
      delegateTasks: async (_request, signal) => {
        receivedSignal = signal;
        return batchResult({ status: "completed" });
      },
    }));

    assert.equal(receivedSignal, controller.signal);
  });

  for (const [name, confirmation] of [
    ["missing confirmation host", undefined],
    ["boolean rejection", async () => false],
    ["object rejection", async () => ({ allow: false })],
  ]) {
    it(`fails closed on ${name} without calling the executor`, async () => {
      let executionCount = 0;
      const result = await delegateTasksTool.execute({
        tasks: [{ profile: "general", prompt: "inspect" }],
      }, hostContext({
        confirmCommand: confirmation,
        delegateTasks: async () => {
          executionCount += 1;
          return batchResult();
        },
      }));

      assert.equal(executionCount, 0);
      assert.equal(diagnosticCode(result), "delegation_not_confirmed");
    });
  }

  it("fails closed when the model validator or executor host is unavailable", async () => {
    const noValidator = await delegateTasksTool.execute({
      tasks: [{ profile: "general", prompt: "inspect", model: MODEL_A }],
    }, hostContext({ validateSubagentModel: undefined }));
    assert.equal(diagnosticCode(noValidator), "delegation_host_unavailable");

    const noExecutor = await delegateTasksTool.execute({
      tasks: [{ profile: "general", prompt: "inspect" }],
    }, hostContext({ delegateTasks: undefined }));
    assert.equal(diagnosticCode(noExecutor), "delegation_host_unavailable");
  });

  it("returns validation errors without confirmation or execution", async () => {
    let confirmationCount = 0;
    let executionCount = 0;
    const result = await delegateTasksTool.execute({ tasks: [] }, hostContext({
      confirmCommand: async () => {
        confirmationCount += 1;
        return true;
      },
      delegateTasks: async () => {
        executionCount += 1;
        return batchResult();
      },
    }));

    assert.equal(confirmationCount, 0);
    assert.equal(executionCount, 0);
    assert.equal(diagnosticCode(result), "invalid_delegate_tasks_input");
  });
});
