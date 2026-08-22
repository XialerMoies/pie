/**
 * Session routes 测试
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("session message parser structure", () => {
  it("keeps JSONL replay parsing in a focused route-independent module", () => {
    const parserPath = resolve(ROOT, "src/server/routes/session-message-parser.ts");
    const sessionsPath = resolve(ROOT, "src/server/routes/sessions.ts");

    assert.strictEqual(existsSync(parserPath), true, "session-message-parser.ts must own replay parsing");

    const parserSource = readFileSync(parserPath, "utf8");
    const sessionsSource = readFileSync(sessionsPath, "utf8");

    assert.match(parserSource, /export function parseSessionMessages\(/);
    assert.doesNotMatch(parserSource, /\b(?:RouteHandler|ServerContext|authorizeRoutePath)\b/);
    assert.match(sessionsSource, /from "\.\/session-message-parser\.js"/);
    assert.match(sessionsSource, /export \{ parseSessionMessages \}/);
    assert.doesNotMatch(sessionsSource, /function parseSessionMessages\(/);
  });
});

describe("parseSessionMessages", () => {
  let mod;

  before(async () => {
    mod = await import("../src/server/routes/session-message-parser.ts");
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

  it("user_note assistant_block 回放为事件流节点且不重复显示对应 user message", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "开始检查" }] } }),
      JSON.stringify({ type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "检查 package.json" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool", status: "success", name: "pwd", output: "007", blockId: "tool-1", seq: 1 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "user_note", noteId: "note-1", mode: "steer", text: "检查 package.json", status: "delivered", blockId: "note-note-1", seq: 2 } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "已检查" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.deepStrictEqual(msgs.map((message) => message.role), ["user", "assistant"]);
    assert.strictEqual(msgs[1].blocks.length, 2);
    assert.strictEqual(msgs[1].blocks[1].type, "user_note");
    assert.strictEqual(msgs[1].blocks[1].text, "检查 package.json");
  });

  it("user_note 与初始提问同文时只去掉后出现的 SDK user message", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "继续检查" }] } }),
      JSON.stringify({ type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "继续检查" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "user_note", noteId: "note-1", mode: "steer", text: "继续检查", status: "delivered", blockId: "note-note-1", seq: 1 } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "完成" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.deepStrictEqual(msgs.map((message) => [message.role, message.content]), [["user", "继续检查"], ["assistant", "完成"]]);
    assert.strictEqual(msgs[1].blocks[0].type, "user_note");
  });

  it("真实 PI message 无 turnId 时按 trace turnId 恢复 assistant blocks", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "run" }] } }),
      JSON.stringify({ type: "message", id: "a1", message: { role: "assistant", content: [{ type: "thinking", thinking: "先想" }, { type: "toolCall", name: "command" }] } }),
      JSON.stringify({ type: "trace", turnId: "turn-1", event: { type: "thinking", status: "done", text: "先想", id: "think-1" } }),
      JSON.stringify({ type: "trace", turnId: "turn-1", event: { type: "tool", status: "success", name: "command", output: "ok", id: "tool-1" } }),
      JSON.stringify({ type: "assistant_block", turnId: "turn-1", block: { type: "thinking", text: "先想", status: "done", blockId: "m1:thinking-0", seq: 1 } }),
      JSON.stringify({ type: "assistant_block", turnId: "turn-1", block: { type: "tool", name: "command", output: "ok", status: "success", blockId: "tool-call-1", seq: 2 } }),
      JSON.stringify({ type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "完成" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "turn-1", block: { type: "text", text: "完成", blockId: "m1:text-1", seq: 3 } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    assert.deepStrictEqual(msgs[1].blocks.map(b => b.type), ["thinking", "tool", "text"]);
    assert.deepStrictEqual(msgs[1].blocks.map(b => b.blockId), ["m1:thinking-0", "tool-call-1", "m1:text-1"]);
    assert.strictEqual(msgs[1].thinking, undefined, "PI message thinking must stay out of the ordinary assistant payload");
    assert.strictEqual(msgs[1].trace, undefined, "raw trace must stay out of the ordinary assistant payload");
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
      assert.ok(blocks[i].seq >= blocks[i - 1].seq, `block[${i}].seq (${blocks[i].seq}) >= block[${i-1}].seq (${blocks[i-1]}.seq)`);
    }
    assert.strictEqual(blocks[0].type, "thinking");
    assert.strictEqual(blocks[1].type, "tool_use");
    assert.strictEqual(blocks[2].type, "tool_result");
    assert.strictEqual(blocks[3].type, "text");
  });

  it("assistant_block 按完成顺序追加时，刷新回放仍按初始 seq 排列", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "out of order" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool", toolCallId: "b", name: "b", status: "success", blockId: "tool-b", seq: 3 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool", toolCallId: "a", name: "a", status: "success", blockId: "tool-a", seq: 2 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "text", text: "final", blockId: "text-1", seq: 4 } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "final" }] } }),
    ].join("\n");
    const blocks = mod.parseSessionMessages(c)[1].blocks;
    assert.deepEqual(blocks.map((block) => block.blockId), ["tool-a", "tool-b", "text-1"]);
  });

  it("刷新回放合并同一工具调用的旧新 blockId，不重复显示工具节点", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "run" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: {
        type: "tool", toolCallId: "call-1", name: "search", input: { query: "x" },
        status: "running", blockId: "call-1@t1", seq: 1,
      } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: {
        type: "tool", toolCallId: "call-1", name: "search", output: "result",
        status: "success", blockId: "tool-call-1", seq: 2,
      } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const blocks = mod.parseSessionMessages(c)[1].blocks;
    assert.equal(blocks.filter((block) => block.type === "tool" && block.toolCallId === "call-1").length, 1);
    assert.deepEqual(blocks.find((block) => block.type === "tool") , {
      type: "tool", toolCallId: "call-1", name: "search", input: { query: "x" },
      output: "result", status: "success", blockId: "call-1@t1", seq: 1,
    });
  });

  it("旧 trace 格式自动转为 block（Stage ②）", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "帮我看看" }] } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "thinking", status: "done", text: "先搜一下", id: "think1" } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "tool", status: "success", name: "search", input: { q: "test" }, output: "结果", id: "tool1" } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "这是结果" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    const blocks = msgs[1].blocks;
    assert.ok(blocks, "旧 trace 应被转为 blocks");
    // B-5：tool 合并为一个 block → thinking + tool + text = 3
    assert.strictEqual(blocks.length, 3, "thinking + tool + text = 3");
    assert.strictEqual(blocks[0].type, "thinking");
    assert.strictEqual(blocks[0].text, "先搜一下");
    assert.strictEqual(blocks[1].type, "tool");
    assert.strictEqual(blocks[1].name, "search");
    assert.strictEqual(blocks[1].output, "结果");
    assert.strictEqual(blocks[2].type, "text");
    assert.strictEqual(blocks[2].text, "这是结果");
  });

  it("旧 trace 不覆盖已有 assistant_block", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "查状态" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_use", status: "success", name: "search", toolCallId: "call1", blockId: "b1", seq: 1 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_result", toolUseId: "call1", output: "ok", blockId: "b2", seq: 2 } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "tool", status: "running", name: "search", id: "tool1" } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    const blocks = msgs[1].blocks;
    assert.ok(blocks, "应有 blocks");
    assert.strictEqual(blocks[0].type, "tool_use");
    assert.strictEqual(blocks.length, 2, "assistant_block 路径优先，不应触发 trace→block 重复转换");
  });

  it("旧 step trace 转为 step block", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "step" }] } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "step", status: "info", text: "开始检查", id: "step1" } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "step", status: "success", text: "检查通过", id: "step2" } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "都好了" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    const blocks = msgs[1].blocks;
    assert.ok(blocks, "step trace 应被转为 blocks");
    const stepBlocks = blocks.filter((b) => b.type === "step");
    assert.strictEqual(stepBlocks.length, 2);
    assert.strictEqual(stepBlocks[0].text, "开始检查");
    assert.strictEqual(stepBlocks[0].status, "info");
    assert.strictEqual(stepBlocks[1].text, "检查通过");
    assert.strictEqual(stepBlocks[1].status, "success");
  });

  it("running→error 工具转换保留 input 和 error", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "失败工具" }] } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "tool", status: "running", name: "read", input: { path: "/tmp" }, id: "tool1" } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "tool", status: "error", name: "read", error: "文件不存在", id: "tool1" } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "出错了" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    const blocks = msgs[1].blocks;
    const use = blocks.find((b) => b.type === "tool");
    assert.ok(use, "应有 tool");
    assert.strictEqual(use.status, "error");
    assert.strictEqual(use.input?.path, "/tmp", "input 应保留");
    assert.strictEqual(use.error, "文件不存在");
  });

  it("running-only 工具不自称为 success", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "中断工具" }] } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "tool", status: "running", name: "build", input: { task: "test" }, id: "tool1" } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "被中断" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    const blocks = msgs[1].blocks;
    const use = blocks.find((b) => b.type === "tool");
    assert.ok(use, "应有 tool");
    assert.strictEqual(use.status, "error", "running-only 工具不应标记为 success");
    assert.strictEqual(use.error, "[中断]");
  });

  it("解析 compaction entry 生成独立卡片", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "before" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
      JSON.stringify({ type: "compaction", summary: "Goal: fix bug\nDecisions: rewrite parser", tokensBefore: 12345 }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "after" }] } }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "continue" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    // user + assistant + compact + user + assistant = 5 条独立消息
    assert.strictEqual(msgs.length, 5, "compaction 应独立成条，不合并前后消息");
    const compact = msgs[2];
    assert.strictEqual(compact._compacted, true, "compaction entry 应标记 _compacted");
    assert.ok(compact.content.includes("12345"), "应包含 tokensBefore");
    assert.ok(compact.content.includes("Goal: fix bug"), "应包含 summary");
    assert.ok(compact.content.includes("Decisions: rewrite parser"), "应包含 summary 全文");
    // 前后消息不受影响
    assert.strictEqual(msgs[0].role, "user");
    assert.strictEqual(msgs[0].content, "before");
    assert.strictEqual(msgs[1].role, "assistant");
    assert.strictEqual(msgs[1].content, "answer");
    assert.strictEqual(msgs[3].role, "user");
    assert.strictEqual(msgs[3].content, "after");
    assert.strictEqual(msgs[4].role, "assistant");
    assert.strictEqual(msgs[4].content, "continue");
  });

  it("compaction 后紧跟 assistant 不合并进卡片", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "compaction", summary: "compact summary", tokensBefore: 500 }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "post compact response" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2, "compact + assistant = 2 条，不应合并为 1 条");
    assert.strictEqual(msgs[0]._compacted, true, "第一条是 compact 卡片");
    assert.strictEqual(msgs[1]._compacted, undefined, "第二条是普通 assistant，不带 _compacted");
    assert.strictEqual(msgs[1].role, "assistant");
    assert.strictEqual(msgs[1].content, "post compact response");
  });

  it("多个 compaction 不互相合并", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "compaction", summary: "first compact", tokensBefore: 1000 }),
      JSON.stringify({ type: "compaction", summary: "second compact", tokensBefore: 2000 }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2, "两个 compaction 应各自独立");
    assert.strictEqual(msgs[0]._compacted, true);
    assert.ok(msgs[0].content.includes("first compact"));
    assert.strictEqual(msgs[1]._compacted, true);
    assert.ok(msgs[1].content.includes("second compact"));
  });

  it("compaction 无 tokensBefore 时显示 0", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "compaction", summary: "summary only" }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0]._compacted, true);
    assert.ok(msgs[0].content.includes("0 tokens"), "无 tokensBefore 时显示 0");
    assert.ok(msgs[0].content.includes("summary only"));
  });

  it("compaction 后的内部 trace 不进入普通 assistant 消息", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "compaction", summary: "compact", tokensBefore: 500 }),
      JSON.stringify({ type: "trace", turnId: "t2", event: { type: "step", status: "info", text: "after compact", id: "step1" } }),
      JSON.stringify({ type: "message", id: "a2", turnId: "t2", message: { role: "assistant", content: [{ type: "text", text: "response" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2, "compact + assistant = 2 条");
    assert.strictEqual(msgs[0]._compacted, true);
    assert.strictEqual(msgs[0].trace, undefined, "trace 不应挂到 compact 卡片");
    assert.strictEqual(msgs[1].trace, undefined, "raw trace 不应挂到普通 assistant 消息");
    assert.strictEqual(msgs[1].thinking, undefined, "thinking 不应挂到普通 assistant 消息");
    assert.strictEqual(msgs[1].blocks?.[0]?.type, "step", "内部 trace 仍可转换为显式节点视图");
    assert.strictEqual(msgs[1].blocks?.[0]?.text, "after compact");
  });

  it("assistant_block 生成 blocks 且含 text block", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "thinking", text: "思考中", status: "done", blockId: "think1", seq: 1 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_use", status: "success", name: "search", toolCallId: "call1", blockId: "tool1", seq: 2 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool_result", toolUseId: "call1", output: "ok", blockId: "res1", seq: 3 } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "text", text: "这是回复", blockId: "text1", seq: 4 } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "这是回复" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.strictEqual(msgs.length, 2);
    assert.ok(msgs[1].blocks, "assistant 消息应有 blocks");
    assert.strictEqual(msgs[1].blocks.length, 4, "thinking + tool_use + tool_result + text = 4");
    assert.strictEqual(msgs[1].blocks[3].type, "text");
    assert.strictEqual(msgs[1].blocks[3].text, "这是回复");
  });

  it("旧 trace 转换后 blocks 含 text block", () => {
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "status" }] } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "tool", status: "running", name: "git-status", input: {}, id: "tool1" } }),
      JSON.stringify({ type: "trace", turnId: "t1", event: { type: "tool", status: "success", name: "git-status", output: "clean", id: "tool1" } }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "status done" }] } }),
    ].join("\n");
    const msgs = mod.parseSessionMessages(c);
    assert.ok(msgs[1].blocks, "旧 trace 应转为 blocks");
    const textBlocks = msgs[1].blocks.filter((b) => b.type === "text");
    assert.strictEqual(textBlocks.length, 1, "应含一个 text block");
    assert.ok(textBlocks[0].text.includes("status done"));
    // B-5：tool 合并为单个 block
    assert.ok(msgs[1].blocks.some((b) => b.type === "tool"));
  });

  it("replays subagent custom entries onto the matching delegate_tasks tool call", () => {
    const subagent = (overrides = {}) => ({
      type: "subagent_event",
      protocolVersion: 1,
      parentToolCallId: "delegate-call-1",
      batchId: "batch-1",
      taskId: null,
      seq: 1,
      kind: "batch_started",
      status: "running",
      timestamp: "2026-08-12T08:00:00.000Z",
      payload: {},
      ...overrides,
    });
    const c = [
      JSON.stringify({ type: "session", id: "s1" }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "delegate" }] } }),
      JSON.stringify({ type: "assistant_block", turnId: "t1", block: { type: "tool", name: "delegate_tasks", toolCallId: "delegate-call-1", status: "success", blockId: "tool-delegate-call-1", seq: 1 } }),
      JSON.stringify({ type: "custom", customType: "subagent_event", data: subagent() }),
      JSON.stringify({ type: "custom", customType: "subagent_event", data: subagent({ taskId: "task-1", seq: 2, kind: "task_started" }) }),
      JSON.stringify({ type: "custom", customType: "subagent_event", data: subagent({ taskId: "task-1", seq: 3, kind: "task_completed", status: "completed", payload: { result: { summary: "checked" } } }) }),
      JSON.stringify({ type: "custom", customType: "subagent_event", data: subagent({ seq: 4, kind: "batch_completed", status: "completed" }) }),
      JSON.stringify({ type: "message", id: "a1", turnId: "t1", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ].join("\n");

    const msgs = mod.parseSessionMessages(c);

    assert.equal(msgs[1].subagentBatches.length, 1);
    assert.equal(msgs[1].subagentBatches[0].parentToolCallId, "delegate-call-1");
    assert.equal(msgs[1].subagentBatches[0].tasks[0].status, "completed");
  });
});
