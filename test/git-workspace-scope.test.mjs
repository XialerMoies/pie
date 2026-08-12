import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";

import {
  gitWorkspacePathspec,
  literalGitPathspec,
  scopeGitStatusEntries,
} from "../src/server/routes/git-core.ts";

describe("Git workspace scoping", () => {
  it("uses no pathspec at the repository root and scopes nested workspaces", () => {
    const repo = resolve("repo");
    assert.strictEqual(gitWorkspacePathspec(repo, repo), undefined);
    assert.strictEqual(
      gitWorkspacePathspec(repo, resolve(repo, "packages", "app")),
      "packages/app",
    );
  });

  it("rejects a workspace outside the discovered repository", () => {
    const repo = resolve("repo");
    assert.throws(
      () => gitWorkspacePathspec(repo, resolve("other")),
      /outside Git repository/,
    );
  });

  it("marks workspace pathspecs as literal so special directory names cannot match siblings", () => {
    assert.strictEqual(literalGitPathspec("packages/[app]*"), ":(literal)packages/[app]*");
    assert.strictEqual(literalGitPathspec(undefined), undefined);
  });

  it("returns only workspace-relative status paths for a nested workspace", () => {
    const entries = scopeGitStatusEntries([
      { x: " ", y: "M", path: "packages/app/src/a.ts" },
      { x: "?", y: "?", path: "packages/app/new.txt" },
      { x: " ", y: "M", path: "packages/other/secret.ts" },
      {
        x: "R",
        y: " ",
        path: "packages/app/old.ts",
        renamePath: "packages/app/new.ts",
      },
      {
        x: "R",
        y: " ",
        path: "packages/app/moved-out.ts",
        renamePath: "packages/other/moved-out.ts",
      },
      {
        x: "R",
        y: " ",
        path: "packages/other/moved-in.ts",
        renamePath: "packages/app/moved-in.ts",
      },
      ...(process.platform === "win32" ? [{
        x: " ",
        y: "M",
        path: "PACKAGES/APP/case.ts",
      }] : []),
    ], "packages/app");

    assert.deepStrictEqual(entries, [
      { x: " ", y: "M", path: "src/a.ts" },
      { x: "?", y: "?", path: "new.txt" },
      { x: "R", y: " ", path: "old.ts", renamePath: "new.ts" },
      { x: "R", y: " ", path: "moved-out.ts" },
      { x: "R", y: " ", path: "moved-in.ts" },
      ...(process.platform === "win32" ? [{ x: " ", y: "M", path: "case.ts" }] : []),
    ]);
  });
});
