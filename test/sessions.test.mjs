/**
 * Session routes 测试
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("parseSessionMessages", () => {
  let mod;

  before(async () => {
    mod = await import("../src/server/routes/sessions.ts");
  });

  it("解析正常 user/assistant 消息", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0].role, "user");
    assert.strictEqual(msgs[0].content, "hello");
    assert.strictEqual(msgs[1].role, "assistant");
    assert.strictEqual(msgs[1].content, "hi");
  });

  it("assistant_block 记录被附加到 assistant 消息", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "status" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_use", status: "running", name: "git-status", blockId: "b1", seq: 1 } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    assert.ok(msgs[1].blocks);
    assert.strictEqual(msgs[1].blocks.length, 1);
    assert.strictEqual(msgs[1].blocks[0].type, "tool_use");
  });

  it("assistant 消息先写入时仍能回挂后续 block", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "inspect" }] } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_use", status: "running", name: "file-read", blockId: "b1", seq: 1 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_result", output: "ok", blockId: "b2", seq: 2 } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[1].content, "");
    assert.deepStrictEqual(msgs[1].blocks.map(b => b.type), ["tool_use", "tool_result"]);
  });

  it("无 assistant_block 记录时兼容回退", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "old" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "legacy" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs[1].content, "legacy");
    assert.strictEqual(msgs[1].blocks, undefined);
  });

  it("正文为空但有关联 tool block 时保留消息", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "check" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_use", status: "running", name: "git-status", toolCallId: "call1", blockId: "b1", seq: 1 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_result", toolUseId: "call1", output: "clean", blockId: "b2", seq: 2 } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    assert.ok(msgs[1].blocks, "应有 blocks");
    assert.strictEqual(msgs[1].blocks.length, 2);
    assert.strictEqual(msgs[1].blocks[0].type, "tool_use");
    assert.strictEqual(msgs[1].blocks[1].type, "tool_result");
  });

  it("tool error block 正确渲染错误标记", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "run" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_use", status: "error", name: "search", toolCallId: "call1", blockId: "b1", seq: 1 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_result", toolUseId: "call1", output: "not found", isError: true, blockId: "b2", seq: 2 } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "error" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    assert.ok(msgs[1].blocks);
    const resultBlock = msgs[1].blocks.find(b => b.type === "tool_result");
    assert.ok(resultBlock, "应有 tool_result block");
    assert.strictEqual(resultBlock.isError, true);
  });

  it("多个 block 按 seq 顺序排列", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "order" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "thinking", text: "think 1", status: "streaming", blockId: "think1", seq: 1 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_use", status: "running", name: "search", toolCallId: "call1", blockId: "tool1", seq: 2 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_result", toolUseId: "call1", output: "ok", blockId: "res1", seq: 3 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "text", text: "final", blockId: "text1", seq: 4 } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    const blocks = msgs[1].blocks;
    assert.ok(blocks, "应有 blocks");
    assert.strictEqual(blocks.length, 4);
    // 验证按 seq 排序
    for (let i = 1; i < blocks.length; i++) {
      assert.ok(blocks[i].seq >= blocks[i - 1].seq, `block[${i}].seq (${blocks[i].seq}) >= block[${i-1}].seq (${blocks[i-1].seq})`);
    }
    assert.strictEqual(blocks[0].type, "thinking");
    assert.strictEqual(blocks[1].type, "tool_use");
    assert.strictEqual(blocks[2].type, "tool_result");
    assert.strictEqual(blocks[3].type, "text");
  });
});
