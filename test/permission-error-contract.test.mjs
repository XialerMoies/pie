import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  ServerPermissionError,
  writeServerPermissionError,
} from "../src/server/permission-service.ts";
import {
  guardPathWithinRoot,
  writePathGuardError,
} from "../src/server/routes/path-guard.ts";
import { makeRes } from "./helpers/http.mjs";

function responseJson(res) {
  return JSON.parse(res._body);
}

describe("permission failure envelope", () => {
  it("normalizes a rule denial with a workspace-relative target and recovery action", () => {
    const workspace = resolve("E:/workspace/project");
    const error = new ServerPermissionError("Denied by project rule", 403, "permission_denied", {
      operation: "write",
      target: resolve(workspace, "src/app.ts"),
      workspaceRoot: workspace,
    });
    const res = makeRes();

    assert.equal(writeServerPermissionError(res, {}, error), true);
    assert.deepEqual(responseJson(res).failure, {
      code: "permission_denied",
      category: "permission",
      decision: "deny",
      message: "权限规则拒绝了此操作。",
      reason: "Denied by project rule",
      operation: "write",
      target: "src/app.ts",
      recoverable: true,
      suggestions: [{ action: "open_permissions", label: "查看权限设置" }],
    });
  });

  it("distinguishes an unavailable confirmation channel from a required confirmation", () => {
    const unavailable = new ServerPermissionError(
      "Permission confirmation is unavailable",
      403,
      "confirmation_unavailable",
      { operation: "execute" },
    );
    const required = new ServerPermissionError(
      "Permission confirmation is required",
      403,
      "permission_confirmation_required",
      { operation: "read", target: "secrets.env" },
    );
    const unavailableRes = makeRes();
    const requiredRes = makeRes();

    writeServerPermissionError(unavailableRes, {}, unavailable);
    writeServerPermissionError(requiredRes, {}, required);

    assert.deepEqual(responseJson(unavailableRes).failure.suggestions, [
      { action: "reconnect", label: "重新连接" },
      { action: "retry", label: "重试操作" },
    ]);
    assert.equal(responseJson(unavailableRes).failure.message, "权限确认通道不可用，操作已安全拒绝。");
    assert.equal(responseJson(requiredRes).failure.decision, "ask");
    assert.equal(responseJson(requiredRes).failure.message, "此操作需要你的确认。");
  });

  it("marks dangerous operations as non-recoverable and exposes no bypass action", () => {
    const error = new ServerPermissionError("Recursive system deletion", 403, "dangerous", {
      operation: "execute",
      target: "rm -rf /",
    });
    const res = makeRes();

    writeServerPermissionError(res, {}, error);

    const failure = responseJson(res).failure;
    assert.equal(failure.category, "safety");
    assert.equal(failure.message, "安全策略已阻止高风险操作。");
    assert.equal(failure.target, "高风险命令");
    assert.equal(failure.recoverable, false);
    assert.deepEqual(failure.suggestions, []);
  });

  it("normalizes path traversal without exposing an absolute external path", () => {
    const root = mkdtempSync(resolve(tmpdir(), "permission-envelope-"));
    try {
      let thrown;
      try {
        guardPathWithinRoot(root, resolve(dirname(root), "private", "secret.txt"), "read");
      } catch (error) {
        thrown = error;
      }
      const res = makeRes();
      assert.equal(writePathGuardError(res, {}, thrown), true);
      const failure = responseJson(res).failure;
      assert.equal(failure.category, "path");
      assert.equal(failure.message, "目标路径不在允许范围内。");
      assert.equal(failure.recoverable, false);
      assert.equal(failure.target, "secret.txt");
      assert.equal(failure.target.includes(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
