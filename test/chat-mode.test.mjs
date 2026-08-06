import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

describe("chat mode server-state boundary", () => {
  it("keeps unknown thinking levels out of the strategy popup DOM", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    win.document.body.innerHTML = '<span id="fi-mode-name"></span>';
    let selectedPermissionMode = null;
    global.App = win.App = {
      Chat: {},
      Permissions: {
        getMode: () => "standard",
        setMode: (mode) => { selectedPermissionMode = mode; },
      },
      Preferences: {
        get: (_key, fallback = "") => fallback,
        set: () => {},
      },
    };

    const injectedLevel = '\" data-thinking-level-injected="yes';
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        supportsThinking: true,
        availableLevels: ["low", injectedLevel, "high"],
        level: injectedLevel,
      }),
    });

    await import(`../src/frontend/chat/chat-mode.ts?${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(win.App.Chat.getEffort(), "low");
    assert.equal(win.document.getElementById("fi-mode-name").textContent, "自动 · 标准");

    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);

    const popup = win.document.getElementById("mode-popup");
    assert.ok(popup);
    assert.equal(popup.querySelector("[data-thinking-level-injected]"), null);
    assert.deepEqual(
      [...popup.querySelectorAll("[data-permission-mode]")].map((option) => option.dataset.permissionMode),
      ["plan", "standard", "dontAsk", "yes"],
    );
    assert.equal(popup.querySelectorAll(".effort-dot").length, 0);
    popup.querySelector('[data-permission-mode="dontAsk"]').click();
    assert.equal(selectedPermissionMode, "dontAsk");
  });

  it("provides the thinking depth control for the model picker", async () => {
    const win = new Window();
    global.window = win;
    global.document = win.document;
    global.self = win;
    global.$ = (id) => win.document.getElementById(id);
    global.App = win.App = {
      Chat: {},
      Preferences: {
        get: (_key, fallback = "") => fallback,
        set: () => {},
      },
    };
    global.fetch = async () => ({
      ok: true,
      json: async () => ({
        supportsThinking: true,
        availableLevels: ["low", "high"],
        level: "high",
      }),
    });

    await import(`../src/frontend/chat/chat-mode.ts?${Date.now()}-${Math.random()}`);
    win.App.Chat.loadModeState();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const container = win.document.createElement("div");
    win.App.Chat.mountThinkingControl(container);
    assert.deepEqual(
      [...container.querySelectorAll(".effort-dot")].map((dot) => dot.dataset.effort),
      ["low", "high"],
    );
  });
});
