/**
 * 前端渲染快照测试
 *
 * 直接测试 HTML 生成函数的输出结构。
 * msgs() 和 sinfoHTML() 已添加 export，可直接 import。
 *
 * 运行：npx tsx --test test/render-snapshot.test.mjs
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";
import * as marked from "marked";

// 初始化 happy-dom
const win = new Window();
const doc = win.document;
global.document = doc;
global.window = win;
global.self = win;
global.setTimeout = setTimeout;
global.clearTimeout = clearTimeout;

doc.body.innerHTML = '<div id="app"></div><div id="ms"></div><div id="si"></div>';

// 基础 mock
const store = {};
global.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
};
// 确保 globals 在所有作用域可见
globalThis.E = global.E || ((s) => String(s ?? ""));
globalThis.S = global.S || ((name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${name}"/></svg>`);
globalThis.$ = global.$ || ((id) => doc.getElementById(id));
globalThis.marked = marked;
win.marked = marked;
globalThis.toast = global.toast || (() => {});
globalThis.fetch = global.fetch || (async () => ({ ok: true, json: async () => ({}) }));
globalThis.localStorage = global.localStorage;
global.fetch = async () => ({ ok: true, json: async () => ({}) });
global.AbortController = class { constructor() { this.signal = {}; } abort() {} };
globalThis.toast = () => {};
globalThis.confirmAsync = async () => true;
globalThis.winCtrl = () => {};
globalThis.refresh = async () => {};
globalThis.S = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${name}"/></svg>`;
globalThis.E = (s) => String(s ?? "");
globalThis.F = (s) => Math.floor(s/60) + '分' + Math.floor(s%60) + '秒';
globalThis.$ = (id) => doc.getElementById(id);
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
globalThis.localStorage = store;

// App state
global.window.__state = {
  D: null, M: [], IL: false, CS: null, CT: "chat",
  _activePanel: "explorer", _fileTabs: [], _activeFileTab: null,
};

// ExplorerService mock
global.ExplorerService = {
  iconFor: () => '<img src="./icons/default.svg" width="16" height="16">',
  getWorkspacePath: () => "",
};

// 最小加载：只加载核心模块
before(async () => {
  const ts = Date.now();
  await import(`../src/frontend/dashboard/dashboard-helpers.ts?t=${ts}`);
  await import(`../src/frontend/service/explorer-service.ts?t=${ts}`);
  await import(`../src/frontend/chat/chat-render.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/dashboard-layout.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/layout-tabs.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/layout-panel.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/layout-shortcuts.ts?t=${ts}`);
}, 10000); // 10s timeout

describe("msgs() 渲染", () => {
  it("空消息返回欢迎页", () => {
    win.__state.M = [];
    const html = win.msgs();
    assert.ok(html.includes("Pi"));
    assert.ok(html.includes("输入"));
  });

  it("用户消息渲染", () => {
    win.__state.M = [{ role: "user", content: "你好" }];
    const html = win.msgs();
    assert.ok(html.includes("你"));
    assert.ok(html.includes("你好"));
  });

  it("AI 回复渲染", () => {
    win.__state.M = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const html = win.msgs();
    assert.ok(html.includes("Pi"));
    assert.ok(html.includes("hello"));
  });

  it("流式消息带打字动画", () => {
    win.__state.M = [{ role: "assistant", content: "思考", streaming: true }];
    const html = win.msgs();
    assert.ok(html.includes("ty"));
  });

  it("div 标签成对闭合", () => {
    win.__state.M = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
    const html = win.msgs();
    const opens = (html.match(/<div/g) || []).length;
    const closes = (html.match(/<\/div>/g) || []).length;
    assert.strictEqual(opens, closes);
  });

  it("markdown 加粗和斜体", () => {
    win.__state.M = [{ role: "assistant", content: "**bold** and *italic*" }];
    const html = win.msgs();
    assert.ok(html.includes("<strong>bold</strong>"), "加粗渲染");
    assert.ok(html.includes("<em>italic</em>"), "斜体渲染");
    assert.ok(!html.includes("**bold**"), "原始 markdown 不出现");
  });

  it("markdown 代码块渲染为 <pre><code>", () => {
    win.__state.M = [{ role: "assistant", content: "```ts\nconst x = 1;\n```" }];
    const html = win.msgs();
    assert.ok(html.includes("<pre"), "代码块为 <pre>");
    assert.ok(html.includes("<code"), "代码块为 <code>");
    assert.ok(html.includes("const x = 1;"), "代码内容保留");
  });

  it("markdown 表格渲染为 <table>", () => {
    win.__state.M = [{ role: "assistant", content: "| a | b |\n|---|---|\n| 1 | 2 |" }];
    const html = win.msgs();
    assert.ok(html.includes("<table>"), "表格为 <table>");
    assert.ok(html.includes("<th>"), "表头渲染");
    assert.ok(html.includes("<td>"), "单元格渲染");
  });

  it("markdown 过滤 <link> 标签", () => {
    win.__state.M = [{ role: "assistant", content: '<link rel="stylesheet" href="/admin/style.css">\nhello' }];
    const html = win.msgs();
    assert.ok(!html.includes('<link rel="stylesheet"'), "<link> 被过滤");
    assert.ok(html.includes("hello"), "其他内容保留");
  });

  it("无 block/无 trace 时仅显示内容", () => {
    win.__state.M = [{
      role: "assistant",
      content: "这是回复内容",
    }];

    const html = win.msgs();

    assert.ok(html.includes("这是回复内容"), "纯内容消息正常显示");
    assert.ok(!html.includes("task track"), "不显示 trace 相关标记");
  });

  it("错误卡片展示原因、下一步和操作按钮", () => {
    win.__state.M = [{
      role: "assistant",
      content: "",
      error: {
        title: "发送失败",
        message: "消息没有成功送达后端，请检查当前连接。",
        reason: "请求 `/api/chat` 失败",
        nextSteps: ["确认后端服务是否仍在运行", "重新发送当前消息"],
        raw: "Error: fetch failed",
      },
      trace: [{ type: "tool", status: "error", name: "search", error: "找不到工作区", input: { query: "workspace", type: "text" }, output: "找不到工作区", id: "search@err", turnId: "turn-err" }],
    }];

    const html = win.msgs();

    assert.ok(html.includes("发送失败"), "显示错误标题");
    assert.ok(html.includes("可能原因"), "显示原因区块");
    assert.ok(html.includes("下一步操作"), "显示下一步区块");
    assert.ok(html.includes("重新发送"), "显示重新发送按钮");
    assert.ok(html.includes("复制错误"), "显示复制错误按钮");
    assert.ok(html.includes("刷新工作区"), "显示刷新工作区按钮");
    assert.ok(html.includes("打开设置"), "显示打开设置按钮");
  });

  it("block tool_use 渲染为工具节点", () => {
    win.__state.M = [{
      role: "assistant",
      blocks: [
        { type: "tool_use", status: "running", name: "search", toolCallId: "call1", blockId: "b1", seq: 1 },
      ],
    }];
    const html = win.msgs();
    assert.ok(html.includes("搜索代码"), "tool_use 映射为中文标签");
    assert.ok(html.includes("trace-running"), "running 状态");
    assert.ok(html.includes("assistant-blocks"), "使用 block 流容器");
    assert.ok(html.includes("trace-node"), "复用事件时间线节点");
    assert.ok(!html.includes("trace-icon"), "不再退化为 emoji 文本行");
  });

  it("block text + tool_use 共存在同一气泡内", () => {
    win.__state.M = [{
      role: "assistant",
      blocks: [
        { type: "text", text: "正在检查代码", blockId: "t1", seq: 1 },
        { type: "tool_use", status: "success", name: "search", toolCallId: "call1", blockId: "b1", seq: 2 },
        { type: "tool_result", toolUseId: "call1", output: "未发现问题", blockId: "r1", seq: 3 },
        { type: "text", text: "检查完毕", blockId: "t2", seq: 4 },
      ],
    }];
    const html = win.msgs();
    assert.ok(html.includes("正在检查代码"), "第一段 text 出现");
    assert.ok(html.includes("检查完毕"), "末尾 text 出现");
    assert.ok(html.includes("搜索代码"), "tool_use 在中间");
    assert.ok(html.includes("OUT"), "tool_result 合并为输出卡");
    assert.ok(html.includes("未发现问题"), "tool_result 输出文本出现");
  });

  it("成对工具 block 合并为无重复文案的单节点", () => {
    const output = "Git 根目录：C:/repo\n分支：main\n变更总数：0";
    win.__state.M = [{
      role: "assistant",
      blocks: [
        { type: "tool_use", status: "running", name: "git-status", input: {}, toolCallId: "call1", blockId: "b1", seq: 1 },
        { type: "tool_result", toolUseId: "call1", output, blockId: "r1", seq: 2 },
      ],
    }];
    const html = win.msgs();

    assert.strictEqual((html.match(/验证结果/g) || []).length, 1, "工具标题只显示一次");
    assert.strictEqual((html.match(/Git 根目录：C:\/repo/g) || []).length, 1, "工具输出只显示一次");
    assert.strictEqual((html.match(/class=\"trace-node/g) || []).length, 1, "tool_use/tool_result 合并为一个节点");
    assert.ok(!html.includes("<pre>{}</pre>"), "空输入对象不显示 IN 卡");
    assert.ok(html.includes("OUT"), "结果保留在 OUT 卡中");
  });

  it("block tool_result 错误时显示 error 标记", () => {
    win.__state.M = [{
      role: "assistant",
      blocks: [
        { type: "tool_use", status: "error", name: "file-read", toolCallId: "call1", blockId: "b1", seq: 1 },
        { type: "tool_result", toolUseId: "call1", output: "文件不存在", isError: true, blockId: "r1", seq: 2 },
      ],
    }];
    const html = win.msgs();
    assert.ok(html.includes("trace-error"), "错误状态 class");
    assert.ok(html.includes("ERROR"), "失败结果显示 ERROR 标签");
    assert.ok(html.includes("文件不存在"), "错误信息显示");
  });

  it("流式 text block 原位更新且不重绘消息列表", () => {
    win.__state.M = [{
      role: "assistant",
      streaming: true,
      blocks: [{ type: "text", text: "par", blockId: "text-0", seq: 1 }],
    }];
    const panel = doc.getElementById("ms");
    panel.innerHTML = win.msgs();
    const targetBefore = panel.querySelector('[data-block-id="text-0"]');
    let panelRedraws = 0;
    const descriptor = Object.getOwnPropertyDescriptor(win.Element.prototype, "innerHTML");
    assert.ok(descriptor?.set && descriptor?.get);
    Object.defineProperty(panel, "innerHTML", {
      configurable: true,
      get() { return descriptor.get.call(this); },
      set(value) { panelRedraws += 1; return descriptor.set.call(this, value); },
    });

    const block = { type: "text", text: "partial", blockId: "text-0", seq: 1 };
    win.__state.M[0].blocks[0] = block;
    const updated = win.App.Chat.updateLastBlock(block);

    assert.strictEqual(updated, true);
    assert.strictEqual(panelRedraws, 0, "不能重绘整个消息列表");
    assert.strictEqual(panel.querySelector('[data-block-id="text-0"]'), targetBefore, "保留目标 block DOM");
    assert.ok(targetBefore.textContent.includes("partial"));
    Object.defineProperty(panel, "innerHTML", descriptor);
  });

  it("block text → tool_use → tool_result 保持 seq 顺序", () => {
    win.__state.M = [{
      role: "assistant",
      blocks: [
        { type: "tool_result", toolUseId: "call1", output: "result", blockId: "r1", seq: 3 },
        { type: "text", text: "先", blockId: "t1", seq: 1 },
        { type: "tool_use", status: "done", name: "git-status", toolCallId: "call1", blockId: "b1", seq: 2 },
      ],
    }];
    const html = win.msgs();

    const idxT1 = html.indexOf("先");
    const idxB1 = html.indexOf("验证结果");
    const idxR1 = html.indexOf("result");

    assert.ok(idxT1 >= 0, "text 出现在输出中");
    assert.ok(idxB1 >= 0, "tool_use 出现在输出中");
    assert.ok(idxR1 >= 0, "tool_result 出现在输出中");
    assert.ok(idxT1 < idxB1, "text 在 tool_use 之前");
    assert.ok(idxB1 < idxR1, "tool_use 在 tool_result 之前");
  });
});

describe("sinfoHTML() 渲染", () => {
  it("无数据时返回非空字符串", () => {
    win.__state.D = null;
    const html = win.sinfoHTML();
    assert.ok(typeof html === "string" && html.length > 0);
  });

  it("显示模型信息", () => {
    win.__state.D = {
      modelProvider: "deepseek", modelId: "deepseek-v4",
      modelContextWindow: "200000", modelMaxTokens: "4096",
      thinkingLevel: "high", runtime: 3600, messagesCount: 42,
      isIdle: true, tools: ["read", "write"], activeTools: ["read"],
      dataDir: "/data",
    };
    const html = win.sinfoHTML();
    assert.ok(html.includes("deepseek"));
    assert.ok(html.includes("deepseek-v4"));
    assert.ok(html.includes("42"));
  });
});
