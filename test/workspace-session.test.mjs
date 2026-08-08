/**
 * Session workspace 链路测试
 *
 * 测试 chat route 的 workspace 切换逻辑。
 *
 * 运行：npx tsx --test test/workspace-session.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    const targetWorkspace = resolve(ROOT, "src");
    const ctx = chatCtx({
      session: { _cwd: ROOT },
      currentWorkspace: ROOT,
      ctx: { paths: { APP_ROOT: ROOT } },
    });
    const req = makeReq("POST", "/api/chat", { message: "hello", workspace: targetWorkspace });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(ctx.chatStream.currentWorkspace, targetWorkspace, "currentWorkspace 应被设置");
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
    const ctx = chatCtx({
      session: { _cwd: ROOT, reload: async () => { reloadCalled = true; } },
      currentWorkspace: ROOT,
      ctx: { paths: { APP_ROOT: ROOT } },
    });
    const req = makeReq("POST", "/api/chat", { message: "hi", workspace: ROOT });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 30));
    assert.strictEqual(reloadCalled, false, "同路径不应 reload");
  });
});
