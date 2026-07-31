import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

describe("chat mode server-state boundary", () => {
  it("keeps unknown thinking levels out of the mode popup DOM", async () => {
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

    const button = win.document.createElement("button");
    win.document.body.appendChild(button);
    win.App.Chat.showModePopup(button);

    const popup = win.document.getElementById("mode-popup");
    assert.ok(popup);
    assert.equal(popup.querySelector("[data-thinking-level-injected]"), null);
    assert.deepEqual(
      [...popup.querySelectorAll(".effort-dot")].map((dot) => dot.dataset.effort),
      ["low", "high"],
    );
  });
});
