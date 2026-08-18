import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createSessionPermissionState } from "../src/agent/permissions.ts";
import { ServerPermissionService } from "../src/server/permission-service.ts";
import { handleChat as rawHandleChat } from "../src/server/routes/chat.ts";
import { makeReq, makeRes } from "./helpers/http.mjs";
import { withServerGroups } from "./helpers/context.mjs";

const handleChat = (req, res, ctx) => rawHandleChat(req, res, withServerGroups(ctx));

function chatContext(workspace, overrides = {}) {
  const session = {
    model: {},
    prompt: async () => {},
    ...overrides.session,
  };
  return {
    runtime: {
      session,
      currentWorkspace: workspace,
      switchWorkspace: async () => {},
      onEvent: () => () => {},
      ...overrides.runtime,
    },
    chatStream: {
      textBuffer: "",
      thinkingBuffer: "",
      currentTextSnapshot: "",
      currentThinkingSnapshot: "",
      response: null,
      currentWorkspace: workspace,
      turnId: "",
      traceSeq: 0,
      blockSeq: 0,
      blocks: [],
      emittedTraces: new Set(),
      ...overrides.chatStream,
    },
    sseClients: [],
    paths: { APP_ROOT: workspace },
    permissionService: overrides.permissionService,
  };
}

async function dispatch(ctx, url, body) {
  const res = makeRes();
  await handleChat(makeReq("POST", url, body), res, ctx);
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  return res;
}

function deniedOutsideFixture(prefix) {
  const root = mkdtempSync(resolve(process.cwd(), `.tmp-${prefix}`));
  const workspace = resolve(root, "workspace");
  const outside = resolve(root, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const state = createSessionPermissionState();
  state.alwaysDenyRules.session.push({
    toolName: "Read",
    ruleContent: `Read(${outside})`,
    match: "exact",
  });
  const permissionService = new ServerPermissionService({
    sessionPermissionState: state,
    workspaceRootProvider: () => workspace,
  });
  return { root, workspace, outside, permissionService };
}

describe("chat workspace authorization", () => {
  it("coalesces concurrent switches to the same outside workspace", async () => {
    const root = mkdtempSync(resolve(process.cwd(), ".tmp-chat-workspace-coalesce-"));
    try {
      const workspace = resolve(root, "workspace");
      const outside = resolve(root, "outside");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });

      const permissionService = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
        confirmPermission: async () => {
          throw new Error("confirmPermission should not be called for a user workspace root");
        },
      });
      let switchCalls = 0;
      const ctx = chatContext(workspace, {
        permissionService,
        runtime: {
          switchWorkspace: async (target) => {
            switchCalls += 1;
            ctx.runtime.currentWorkspace = target;
          },
        },
      });
      const first = makeRes();
      const second = makeRes();

      await Promise.all([
        handleChat(makeReq("POST", "/api/workspace/switch", { workspace: outside }), first, ctx),
        handleChat(makeReq("POST", "/api/workspace/switch", { workspace: outside }), second, ctx),
      ]);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));

      assert.strictEqual(switchCalls, 1);
      assert.strictEqual(first._status, 200);
      assert.strictEqual(second._status, 200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a denied outside workspace before switching", async () => {
    const fixture = deniedOutsideFixture("chat-workspace-switch-deny-");
    try {
      let switchedTo = "";
      const ctx = chatContext(fixture.workspace, {
        permissionService: fixture.permissionService,
        runtime: { switchWorkspace: async (target) => { switchedTo = target; } },
      });

      const res = await dispatch(ctx, "/api/workspace/switch", { workspace: fixture.outside });

      assert.strictEqual(res._status, 403);
      assert.strictEqual(switchedTo, "");
      assert.ok(fixture.permissionService.getAuditTrail().some((entry) => (
        entry.source === "workspace.switch" && entry.operation === "read" && entry.decision === "deny"
      )));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not mutate chat state or prompt when workspace authorization fails", async () => {
    const fixture = deniedOutsideFixture("chat-workspace-message-deny-");
    try {
      let switchCalls = 0;
      let promptCalls = 0;
      const ctx = chatContext(fixture.workspace, {
        permissionService: fixture.permissionService,
        runtime: { switchWorkspace: async () => { switchCalls += 1; } },
        session: { prompt: async () => { promptCalls += 1; } },
        chatStream: { currentWorkspace: fixture.workspace, textBuffer: "unchanged" },
      });

      const res = await dispatch(ctx, "/api/chat", { message: "hello", workspace: fixture.outside });

      assert.strictEqual(res._status, 403);
      assert.strictEqual(switchCalls, 0);
      assert.strictEqual(promptCalls, 0);
      assert.strictEqual(ctx.chatStream.currentWorkspace, fixture.workspace);
      assert.strictEqual(ctx.chatStream.textBuffer, "unchanged");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("allows switching to a valid workspace root without confirmation", async () => {
    const root = mkdtempSync(resolve(process.cwd(), ".tmp-chat-workspace-enter-"));
    try {
      const workspace = resolve(root, "workspace");
      const outside = resolve(root, "outside");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      let confirmationCalls = 0;
      const permissionService = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
        confirmPermission: async () => {
          confirmationCalls += 1;
          return { allow: true, scope: "session" };
        },
      });
      let switchedTo = "";
      const ctx = chatContext(workspace, {
        permissionService,
        runtime: { switchWorkspace: async (target) => { switchedTo = target; } },
      });

      const res = await dispatch(ctx, "/api/workspace/switch", { workspace: outside });

      assert.strictEqual(res._status, 200);
      assert.strictEqual(switchedTo, outside);
      assert.strictEqual(confirmationCalls, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed outside the current workspace when PermissionService is unavailable", async () => {
    const root = mkdtempSync(resolve(process.cwd(), ".tmp-chat-workspace-no-service-"));
    try {
      const workspace = resolve(root, "workspace");
      const outside = resolve(root, "outside");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(outside, { recursive: true });
      let switchedTo = "";
      const ctx = chatContext(workspace, {
        runtime: { switchWorkspace: async (target) => { switchedTo = target; } },
      });

      const res = await dispatch(ctx, "/api/workspace/switch", { workspace: outside });

      assert.strictEqual(res._status, 403);
      assert.strictEqual(switchedTo, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sensitive system roots as workspace even without deny rules", async () => {
    const root = mkdtempSync(resolve(process.cwd(), ".tmp-chat-workspace-sensitive-"));
    try {
      const workspace = resolve(root, "workspace");
      mkdirSync(workspace, { recursive: true });
      const permissionService = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
      });
      let switchedTo = "";
      const ctx = chatContext(workspace, {
        permissionService,
        runtime: { switchWorkspace: async (target) => { switchedTo = target; } },
      });

      // 敏感系统根（本机存在的真实系统目录），应被规则拒绝而非当作工作区进入
      const sensitive = process.platform === "win32" ? "C:\\Windows" : "/etc";
      if (!existsSync(sensitive)) return;
      const res = await dispatch(ctx, "/api/workspace/switch", { workspace: sensitive });

      assert.strictEqual(res._status, 403);
      assert.strictEqual(switchedTo, "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
