import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  mcpStateLabel,
  normalizeMcpState,
} from "../src/frontend/pane/mcp/mcp-state.ts";

describe("MCP state boundary", () => {
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
    const paneSource = readFileSync(
      resolve(process.cwd(), "src/frontend/pane/mcp/index.ts"),
      "utf8",
    );
    const compilerSource = readFileSync(
      resolve(process.cwd(), "scripts/compile-frontend-ts.mjs"),
      "utf8",
    );

    assert.match(paneSource, /App\.McpState\.normalize\(s\.state\)/);
    assert.doesNotMatch(paneSource, /\$\{s\.state\}/);
    assert.match(
      compilerSource,
      /gen\/pane\/mcp\/mcp-state\.js[\s\S]*gen\/pane\/mcp\/index\.js/,
    );
  });

  it("does not interpolate server names into trust-result selectors", () => {
    const paneSource = readFileSync(
      resolve(process.cwd(), "src/frontend/pane/mcp/index.ts"),
      "utf8",
    );

    assert.match(paneSource, /btnEl\.closest\("\.mcp-server"\)/);
    assert.doesNotMatch(
      paneSource,
      /querySelector\(`[^`]*data-name=\"\$\{E\(name\)\}/,
    );
  });
});
