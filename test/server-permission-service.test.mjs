import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createSessionPermissionState } from "../src/agent/permissions.ts";
import {
  ServerPermissionError,
  ServerPermissionService,
} from "../src/server/permission-service.ts";
import { FilePermissionAuditStore } from "../src/server/permission-audit-store.ts";
import { createPermissionConfirmCallback } from "../src/server/permission-confirmation.ts";
import { handleDashboard } from "../src/server/routes/dashboard.ts";
import { handleExplorer } from "../src/server/routes/explorer.ts";
import { handlePermissions } from "../src/server/routes/permissions.ts";
import { handleSearch } from "../src/server/routes/search.ts";
import { handleSessions } from "../src/server/routes/sessions.ts";
import { handleSettings } from "../src/server/routes/settings.ts";
import { handleUiState } from "../src/server/routes/ui-state.ts";
import { makeReq, makeRes, makeResWithEvents } from "./helpers/http.mjs";

function routeCtx(root, permissionService) {
  return {
    runtime: {
      session: {
        isStreaming: false,
        sessionManager: { getSessionId: () => "" },
      },
      currentWorkspace: root,
      switchWorkspace: async () => {},
      openSession: async () => {},
      createNewSession: async () => "new-session",
      getActiveSession: () => null,
    },
    chatStream: { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: "" },
    sseClients: [],
    permissionService,
    paths: {
      APP_ROOT: root,
      DATA_DIR: resolve(root, "data"),
      PI_CONFIG_DIR: resolve(root, "data", "pi"),
      SESSIONS_DIR: resolve(root, "data", "pi", "sessions"),
      SETTINGS_FILE: resolve(root, "data", "pi", "settings.json"),
      FRONTEND_DIR: resolve(root, "dist", "frontend"),
      FRONTEND_SRC_DIR: resolve(root, "src", "frontend"),
      HAS_BUILT_FRONTEND: false,
    },
  };
}

