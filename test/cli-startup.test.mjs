import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalWorkspacePath } from "../src/data/data-layout.ts";
import { resolveCliRuntimePaths } from "../src/server/cli-startup.ts";

const tempRoots = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "cli-startup-"));
  tempRoots.push(root);
  const appRoot = join(root, "app");
  const workspace = join(root, "workspace");
  const dataRoot = join(root, "data");
  mkdirSync(appRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { appRoot, workspace, dataRoot };
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe("CLI startup", () => {
  it("initializes the agent cwd and data files from the desktop environment", () => {
    const fixture = makeFixture();
    const paths = resolveCliRuntimePaths({
      appRoot: fixture.appRoot,
      argv: ["--cli"],
      env: {
        PI_WORKSPACE: fixture.workspace,
        PI_DATA_ROOT: fixture.dataRoot,
        PI_INSTANCE_ID: "terminal-cli",
      },
    });

    assert.strictEqual(paths.cwd, canonicalWorkspacePath(fixture.workspace));
    assert.strictEqual(paths.dataRoot, resolve(fixture.dataRoot));
    assert.strictEqual(paths.agentDir, join(resolve(fixture.dataRoot), "user"));
    assert.strictEqual(paths.authFile, join(resolve(fixture.dataRoot), "user", "auth.json"));
    assert.strictEqual(paths.modelsFile, join(resolve(fixture.dataRoot), "user", "models.json"));
    assert.match(paths.sessionsDir, /workspaces[\\/]\w+[\\/]sessions$/);
    assert.strictEqual(paths.sessionsDirForWorkspace(fixture.workspace), paths.sessionsDir);
  });

  it("keeps the npm CLI fallback rooted at the application", () => {
    const fixture = makeFixture();
    const paths = resolveCliRuntimePaths({ appRoot: fixture.appRoot, argv: ["--cli"], env: {} });

    assert.strictEqual(paths.cwd, canonicalWorkspacePath(fixture.appRoot));
    assert.strictEqual(paths.dataRoot, join(resolve(fixture.appRoot), "data"));
  });

  it("composes the CLI entry from resolved runtime paths instead of module-root assumptions", () => {
    const mainSource = readFileSync(resolve("src/server/main.ts"), "utf8");

    assert.match(mainSource, /resolve\(__dirname, "\.\.", "\.\."\)/);
    assert.match(mainSource, /resolveCliRuntimePaths/);
    assert.match(mainSource, /cwd:\s*CLI_PATHS\.cwd/);
    assert.match(mainSource, /agentDir:\s*CLI_PATHS\.agentDir/);
    assert.match(mainSource, /sessionsDir:\s*CLI_PATHS\.sessionsDir/);
    assert.match(mainSource, /sessionsDirForWorkspace:\s*CLI_PATHS\.sessionsDirForWorkspace/);
    assert.doesNotMatch(mainSource, /cwd:\s*APP_ROOT/);
  });
});
