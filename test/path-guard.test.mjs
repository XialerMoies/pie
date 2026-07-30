import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { guardPathWithinRoot } from "../src/server/routes/path-guard.ts";
import { processAttachments } from "../src/server/routes/attach.ts";
import { handleExplorer } from "../src/server/routes/explorer.ts";
import { makeReq, makeRes } from "./helpers/http.mjs";

function mockCtx(root) {
  return {
    runtime: {},
    chatStream: { textBuffer: "", thinkingBuffer: "", response: null, currentWorkspace: root },
    sseClients: [],
    paths: {
      APP_ROOT: root,
      DATA_DIR: resolve(root, "data"),
      PI_CONFIG_DIR: resolve(root, "data", "pi"),
      SESSIONS_DIR: resolve(root, "data", "pi", "sessions"),
      SETTINGS_FILE: resolve(root, "data", "pi", "settings.json"),
      FRONTEND_DIR: resolve(root, "dist", "frontend"),
      FRONTEND_SRC_DIR: resolve(root, "src", "frontend"),
      HAS_BUILT_FRONTEND: false,
    },
  };
}

describe("server PathGuard", () => {
  it("allows paths inside the root", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "path-guard-inside-"));
    try {
      const root = resolve(parent, "root");
      mkdirSync(root);
      const guarded = guardPathWithinRoot(root, "nested/file.txt", "write");
      assert.strictEqual(guarded.path, resolve(root, "nested", "file.txt"));
      assert.strictEqual(guarded.relativePath, "nested/file.txt");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects sibling-prefix traversal", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "path-guard-prefix-"));
    try {
      const root = resolve(parent, "root");
      const sibling = resolve(parent, "root-evil");
      mkdirSync(root);
      mkdirSync(sibling);
      assert.throws(
        () => guardPathWithinRoot(root, "../root-evil/pwn.txt", "write"),
        /Access denied/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects Windows absolute and UNC escapes", () => {
    if (process.platform !== "win32") return;
    const parent = mkdtempSync(resolve(tmpdir(), "path-guard-win-"));
    try {
      const root = resolve(parent, "root");
      mkdirSync(root);
      assert.throws(
        () => guardPathWithinRoot(root, "C:\\Windows\\win.ini", "read"),
        /Access denied/,
      );
      assert.throws(
        () => guardPathWithinRoot(root, "\\\\server\\share\\evil.txt", "read"),
        /Access denied/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects symlink escape through an existing directory", () => {
    const parent = mkdtempSync(resolve(tmpdir(), "path-guard-link-"));
    try {
      const root = resolve(parent, "root");
      const outside = resolve(parent, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      try {
        symlinkSync(outside, resolve(root, "link"), "junction");
      } catch {
        return;
      }

      assert.throws(
        () => guardPathWithinRoot(root, "link/escape.txt", "write"),
        /Access denied/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("explorer write rejects sibling-prefix traversal", async () => {
    const parent = mkdtempSync(resolve(tmpdir(), "path-guard-explorer-"));
    try {
      const root = resolve(parent, "root");
      const sibling = resolve(parent, "root-evil");
      mkdirSync(root);
      mkdirSync(sibling);
      const target = resolve(sibling, "pwn.txt");

      const req = makeReq("POST", "/api/file/write", {
        root,
        path: "../root-evil/pwn.txt",
        content: "owned",
      });
      const res = makeRes();

      await handleExplorer(req, res, mockCtx(root));

      assert.strictEqual(res._status, 403);
      assert.strictEqual(existsSync(target), false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("attachments skip sibling-prefix traversal", async () => {
    const parent = mkdtempSync(resolve(tmpdir(), "path-guard-attach-"));
    try {
      const root = resolve(parent, "root");
      const sibling = resolve(parent, "root-evil");
      mkdirSync(root);
      mkdirSync(sibling);
      writeFileSync(resolve(sibling, "secret.txt"), "outside secret");

      const result = await processAttachments([
        { kind: "file", path: "../root-evil/secret.txt" },
      ], root);

      assert.strictEqual(result.blocks.length, 0);
      assert.strictEqual(readFileSync(resolve(sibling, "secret.txt"), "utf-8"), "outside secret");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
