/**
 * Session workspace 链路测试
 *
 * 测试 chat route 的 workspace 记录 + session 文件迁移逻辑。
 *
 * 运行：npx tsx --test test/workspace-session.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeReq, makeRes } from "./helpers/http.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("chat route workspace", () => {
  let handleChat;

  before(async () => {
    const ts = Date.now();
    handleChat = (await import(`../src/server/routes/chat.ts?t=${ts}`)).handleChat;
  });

  function chatCtx(overrides = {}) {
    const session = { model: {}, _cwd: "/test", reload: async () => {}, ...overrides.session };
    return {
      runtime: { session, currentWorkspace: overrides.currentWorkspace || "/test", switchWorkspace: async () => {}, onEvent: () => () => {}, ...overrides.runtime },
      chatStream: { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: "", ...overrides.chatStream },
      sseClients: [],
      paths: { APP_ROOT: "/test" },
      ...overrides.ctx,
    };
  }

  it("POST /api/chat 设置 currentWorkspace", async () => {
    const ctx = chatCtx({ session: { _cwd: "/other/path" } });
    const req = makeReq("POST", "/api/chat", { message: "hello", workspace: "/my/project" });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(ctx.chatStream.currentWorkspace, "/my/project", "currentWorkspace 应被设置");
  });

  it("POST /api/chat 不带 workspace 不影响 currentWorkspace", async () => {
    const ctx = chatCtx({ chatStream: { currentWorkspace: "" } });
    const req = makeReq("POST", "/api/chat", { message: "hi" });
    const res = makeRes();
    await handleChat(req, res, ctx);
    assert.strictEqual(ctx.chatStream.currentWorkspace, "", "无 workspace 时不设置");
  });

  it("POST /api/chat 同路径不重复切换（_cwd 相同）", async () => {
    let reloadCalled = false;
    const ctx = chatCtx({ session: { _cwd: "/my/project", reload: async () => { reloadCalled = true; } }, currentWorkspace: "/my/project" });
    const req = makeReq("POST", "/api/chat", { message: "hi", workspace: "/my/project" });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(reloadCalled, false, "同路径不应 reload");
  });
});

describe("tagSessionWorkspace（已废弃，不再移动文件）", () => {
  let tagSessionWorkspace;
  let tmpDir;

  before(async () => {
    const ts = Date.now();
    tagSessionWorkspace = (await import(`../src/server/session-workspace.ts?t=${ts}`)).tagSessionWorkspace;
    tmpDir = mkdtempSync(resolve(tmpdir(), "ws-tag-"));
  });

  it("不存在的 sessionId 不报错", async () => {
    await tagSessionWorkspace("id-does-not-exist-999", tmpDir, "/ws");
    assert.ok(true);
  });

  it("undefined sessionId 不报错", async () => {
    await tagSessionWorkspace(undefined, tmpDir, "/ws");
    assert.ok(true);
  });
});
