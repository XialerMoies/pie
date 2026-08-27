import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window();
global.window = win;
global.document = win.document;
global.self = win;
global.$ = (id) => document.getElementById(id);
global.E = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll("'", "&#39;");
global.ExplorerService = {
  iconFor: () => '<span class="file-icon"></span>',
  getWorkspacePath: () => "",
};
win.App = { Chat: {}, UI: { openFileTab() {} } };

before(async () => {
  await import("../src/frontend/chat/chat-attachments.ts");
});

beforeEach(() => {
  document.body.innerHTML = '<div id="fi-attach-bar"></div>';
  win.App.Chat.clearAttachments();
  delete global.__attachmentInjected;
});

describe("chat attachment DOM boundary", () => {
  it("renders hostile attachment ids as data and removes them without inline handlers", () => {
    const hostileId = 'bad" onmouseover="globalThis.__attachmentInjected=true';
    win.App.Chat.getPendingAttachments().push({
      id: hostileId,
      kind: "file",
      path: "src/example.ts",
      name: "example.ts",
    });

    win.App.Chat.addAttachment({ kind: "file", path: "src/safe.ts", name: "safe.ts" });

    const pills = [...document.querySelectorAll(".fi-attach-pill")];
    const hostilePill = pills.find((pill) => pill.dataset.attachId === hostileId);
    assert.ok(hostilePill, "attachment id should remain inert data");
    const deleteButton = hostilePill.querySelector(".fi-attach-del");
    assert.ok(deleteButton);
    assert.strictEqual(deleteButton.hasAttribute("onclick"), false);

    deleteButton.click();

    assert.strictEqual(global.__attachmentInjected, undefined);
    assert.strictEqual(win.App.Chat.getPendingAttachments().some((item) => item.id === hostileId), false);
  });
});
