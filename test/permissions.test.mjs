import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

import {
  applySessionPermissionSuggestions,
  createPathPermissionSuggestions,
  createSessionPermissionState,
  createToolPermissionSuggestions,
  evaluatePathPermission,
  findMatchingPathPermissionRule,
  findMatchingToolPermissionRule,
  pathPermissionToolForOperation,
  pathRuleContentForDirectory,
  toolRuleContentForTool,
} from "../src/agent/permissions.ts";

describe("shared permission primitives", () => {
  it("maps path operations to permission tool names", () => {
    assert.strictEqual(pathPermissionToolForOperation("read"), "Read");
    assert.strictEqual(pathPermissionToolForOperation("write"), "Write");
    assert.strictEqual(pathPermissionToolForOperation("create"), "Create");
    assert.strictEqual(pathPermissionToolForOperation("remove"), "Remove");
  });

  it("matches wildcard path rules without sibling-prefix escape", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "perm-rule-"));
    try {
      const root = resolve(parent, "root");
      const sibling = resolve(parent, "root-evil");
      mkdirSync(root);
      mkdirSync(sibling);

      const rule = {
        toolName: "Write",
        ruleContent: pathRuleContentForDirectory(root, "write"),
        match: "wildcard",
      };

      assert.ok(findMatchingPathPermissionRule(resolve(root, "a.txt"), "write", [rule]));
      assert.strictEqual(findMatchingPathPermissionRule(resolve(sibling, "a.txt"), "write", [rule]), undefined);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("lets explicit deny rules override workspace membership", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "perm-deny-"));
    try {
      const workspace = resolve(parent, "workspace");
      mkdirSync(workspace);
      const blocked = resolve(workspace, "blocked.txt");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Write",
        ruleContent: `Write(${blocked})`,
        match: "exact",
      });

      const decision = evaluatePathPermission(blocked, "write", {
        workspaceRoot: workspace,
        alwaysDenyRules: state.alwaysDenyRules,
      });

      assert.strictEqual(decision.status, "deny");
      assert.strictEqual(decision.matchedRule?.ruleContent, `Write(${blocked})`);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("suggests session path rules for paths outside authorized roots", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "perm-ask-"));
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);

      const target = resolve(external, "out.txt");
      const decision = evaluatePathPermission(target, "write", { workspaceRoot: workspace });
      assert.strictEqual(decision.status, "ask");
      assert.strictEqual(decision.suggestions[0].type, "addPathRule");
      assert.strictEqual(decision.suggestions[0].operation, "write");

      const state = createSessionPermissionState();
      applySessionPermissionSuggestions(state, createPathPermissionSuggestions(external, "write"));
      const allowed = evaluatePathPermission(target, "write", {
        workspaceRoot: workspace,
        alwaysAllowRules: state.alwaysAllowRules,
      });
      assert.strictEqual(allowed.status, "allow");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("allows ordinary reads outside the workspace without confirmation", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "perm-external-read-"));
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);

      const decision = evaluatePathPermission(resolve(external, "README.md"), "read", {
        workspaceRoot: workspace,
      });

      assert.strictEqual(decision.status, "allow");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("asks before reading sensitive files outside the workspace", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "perm-sensitive-read-"));
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);

      const target = resolve(external, ".npmrc");
      const decision = evaluatePathPermission(target, "read", { workspaceRoot: workspace });

      assert.strictEqual(decision.status, "ask");
      assert.match(decision.reason, /sensitive/i);
      assert.strictEqual(decision.suggestions[0].operation, "read");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("trusts a sensitive path when the user explicitly selected its root", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "perm-sensitive-trusted-"));
    try {
      const workspace = resolve(parent, "workspace");
      const selectedRoot = resolve(parent, "selected");
      mkdirSync(workspace);
      mkdirSync(selectedRoot);

      const decision = evaluatePathPermission(resolve(selectedRoot, ".npmrc"), "read", {
        workspaceRoot: workspace,
        allowedWorkingRoots: [selectedRoot],
      });

      assert.strictEqual(decision.status, "allow");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("recognizes browser profile data as a sensitive external read", () => {
    const workspace = resolve(tmpdir(), "perm-browser-workspace");
    const browserFile = process.platform === "win32"
      ? resolve(homedir(), "AppData", "Local", "Google", "Chrome", "User Data", "Default", "Cookies")
      : process.platform === "darwin"
        ? resolve(homedir(), "Library", "Application Support", "Google", "Chrome", "Default", "Cookies")
        : resolve(homedir(), ".config", "google-chrome", "Default", "Cookies");

    const decision = evaluatePathPermission(browserFile, "read", { workspaceRoot: workspace });

    assert.strictEqual(decision.status, "ask");
    assert.match(decision.reason, /sensitive/i);
  });

  it("respects explicit ask rules inside the workspace", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "perm-internal-ask-"));
    try {
      const workspace = resolve(parent, "workspace");
      mkdirSync(workspace);
      const target = resolve(workspace, "review.txt");
      const state = createSessionPermissionState();
      state.alwaysAskRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${target})`,
        match: "exact",
      });

      const decision = evaluatePathPermission(target, "read", {
        workspaceRoot: workspace,
        alwaysAskRules: state.alwaysAskRules,
      });

      assert.strictEqual(decision.status, "ask");
      assert.match(decision.reason, /session rule/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("matches Tool rules by exact, prefix, and wildcard modes", () => {
    assert.strictEqual(toolRuleContentForTool("mcp__fs__read"), "Tool(mcp__fs__read)");

    const exact = { toolName: "Tool", ruleContent: "Tool(mcp__fs__read)", match: "exact" };
    const prefix = { toolName: "Tool", ruleContent: "mcp__fs__", match: "prefix" };
    const wildcard = { toolName: "Tool", ruleContent: "Tool(mcp__*__write)", match: "wildcard" };

    assert.ok(findMatchingToolPermissionRule("mcp__fs__read", [exact]));
    assert.strictEqual(findMatchingToolPermissionRule("mcp__fs__write", [exact]), undefined);
    assert.ok(findMatchingToolPermissionRule("mcp__fs__write", [prefix]));
    assert.ok(findMatchingToolPermissionRule("mcp__sqlite__write", [wildcard]));
    assert.strictEqual(findMatchingToolPermissionRule("mcp__sqlite__read", [wildcard]), undefined);
  });

  it("applies session Tool suggestions into allow rules", () => {
    const state = createSessionPermissionState();
    applySessionPermissionSuggestions(state, createToolPermissionSuggestions("mcp__fs__read"));

    assert.strictEqual(state.alwaysAllowRules.session.length, 1);
    assert.strictEqual(state.alwaysAllowRules.session[0].toolName, "Tool");
    assert.strictEqual(state.alwaysAllowRules.session[0].ruleContent, "Tool(mcp__fs__read)");
    assert.ok(findMatchingToolPermissionRule("mcp__fs__read", state.alwaysAllowRules.session));
  });
});