function writeSessionFixture(root, id, options = {}) {
  const workspace = options.workspace || resolve(root, "workspace");
  const sessionsDir = resolve(root, "data", "pi", "sessions");
  const projectDir = resolve(sessionsDir, "by-project", options.projectKey || "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const file = resolve(projectDir, `${id}.jsonl`);
  writeFileSync(file, [
    JSON.stringify({ type: "session", id, timestamp: "2026-07-30T00:00:00.000Z", workspace }),
    JSON.stringify({ type: "message", timestamp: "2026-07-30T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
  ].join("\n") + "\n");
  return { workspace, sessionsDir, projectDir, file };
}

function makeTempRoot(prefix) {
  return mkdtempSync(resolve(process.cwd(), `.tmp-${prefix}`));
}

function makeAsyncJsonReq(method, url, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return {
    url,
    method,
    headers: { host: "localhost", "content-type": "application/json" },
    async *[Symbol.asyncIterator]() {
      if (payload) yield Buffer.from(payload);
    },
  };
}

describe("server permission service", () => {
  it("authorizes and audits in-root path operations", async () => {
    const root = makeTempRoot("server-perm-");
    try {
      const service = new ServerPermissionService();
      const guarded = await service.authorizePath(root, "out.txt", "write", "test.write");
      assert.strictEqual(guarded.relativePath, "out.txt");

      const audit = service.getAuditTrail();
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].decision, "allow");
      assert.strictEqual(audit[0].source, "test.write");
      assert.strictEqual(audit[0].operation, "write");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("audits PathGuard denials", async () => {
    const parent = makeTempRoot("server-perm-deny-");
    try {
      const root = resolve(parent, "root");
      const sibling = resolve(parent, "root-evil");
      mkdirSync(root);
      mkdirSync(sibling);
      const service = new ServerPermissionService();

      await assert.rejects(
        () => service.authorizePath(root, "../root-evil/pwn.txt", "write", "test.traversal"),
        /Access denied/,
      );

      const audit = service.getAuditTrail();
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].decision, "deny");
      assert.strictEqual(audit[0].code, "access_denied");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("fails closed when session deny rules match", async () => {
    const root = makeTempRoot("server-perm-rule-");
    try {
      const blocked = resolve(root, "blocked.txt");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Write",
        ruleContent: `Write(${blocked})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });

      await assert.rejects(
        () => service.authorizePath(root, "blocked.txt", "write", "test.rule"),
        ServerPermissionError,
      );

      const audit = service.getAuditTrail();
      assert.strictEqual(audit[0].decision, "deny");
      assert.match(audit[0].reason, /denied by session rule/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed and audits synchronous internal session writes", () => {
    const root = makeTempRoot("server-perm-sync-session-write-");
    try {
      mkdirSync(resolve(root, "sessions"), { recursive: true });
      const sessionFile = resolve(root, "sessions", "session.jsonl");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Write",
        ruleContent: `Write(${sessionFile})`,
        match: "exact",
      });
      const service = new ServerPermissionService({
        sessionPermissionState: state,
        trustedRootsProvider: () => [resolve(root, "sessions")],
      });

      assert.throws(
        () => service.authorizePathSync(resolve(root, "sessions"), sessionFile, "write", "sessions.trace"),
        ServerPermissionError,
      );
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.trace" &&
        entry.operation === "write" &&
        entry.path === sessionFile &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("asks through confirmation callback for paths outside the trusted workspace", async () => {
    const parent = makeTempRoot("server-perm-ask-");
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);
      const state = createSessionPermissionState();
      let request;
      const service = new ServerPermissionService({
        sessionPermissionState: state,
        workspaceRootProvider: () => workspace,
        trustedRootsProvider: () => [workspace],
        confirmPermission: async (req) => {
          request = req;
          return { allow: true, scope: "session" };
        },
      });

      const guarded = await service.authorizePath(external, "allowed.txt", "write", "test.ask");

      assert.strictEqual(guarded.path, resolve(external, "allowed.txt"));
      assert.strictEqual(request.source, "test.ask");
      assert.strictEqual(request.operation, "write");
      assert.match(request.reason, /outside workspace\/authorized roots/);
      assert.strictEqual(state.alwaysAllowRules.session.length, 1);
      assert.match(state.alwaysAllowRules.session[0].ruleContent, /Write\(/);
      const audit = service.getAuditTrail();
      assert.deepStrictEqual(audit.map((entry) => entry.decision), ["ask", "allow"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("allows ordinary external reads without prompting or audit noise", async () => {
    const parent = makeTempRoot("server-perm-external-read-");
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);
      writeFileSync(resolve(external, "README.md"), "ordinary");
      let confirmCount = 0;
      const service = new ServerPermissionService({
        workspaceRootProvider: () => workspace,
        trustedRootsProvider: () => [workspace],
        confirmPermission: async () => {
          confirmCount += 1;
          return { allow: true, scope: "session" };
        },
      });

      const guarded = await service.authorizePath(external, "README.md", "read", "test.external-read");

      assert.strictEqual(guarded.path, resolve(external, "README.md"));
      assert.strictEqual(confirmCount, 0);
      assert.deepStrictEqual(service.getAuditTrail(), []);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("confirms a sensitive external read once per session", async () => {
    const parent = makeTempRoot("server-perm-sensitive-read-");
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);
      writeFileSync(resolve(external, ".npmrc"), "//registry.example/:_authToken=secret");
      const state = createSessionPermissionState();
      let confirmCount = 0;
      let request;
      const service = new ServerPermissionService({
        sessionPermissionState: state,
        workspaceRootProvider: () => workspace,
        trustedRootsProvider: () => [workspace],
        confirmPermission: async (nextRequest) => {
          confirmCount += 1;
          request = nextRequest;
          return { allow: true, scope: "session" };
        },
      });

      await service.authorizePath(external, ".npmrc", "read", "test.sensitive-read");
      await service.authorizePath(external, ".npmrc", "read", "test.sensitive-read");

      assert.strictEqual(confirmCount, 1);
      assert.match(request.reason, /sensitive/i);
      assert.strictEqual(request.permissionSuggestions[0].operation, "read");
      assert.strictEqual(state.alwaysAllowRules.session.length, 1);
      assert.deepStrictEqual(service.getAuditTrail().map((entry) => entry.decision), ["ask", "allow"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not audit routine workspace reads", async () => {
    const root = makeTempRoot("server-perm-read-audit-noise-");
    try {
      writeFileSync(resolve(root, "source.ts"), "export const value = 1;");
      const service = new ServerPermissionService();

      await service.authorizePath(root, "source.ts", "read", "search.read");

      assert.deepStrictEqual(service.getAuditTrail(), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when route permission confirmation is unavailable", async () => {
    const parent = makeTempRoot("server-perm-no-confirm-");
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);
      const service = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
        trustedRootsProvider: () => [workspace],
      });

      await assert.rejects(
        () => service.authorizePath(external, "blocked.txt", "write", "test.no-confirm"),
        (error) => error instanceof ServerPermissionError && error.code === "permission_confirmation_required",
      );
      const audit = service.getAuditTrail();
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].decision, "ask");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not write route files when confirmation is denied", async () => {
    const parent = makeTempRoot("server-perm-route-deny-");
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);
      const service = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
        trustedRootsProvider: () => [workspace],
        confirmPermission: async () => ({ allow: false }),
      });
      const ctx = routeCtx(workspace, service);
      const req = makeReq("POST", "/api/file/write", { root: external, path: "denied.txt", content: "nope" });
      const res = makeRes();

      await handleExplorer(req, res, ctx);

      assert.strictEqual(res._status, 403);
      assert.strictEqual(existsSync(resolve(external, "denied.txt")), false);
      const audit = service.getAuditTrail();
      assert.deepStrictEqual(audit.map((entry) => entry.decision), ["ask", "deny"]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("emits route permission confirmations over the desktop events stream", async () => {
    const root = makeTempRoot("server-perm-event-");
    try {
      const eventRes = makeResWithEvents();
      const sseClients = [eventRes];
      const confirmPermission = createPermissionConfirmCallback(sseClients, { timeoutMs: 1000 });
      const pending = confirmPermission({
        source: "file.write",
        operation: "write",
        root,
        path: resolve(root, "outside.txt"),
        relativePath: "outside.txt",
        reason: "Write path is outside workspace/authorized roots",
        permissionSuggestions: [],
      });

      const line = eventRes._body.split("\n").find((part) => part.startsWith("data: "));
      assert.ok(line, "permission_confirm event should be written");
      const event = JSON.parse(line.slice("data: ".length));
      assert.strictEqual(event.type, "permission_confirm");
      assert.strictEqual(event.source, "file.write");
      assert.strictEqual(event.operation, "write");

      const res = makeRes();
      await handlePermissions(makeReq("POST", "/api/permissions/confirm", { id: event.id, allow: true, scope: "once" }), res, routeCtx(root, undefined));
      assert.strictEqual(res._status, 200);
      assert.deepStrictEqual(JSON.parse(res._body), { ok: true });
      assert.deepStrictEqual(await pending, { allow: true, scope: "once" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out route permission confirmations fail-closed", async () => {
    const root = makeTempRoot("server-perm-timeout-");
    try {
      const eventRes = makeResWithEvents();
      const confirmPermission = createPermissionConfirmCallback([eventRes], { timeoutMs: 5 });
      const result = await confirmPermission({
        source: "file.write",
        operation: "write",
        root,
        path: resolve(root, "late.txt"),
        reason: "Write path requires confirmation",
        permissionSuggestions: [],
      });
      assert.deepStrictEqual(result, { allow: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("authorizes external tool execution through confirmation and audit", async () => {
    const root = makeTempRoot("server-perm-tool-");
    try {
      let request;
      let confirmCount = 0;
      const state = createSessionPermissionState();
      const service = new ServerPermissionService({
        sessionPermissionState: state,
        workspaceRootProvider: () => root,
        confirmPermission: async (req) => {
          confirmCount += 1;
          request = req;
          return { allow: true, scope: "session" };
        },
      });

      const result = await service.authorizeTool({
        toolName: "mcp__external__run",
        source: "mcp.external.run",
        operations: ["execute"],
        riskLevel: "high",
        workspaceBounded: false,
        args: { path: "/tmp" },
      });

      assert.deepStrictEqual(result, { allow: true });
      const second = await service.authorizeTool({
        toolName: "mcp__external__run",
        source: "mcp.external.run",
        operations: ["execute"],
        riskLevel: "high",
        workspaceBounded: false,
        args: { path: "/tmp" },
      });

      assert.deepStrictEqual(second, { allow: true });
      assert.strictEqual(confirmCount, 1);
      assert.strictEqual(state.alwaysAllowRules.session[0].toolName, "Tool");
      assert.strictEqual(state.alwaysAllowRules.session[0].ruleContent, "Tool(mcp__external__run)");
      assert.strictEqual(request.operation, "tool");
      assert.strictEqual(request.toolName, "mcp__external__run");
      assert.deepStrictEqual(request.toolOperations, ["execute"]);
      assert.strictEqual(request.riskLevel, "high");
      assert.strictEqual(request.workspaceBounded, false);
      assert.strictEqual(request.permissionRequired, true);
      const audit = service.getAuditTrail();
      assert.deepStrictEqual(audit.map((entry) => entry.decision), ["ask", "allow", "allow"]);
      assert.strictEqual(audit[0].operation, "tool");
      assert.deepStrictEqual(audit[0].toolOperations, ["execute"]);
      assert.strictEqual(audit[0].workspaceBounded, false);
      assert.strictEqual(audit[0].permissionRequired, true);
      assert.strictEqual(audit[1].operation, "tool");
      assert.strictEqual(audit[1].toolName, "mcp__external__run");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for external tool execution without confirmation", async () => {
    const root = makeTempRoot("server-perm-tool-deny-");
    try {
      const service = new ServerPermissionService({
        workspaceRootProvider: () => root,
      });

      const result = await service.authorizeTool({
        toolName: "mcp__external__run",
        source: "mcp.external.run",
        operations: ["execute"],
        riskLevel: "high",
        workspaceBounded: false,
        args: {},
      });

      assert.strictEqual(result.allow, false);
      assert.match(result.reason, /unavailable/);
      const audit = service.getAuditTrail();
      assert.deepStrictEqual(audit.map((entry) => entry.decision), ["ask", "deny"]);
      assert.strictEqual(audit[1].code, "permission_confirmation_required");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tracks audit-only tool execution without prompting", async () => {
    const root = makeTempRoot("server-perm-tool-audit-");
    try {
      let confirmCount = 0;
      const service = new ServerPermissionService({
        workspaceRootProvider: () => root,
        confirmPermission: async () => {
          confirmCount += 1;
          return { allow: true };
        },
      });

      const result = await service.authorizeTool({
        toolName: "file_write",
        source: "agent.file_write.create",
        operations: ["create", "write"],
        riskLevel: "high",
        workspaceBounded: true,
        permissionRequired: false,
        args: { path: "ok.txt" },
      });

      assert.deepStrictEqual(result, { allow: true });
      assert.strictEqual(confirmCount, 0);
      const audit = service.getAuditTrail();
      assert.strictEqual(audit.length, 1);
      assert.strictEqual(audit[0].decision, "allow");
      assert.strictEqual(audit[0].toolName, "file_write");
      assert.strictEqual(audit[0].operation, "tool");
      assert.deepStrictEqual(audit[0].toolOperations, ["create", "write"]);
      assert.strictEqual(audit[0].workspaceBounded, true);
      assert.strictEqual(audit[0].permissionRequired, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not audit low or medium risk permission-free tool allows", async () => {
    const root = makeTempRoot("server-perm-tool-noise-");
    try {
      const service = new ServerPermissionService({ workspaceRootProvider: () => root });

      await service.authorizeTool({
        toolName: "search",
        source: "agent.search",
        operations: ["read"],
        riskLevel: "low",
        workspaceBounded: true,
        permissionRequired: false,
        args: { query: "needle" },
      });
      await service.authorizeTool({
        toolName: "web-fetch",
        source: "agent.web_fetch",
        operations: ["execute"],
        riskLevel: "medium",
        workspaceBounded: false,
        permissionRequired: false,
        args: { url: "https://example.com" },
      });

      assert.deepStrictEqual(service.getAuditTrail(), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists and reloads tool permission audit history", async () => {
    const root = makeTempRoot("server-perm-tool-audit-store-");
    try {
      const auditFile = resolve(root, "data", "pi", "permission-audit.json");
      const firstService = new ServerPermissionService({
        auditStore: new FilePermissionAuditStore(auditFile, { maxEntries: 20 }),
        workspaceRootProvider: () => root,
      });
      await firstService.authorizeTool({
        toolName: "file_write",
        source: "agent.file_write",
        operations: ["create", "write"],
        riskLevel: "high",
        workspaceBounded: true,
        permissionRequired: false,
        args: { path: "output.txt" },
      });

      const saved = JSON.parse(readFileSync(auditFile, "utf-8"));
      assert.strictEqual(saved.length, 1);
      assert.strictEqual(saved[0].operation, "tool");
      assert.strictEqual(saved[0].toolName, "file_write");
      assert.deepStrictEqual(saved[0].toolOperations, ["create", "write"]);
      assert.strictEqual(saved[0].permissionRequired, false);

      const secondService = new ServerPermissionService({
        auditStore: new FilePermissionAuditStore(auditFile, { maxEntries: 20 }),
      });
      const reloaded = secondService.getAuditTrail();
      assert.strictEqual(reloaded.length, 1);
      assert.strictEqual(reloaded[0].operation, "tool");
      assert.strictEqual(reloaded[0].toolName, "file_write");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes file writes through the shared permission service audit", async () => {
    const root = makeTempRoot("server-perm-route-");
    try {
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      const req = makeReq("POST", "/api/file/write", { root, path: "ok.txt", content: "hello" });
      const res = makeRes();

      await handleExplorer(req, res, ctx);

      assert.strictEqual(res._status, 200);
      assert.strictEqual(readFileSync(resolve(root, "ok.txt"), "utf-8"), "hello");
      const audit = service.getAuditTrail();
      assert.ok(audit.some((entry) => entry.source === "file.write" && entry.decision === "allow"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes permission audit as a read-only route", async () => {
    const root = makeTempRoot("server-perm-audit-");
    try {
      const service = new ServerPermissionService();
      await service.authorizePath(root, "view.txt", "write", "test.audit");
      const ctx = routeCtx(root, service);
      const req = makeReq("GET", "/api/permissions/audit?limit=1");
      const res = makeRes();

      await handlePermissions(req, res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.total, 1);
      assert.strictEqual(body.audit[0].source, "test.audit");
      assert.strictEqual(body.audit[0].decision, "allow");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists and reloads app-local permission audit history", async () => {
    const root = makeTempRoot("server-perm-audit-store-");
    try {
      const auditFile = resolve(root, "data", "pi", "permission-audit.json");
      const firstService = new ServerPermissionService({
        auditStore: new FilePermissionAuditStore(auditFile, { maxEntries: 20 }),
      });
      await firstService.authorizePath(root, "first.txt", "write", "test.audit.persist");

      const saved = JSON.parse(readFileSync(auditFile, "utf-8"));
      assert.strictEqual(saved.length, 1);
      assert.strictEqual(saved[0].source, "test.audit.persist");
      assert.strictEqual(saved[0].id, 1);

      const secondService = new ServerPermissionService({
        auditStore: new FilePermissionAuditStore(auditFile, { maxEntries: 20 }),
      });
      assert.strictEqual(secondService.getAuditTrail()[0].source, "test.audit.persist");

      await secondService.authorizePath(root, "second.txt", "write", "test.audit.reload");
      const reloaded = secondService.getAuditTrail();
      assert.deepStrictEqual(reloaded.map((entry) => entry.id), [1, 2]);
      assert.deepStrictEqual(reloaded.map((entry) => entry.source), ["test.audit.persist", "test.audit.reload"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exposes session permission rules through management routes", async () => {
    const root = makeTempRoot("server-perm-rules-");
    try {
      const service = new ServerPermissionService({ sessionPermissionState: createSessionPermissionState() });
      const ctx = routeCtx(root, service);

      const addReq = makeReq("POST", "/api/permissions/rules", {
        list: "deny",
        rule: { toolName: "Write", ruleContent: `Write(${resolve(root, "blocked.txt")})`, match: "exact" },
      });
      const addRes = makeRes();
      await handlePermissions(addReq, addRes, ctx);
      assert.strictEqual(addRes._status, 200);

      const getReq = makeReq("GET", "/api/permissions/rules");
      const getRes = makeRes();
      await handlePermissions(getReq, getRes, ctx);
      assert.strictEqual(getRes._status, 200);
      const snapshot = JSON.parse(getRes._body);
      assert.strictEqual(snapshot.alwaysDenyRules.length, 1);
      assert.strictEqual(snapshot.alwaysDenyRules[0].match, "exact");

      const deleteReq = makeReq("DELETE", "/api/permissions/rules?list=deny&index=0");
      const deleteRes = makeRes();
      await handlePermissions(deleteReq, deleteRes, ctx);
      assert.strictEqual(deleteRes._status, 200);
      assert.strictEqual(service.getRulesSnapshot().alwaysDenyRules.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("clears all session permission rules and working directories", async () => {
    const root = makeTempRoot("server-perm-rules-clear-");
    try {
      const state = createSessionPermissionState();
      state.alwaysAllowRules.session.push({ toolName: "Read", ruleContent: `Read(${root})`, match: "prefix" });
      state.alwaysAskRules.session.push({ toolName: "Write", ruleContent: `Write(${root})`, match: "prefix" });
      state.additionalWorkingDirectories.set("root", { path: root, source: "session" });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const req = makeReq("POST", "/api/permissions/rules/clear", { list: "all" });
      const res = makeRes();

      await handlePermissions(req, res, ctx);

      assert.strictEqual(res._status, 200);
      const snapshot = service.getRulesSnapshot();
      assert.strictEqual(snapshot.alwaysAllowRules.length, 0);
      assert.strictEqual(snapshot.alwaysAskRules.length, 0);
      assert.strictEqual(snapshot.additionalWorkingDirectories.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes settings writes through the shared permission service audit", async () => {
    const root = makeTempRoot("server-perm-settings-");
    try {
      mkdirSync(resolve(root, "data", "pi"), { recursive: true });
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      const req = makeReq("POST", "/api/settings", { defaultProvider: "test", defaultModel: "model" });
      const res = makeRes();

      await handleSettings(req, res, ctx);

      assert.strictEqual(res._status, 200);
      const audit = service.getAuditTrail();
      assert.ok(audit.some((entry) => entry.source === "settings.save" && entry.decision === "allow"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves layout config reads without routine allow audit noise", async () => {
    const root = makeTempRoot("server-perm-layout-read-");
    try {
      const srcDir = resolve(root, "src");
      mkdirSync(srcDir, { recursive: true });
      const layoutPath = resolve(srcDir, "layout-config.json");
      writeFileSync(layoutPath, JSON.stringify({ marker: "layout-read-ok" }));
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleDashboard(makeReq("GET", "/layout-config.json"), res, ctx);

      assert.strictEqual(res._status, 200);
      assert.match(res._body, /layout-read-ok/);
      assert.ok(!service.getAuditTrail().some((entry) => (
        entry.source === "dashboard.layout-config" &&
        entry.operation === "read" &&
        entry.path === layoutPath &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when layout config reads are denied", async () => {
    const root = makeTempRoot("server-perm-layout-read-deny-");
    try {
      const srcDir = resolve(root, "src");
      mkdirSync(srcDir, { recursive: true });
      const layoutPath = resolve(srcDir, "layout-config.json");
      writeFileSync(layoutPath, JSON.stringify({ marker: "layout-secret-denied" }));
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${layoutPath})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleDashboard(makeReq("GET", "/layout-config.json"), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.doesNotMatch(res._body, /layout-secret-denied/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "dashboard.layout-config" &&
        entry.operation === "read" &&
        entry.path === layoutPath &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves auth metadata reads without routine allow audit noise", async () => {
    const root = makeTempRoot("server-perm-auth-read-");
    try {
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      const authFile = resolve(ctx.paths.PI_CONFIG_DIR, "auth.json");
      writeFileSync(authFile, JSON.stringify({
        openai: { apiKey: "sk-test-auth-read" },
      }));
      const res = makeRes();

      await handleSettings(makeReq("GET", "/api/auth"), res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.providers[0].provider, "openai");
      assert.strictEqual(body.providers[0].hasKey, true);
      assert.ok(!service.getAuditTrail().some((entry) => (
        entry.source === "settings.auth.read" &&
        entry.operation === "read" &&
        entry.path === authFile &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when auth metadata reads are denied", async () => {
    const root = makeTempRoot("server-perm-auth-read-deny-");
    try {
      const ctxForPath = routeCtx(root, undefined);
      mkdirSync(ctxForPath.paths.PI_CONFIG_DIR, { recursive: true });
      const authFile = resolve(ctxForPath.paths.PI_CONFIG_DIR, "auth.json");
      writeFileSync(authFile, JSON.stringify({
        openai: { apiKey: "sk-denied-auth-read" },
      }));
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${authFile})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSettings(makeReq("GET", "/api/auth"), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.doesNotMatch(res._body, /sk-denied-auth-read/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "settings.auth.read" &&
        entry.operation === "read" &&
        entry.path === authFile &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves model availability without routine read allow audit noise", async () => {
    const root = makeTempRoot("server-perm-models-auth-read-");
    try {
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      ctx.runtime.modelRegistry = {
        getAvailable: () => [
          { provider: "openai", id: "gpt-test" },
          { provider: "anthropic", id: "claude-test" },
        ],
      };
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      const authFile = resolve(ctx.paths.PI_CONFIG_DIR, "auth.json");
      writeFileSync(authFile, JSON.stringify({
        openai: { apiKey: "sk-test-models-auth-read" },
      }));
      const res = makeRes();

      await handleSettings(makeReq("GET", "/api/models"), res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.deepStrictEqual(body.models, [{ provider: "openai", id: "gpt-test" }]);
      assert.ok(!service.getAuditTrail().some((entry) => (
        entry.source === "settings.models.auth" &&
        entry.operation === "read" &&
        entry.path === authFile &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when model availability auth reads are denied", async () => {
    const root = makeTempRoot("server-perm-models-auth-read-deny-");
    try {
      const ctxForPath = routeCtx(root, undefined);
      mkdirSync(ctxForPath.paths.PI_CONFIG_DIR, { recursive: true });
      const authFile = resolve(ctxForPath.paths.PI_CONFIG_DIR, "auth.json");
      writeFileSync(authFile, JSON.stringify({
        openai: { apiKey: "sk-denied-models-auth-read" },
      }));
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${authFile})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      ctx.runtime.modelRegistry = {
        getAvailable: () => [
          { provider: "openai", id: "gpt-secret" },
          { provider: "anthropic", id: "claude-secret" },
        ],
      };
      const res = makeRes();

      await handleSettings(makeReq("GET", "/api/models"), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.doesNotMatch(res._body, /gpt-secret/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "settings.models.auth" &&
        entry.operation === "read" &&
        entry.path === authFile &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists all models when auth config has not been created yet", async () => {
    const root = makeTempRoot("server-perm-models-first-run-");
    try {
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      ctx.runtime.modelRegistry = {
        getAvailable: () => [
          { provider: "openai", id: "gpt-first-run" },
          { provider: "anthropic", id: "claude-first-run" },
        ],
      };
      const res = makeRes();

      await handleSettings(makeReq("GET", "/api/models"), res, ctx);

      assert.strictEqual(res._status, 200);
      assert.deepStrictEqual(JSON.parse(res._body), {
        models: [
          { provider: "openai", id: "gpt-first-run" },
          { provider: "anthropic", id: "claude-first-run" },
        ],
      });
      assert.strictEqual(service.getAuditTrail().length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves UI state reads without routine allow audit noise", async () => {
    const root = makeTempRoot("server-perm-ui-state-read-");
    try {
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      const uiStateFile = resolve(ctx.paths.PI_CONFIG_DIR, "ui-state.json");
      writeFileSync(uiStateFile, JSON.stringify({
        workspaces: {
          [root]: {
            schemaVersion: 2,
            workspacePath: root,
            activeView: { type: "session", id: "sess-ui-read" },
            tabs: { sessions: ["sess-ui-read"], files: [], chatOpen: true, labels: {} },
            panel: { active: "explorer", closed: false, width: 260 },
            recent: { sessions: {} },
          },
        },
      }));
      const res = makeRes();

      await handleUiState(makeReq("GET", `/api/ui-state?workspace=${encodeURIComponent(root)}`), res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.activeView.id, "sess-ui-read");
      assert.ok(!service.getAuditTrail().some((entry) => (
        entry.source === "ui-state.read" &&
        entry.operation === "read" &&
        entry.path === uiStateFile &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when UI state reads are denied", async () => {
    const root = makeTempRoot("server-perm-ui-state-read-deny-");
    try {
      const ctxForPath = routeCtx(root, undefined);
      mkdirSync(ctxForPath.paths.PI_CONFIG_DIR, { recursive: true });
      const uiStateFile = resolve(ctxForPath.paths.PI_CONFIG_DIR, "ui-state.json");
      writeFileSync(uiStateFile, JSON.stringify({
        workspaces: {
          [root]: {
            schemaVersion: 2,
            workspacePath: root,
            activeView: { type: "session", id: "sess-ui-denied" },
            tabs: { sessions: ["sess-ui-denied"], files: [], chatOpen: true, labels: {} },
            panel: { active: "explorer", closed: false, width: 260 },
            recent: { sessions: {} },
          },
        },
      }));
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${uiStateFile})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleUiState(makeReq("GET", `/api/ui-state?workspace=${encodeURIComponent(root)}`), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.doesNotMatch(res._body, /sess-ui-denied/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "ui-state.read" &&
        entry.operation === "read" &&
        entry.path === uiStateFile &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("audits UI state writes while suppressing routine read allows", async () => {
    const root = makeTempRoot("server-perm-ui-state-save-");
    try {
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      mkdirSync(ctx.paths.PI_CONFIG_DIR, { recursive: true });
      const uiStateFile = resolve(ctx.paths.PI_CONFIG_DIR, "ui-state.json");
      writeFileSync(uiStateFile, JSON.stringify({ workspaces: {} }));
      const nextState = {
        schemaVersion: 2,
        workspacePath: root,
        activeView: { type: "chat" },
        tabs: { sessions: [], files: [], chatOpen: true, labels: {} },
        panel: { active: "explorer", closed: false, width: 260 },
        recent: { sessions: {} },
      };
      const res = makeRes();

      await handleUiState(makeAsyncJsonReq("PUT", "/api/ui-state", nextState), res, ctx);

      assert.strictEqual(res._status, 200);
      const persistedUiState = JSON.parse(readFileSync(uiStateFile, "utf8"));
      assert.strictEqual(persistedUiState.activeWorkspace, root);
      const audit = service.getAuditTrail();
      assert.ok(!audit.some((entry) => (
        entry.source === "ui-state.save.workspace" &&
        entry.operation === "read" &&
        entry.path === root &&
        entry.decision === "allow"
      )));
      assert.ok(!audit.some((entry) => (
        entry.source === "ui-state.read" &&
        entry.operation === "read" &&
        entry.path === uiStateFile &&
        entry.decision === "allow"
      )));
      assert.ok(audit.some((entry) => (
        entry.source === "ui-state.save" &&
        entry.operation === "write" &&
        entry.path === uiStateFile &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("suppresses usage summary read allows while auditing its index write", async () => {
    const root = makeTempRoot("server-perm-usage-summary-");
    try {
      const service = new ServerPermissionService();
      const { workspace } = writeSessionFixture(root, "sess-usage");
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleDashboard(makeReq("GET", "/api/usage/summary"), res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.sessions, 1);
      assert.ok(!service.getAuditTrail().some((entry) => (
        entry.source === "usage.summary.file" &&
        entry.operation === "read" &&
        entry.decision === "allow"
      )));
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "usage.summary.index" &&
        entry.operation === "write" &&
        entry.decision === "allow"
      )));
      assert.strictEqual(body.topSessions[0].workspace, workspace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when usage summary enters a denied session directory", async () => {
    const root = makeTempRoot("server-perm-usage-summary-deny-");
    try {
      const { projectDir } = writeSessionFixture(root, "sess-usage-deny");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${projectDir})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleDashboard(makeReq("GET", "/api/usage/summary"), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "usage.summary.project" &&
        entry.operation === "read" &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("suppresses compact read allows while auditing its index write", async () => {
    const root = makeTempRoot("server-perm-usage-compact-");
    try {
      const service = new ServerPermissionService();
      writeSessionFixture(root, "sess-compact");
      const ctx = routeCtx(root, service);
      let compactCalls = 0;
      ctx.runtime.session.compact = async () => {
        compactCalls += 1;
        return { summary: "done" };
      };
      const res = makeRes();

      await handleDashboard(makeReq("POST", "/api/compact", { focus: "usage" }), res, ctx);

      assert.strictEqual(res._status, 200);
      assert.strictEqual(compactCalls, 1);
      const audit = service.getAuditTrail();
      assert.ok(!audit.some((entry) => (
        entry.source === "usage.compact.file" &&
        entry.operation === "read" &&
        entry.decision === "allow"
      )));
      assert.ok(audit.some((entry) => (
        entry.source === "usage.compact.index" &&
        entry.operation === "write" &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed before compact when usage index refresh enters a denied session directory", async () => {
    const root = makeTempRoot("server-perm-usage-compact-deny-");
    try {
      const { projectDir } = writeSessionFixture(root, "sess-compact-deny");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${projectDir})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      let compactCalls = 0;
      ctx.runtime.session.compact = async () => {
        compactCalls += 1;
        return { summary: "should-not-run" };
      };
      const res = makeRes();

      await handleDashboard(makeReq("POST", "/api/compact", { focus: "usage" }), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.strictEqual(compactCalls, 0);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "usage.compact.project" &&
        entry.operation === "read" &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("searches conversations without routine read allow audit noise", async () => {
    const root = makeTempRoot("server-perm-search-conv-");
    try {
      const service = new ServerPermissionService();
      const { workspace } = writeSessionFixture(root, "sess-search");
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSearch(makeReq("POST", "/api/search/conversations", { query: "hello" }), res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.results.length, 1);
      assert.strictEqual(body.results[0].workspace, workspace);
      assert.ok(!service.getAuditTrail().some((entry) => (
        entry.source === "search.conversations.file" &&
        entry.operation === "read" &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed before conversation search enters a denied session directory", async () => {
    const root = makeTempRoot("server-perm-search-conv-deny-");
    try {
      const { projectDir } = writeSessionFixture(root, "sess-search-deny");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${projectDir})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSearch(makeReq("POST", "/api/search/conversations", { query: "hello" }), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "search.conversations.project" &&
        entry.operation === "read" &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists MCP config without routine read allow audit noise", async () => {
    const root = makeTempRoot("server-perm-mcp-read-");
    try {
      const configPath = resolve(root, ".mcp.json");
      writeFileSync(configPath, JSON.stringify({
        servers: { readServer: { command: "node", enabled: true } },
      }));
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleDashboard(makeReq("GET", "/api/mcp/servers"), res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.ok(body.some((server) => server.name === "readServer"));
      const audit = service.getAuditTrail();
      assert.ok(!audit.some((entry) => (
        entry.source === "mcp.servers.config" &&
        entry.operation === "read" &&
        entry.path === configPath &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when MCP server config reads are denied", async () => {
    const root = makeTempRoot("server-perm-mcp-read-deny-");
    try {
      const configPath = resolve(root, ".mcp.json");
      writeFileSync(configPath, JSON.stringify({
        servers: { blockedServer: { command: "secret-node", enabled: true } },
      }));
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${configPath})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleDashboard(makeReq("GET", "/api/mcp/servers"), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.doesNotMatch(res._body, /secret-node/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "mcp.servers.config" &&
        entry.operation === "read" &&
        entry.path === configPath &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes MCP toggles through the shared permission service audit", async () => {
    const root = makeTempRoot("server-perm-mcp-toggle-");
    try {
      writeFileSync(resolve(root, ".mcp.json"), JSON.stringify({
        servers: { myServer: { command: "node", enabled: false } },
      }));
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      const req = makeReq("POST", "/api/mcp/servers/myServer/toggle");
      const res = makeRes();

      await handleDashboard(req, res, ctx);

      assert.strictEqual(res._status, 200);
      const audit = service.getAuditTrail();
      assert.ok(audit.some((entry) => entry.source === "mcp.toggle" && entry.operation === "write" && entry.decision === "allow"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes MCP global installs through the shared permission service audit", async () => {
    const root = makeTempRoot("server-perm-mcp-install-");
    const workspace = resolve(root, "workspace");
    const home = resolve(root, "home");
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    try {
      mkdirSync(workspace, { recursive: true });
      process.env.HOME = home;
      process.env.USERPROFILE = home;

      const service = new ServerPermissionService();
      const ctx = routeCtx(workspace, service);
      const req = makeReq("POST", "/api/mcp/install", { id: "filesystem" });
      const res = makeRes();

      await handleDashboard(req, res, ctx);

      assert.strictEqual(res._status, 200);
      const globalPath = resolve(home, ".pi", "agent", "mcp.json");
      assert.ok(existsSync(globalPath), "global MCP config should be written");
      const audit = service.getAuditTrail();
      assert.ok(audit.some((entry) => entry.source === "mcp.install" && entry.path === globalPath && entry.decision === "allow"));
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when MCP global install is denied by session rule", async () => {
    const root = makeTempRoot("server-perm-mcp-deny-");
    const workspace = resolve(root, "workspace");
    const home = resolve(root, "home");
    const globalPath = resolve(home, ".pi", "agent", "mcp.json");
    const origHome = process.env.HOME;
    const origProfile = process.env.USERPROFILE;
    try {
      mkdirSync(workspace, { recursive: true });
      process.env.HOME = home;
      process.env.USERPROFILE = home;

      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Write",
        ruleContent: `Write(${globalPath})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(workspace, service);
      const req = makeReq("POST", "/api/mcp/install", { id: "filesystem" });
      const res = makeRes();

      await handleDashboard(req, res, ctx);

      assert.strictEqual(res._status, 403);
      assert.strictEqual(existsSync(globalPath), false, "denied global MCP config should not be written");
      const audit = service.getAuditTrail();
      assert.ok(audit.some((entry) => entry.source === "mcp.install" && entry.decision === "deny"));
    } finally {
      process.env.HOME = origHome;
      process.env.USERPROFILE = origProfile;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists sessions without routine read allow audit noise", async () => {
    const root = makeTempRoot("server-perm-sessions-list-");
    try {
      const service = new ServerPermissionService();
      const { workspace } = writeSessionFixture(root, "sess-list");
      const ctx = routeCtx(root, service);
      const req = makeReq("GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`);
      const res = makeRes();

      await handleSessions(req, res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.sessions.length, 1);
      assert.strictEqual(body.sessions[0].id, "sess-list");
      assert.ok(!service.getAuditTrail().some((entry) => (
        entry.source === "sessions.list" &&
        entry.operation === "read" &&
        entry.decision === "allow"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed before automatic migration enumerates a denied sessions root", async () => {
    const root = makeTempRoot("server-perm-sessions-root-deny-");
    try {
      const workspace = resolve(root, "workspace");
      const sessionsDir = resolve(root, "data", "pi", "sessions");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(resolve(sessionsDir, "by-project", "workspace"), { recursive: true });
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${sessionsDir})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSessions(makeReq("GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.auto-migrate.root" &&
        entry.operation === "read" &&
        entry.path === sessionsDir &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when session listing targets an outside workspace", async () => {
    const root = makeTempRoot("server-perm-sessions-list-workspace-");
    try {
      const workspace = resolve(root, "workspace");
      const externalWorkspace = resolve(root, "external-workspace");
      const sessionsDir = resolve(root, "data", "pi", "sessions", "by-project", "external-workspace");
      mkdirSync(sessionsDir, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      mkdirSync(externalWorkspace, { recursive: true });
      writeFileSync(resolve(sessionsDir, "sess-outside.jsonl"), [
        JSON.stringify({ type: "session", id: "sess-outside", timestamp: "2026-07-30T00:00:00.000Z", workspace: externalWorkspace }),
      ].join("\n") + "\n");

      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${externalWorkspace})`,
        match: "exact",
      });
      const service = new ServerPermissionService({
        sessionPermissionState: state,
        workspaceRootProvider: () => workspace,
        trustedRootsProvider: () => [
          workspace,
          resolve(root, "data"),
          resolve(root, "data", "pi"),
          resolve(root, "data", "pi", "sessions"),
        ],
      });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSessions(makeReq("GET", `/api/sessions?workspace=${encodeURIComponent(externalWorkspace)}`), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.list.workspace" &&
        entry.operation === "read" &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed before recursively listing a denied session subdirectory", async () => {
    const root = makeTempRoot("server-perm-sessions-list-deny-");
    try {
      const workspace = resolve(root, "workspace");
      const sessionsDir = resolve(root, "data", "pi", "sessions");
      const nestedDir = resolve(sessionsDir, "by-project", "workspace", "nested");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(resolve(nestedDir, "sess-nested.jsonl"), [
        JSON.stringify({ type: "session", id: "sess-nested", timestamp: "2026-07-30T00:00:00.000Z", workspace }),
      ].join("\n") + "\n");

      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${nestedDir})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSessions(makeReq("GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.list.dir" &&
        entry.operation === "read" &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed before listing other-project session directories when the project index is denied", async () => {
    const root = makeTempRoot("server-perm-sessions-project-index-deny-");
    try {
      const { workspace, sessionsDir } = writeSessionFixture(root, "sess-current");
      writeSessionFixture(root, "sess-other", {
        workspace: resolve(root, "other-workspace"),
        projectKey: "other-workspace",
      });
      const projectsDir = resolve(sessionsDir, "by-project");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${projectsDir})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSessions(makeReq("GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}&other=1`), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.doesNotMatch(res._body, /sess-other/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.list.projects" &&
        entry.operation === "read" &&
        entry.path === projectsDir &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed before recursive session lookup enters a denied subdirectory", async () => {
    const root = makeTempRoot("server-perm-sessions-lookup-deny-");
    try {
      const workspace = resolve(root, "workspace");
      const sessionsDir = resolve(root, "data", "pi", "sessions");
      const nestedDir = resolve(sessionsDir, "by-project", "workspace", "nested");
      const nestedFile = resolve(nestedDir, "sess-nested.jsonl");
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(nestedFile, [
        JSON.stringify({ type: "session", id: "sess-nested", timestamp: "2026-07-30T00:00:00.000Z", workspace }),
      ].join("\n") + "\n");

      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${nestedDir})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSessions(makeReq("POST", "/api/sessions/rename", { id: "sess-nested", name: "blocked" }), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.doesNotMatch(readFileSync(nestedFile, "utf-8"), /"name":"blocked"/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.rename.lookup.dir" &&
        entry.operation === "read" &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports an authorized session lookup helper for startup restore", async () => {
    const root = makeTempRoot("server-perm-sessions-startup-lookup-deny-");
    try {
      const workspace = resolve(root, "workspace");
      const sessionsDir = resolve(root, "data", "pi", "sessions");
      const nestedDir = resolve(sessionsDir, "by-project", "workspace", "nested");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(resolve(nestedDir, "sess-startup.jsonl"), [
        JSON.stringify({ type: "session", id: "sess-startup", timestamp: "2026-07-30T00:00:00.000Z", workspace }),
      ].join("\n") + "\n");

      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${nestedDir})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const sessionsMod = await import("../src/server/routes/sessions.ts");

      assert.strictEqual(typeof sessionsMod.findAuthorizedSessionFileById, "function");
      await assert.rejects(
        () => sessionsMod.findAuthorizedSessionFileById(ctx, "sess-startup", "sessions.startup.restore"),
        ServerPermissionError,
      );
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.startup.restore.dir" &&
        entry.operation === "read" &&
        entry.path === nestedDir &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the authorized session lookup helper during startup restore", () => {
    const serverSource = readFileSync(resolve(process.cwd(), "src", "server", "server.ts"), "utf-8");

    assert.match(serverSource, /findAuthorizedSessionFileById/);
    assert.doesNotMatch(serverSource, /findSessionFileById\(SESSIONS_DIR/);
  });

  it("authorizes UI state before startup restore reads it", () => {
    const serverSource = readFileSync(resolve(process.cwd(), "src", "server", "server.ts"), "utf-8");

    assert.match(
      serverSource,
      /authorizeRoutePath\(\s*baseCtx,\s*PI_CONFIG_DIR,\s*"ui-state\.json",\s*"read",\s*"ui-state\.startup\.restore",?\s*\)/,
    );
    assert.doesNotMatch(
      serverSource,
      /const uiStateFile = resolve\(PI_CONFIG_DIR, "ui-state\.json"\)/,
    );
  });

  it("restores the explicitly active workspace before legacy session fallback", () => {
    const serverSource = readFileSync(resolve(process.cwd(), "src", "server", "server.ts"), "utf-8");
    const activeWorkspaceLookup = serverSource.indexOf("uiData.activeWorkspace");
    const legacyWorkspaceScan = serverSource.indexOf("Object.entries(workspaces).filter", activeWorkspaceLookup);

    assert.ok(activeWorkspaceLookup >= 0);
    assert.ok(legacyWorkspaceScan > activeWorkspaceLookup);
    assert.match(serverSource, /activeState\s*\?\s*\[\[activeWorkspace, activeState\]\]/);
  });

  it("fails closed on session list symlink or junction escapes when the platform follows them", async () => {
    const root = makeTempRoot("server-perm-sessions-link-");
    try {
      const workspace = resolve(root, "workspace");
      const sessionsDir = resolve(root, "data", "pi", "sessions");
      const projectDir = resolve(sessionsDir, "by-project", "workspace");
      const outsideDir = resolve(root, "outside-sessions");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(resolve(outsideDir, "outside.jsonl"), [
        JSON.stringify({ type: "session", id: "outside-session", timestamp: "2026-07-30T00:00:00.000Z", workspace }),
      ].join("\n") + "\n");

      try {
        symlinkSync(outsideDir, resolve(projectDir, "escape-link"), "junction");
      } catch {
        return;
      }

      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSessions(makeReq("GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`), res, ctx);

      if (res._status === 403) {
        assert.ok(service.getAuditTrail().some((entry) => (
          entry.source === "sessions.list.dir" &&
          entry.operation === "read" &&
          entry.decision === "deny" &&
          entry.code === "access_denied"
        )));
      } else {
        assert.strictEqual(res._status, 200);
        const body = JSON.parse(res._body);
        assert.strictEqual(body.sessions.some((session) => session.id === "outside-session"), false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("audits automatic legacy session migration mutations without routine reads", async () => {
    const root = makeTempRoot("server-perm-sessions-migrate-");
    try {
      const service = new ServerPermissionService();
      const ctx = routeCtx(root, service);
      const workspace = resolve(root, "workspace");
      const sessionsDir = ctx.paths.SESSIONS_DIR;
      mkdirSync(workspace, { recursive: true });
      mkdirSync(sessionsDir, { recursive: true });
      const legacyFile = resolve(sessionsDir, "legacy.jsonl");
      writeFileSync(legacyFile, [
        JSON.stringify({ type: "session", id: "legacy", timestamp: "2026-07-30T00:00:00.000Z", workspace }),
        JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "legacy" }] } }),
      ].join("\n") + "\n");

      const req = makeReq("GET", `/api/sessions?workspace=${encodeURIComponent(workspace)}`);
      const res = makeRes();
      await handleSessions(req, res, ctx);

      assert.strictEqual(res._status, 200);
      assert.strictEqual(existsSync(legacyFile), false);
      assert.strictEqual(existsSync(resolve(sessionsDir, "by-project", "workspace", "legacy.jsonl")), true);
      const audit = service.getAuditTrail();
      assert.ok(!audit.some((entry) => entry.source === "sessions.auto-migrate.source" && entry.operation === "read"));
      assert.ok(audit.some((entry) => entry.source === "sessions.auto-migrate.destination" && entry.operation === "create"));
      assert.ok(audit.some((entry) => entry.source === "sessions.auto-migrate.source" && entry.operation === "remove"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when session migration targets an outside workspace", async () => {
    const root = makeTempRoot("server-perm-sessions-migrate-workspace-");
    try {
      const workspace = resolve(root, "workspace");
      const externalWorkspace = resolve(root, "external-workspace");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(externalWorkspace, { recursive: true });
      const { file, sessionsDir } = writeSessionFixture(root, "sess-migrate-deny", { workspace });
      const deniedTarget = resolve(sessionsDir, "by-project", "external-workspace", "sess-migrate-deny.jsonl");

      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${externalWorkspace})`,
        match: "exact",
      });
      const service = new ServerPermissionService({
        sessionPermissionState: state,
        workspaceRootProvider: () => workspace,
        trustedRootsProvider: () => [
          workspace,
          resolve(root, "data"),
          resolve(root, "data", "pi"),
          resolve(root, "data", "pi", "sessions"),
        ],
      });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSessions(makeReq("POST", "/api/sessions/migrate", { id: "sess-migrate-deny", workspace: externalWorkspace }), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.strictEqual(existsSync(file), true);
      assert.strictEqual(existsSync(deniedTarget), false);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.migrate.workspace" &&
        entry.operation === "read" &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("audits session rename and delete route operations", async () => {
    const root = makeTempRoot("server-perm-sessions-mut-");
    try {
      const service = new ServerPermissionService();
      const { file } = writeSessionFixture(root, "sess-mut");
      const ctx = routeCtx(root, service);

      const renameRes = makeRes();
      await handleSessions(makeReq("POST", "/api/sessions/rename", { id: "sess-mut", name: "renamed" }), renameRes, ctx);
      assert.strictEqual(renameRes._status, 200);
      assert.match(readFileSync(file, "utf-8"), /"name":"renamed"/);

      const deleteRes = makeRes();
      await handleSessions(makeReq("POST", "/api/sessions/delete", { id: "sess-mut" }), deleteRes, ctx);
      assert.strictEqual(deleteRes._status, 200);
      assert.strictEqual(existsSync(file), false);

      const audit = service.getAuditTrail();
      assert.ok(!audit.some((entry) => entry.source === "sessions.rename.lookup" && entry.operation === "read"));
      assert.ok(audit.some((entry) => entry.source === "sessions.rename" && entry.operation === "write"));
      assert.ok(!audit.some((entry) => entry.source === "sessions.delete.lookup" && entry.operation === "read"));
      assert.ok(audit.some((entry) => entry.source === "sessions.delete" && entry.operation === "remove"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a session rename is denied by rule", async () => {
    const root = makeTempRoot("server-perm-sessions-deny-");
    try {
      const { file } = writeSessionFixture(root, "sess-deny");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Write",
        ruleContent: `Write(${file})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });
      const ctx = routeCtx(root, service);
      const res = makeRes();

      await handleSessions(makeReq("POST", "/api/sessions/rename", { id: "sess-deny", name: "blocked" }), res, ctx);

      assert.strictEqual(res._status, 403);
      assert.doesNotMatch(readFileSync(file, "utf-8"), /"name":"blocked"/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "sessions.rename" &&
        entry.operation === "write" &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("audits session branch creation without routine read allows", async () => {
    const root = makeTempRoot("server-perm-sessions-branch-");
    try {
      const service = new ServerPermissionService();
      const { projectDir } = writeSessionFixture(root, "sess-branch");
      const ctx = routeCtx(root, service);
      let openedFile = "";
      ctx.runtime.openSession = async (file) => { openedFile = file; };
      ctx.runtime.getActiveSession = () => ({ id: "branch-active", file: openedFile });
      const res = makeRes();

      await handleSessions(makeReq("POST", "/api/sessions/branch", { id: "sess-branch", name: "branch copy" }), res, ctx);

      assert.strictEqual(res._status, 200);
      const body = JSON.parse(res._body);
      assert.ok(body.id.startsWith("branch-"));
      assert.strictEqual(existsSync(resolve(projectDir, `${body.id}.jsonl`)), true);
      const audit = service.getAuditTrail();
      assert.ok(!audit.some((entry) => entry.source === "sessions.branch.lookup" && entry.operation === "read"));
      assert.ok(!audit.some((entry) => entry.source === "sessions.branch.source" && entry.operation === "read"));
      assert.ok(audit.some((entry) => entry.source === "sessions.branch.destination" && entry.operation === "create"));
      assert.ok(!audit.some((entry) => entry.source === "sessions.branch.result" && entry.operation === "read"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
