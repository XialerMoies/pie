/**
 * 附件拼 prompt 测试
 *
 * mock session.prompt 捕获最终消息，断言 file/clip/folder 内容已拼入。
 *
 * 运行：npx tsx --test test/attachments.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeReq, makeRes } from "./helpers/http.mjs";
import { mockChatCtx } from "./helpers/context.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("Attachments — prompt 内容断言", () => {
  let handleChat;

  before(async () => {
    const ts = Date.now();
    handleChat = (await import(`../src/server/routes/chat.ts?t=${ts}`)).handleChat;
  });

  it("无附件时 prompt = 原始消息", async () => {
    const captured = [];
    const ctx = mockChatCtx(captured, ROOT);
    const req = makeReq("POST", "/api/chat", { message: "hello" });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(captured[0], "hello", "无附件不应追加内容");
  });

  it("file 附件内容拼入 prompt", async () => {
    const captured = [];
    const ctx = mockChatCtx(captured, ROOT);
    const req = makeReq("POST", "/api/chat", {
      message: "解释",
      workspace: ROOT,
      attachments: [{ kind: "file", path: "package.json", name: "package.json" }],
    });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(captured[0].includes("解释"), "原始消息保留");
    assert.ok(captured[0].includes("package.json"), "文件路径出现");
    assert.ok(captured[0].includes("```"), "文件内容以代码块包裹");
  });

  it("clip 附件只包含指定行", async () => {
    const captured = [];
    const ctx = mockChatCtx(captured, ROOT);
    const req = makeReq("POST", "/api/chat", {
      message: "这段代码做什么",
      workspace: ROOT,
      attachments: [{ kind: "clip", path: "package.json", name: "package.json", startLine: 1, endLine: 5 }],
    });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(captured[0].includes("这段代码做什么"));
    assert.ok(captured[0].includes("package.json"));
  });

  it("路径穿越不拼入 prompt（原文保留）", async () => {
    const captured = [];
    const ctx = mockChatCtx(captured, ROOT);
    const req = makeReq("POST", "/api/chat", {
      message: "安全测试",
      workspace: ROOT,
      attachments: [{ kind: "file", path: "../../../etc/passwd", name: "passwd" }],
    });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(captured[0], "安全测试", "穿越路径不拼入");
  });

  it("不存在的文件原始消息保留", async () => {
    const captured = [];
    const ctx = mockChatCtx(captured, ROOT);
    const req = makeReq("POST", "/api/chat", {
      message: "test",
      workspace: ROOT,
      attachments: [{ kind: "file", path: "not-exists-12345.xyz", name: "ghost" }],
    });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(captured[0].includes("test"));
  });

  it("folder 附件展开子文件", async () => {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "att-folder-"));
    const subDir = resolve(tmpDir, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(resolve(subDir, "hello.txt"), "world content");
    const captured = [];
    const ctx = {
      runtime: { session: { model: {}, _cwd: tmpDir, prompt: async (msg) => { captured.push(msg); } }, currentWorkspace: tmpDir, switchWorkspace: async () => {}, onEvent: () => () => {} },
      paths: { APP_ROOT: tmpDir },
      chatStream: { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: "" },
      sseClients: [],
      modelRegistry: {},
    };
    const req = makeReq("POST", "/api/chat", {
      message: "看文件夹",
      workspace: tmpDir,
      attachments: [{ kind: "folder", path: "sub", name: "sub" }],
    });
    const res = makeRes();
    await handleChat(req, res, ctx);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(captured[0].includes("看文件夹"), "原始消息保留");
    assert.ok(captured[0].includes("world content"), "子文件内容出现");
  });
});
