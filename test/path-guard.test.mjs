import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { createSessionPermissionState } from "../src/agent/permissions.ts";
import { ServerPermissionService } from "../src/server/permission-service.ts";
import { guardPathWithinRoot } from "../src/server/routes/path-guard.ts";
import { contentTypeForStaticAsset, resolveStaticAssetPath } from "../src/server/static-assets.ts";
import { processAttachments } from "../src/server/routes/attach.ts";
import { handleExplorer } from "../src/server/routes/explorer.ts";
import { makeReq, makeRes } from "./helpers/http.mjs";

function makeTempRoot(prefix) {
  return mkdtempSync(resolve(process.cwd(), `.tmp-${prefix}`));
}

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
    const parent = makeTempRoot("path-guard-inside-");
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
    const parent = makeTempRoot("path-guard-prefix-");
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
    const parent = makeTempRoot("path-guard-win-");
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
    const parent = makeTempRoot("path-guard-link-");
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

  it("serves packaged frontend assets with strict MIME-compatible content types", () => {
    assert.strictEqual(contentTypeForStaticAsset("dashboard.html"), "text/html; charset=utf-8");
    assert.strictEqual(contentTypeForStaticAsset("js/dashboard.js"), "text/javascript; charset=utf-8");
    assert.strictEqual(contentTypeForStaticAsset("assets/dashboard.css"), "text/css; charset=utf-8");
    assert.strictEqual(contentTypeForStaticAsset("assets/font.ttf"), "font/ttf");
    assert.strictEqual(contentTypeForStaticAsset("assets/font.woff2"), "font/woff2");
    assert.strictEqual(contentTypeForStaticAsset("icons/tool.svg"), "image/svg+xml");
    assert.strictEqual(contentTypeForStaticAsset("asset.bin"), "application/octet-stream");
  });

  it("rejects traversal and symlink escapes for static server assets", () => {
    const parent = makeTempRoot("path-guard-static-assets-");
    try {
      const root = resolve(parent, "frontend");
      const outside = resolve(parent, "outside");
      mkdirSync(root);
      mkdirSync(outside);

      assert.throws(
        () => resolveStaticAssetPath(root, "../outside/secret.txt"),
        /Access denied/,
      );

      try {
        symlinkSync(outside, resolve(root, "escape-link"), "junction");
      } catch {
        return;
      }
      assert.throws(
        () => resolveStaticAssetPath(root, "escape-link/secret.txt"),
        /Access denied/,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("explorer write rejects sibling-prefix traversal", async () => {
    const parent = makeTempRoot("path-guard-explorer-");
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
    const parent = makeTempRoot("path-guard-attach-");
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

  it("attachments only expand files under the requested folder", async () => {
    const parent = makeTempRoot("path-guard-attach-folder-scope-");
    try {
      const root = resolve(parent, "root");
      const sub = resolve(root, "sub");
      mkdirSync(sub, { recursive: true });
      writeFileSync(resolve(root, "root-secret.txt"), "root secret");
      writeFileSync(resolve(sub, "hello.txt"), "folder content");

      const result = await processAttachments([
        { kind: "folder", path: "sub" },
      ], root);

      assert.ok(result.blocks.some((block) => block.path === "sub/hello.txt"));
      assert.ok(result.blocks.every((block) => block.path !== "root-secret.txt"));
      assert.doesNotMatch(JSON.stringify(result.blocks), /root secret/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("attachments stop before recursively reading denied subdirectories", async () => {
    const parent = makeTempRoot("path-guard-attach-folder-deny-");
    try {
      const root = resolve(parent, "root");
      const sub = resolve(root, "sub");
      const denied = resolve(sub, "denied");
      mkdirSync(denied, { recursive: true });
      writeFileSync(resolve(sub, "allowed.txt"), "allowed content");
      writeFileSync(resolve(denied, "secret.txt"), "denied secret");
      const state = createSessionPermissionState();
      state.alwaysDenyRules.session.push({
        toolName: "Read",
        ruleContent: `Read(${denied})`,
        match: "exact",
      });
      const service = new ServerPermissionService({ sessionPermissionState: state });

      const result = await processAttachments([
        { kind: "folder", path: "sub" },
      ], root, service);

      assert.ok(result.blocks.some((block) => block.path === "sub/allowed.txt"));
      assert.doesNotMatch(JSON.stringify(result.blocks), /denied secret/);
      assert.ok(service.getAuditTrail().some((entry) => (
        entry.source === "chat.attachment.folder.dir" &&
        entry.operation === "read" &&
        entry.path === denied &&
        entry.decision === "deny"
      )));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
