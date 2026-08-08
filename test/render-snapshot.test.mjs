/**
 * 前端渲染快照测试
 *
 * 直接测试 HTML 生成函数的输出结构。
 * 覆盖消息渲染与真实 Dashboard 布局的关键 DOM 约束。
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
global.mark = () => {};
global.logTiming = () => {};

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
globalThis.getPane = () => null;
globalThis.S = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24"><use href="#${name}"/></svg>`;
globalThis.E = (s) => String(s ?? "");
globalThis.F = (s) => Math.floor(s/60) + '分' + Math.floor(s%60) + '秒';
globalThis.$ = (id) => doc.getElementById(id);
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
globalThis.AbortController = class { constructor() { this.signal = {}; } abort() {} };
globalThis.localStorage = store;

// Explorer subscribes to the shared application event bus during module load.
win.App = win.App || {};
win.App.Events = win.App.Events || { subscribe: () => () => {} };

// App state
const state = {
  D: null, M: [], IL: false, CS: null, CT: "chat",
  _activePanel: "explorer", _fileTabs: [], _activeFileTab: null,
};
Object.defineProperties(state, {
  D: {
    get: () => win.App.ChatState.getDashboard(),
    set: (value) => win.App.ChatState.setDashboard(value),
  },
  M: {
    get: () => win.App.ChatState.getMessages(),
    set: (value) => win.App.ChatState.replaceMessages(value),
  },
  IL: {
    get: () => win.App.ChatState.isBusy(),
    set: (value) => win.App.ChatState.setBusy(value),
  },
});

// ExplorerService mock
global.ExplorerService = {
  iconFor: () => '<img src="./icons/default.svg" width="16" height="16">',
  getWorkspacePath: () => "",
};

// 最小加载：只加载核心模块
before(async () => {
  const ts = Date.now();
  await import(`../src/frontend/dashboard/dashboard-helpers.ts?t=${ts}`);
  await import(`../src/frontend/services/chat-runtime-store.ts?t=${ts}`);
  await import(`../src/frontend/services/preferences.ts?t=${ts}`);
  await import(`../src/frontend/services/ui-state-store.ts?t=${ts}`);
  await import(`../src/frontend/services/tab-store.ts?t=${ts}`);
  global.App = win.App;
  await import(`../src/frontend/service/explorer-service.ts?t=${ts}`);
  await import(`../src/frontend/chat/chat-render.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/dashboard-layout.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/layout-tabs.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/layout-panel.ts?t=${ts}`);
  await import(`../src/frontend/dashboard/layout-shortcuts.ts?t=${ts}`);
}, 10000); // 10s timeout

describe("msgs() 渲染", () => {
  it("空消息返回欢迎页", () => {
    state.M = [];
    const html = win.msgs();
    assert.ok(html.includes("Pi"));
    assert.ok(html.includes("输入"));
  });

  it("用户消息渲染", () => {
    state.M = [{ role: "user", content: "你好" }];
    const html = win.msgs();
    assert.ok(html.includes("你"));
    assert.ok(html.includes("你好"));
  });

  it("AI 回复渲染", () => {
    state.M = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const html = win.msgs();
    assert.ok(html.includes("Pi"));
    assert.ok(html.includes("hello"));
  });

  it("流式消息带打字动画", () => {
    state.M = [{ role: "assistant", content: "思考", streaming: true }];
    const html = win.msgs();
    assert.ok(html.includes("ty"));
  });

  it("div 标签成对闭合", () => {
    state.M = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
    const html = win.msgs();
    const opens = (html.match(/<div/g) || []).length;
    const closes = (html.match(/<\/div>/g) || []).length;
    assert.strictEqual(opens, closes);
  });

  it("markdown 加粗和斜体", () => {
    state.M = [{ role: "assistant", content: "**bold** and *italic*" }];
    const html = win.msgs();
    assert.ok(html.includes("<strong>bold</strong>"), "加粗渲染");
    assert.ok(html.includes("<em>italic</em>"), "斜体渲染");
    assert.ok(!html.includes("**bold**"), "原始 markdown 不出现");
  });

  it("markdown 代码块渲染为 <pre><code>", () => {
    state.M = [{ role: "assistant", content: "```ts\nconst x = 1;\n```" }];
    const html = win.msgs();
    assert.ok(html.includes("<pre"), "代码块为 <pre>");
    assert.ok(html.includes("<code"), "代码块为 <code>");
    assert.ok(html.includes("const x = 1;"), "代码内容保留");
  });

  it("markdown 表格渲染为 <table>", () => {
    state.M = [{ role: "assistant", content: "| a | b |\n|---|---|\n| 1 | 2 |" }];
    const html = win.msgs();
    assert.ok(html.includes("<table>"), "表格为 <table>");
    assert.ok(html.includes("<th>"), "表头渲染");
    assert.ok(html.includes("<td>"), "单元格渲染");
  });

  it("markdown 过滤 <link> 标签", () => {
    state.M = [{ role: "assistant", content: '<link rel="stylesheet" href="/admin/style.css">\nhello' }];
    const html = win.msgs();
    assert.ok(!html.includes('<link rel="stylesheet"'), "<link> 被过滤");
    assert.ok(html.includes("hello"), "其他内容保留");
  });

  it("无 block/无 trace 时仅显示内容", () => {
    state.M = [{
      role: "assistant",
      content: "这是回复内容",
    }];

    const html = win.msgs();

    assert.ok(html.includes("这是回复内容"), "纯内容消息正常显示");
    assert.ok(!html.includes("task track"), "不显示 trace 相关标记");
  });

  it("错误卡片展示原因、下一步和操作按钮", () => {
    state.M = [{
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

    const host = doc.createElement("div");
    host.innerHTML = html;
    doc.body.appendChild(host);
    assert.strictEqual(host.querySelectorAll("[onclick], [onchange], [oninput]").length, 0);

    const calls = [];
    const originals = {
      retryLastTurn: win.App.Chat.retryLastTurn,
      copyLastError: win.App.Chat.copyLastError,
      refreshWorkspaceState: win.App.Chat.refreshWorkspaceState,
      openSettingsModal: win.App.Settings.openSettingsModal,
    };
    win.App.Chat.retryLastTurn = () => calls.push("retry");
    win.App.Chat.copyLastError = () => { calls.push("copy"); return Promise.resolve(); };
    win.App.Chat.refreshWorkspaceState = () => calls.push("refresh");
    win.App.Settings.openSettingsModal = () => calls.push("settings");
    for (const action of ["retry", "copy", "refresh", "settings"]) {
      host.querySelector(`[data-chat-error-action="${action}"]`)?.click();
    }
    assert.deepStrictEqual(calls, ["retry", "copy", "refresh", "settings"]);
    Object.assign(win.App.Chat, {
      retryLastTurn: originals.retryLastTurn,
      copyLastError: originals.copyLastError,
      refreshWorkspaceState: originals.refreshWorkspaceState,
    });
    win.App.Settings.openSettingsModal = originals.openSettingsModal;
    host.remove();
  });

  it("block tool_use 渲染为工具节点", () => {
    state.M = [{
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
    state.M = [{
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
    state.M = [{
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
    state.M = [{
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
    state.M = [{
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
    state.M[0].blocks[0] = block;
    const updated = win.App.Chat.updateLastBlock(block);

    assert.strictEqual(updated, true);
    assert.strictEqual(panelRedraws, 0, "不能重绘整个消息列表");
    assert.strictEqual(panel.querySelector('[data-block-id="text-0"]'), targetBefore, "保留目标 block DOM");
    assert.ok(targetBefore.querySelector('.trace-node.trace-text'), "streaming update preserves the text event node");
    assert.ok(targetBefore.querySelector('.trace-dot'), "streaming update preserves the timeline dot");
    assert.ok(targetBefore.querySelector('.trace-text-body'), "streaming update preserves the text body");
    assert.ok(targetBefore.textContent.includes("partial"));
    Object.defineProperty(panel, "innerHTML", descriptor);
  });

  it("流式 tool_use block 原位更新且不替换 block flow", () => {
    state.M = [{
      role: "assistant",
      streaming: true,
      blocks: [{ type: "tool_use", status: "running", name: "command", toolCallId: "call1", blockId: "tool-1", seq: 1, output: "step 1\n" }],
    }];
    const panel = doc.getElementById("ms");
    panel.innerHTML = win.msgs();
    const flowBefore = panel.querySelector('.assistant-blocks');
    const targetBefore = panel.querySelector('[data-block-id="tool-1"]');

    const block = { type: "tool_use", status: "running", name: "command", toolCallId: "call1", blockId: "tool-1", seq: 1, output: "step 1\nstep 2\n" };
    state.M[0].blocks[0] = block;
    const updated = win.App.Chat.updateLastBlock(block);

    assert.strictEqual(updated, true);
    assert.strictEqual(panel.querySelector('.assistant-blocks'), flowBefore, "保留 block flow DOM");
    assert.strictEqual(panel.querySelector('[data-block-id="tool-1"]'), targetBefore, "保留目标 tool_use block DOM");
    assert.ok(targetBefore.textContent.includes("step 2"));
  });

  it("流式新增 block 只插入新节点，不重建已有事件流", () => {
    state.M = [{
      role: "assistant",
      streaming: true,
      blocks: [{ type: "thinking", status: "done", text: "先想", blockId: "think-1", seq: 1 }],
    }];
    const panel = doc.getElementById("ms");
    panel.innerHTML = win.msgs();
    const flowBefore = panel.querySelector('.assistant-blocks');
    const firstBefore = panel.querySelector('[data-block-id="think-1"]');

    const block = { type: "tool", status: "running", name: "command", blockId: "tool-1", seq: 2 };
    state.M[0].blocks.push(block);
    const updated = win.App.Chat.updateLastBlock(block);

    assert.strictEqual(updated, true);
    assert.strictEqual(panel.querySelector('.assistant-blocks'), flowBefore, "保留事件流 DOM");
    assert.strictEqual(panel.querySelector('[data-block-id="think-1"]'), firstBefore, "保留已有节点 DOM");
    const inserted = panel.querySelector('[data-block-id="tool-1"]');
    assert.ok(inserted, "只插入新增节点");
    assert.strictEqual(inserted.parentElement?.classList.contains("trace"), true, "新增节点仍在时间线容器内");
  });

  it("流式新增 block seq 乱序时插入到正确位置（中间插入）", () => {
    state.M = [{
      role: "assistant",
      streaming: true,
      blocks: [
        { type: "thinking", status: "done", text: "先想", blockId: "think-1", seq: 1 },
        { type: "text", text: "总结", blockId: "text-1", seq: 3 },
      ],
    }];
    const panel = doc.getElementById("ms");
    panel.innerHTML = win.msgs();
    // 新增 seq=2 的 tool，应插入 think-1 与 text-1 之间
    const toolBlock = { type: "tool", status: "running", name: "command", blockId: "tool-1", seq: 2 };
    state.M[0].blocks.push(toolBlock);
    win.App.Chat.updateLastBlock(toolBlock);
    const order = [...panel.querySelectorAll('[data-block-id]')].map((e) => e.dataset.blockId);
    assert.deepStrictEqual(order, ["think-1", "tool-1", "text-1"], "中间插入按 seq 排序");
  });

  it("首个 tool_use block 只填充消息内容区", () => {
    state.M = [{ role: "assistant", content: "", streaming: true }];
    const panel = doc.getElementById("ms");
    panel.innerHTML = win.msgs();
    const messageBefore = panel.querySelector('.m');

    const block = { type: "tool_use", status: "running", name: "command", toolCallId: "call1", blockId: "tool-1", seq: 1, output: "step 1\n" };
    state.M[0].blocks = [block];
    const updated = win.App.Chat.updateLastBlock(block);

    assert.strictEqual(updated, true);
    assert.strictEqual(panel.querySelector('.m'), messageBefore, "保留 assistant 消息 DOM");
    assert.ok(panel.querySelector('.assistant-blocks'), "内容区填充 block flow");
    assert.ok(panel.textContent.includes("step 1"));
  });

  it("成对 tool_result block 只刷新对应 tool_use 节点", () => {
    state.M = [{
      role: "assistant",
      streaming: true,
      blocks: [{ type: "tool_use", status: "running", name: "command", toolCallId: "call1", blockId: "tool-1", seq: 1, output: "step 1\n" }],
    }];
    const panel = doc.getElementById("ms");
    panel.innerHTML = win.msgs();
    const flowBefore = panel.querySelector('.assistant-blocks');
    const targetBefore = panel.querySelector('[data-block-id="tool-1"]');

    const result = { type: "tool_result", toolUseId: "call1", output: "done\n", blockId: "result-1", seq: 2 };
    state.M[0].blocks.push(result);
    const updated = win.App.Chat.updateLastBlock(result);

    assert.strictEqual(updated, true);
    assert.strictEqual(panel.querySelector('.assistant-blocks'), flowBefore, "保留 block flow DOM");
    assert.strictEqual(panel.querySelector('[data-block-id="tool-1"]'), targetBefore, "保留对应 tool_use block DOM");
    assert.ok(targetBefore.textContent.includes("done"));
  });

  it("done 结束态不替换 assistant 气泡", () => {
    state.M = [{
      role: "assistant",
      streaming: true,
      blocks: [{ type: "tool_use", status: "running", name: "command", toolCallId: "call1", blockId: "tool-1", seq: 1, output: "step 1\n" }],
    }];
    const panel = doc.getElementById("ms");
    panel.innerHTML = win.msgs();
    const messageBefore = panel.querySelector('.m');
    const targetBefore = panel.querySelector('[data-block-id="tool-1"]');

    state.M[0].streaming = false;
    state.M[0].blocks = [
      { type: "tool_use", status: "success", name: "command", toolCallId: "call1", blockId: "tool-1", seq: 1, output: "step 1\ndone\n" },
      { type: "tool_result", toolUseId: "call1", output: "done\n", blockId: "result-1", seq: 2 },
    ];
    const finalized = win.App.Chat.finalizeLastMessage();

    assert.strictEqual(finalized, true);
    assert.strictEqual(panel.querySelector('.m'), messageBefore, "保留 assistant 消息 DOM");
    assert.strictEqual(panel.querySelector('[data-block-id="tool-1"]'), targetBefore, "保留工具节点 DOM");
    assert.strictEqual(messageBefore.classList.contains('go'), false);
    assert.strictEqual(messageBefore.querySelector('.ty'), null);
    assert.ok(targetBefore.textContent.includes("done"));
  });

  it("block text → tool_use → tool_result 保持 seq 顺序", () => {
    state.M = [{
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

  it("_compacted 消息渲染为 .compact-summary 卡片", () => {
    const html = win.App.Chat.renderMessage({
      role: "assistant",
      content: "📦 **上下文已压缩** — 原 500 tokens\n\nsome summary here",
      _compacted: true,
    });
    assert.ok(html.startsWith('<div class="compact-summary">'), "使用 compact-summary 容器而非普通 m assistant");
    assert.ok(html.includes("some summary here"), "summary 内容渲染");
    assert.ok(!html.includes('class="m '), "不走普通 assistant 气泡");
    assert.ok(html.includes("<strong>上下文已压缩</strong>"), "markdown 加粗渲染");
  });

  it("普通 assistant 不走 .compact-summary", () => {
    const html = win.App.Chat.renderMessage({
      role: "assistant",
      content: "normal reply",
    });
    assert.ok(html.startsWith('<div class="m '), "普通 assistant 使用 m 容器");
    assert.ok(html.includes("normal reply"), "内容渲染");
  });

  it("renderMessage exposes the current message index for Timeline targets", () => {
    const html = win.App.Chat.renderMessage({
      role: "user",
      content: "定位问题",
    }, 4);

    assert.ok(html.includes('data-message-index="4"'));
  });

  it("blocks 中 text block 渲染在事件流内", () => {
    const html = win.App.Chat.renderMessage({
      role: "assistant",
      content: "reply",
      turnId: "t1",
      blocks: [
        { type: "thinking", text: "思考步骤", status: "done", blockId: "think1", seq: 1 },
        { type: "tool_use", status: "success", name: "search", toolCallId: "call1", blockId: "tool1", seq: 2 },
        { type: "tool_result", toolUseId: "call1", output: "结果", blockId: "res1", seq: 3 },
        { type: "text", text: "最终回复", blockId: "text1", seq: 4 },
      ],
    });
    // text block 作为事件节点流的一部分，带 timeline 圆点
    assert.ok(html.includes("block-trace"), "使用事件流容器");
    assert.ok(html.includes('class="trace-node trace-text"'), "text block 使用 trace-text 节点");
    assert.ok(html.includes("trace-dot"), "text block 带 timeline 圆点");
    assert.ok(html.includes("最终回复"), "text body 渲染");
    // 所有事件节点都在单个 trace 容器内
    const matchTrace = html.match(/<div class="trace block-trace">/g);
    assert.strictEqual(matchTrace?.length, 1, "所有 block 在单个 trace 容器内");
    // 第一个 thinking 默认展开
    assert.ok(html.includes('<details class="trace-thought" open>'), "第一个 thinking 默认展开");
    // 最后一个节点的竖线不延伸
    assert.ok(html.includes('trace-text'), "最后一个节点是 text block");
    const lastNodeMatch = html.match(/<div class="trace-node trace-text">/g);
    assert.ok(lastNodeMatch, "text 节点存在");
  });
});

describe("side panel interaction", () => {
  it("maps a persisted Permissions panel to Explorer during startup restore", () => {
    const panel = doc.getElementById("si");
    assert.ok(panel);
    panel.className = "sinfo";
    panel.innerHTML = '<div class="panel-content" id="pc"></div>';

    const originalGetPane = globalThis.getPane;
    globalThis.getPane = (name) => name === "explorer"
      ? (container) => { container.innerHTML = '<div id="explorer-pane">Explorer</div>'; }
      : null;
    try {
      win.App.State.updatePanel({ active: "permissions", closed: false, width: 260 });
      win.App.UI.restorePanel("permissions");

      assert.strictEqual(win.App.State.getSnapshot().panel.active, "explorer");
      assert.ok(doc.getElementById("explorer-pane"));
      assert.doesNotMatch(panel.textContent, /未注册/);
    } finally {
      globalThis.getPane = originalGetPane;
    }
  });

  it("opens the requested panel when restored state and startup DOM disagree", () => {
    win.App.State.updatePanel({ active: "chat", closed: false, width: 260 });

    const oldSidebar = doc.querySelector(".sbar");
    oldSidebar?.remove();
    const sidebar = doc.createElement("div");
    sidebar.className = "sbar";
    sidebar.innerHTML = [
      '<button class="b on" data-side="explorer"></button>',
      '<button class="b" data-side="chat"></button>',
    ].join("");
    doc.body.appendChild(sidebar);

    const panel = doc.getElementById("si");
    assert.ok(panel);
    panel.className = "sinfo";
    panel.style.width = "260px";
    panel.innerHTML = '<div class="panel-content" id="pc"></div>';

    win.togglePanel("chat");

    assert.strictEqual(panel.classList.contains("closed"), false, "first click should keep the panel open");
    assert.strictEqual(sidebar.querySelector('[data-side="chat"]')?.classList.contains("on"), true);
    assert.strictEqual(win.App.State.getSnapshot().panel.active, "chat");

    win.togglePanel("chat");
    assert.strictEqual(panel.classList.contains("closed"), true, "clicking the visible panel again should close it");

    sidebar.remove();
  });
});

describe("markdown security", () => {
  it("不允许原始 HTML 和危险 URL 协议", () => {
    const originalE = globalThis.E;
    const escape = (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
    globalThis.E = escape;
    state.M = [{ role: "assistant", content: '<script>alert(1)</script> [run](javascript:alert(1)) ![x](data:text/html,alert(1))' }];
    const html = win.msgs();
    assert.ok(!html.includes("<script>"), "raw script tags must not enter the DOM");
    assert.ok(html.includes("&lt;script&gt;"), "raw HTML should render as text");
    assert.ok(!html.includes('href="javascript:'), "javascript links must be removed");
    assert.ok(!html.includes('src="data:'), "data image URLs must be removed");
    globalThis.E = originalE;
  });
});

describe("shortcut modal", () => {
  it("closes through DOM events without inline JavaScript", () => {
    doc.dispatchEvent(new win.KeyboardEvent("keydown", { key: "F1", bubbles: true }));
    const modal = doc.getElementById("shortcuts-modal");
    assert.ok(modal);
    assert.strictEqual(modal.querySelectorAll("[onclick], [onchange], [oninput]").length, 0);
    modal.querySelector("[data-shortcuts-action='close']")?.click();
    assert.strictEqual(doc.getElementById("shortcuts-modal"), null);
  });
});

describe("dashboard refresh", () => {
  it("preserves the mounted side panel and resize handle", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindowFetch = win.fetch;
    const originalElectronApi = win.electronAPI;
    const originalInitResizeHandle = globalThis.initResizeHandle;
    const originalRenderPanel = globalThis.renderPanel;
    const originalBind = globalThis.bind;
    const originalGetPane = globalThis.getPane;
    const response = (body = {}) => ({
      ok: true,
      json: async () => body,
      text: async () => "",
    });

    win.electronAPI = { getDesktopSessionToken: async () => "test-token" };
    const fetchStub = async (input) => {
      const url = String(input);
      if (url === "/api/dashboard") {
        return response({ modelId: "test-model", runtime: 12, isIdle: true });
      }
      if (url === "/api/permissions/mode") return response({ mode: "standard" });
      return response();
    };
    globalThis.fetch = fetchStub;
    win.fetch = fetchStub;
    // Production concatenates these scripts into one global scope; bridge that scope in ESM tests.
    globalThis.initResizeHandle = () => {};
    globalThis.renderPanel = (...args) => win.renderPanel(...args);
    globalThis.bind = () => {};
    globalThis.getPane = (...args) => win.App.UI.getPane(...args);

    try {
      win.App.UI.registerPane("refresh-regression", (container) => {
        container.innerHTML = '<div id="refresh-regression-pane">mounted</div>';
      });
      win.App.State.updatePanel({ active: "refresh-regression", closed: false, width: 260 });
      win.layout();

      const panelContent = doc.getElementById("pc");
      const resizeHandle = doc.getElementById("si-handle");
      assert.ok(panelContent);
      assert.ok(resizeHandle);
      assert.ok(doc.getElementById("refresh-regression-pane"));

      await win.App.UI.getD();

      assert.strictEqual(doc.getElementById("pc"), panelContent);
      assert.strictEqual(doc.getElementById("si-handle"), resizeHandle);
      assert.ok(doc.getElementById("refresh-regression-pane"));
    } finally {
      globalThis.fetch = originalFetch;
      win.fetch = originalWindowFetch;
      win.electronAPI = originalElectronApi;
      globalThis.initResizeHandle = originalInitResizeHandle;
      globalThis.renderPanel = originalRenderPanel;
      globalThis.bind = originalBind;
      globalThis.getPane = originalGetPane;
    }
  });
});
