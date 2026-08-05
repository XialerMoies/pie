import { beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { Window } from "happy-dom";

function makeTurns(count) {
  const messages = [];
  for (let index = 0; index < count; index++) {
    messages.push({ role: "user", content: `问题 ${index + 1}` });
    messages.push({ role: "assistant", content: `回复 ${index + 1}` });
  }
  return messages;
}

async function setup(messages) {
  const win = new Window();
  const doc = win.document;
  doc.body.innerHTML = [
    '<div id="ms"></div>',
    '<nav id="chat-timeline" class="chat-timeline" aria-label="会话时间线" aria-hidden="true"></nav>',
  ].join("");

  global.window = win;
  global.document = doc;
  global.self = win;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
  global.$ = (id) => doc.getElementById(id);
  global.E = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  let currentMessages = messages;
  const preferences = new Map();
  const panel = doc.getElementById("ms");
  let scrollTop = 0;
  let scrollHeight = 1600;
  let clientHeight = 400;
  let lastScrollTo = null;
  Object.defineProperties(panel, {
    scrollTop: { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = Number(value); } },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    clientHeight: { configurable: true, get: () => clientHeight },
  });
  panel.scrollTo = (options) => {
    lastScrollTo = options;
    scrollTop = Number(options.top);
  };
  win.App = {
    Preferences: {
      get(key, fallback) {
        return preferences.has(key) ? preferences.get(key) : fallback;
      },
      getBoolean(key, fallback = false) {
        const value = preferences.has(key)
          ? preferences.get(key)
          : (fallback ? "1" : "0");
        if (value === "1" || value === "true") return true;
        if (value === "0" || value === "false") return false;
        return fallback;
      },
      getNumber(key, fallback, min = -Infinity, max = Infinity) {
        if (!preferences.has(key)) return fallback;
        const raw = String(preferences.get(key));
        if (!raw.trim()) return fallback;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(min ?? -Infinity, Math.min(max ?? Infinity, parsed));
      },
    },
    ChatState: {
      getMessages: () => currentMessages,
    },
  };
  global.App = win.App;

  try {
    await import(`../src/frontend/chat/chat-timeline.ts?t=${Date.now()}-${Math.random()}`);
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }

  return {
    win,
    doc,
    timeline: doc.getElementById("chat-timeline"),
    setMessages(nextMessages) { currentMessages = nextMessages; },
    setPreference(key, value) { preferences.set(key, typeof value === "boolean" ? (value ? "1" : "0") : value); },
    setScrollMetrics(next) {
      if (next.scrollTop !== undefined) scrollTop = next.scrollTop;
      if (next.scrollHeight !== undefined) scrollHeight = next.scrollHeight;
      if (next.clientHeight !== undefined) clientHeight = next.clientHeight;
    },
    getLastScrollTo() { return lastScrollTo; },
    renderMessageTargets(offsets) {
      panel.replaceChildren();
      currentMessages.forEach((message, index) => {
        const node = doc.createElement("div");
        node.className = `m ${message.role}`;
        node.dataset.messageIndex = String(index);
        Object.defineProperty(node, "offsetTop", {
          configurable: true,
          get: () => offsets[index] ?? 0,
        });
        panel.appendChild(node);
      });
    },
  };
}

