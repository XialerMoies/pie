import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  READ_ONLY_SUBAGENT_TOOL_NAMES,
  readSubagentDefinitions,
  readSubagentDefinitionsStrict,
  replaceSubagentDefinitions,
  validateSubagentDefinitions,
} from "../src/data/subagent-config.ts";

const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function tempFile() {
  const root = mkdtempSync(join(tmpdir(), "my-code-agent-subagents-"));
  roots.push(root);
  return join(root, "user", "subagents.json");
}

function definition(overrides = {}) {
  return {
    id: "security-reviewer",
    name: "安全审查",
    description: "检查安全边界和回归风险",
    prompt: "优先检查权限、输入验证和敏感数据边界。",
    tools: ["search", "file_read", "git-status"],
    model: { provider: "openai", id: "gpt-5" },
    ...overrides,
  };
}

describe("subagent configuration store", () => {
  it("persists a validated versioned document and reads it back", async () => {
    const file = tempFile();
    const saved = await replaceSubagentDefinitions(file, [definition()]);

    assert.deepStrictEqual(saved, [definition()]);
    assert.deepStrictEqual(readSubagentDefinitions(file), [definition()]);
    assert.deepStrictEqual(JSON.parse(readFileSync(file, "utf8")), {
      version: 1,
      agents: [definition()],
    });
  });

  it("returns an empty list for missing or malformed persisted data", () => {
    const file = tempFile();
    assert.deepStrictEqual(readSubagentDefinitions(file), []);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{broken", { encoding: "utf8", flag: "w" });
    assert.deepStrictEqual(readSubagentDefinitions(file), []);
  });

  it("keeps missing strict reference config empty but fails closed on malformed data", () => {
    const file = tempFile();
    assert.deepStrictEqual(readSubagentDefinitionsStrict(file), []);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{broken", "utf8");
    assert.throws(() => readSubagentDefinitionsStrict(file), SyntaxError);
    writeFileSync(file, JSON.stringify({ version: 2, agents: [] }), "utf8");
    assert.throws(() => readSubagentDefinitionsStrict(file), /version/);
    writeFileSync(file, JSON.stringify({ version: 1, agents: [{}] }), "utf8");
    assert.throws(() => readSubagentDefinitionsStrict(file), /required/);
  });

  it("rejects duplicate ids, unknown tools, and invalid fields", () => {
    assert.throws(() => validateSubagentDefinitions([definition(), definition()]), /duplicate.*security-reviewer/i);
    assert.throws(() => validateSubagentDefinitions([definition({ tools: ["file_write"] })]), /read-only tool/i);
    assert.throws(() => validateSubagentDefinitions([definition({ id: "Bad ID" })]), /id/i);
    assert.throws(() => validateSubagentDefinitions([definition({ name: "" })]), /name/i);
    assert.throws(() => validateSubagentDefinitions([definition({ prompt: "" })]), /prompt/i);
    assert.throws(() => validateSubagentDefinitions([definition({ model: { provider: "openai" } })]), /model/i);
  });

  it("exports only the supervisor read-only whitelist", () => {
    assert.deepStrictEqual(READ_ONLY_SUBAGENT_TOOL_NAMES, [
      "git-status",
      "search",
      "file_read",
      "explorer_list",
      "git_log",
      "file_outline",
    ]);
  });
});
