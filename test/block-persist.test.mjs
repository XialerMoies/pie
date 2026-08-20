/**
 * Block 持久化生命周期测试
 *
 * persistBlockEvent / flushPendingBlockPersist / emitBlock
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { attachSessionEvents, persistBlockEvent, flushPendingBlockPersist, nextBlockSeq, recordUserNoteBlock } from "../src/server/server.ts";

function jsonl(file) {
  return readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mockRuntime(sessionFile, sessionManager = {}) {
  return {
    session: {
      sessionFile,
      sessionManager: {
        flushed: false,
        getSessionId: () => "session-1",
        ...sessionManager,
      },
    },
  };
}

describe("block persistence lifecycle", () => {
  it("records a runtime user note as one assistant block", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "pi-note-"));
    const sessionFile = resolve(dir, "session.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const runtime = mockRuntime(sessionFile, { flushed: true });
    const chatStream = { turnId: "turn-1", blockSeq: 0, blocks: [], response: { write() {} } };

    assert.strictEqual(recordUserNoteBlock(runtime, chatStream, {
      noteId: "note-1", message: "补充检查", mode: "steer",
    }), true);
    assert.strictEqual(chatStream.blocks.length, 1);
    assert.strictEqual(chatStream.blocks[0].type, "user_note");
    assert.strictEqual(chatStream.blocks[0].blockId, "note-note-1");
    const records = jsonl(sessionFile);
    assert.strictEqual(records.filter((entry) => entry.type === "assistant_block").length, 1);
  });
  it("keeps block pending before SDK flush, then appends once on flush", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "block-pending-"));
    const sessionFile = resolve(dir, "session.jsonl");
    const runtime = mockRuntime(sessionFile);
    const block = {
      type: "tool_use",
      status: "running",
      name: "search",
      toolCallId: "call-1",
      turnId: "turn-1",
      blockId: "b1",
      seq: 1,
    };

    // Before session flush: pending, no file created
    assert.strictEqual(persistBlockEvent(runtime, block), false);
    assert.strictEqual(existsSync(sessionFile), false,
      "must not create the file before PI SessionManager flushes it");

    // After session flush: pending blocks get written once
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");
    runtime.session.sessionManager.flushed = true;

    flushPendingBlockPersist(runtime, "turn-1");
    flushPendingBlockPersist(runtime, "turn-1"); // idempotent

    const records = jsonl(sessionFile).filter((entry) => entry.type === "assistant_block");
    assert.strictEqual(records.length, 1, "pending block should flush once");
    assert.strictEqual(records[0].block.blockId, "b1");
    assert.strictEqual(records[0].turnId, "turn-1");
  });

  it("writes tool_use and tool_result blocks in order", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "block-order-"));
    const sessionFile = resolve(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");
    const runtime = mockRuntime(sessionFile, { flushed: true });

    const toolUse = { type: "tool_use", status: "running", name: "search", toolCallId: "call-1", turnId: "turn-1", blockId: "b1", seq: 1 };
    const toolResult = { type: "tool_result", toolUseId: "call-1", output: "ok", turnId: "turn-1", blockId: "b2", seq: 2 };

    persistBlockEvent(runtime, toolUse);
    persistBlockEvent(runtime, toolResult);

    const records = jsonl(sessionFile).filter((entry) => entry.type === "assistant_block");
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].block.type, "tool_use");
    assert.strictEqual(records[1].block.type, "tool_result");
  });

  it("same blockId overwrites pending (no duplicate on flush)", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "block-dedup-"));
    const sessionFile = resolve(dir, "session.jsonl");
    const runtime = mockRuntime(sessionFile);

    const v1 = { type: "thinking", text: "step 1", status: "streaming", turnId: "turn-1", blockId: "think-1", seq: 1 };
    const v2 = { type: "thinking", text: "step 1 step 2", status: "streaming", turnId: "turn-1", blockId: "think-1", seq: 2 };

    persistBlockEvent(runtime, v1);
    persistBlockEvent(runtime, v2);

    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");
    runtime.session.sessionManager.flushed = true;

    flushPendingBlockPersist(runtime, "turn-1");

    const records = jsonl(sessionFile).filter((entry) => entry.type === "assistant_block");
    assert.strictEqual(records.length, 1, "dedup by blockId: only latest version written");
    assert.strictEqual(records[0].block.text, "step 1 step 2");
    assert.strictEqual(records[0].block.seq, 2);
  });

  it("nextBlockSeq increments and returns matching id and seq", () => {
    const chatStream = { blockSeq: 0, blocks: [] };
    const s1 = nextBlockSeq(chatStream);
    assert.strictEqual(s1, 1);
    const s2 = nextBlockSeq(chatStream);
    assert.strictEqual(s2, 2);
    assert.strictEqual(chatStream.blockSeq, 2);
  });

  it("SSE assistant block updates keep the initial seq", () => {
    const writes = [];
    const runtime = mockRuntime("", { flushed: true });
    const chatStream = {
      turnId: "turn-1",
      blocks: [],
      blockSeq: 0,
      response: { write(chunk) { writes.push(String(chunk)); return true; } },
    };
    let callback = null;
    runtime.onEvent = (handler) => { callback = handler; return () => {}; };
    runtime.emit = (event) => callback(event);
    attachSessionEvents(runtime, chatStream);

    const content = [{ type: "text", text: "首段" }];
    runtime.emit({ type: "message_update", turnId: "turn-1", message: { role: "assistant", content }, assistantMessageEvent: {
      type: "text_delta", contentIndex: 0, delta: "首段",
    }});
    runtime.emit({ type: "message_update", turnId: "turn-1", message: { role: "assistant", content: [{ type: "text", text: "首段追加" }] }, assistantMessageEvent: {
      type: "text_delta", contentIndex: 0, delta: "追加",
    }});

    const blockEvents = writes
      .map((chunk) => {
        const marker = chunk.indexOf("data: ");
        return marker >= 0 ? JSON.parse(chunk.slice(marker + 6).trim()) : null;
      })
      .filter((event) => event?.type === "block" && event.block?.blockId === "m1:text-0");
    assert.strictEqual(blockEvents.length, 2);
    assert.strictEqual(blockEvents[0].block.seq, 1);
    assert.strictEqual(blockEvents[1].block.seq, 1,
      "更新事件必须复用首次创建序号，避免实时节点漂移");
  });

  it("B-5: 验收——thinking/text 独立 + tool 合并 + seq 稳定 + 末尾正文", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "block-b5accept-"));
    const sessionFile = resolve(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");

    let callback = null;
    const runtime = {
      session: { sessionFile, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true; }, end() {} }, currentWorkspace: "ws", turnId: "turn-1",
      traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const upd = (content, inc) => runtime.emit({ type: "message_update", turnId: "turn-1", message: { role: "assistant", content }, assistantMessageEvent: inc });
    const tool = (cid, name, result, isError) => {
      runtime.emit({ type: "tool_execution_start", turnId: "turn-1", toolCallId: cid, toolName: name, args: {} });
      runtime.emit({ type: "tool_execution_end", turnId: "turn-1", toolCallId: cid, toolName: name, result, isError });
    };

    const c1 = [{ type: "thinking", thinking: "思考1" }, { type: "text", text: "正文1" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content: c1 } }); // message 1
    upd(c1, { type: "thinking_delta", contentIndex: 0, delta: "思考1" });
    upd(c1, { type: "text_delta", contentIndex: 1, delta: "正文1" });
    tool("call1", "search", "结果1", false);
    // 工具后新 assistant message（contentIndex 重新从 0 开始）
    const c2 = [{ type: "thinking", thinking: "思考2" }, { type: "text", text: "末尾正文" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content: c2 } }); // message 2
    upd(c2, { type: "thinking_delta", contentIndex: 0, delta: "思考2" });
    upd(c2, { type: "text_delta", contentIndex: 1, delta: "末尾正文" });

    // 1. 类型序列：thinking -> text -> tool -> thinking -> text
    const sorted = [...chatStream.blocks].sort((a, b) => a.seq - b.seq);
    const types = sorted.map((b) => b.type);
    assert.deepStrictEqual(types, ["thinking", "text", "tool", "thinking", "text"],
      "thinking/text/tool 线性 block 顺序");

    // 2. blockId 带 message 前缀，跨 message 的 contentIndex 不冲突
    assert.strictEqual(sorted[0].blockId, "m1:thinking-0");
    assert.strictEqual(sorted[1].blockId, "m1:text-1");
    assert.strictEqual(sorted[3].blockId, "m2:thinking-0", "message 2 的 thinking-0 不与 message 1 冲突");
    assert.strictEqual(sorted[4].blockId, "m2:text-1");

    // 3. tool 合并为一个 block（无 tool_use/tool_result）
    assert.ok(!types.includes("tool_use") && !types.includes("tool_result"), "tool 合并");
    assert.strictEqual(sorted[2].blockId, "tool-call1");
    assert.strictEqual(sorted[2].output, "结果1");

    // 4. seq 稳定：更新当前 message 的 text block 不改变其 seq
    const t1Before = chatStream.blocks.find((b) => b.blockId === "m2:text-1").seq;
    upd(c2, { type: "text_delta", contentIndex: 1, delta: "末尾正文追加" });
    const t1After = chatStream.blocks.find((b) => b.blockId === "m2:text-1").seq;
    assert.strictEqual(t1After, t1Before, "更新保留初始 seq，位置不漂移");

    // 5. agent_end：末尾是正文、indexed thinking 变 done、done.text/thinking 完整
    let doneBlocks = null;
    let doneText = "";
    let doneThinking = "";
    chatStream.response.write = (chunk) => {
      const s = String(chunk);
      if (s.includes('"type":"done"')) {
        const payload = JSON.parse(s.slice(s.indexOf("data: ") + 6).trim());
        doneBlocks = payload.blocks;
        doneText = payload.text;
        doneThinking = payload.thinking || "";
      }
      return true;
    };
    runtime.emit({ type: "agent_end" });
    const last = doneBlocks[doneBlocks.length - 1];
    assert.strictEqual(last.type, "text", "末尾必须是正文节点");
    assert.strictEqual(last.text, "末尾正文");
    // P1-3：indexed thinking 收尾为 done
    const thinkingBlocks = doneBlocks.filter((b) => b.type === "thinking");
    assert.ok(thinkingBlocks.every((b) => b.status === "done"), "所有 thinking block 结束为 done");
    // P2-1：done.text 拼接全部正文（正文1 + 末尾正文）
    assert.ok(doneText.includes("正文1"), "done.text 含第一段正文");
    assert.ok(doneText.includes("末尾正文"), "done.text 含末尾正文");
    // 收尾问题1：done.thinking 同步 thinkingBuffer（indexed thinking 也要进 done.thinking）
    assert.ok(doneThinking.includes("思考1"), "done.thinking 含 message 1 思考");
    assert.ok(doneThinking.includes("思考2"), "done.thinking 含 message 2 思考");
    // 收尾问题3：JSONL 无重复 blockId
    const persisted = readFileSync(sessionFile, "utf-8")
      .trim().split("\n")
      .filter((l) => l.includes('"assistant_block"'))
      .map((l) => JSON.parse(l).block);
    const ids = persisted.map((b) => b.blockId);
    assert.strictEqual(new Set(ids).size, ids.length, "落盘 blockId 不应重复");
  });

  it("B-5: agent_end 无正文时补占位正文（纯工具调用）", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "block-b5nopost-"));
    const sessionFile = resolve(dir, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-1" }) + "\n");

    let callback = null;
    const runtime = {
      session: { sessionFile, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true; }, end() {} }, currentWorkspace: "ws", turnId: "turn-1",
      traceSeq: 0, emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    runtime.emit({ type: "tool_execution_start", turnId: "turn-1", toolCallId: "c1", toolName: "search", args: {} });
    runtime.emit({ type: "tool_execution_end", turnId: "turn-1", toolCallId: "c1", toolName: "search", result: "ok", isError: false });

    let doneBlocks = null;
    chatStream.response.write = (chunk) => {
      const s = String(chunk);
      if (s.includes('"type":"done"')) doneBlocks = JSON.parse(s.slice(s.indexOf("data: ") + 6).trim()).blocks;
      return true;
    };
    runtime.emit({ type: "agent_end" });
    const last = doneBlocks[doneBlocks.length - 1];
    assert.strictEqual(last.type, "text", "纯工具调用末尾也补正文节点");
    assert.strictEqual(last.text, "本轮未生成最终回复。");
  });
});

describe("block persistence compatibility snapshots", () => {
  it("closes an indexed text input before opening the next text node", () => {
    let callback = null;
    const runtime = {
      session: { sessionFile: undefined, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true; }, end() {} }, currentWorkspace: "", turnId: "turn-1",
      emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const update = (content, assistantMessageEvent) => runtime.emit({
      type: "message_update",
      turnId: "turn-1",
      message: { role: "assistant", content },
      assistantMessageEvent,
    });
    const content = [{ type: "text", text: "" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content } });
    update(content, { type: "text_start", contentIndex: 0 });
    content[0].text = "第一段";
    update(content, { type: "text_delta", contentIndex: 0, delta: "第一段" });
    update(content, { type: "text_end", contentIndex: 0 });

    // 关闭后的迟到 delta 不得再次写入已关闭的正文节点。
    content[0].text = "第一段迟到追加";
    update(content, { type: "text_delta", contentIndex: 0, delta: "迟到追加" });

    // 关闭后即使换了 contentIndex，也必须等待 text_start，不能凭 delta 偷开新节点。
    update(content, { type: "text_delta", contentIndex: 1, delta: "无 start 的新节点" });

    // 只有新的 text_start 才能开启新的正文输入节点，即使 contentIndex 相同。
    content[0].text = "";
    update(content, { type: "text_start", contentIndex: 0 });
    content[0].text = "第二段";
    update(content, { type: "text_delta", contentIndex: 0, delta: "第二段" });

    const textBlocks = chatStream.blocks.filter((block) => block.type === "text");
    assert.strictEqual(textBlocks.length, 2, "正文应拆成两个线性节点");
    assert.strictEqual(textBlocks[0].text, "第一段");
    assert.strictEqual(textBlocks[1].text, "第二段");
    assert.notStrictEqual(textBlocks[0].blockId, textBlocks[1].blockId, "新正文节点必须有新的 blockId");
  });

  it("closes an indexed thinking input before opening the next thinking node", () => {
    let callback = null;
    const runtime = {
      session: { sessionFile: undefined, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true; }, end() {} }, currentWorkspace: "", turnId: "turn-1",
      emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const update = (content, assistantMessageEvent) => runtime.emit({
      type: "message_update",
      turnId: "turn-1",
      message: { role: "assistant", content },
      assistantMessageEvent,
    });
    const content = [{ type: "thinking", thinking: "" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content } });
    update(content, { type: "thinking_start", contentIndex: 0 });
    content[0].thinking = "第一段思考";
    update(content, { type: "thinking_delta", contentIndex: 0, delta: "第一段思考" });
    update(content, { type: "thinking_end", contentIndex: 0, content: "第一段思考" });

    // thinking_end 后该节点立即 done，不再显示进行中。
    const ended = chatStream.blocks.find((block) => block.type === "thinking");
    assert.strictEqual(ended?.status, "done", "thinking_end 应立即把节点标 done");

    // 关闭后的迟到 delta 不得再次写入已关闭的思考节点。
    content[0].thinking = "第一段思考迟到追加";
    update(content, { type: "thinking_delta", contentIndex: 0, delta: "迟到追加" });

    // 关闭后即使换了 contentIndex，也必须等待 thinking_start，不能凭 delta 偷开新节点。
    update(content, { type: "thinking_delta", contentIndex: 1, delta: "无 start 的新节点" });

    // 只有新的 thinking_start 才能开启新的思考输入节点，即使 contentIndex 相同。
    content[0].thinking = "";
    update(content, { type: "thinking_start", contentIndex: 0 });
    content[0].thinking = "第二段思考";
    update(content, { type: "thinking_delta", contentIndex: 0, delta: "第二段思考" });

    const thinkingBlocks = chatStream.blocks.filter((block) => block.type === "thinking");
    assert.strictEqual(thinkingBlocks.length, 2, "思考应拆成两个线性节点");
    assert.strictEqual(thinkingBlocks[0].text, "第一段思考");
    assert.strictEqual(thinkingBlocks[1].text, "第二段思考");
    assert.strictEqual(thinkingBlocks[1].status, "streaming", "第二段思考尚未 end，保持 streaming");
    assert.notStrictEqual(thinkingBlocks[0].blockId, thinkingBlocks[1].blockId, "新思考节点必须有新的 blockId");
  });

  it("marks the previous thinking node done when a new start arrives without end", () => {
    let callback = null;
    const runtime = {
      session: { sessionFile: undefined, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true; }, end() {} }, currentWorkspace: "", turnId: "turn-1",
      emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const update = (content, assistantMessageEvent) => runtime.emit({
      type: "message_update",
      turnId: "turn-1",
      message: { role: "assistant", content },
      assistantMessageEvent,
    });
    const content = [{ type: "thinking", thinking: "" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content } });

    // LLM 未发 thinking_end，直接开新 thinking_start（同 contentIndex）。
    update(content, { type: "thinking_start", contentIndex: 0 });
    content[0].thinking = "第一段思考";
    update(content, { type: "thinking_delta", contentIndex: 0, delta: "第一段思考" });
    content[0].thinking = "";
    update(content, { type: "thinking_start", contentIndex: 0 });
    content[0].thinking = "第二段思考";
    update(content, { type: "thinking_delta", contentIndex: 0, delta: "第二段思考" });

    const thinkingBlocks = chatStream.blocks.filter((block) => block.type === "thinking");
    assert.strictEqual(thinkingBlocks.length, 2, "两个 thinking_start 生成两个线性节点");
    assert.strictEqual(thinkingBlocks[0].status, "done", "缺 end 时新 start 也必须把旧节点标 done");
    assert.strictEqual(thinkingBlocks[0].text, "第一段思考");
    assert.strictEqual(thinkingBlocks[1].status, "streaming", "第二段思考仍进行中");
    assert.notStrictEqual(thinkingBlocks[0].blockId, thinkingBlocks[1].blockId, "新旧思考节点 blockId 不同");
  });

  it("opens separate text nodes when a new start arrives without text_end", () => {
    let callback = null;
    const runtime = {
      session: { sessionFile: undefined, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true; }, end() {} }, currentWorkspace: "", turnId: "turn-1",
      emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const update = (content, assistantMessageEvent) => runtime.emit({
      type: "message_update",
      turnId: "turn-1",
      message: { role: "assistant", content },
      assistantMessageEvent,
    });
    const content = [{ type: "text", text: "" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content } });

    // LLM 未发 text_end，直接开新 text_start（同 contentIndex）。
    update(content, { type: "text_start", contentIndex: 0 });
    content[0].text = "第一段";
    update(content, { type: "text_delta", contentIndex: 0, delta: "第一段" });
    content[0].text = "";
    update(content, { type: "text_start", contentIndex: 0 });
    content[0].text = "第二段";
    update(content, { type: "text_delta", contentIndex: 0, delta: "第二段" });

    const textBlocks = chatStream.blocks.filter((block) => block.type === "text");
    assert.strictEqual(textBlocks.length, 2, "两个 text_start 生成两个线性节点，不互相覆盖");
    assert.strictEqual(textBlocks[0].text, "第一段");
    assert.strictEqual(textBlocks[1].text, "第二段");
    assert.notStrictEqual(textBlocks[0].blockId, textBlocks[1].blockId, "新旧正文节点 blockId 不同");
  });

  it("cuts off thinking input when text arrives and vice versa", () => {
    let callback = null;
    const runtime = {
      session: { sessionFile: undefined, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true; }, end() {} }, currentWorkspace: "", turnId: "turn-1",
      emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const update = (content, assistantMessageEvent) => runtime.emit({
      type: "message_update",
      turnId: "turn-1",
      message: { role: "assistant", content },
      assistantMessageEvent,
    });
    const content = [{ type: "thinking", thinking: "" }, { type: "text", text: "" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content } });

    // 思考输入流中正文出现——思考输入被切断，正文开新节点。
    update(content, { type: "thinking_start", contentIndex: 0 });
    content[0].thinking = "思考";
    update(content, { type: "thinking_delta", contentIndex: 0, delta: "思考" });
    content[1].text = "正文";
    update(content, { type: "text_delta", contentIndex: 1, delta: "正文" });

    // 正文到达后迟到的思考 delta 被拒绝（思考节点已被切断且无 thinking_start）。
    content[0].thinking = "思考迟到";
    update(content, { type: "thinking_delta", contentIndex: 0, delta: "迟到思考" });

    const thinkingBlocks = chatStream.blocks.filter((block) => block.type === "thinking");
    const textBlocks = chatStream.blocks.filter((block) => block.type === "text");
    assert.strictEqual(thinkingBlocks.length, 1, "思考保持单个节点");
    assert.strictEqual(thinkingBlocks[0].text, "思考", "正文到达后迟到的思考 delta 被拒绝");
    assert.strictEqual(textBlocks.length, 1, "正文独立成节点");
    assert.strictEqual(textBlocks[0].text, "正文");
  });

  it("reuses the indexed text block after an unindexed compatibility snapshot", () => {
    let callback = null;
    const runtime = {
      session: { sessionFile: undefined, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true; }, end() {} }, currentWorkspace: "", turnId: "turn-1",
      emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const content = [{ type: "text", text: "same text" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content } });
    runtime.emit({ type: "message_update", turnId: "turn-1", message: { role: "assistant", content } });
    runtime.emit({
      type: "message_update",
      turnId: "turn-1",
      message: { role: "assistant", content },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "same text" },
    });

    const textBlocks = chatStream.blocks.filter((block) => block.type === "text");
    assert.strictEqual(textBlocks.length, 1, "mixed snapshots must not create duplicate text blocks");
    assert.strictEqual(textBlocks[0].blockId, "m1:text-0");
    assert.strictEqual(textBlocks[0].text, "same text");
  });

  it("falls back to a valid blockId when a delta omits contentIndex", () => {
    let callback = null;
    const runtime = {
      session: { sessionFile: undefined, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true }, end() {} }, currentWorkspace: "", turnId: "turn-1",
      emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const update = (content, assistantMessageEvent) => runtime.emit({
      type: "message_update",
      turnId: "turn-1",
      message: { role: "assistant", content },
      assistantMessageEvent,
    });
    const content = [{ type: "text", text: "无 contentIndex 正文" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content } });
    update(content, { type: "text_delta" }); // 无 contentIndex

    const textBlocks = chatStream.blocks.filter((block) => block.type === "text");
    assert.strictEqual(textBlocks.length, 1, "应生成一个正文节点");
    assert.doesNotMatch(textBlocks[0].blockId, /text--/, "blockId 不得含非法 -1 索引（text--1）");
  });

  it("closes both open inputs before the compatibility path creates nodes", () => {
    let callback = null;
    const runtime = {
      session: { sessionFile: undefined, sessionManager: { flushed: true, getSessionId: () => "session-1" } },
      onEvent(handler) { callback = handler; return () => {}; },
      emit(event) { callback(event); },
    };
    const chatStream = {
      textBuffer: "", thinkingBuffer: "", currentTextSnapshot: "", currentThinkingSnapshot: "",
      response: { write() { return true }, end() {} }, currentWorkspace: "", turnId: "turn-1",
      emittedTraces: new Set(), blocks: [], blockSeq: 0, textSegments: [],
    };
    attachSessionEvents(runtime, chatStream);

    const update = (content, assistantMessageEvent) => runtime.emit({
      type: "message_update",
      turnId: "turn-1",
      message: { role: "assistant", content },
      assistantMessageEvent,
    });
    const content = [{ type: "text", text: "" }, { type: "thinking", thinking: "" }];
    runtime.emit({ type: "message_start", turnId: "turn-1", message: { role: "assistant", content } });

    // 先开启 thinking 和 text 两个输入（indexed 路径）。
    update(content, { type: "thinking_start", contentIndex: 0 });
    content[0].thinking = "思考";
    update(content, { type: "thinking_delta", contentIndex: 0, delta: "思考" });
    update(content, { type: "text_start", contentIndex: 1 });
    content[1].text = "正文";
    update(content, { type: "text_delta", contentIndex: 1, delta: "正文" });

    // 一个非 text/thinking 事件走兼容路径——必须先关闭两个 active 输入。
    update(content, { type: "step" });
    assert.strictEqual(chatStream.activeTextInput?.open, false, "兼容路径必须关闭 text 输入");
    assert.strictEqual(chatStream.activeThinkingInput?.open, false, "兼容路径必须关闭 thinking 输入");
  });
});