describe("chat Timeline", () => {
  let env;

  beforeEach(async () => {
    env = await setup([]);
  });

  it("stays hidden until three assistant turns are available", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setMessages(makeTurns(2));
    env.win.App.ChatTimeline.sync();

    assert.strictEqual(env.timeline.classList.contains("on"), false);
    assert.strictEqual(env.timeline.getAttribute("aria-hidden"), "true");
    assert.strictEqual(env.timeline.childElementCount, 0);
  });

  it("pairs each assistant reply with its preceding user prompt", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setMessages(makeTurns(3));
    env.win.App.ChatTimeline.sync();

    assert.strictEqual(env.timeline.classList.contains("on"), true);
    assert.strictEqual(env.timeline.getAttribute("aria-hidden"), "false");
    assert.strictEqual(env.timeline.querySelectorAll("[data-timeline-index]").length, 3);
    const second = env.timeline.querySelector('[data-user-message-index="2"]');
    assert.ok(second);
    assert.strictEqual(second.dataset.prompt, "问题 2");
    assert.strictEqual(second.getAttribute("title"), "问题 2");
  });

  it("keeps directory labels within twelve characters while preserving the full tooltip", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setMessages([
      { role: "user", content: "这是一个超过十二个字的提问目录标题" },
      { role: "assistant", content: "回复 1" },
      { role: "user", content: "问题 2" },
      { role: "assistant", content: "回复 2" },
      { role: "user", content: "问题 3" },
      { role: "assistant", content: "回复 3" },
    ]);
    env.win.App.ChatTimeline.sync();

    const first = env.timeline.querySelector(".chat-timeline-item");
    assert.ok(first);
    assert.ok(Array.from(first.querySelector(".chat-timeline-prompt")?.textContent || "").length <= 12);
    assert.strictEqual(first.getAttribute("title"), "这是一个超过十二个字的提问目录标题");
  });

  it("keeps Timeline enabled with a nine-item window when preferences are missing", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setMessages(makeTurns(12));
    env.win.App.ChatTimeline.sync();

    assert.strictEqual(env.timeline.classList.contains("on"), true);
    assert.strictEqual(env.timeline.querySelectorAll("[data-timeline-index]").length, 9);
  });

  it("fails safe to enabled for an unknown persisted enabled preference", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setPreference("chat-timeline-enabled", "maybe");
    env.setMessages(makeTurns(3));
    env.win.App.ChatTimeline.sync();

    assert.strictEqual(env.timeline.classList.contains("on"), true);
    assert.strictEqual(env.timeline.querySelectorAll("[data-timeline-index]").length, 3);
  });

  it("uses a persisted five-item Timeline window", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setPreference("chat-timeline-window-size", 5);
    env.setMessages(makeTurns(12));
    env.win.App.ChatTimeline.sync();

    assert.strictEqual(env.timeline.querySelectorAll("[data-timeline-index]").length, 5);
  });

  it("falls back to a nine-item Timeline window for an invalid persisted setting", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setPreference("chat-timeline-window-size", "bad");
    env.setMessages(makeTurns(12));
    env.win.App.ChatTimeline.sync();

    assert.strictEqual(env.timeline.querySelectorAll("[data-timeline-index]").length, 9);
  });

  it("hides and clears Timeline when the persisted setting is disabled", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setMessages(makeTurns(3));
    env.win.App.ChatTimeline.sync();
    assert.strictEqual(env.timeline.querySelectorAll("[data-timeline-index]").length, 3);

    env.setPreference("chat-timeline-enabled", false);
    env.win.App.ChatTimeline.refreshSettings();

    assert.strictEqual(env.timeline.classList.contains("on"), false);
    assert.strictEqual(env.timeline.getAttribute("aria-hidden"), "true");
    assert.strictEqual(env.timeline.childElementCount, 0);
  });

  it("recomputes the active turn from scroll position after re-enabling", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setMessages(makeTurns(12));
    env.renderMessageTargets(Array.from({ length: 24 }, (_, index) => index * 100));
    env.setScrollMetrics({ scrollTop: 1600, scrollHeight: 2600, clientHeight: 400 });
    env.win.App.ChatTimeline.sync();

    env.setPreference("chat-timeline-enabled", false);
    env.win.App.ChatTimeline.refreshSettings();
    env.setPreference("chat-timeline-enabled", true);
    env.win.App.ChatTimeline.refreshSettings();

    const active = env.timeline.querySelector('[aria-current="true"]');
    assert.ok(active);
    assert.strictEqual(active.dataset.timelineIndex, "8");
    assert.strictEqual(env.doc.getElementById("ms").scrollTop, 1600);
  });

  it("renders at most nine turns around the active turn", () => {
    assert.ok(env.win.App.ChatTimeline, "App.ChatTimeline should be registered");

    env.setMessages(makeTurns(12));
    env.win.App.ChatTimeline.sync();

    const items = [...env.timeline.querySelectorAll("[data-timeline-index]")];
    assert.strictEqual(items.length, 9);
    assert.deepStrictEqual(items.map((item) => Number(item.dataset.timelineIndex)), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("clicking a prompt jumps directly to its user message", () => {
    env.setMessages(makeTurns(4));
    env.renderMessageTargets([0, 120, 260, 420, 600, 760, 940, 1100]);
    env.win.App.ChatTimeline.bind();

    env.timeline.querySelector('[data-user-message-index="2"]').click();

    assert.deepStrictEqual(env.getLastScrollTo(), { top: 260, behavior: "auto" });
  });

  it("wheel navigation advances exactly one assistant turn", () => {
    env.setMessages(makeTurns(4));
    env.renderMessageTargets([0, 120, 260, 420, 600, 760, 940, 1100]);
    env.win.App.ChatTimeline.bind();

    env.timeline.dispatchEvent(new env.win.WheelEvent("wheel", { deltaY: 100, cancelable: true }));

    const active = env.timeline.querySelector('[aria-current="true"]');
    assert.ok(active);
    assert.strictEqual(active.dataset.userMessageIndex, "2");
    assert.deepStrictEqual(env.getLastScrollTo(), { top: 260, behavior: "auto" });
  });

  it("message scrolling updates the active turn and the bounded window", async () => {
    env.setMessages(makeTurns(12));
    const offsets = Array.from({ length: 24 }, (_, index) => index * 100);
    env.renderMessageTargets(offsets);
    env.win.App.ChatTimeline.bind();
    env.setScrollMetrics({ scrollTop: 1600, scrollHeight: 2600, clientHeight: 400 });

    env.win.App.ChatTimeline.handleMessagesScroll();
    await new Promise((resolve) => setTimeout(resolve, 5));

    const active = env.timeline.querySelector('[aria-current="true"]');
    assert.ok(active);
    assert.strictEqual(active.dataset.timelineIndex, "8");
    const items = [...env.timeline.querySelectorAll("[data-timeline-index]")];
    assert.deepStrictEqual(items.map((item) => Number(item.dataset.timelineIndex)), [3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});
