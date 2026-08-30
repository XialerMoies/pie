import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

import {
  mcpStateLabel,
  normalizeMcpState,
} from "../src/frontend/pane/mcp/mcp-state.ts";

describe("MCP state boundary", () => {
  it("renders hostile server and catalog fields as text", async () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousE = globalThis.E;
    const win = new Window();
    const payload = `hostile\"><img data-mcp-xss=\"yes\" onerror=alert(1)>`;
    globalThis.window = win;
    globalThis.document = win.document;
    globalThis.E = (value) => String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
    win.App = {
      McpState: {
        normalize: normalizeMcpState,
        label: mcpStateLabel,
      },
    };

    try {
      await import(`../src/frontend/pane/mcp/mcp-views.ts?xss=${Date.now()}`);
      const html = [
        win.App.McpViews.renderServers([{
          name: payload,
          state: "connected",
          error: payload,
          tools: [payload],
          config: { transport: "stdio", command: payload, args: [payload] },
        }]),
        win.App.McpViews.renderCatalog([{
          id: payload,
          name: payload,
          description: payload,
          category: payload,
          command: payload,
          args: [payload],
          envHints: [payload],
          postInstallHint: payload,
        }]),
      ].join("");
      const host = win.document.createElement("div");
      host.innerHTML = html;

      assert.strictEqual(host.querySelector('[data-mcp-xss="yes"]'), null);
      assert.strictEqual(host.querySelector("script"), null);
      assert.ok(host.textContent.includes("<img"), "hostile MCP fields should remain visible as text");
    } finally {
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.E = previousE;
    }
  });

  it("maps unknown server states to the fixed error state", () => {
    const hostileState = 'connected"><img data-mcp-state-injected="yes">';

    assert.equal(normalizeMcpState(hostileState), "error");
    assert.equal(mcpStateLabel(hostileState), "错误");
  });

  it("preserves the four supported connection states", () => {
    for (const state of ["connected", "connecting", "disconnected", "error"]) {
      assert.equal(normalizeMcpState(state), state);
    }
  });

  it("requires the MCP pane to normalize state before HTML interpolation", () => {
    const viewSource = readFileSync(
      resolve(process.cwd(), "src/frontend/pane/mcp/mcp-views.ts"),
      "utf8",
    );
    const compilerSource = readFileSync(
      resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"),
      "utf8",
    );

    assert.match(viewSource, /mcpViewsState\.normalize\(server\.state\)/);
    assert.doesNotMatch(viewSource, /\$\{server\.state\}/);
    assert.match(
      compilerSource,
      /gen\/pane\/mcp\/mcp-state\.js[\s\S]*gen\/pane\/mcp\/mcp-views\.js[\s\S]*gen\/pane\/mcp\/index\.js/,
    );
  });

  it("does not interpolate server names into MCP action selectors or request paths", () => {
    const componentSource = readFileSync(
      resolve(process.cwd(), "src/frontend/dashboard/dashboard-layout.ts"),
      "utf8",
    );

    assert.match(componentSource, /\[data-mcp-action="\$\{action\}"\]/);
    assert.match(componentSource, /encodeURIComponent\(server\.name\)/);
    assert.doesNotMatch(
      componentSource,
      /querySelector\(`[^`]*data-name=\"\$\{E\([^)]*server\.name/,
    );
  });
});
