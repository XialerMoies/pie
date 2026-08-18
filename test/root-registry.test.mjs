import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { createSessionPermissionState } from "../src/agent/permissions.ts";
import { ServerPermissionError, ServerPermissionService } from "../src/server/permission-service.ts";
import { RootRegistry } from "../src/server/root-registry.ts";

function tempRoot(prefix) {
  return mkdtempSync(resolve(process.cwd(), `.tmp-${prefix}`));
}

describe("root provenance registry", () => {
  it("does not turn an empty root into the process working directory", () => {
    const registry = new RootRegistry();
    assert.throws(() => registry.register("", { source: "workspace", operations: ["read"] }), /existing directory/);
    assert.strictEqual(registry.resolveRegisteredRoot(""), undefined);
  });

  it("canonicalizes and replaces the active workspace root without retaining the stale root", () => {
    const parent = tempRoot("root-registry-workspace-");
    try {
      const first = resolve(parent, "first");
      const second = resolve(parent, "second");
      mkdirSync(first);
      mkdirSync(second);

      const registry = new RootRegistry();
      registry.setWorkspaceRoot(first);
      assert.strictEqual(registry.resolveRegisteredRoot(first)?.source, "workspace");
      registry.setWorkspaceRoot(second);

      assert.strictEqual(registry.resolveRegisteredRoot(first), undefined);
      assert.strictEqual(registry.resolveRegisteredRoot(second)?.path, second);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("uses registered root provenance for mutation authorization", async () => {
    const parent = tempRoot("root-registry-permission-");
    try {
      const workspace = resolve(parent, "workspace");
      const trusted = resolve(parent, "trusted");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(trusted);
      mkdirSync(external);

      const registry = new RootRegistry();
      registry.setWorkspaceRoot(workspace);
      registry.register(trusted, {
        source: "app-data",
        operations: ["read", "write", "create", "remove"],
      });

      const service = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
        rootRegistry: registry,
      });

      const trustedPath = await service.authorizePath(trusted, "generated.json", "create", "test.registered-root");
      assert.strictEqual(trustedPath.path, resolve(trusted, "generated.json"));

      await assert.rejects(
        () => service.authorizePath(external, "generated.json", "create", "test.unregistered-root"),
        (error) => error instanceof ServerPermissionError && error.code === "confirmation_unavailable",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("allows ordinary reads from an unregistered root (low-friction read policy)", async () => {
    const parent = tempRoot("root-registry-ordinary-read-");
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);
      writeFileSync(resolve(external, "README.md"), "ordinary");

      const registry = new RootRegistry();
      registry.setWorkspaceRoot(workspace);
      const service = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
        rootRegistry: registry,
      });

      const r = await service.authorizePath(external, "README.md", "read", "test.unregistered-ordinary-read");
      assert.strictEqual(r.path, resolve(external, "README.md"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("confirms sensitive reads from an unregistered root before allowing", async () => {
    const parent = tempRoot("root-registry-sensitive-read-");
    try {
      const workspace = resolve(parent, "workspace");
      const external = resolve(parent, "external");
      mkdirSync(workspace);
      mkdirSync(external);
      writeFileSync(resolve(external, ".npmrc"), "//registry.example/:_authToken=secret");
      let confirmationCount = 0;

      const registry = new RootRegistry();
      registry.setWorkspaceRoot(workspace);
      const service = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
        rootRegistry: registry,
        confirmPermission: async () => {
          confirmationCount += 1;
          return { allow: true, scope: "session" };
        },
      });

      const r = await service.authorizePath(external, ".npmrc", "read", "test.unregistered-sensitive-read");
      assert.strictEqual(confirmationCount, 1);
      assert.strictEqual(r.path, resolve(external, ".npmrc"));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("does not let a read-only registered root silently authorize writes", async () => {
    const parent = tempRoot("root-registry-read-only-");
    try {
      const workspace = resolve(parent, "workspace");
      const readOnly = resolve(parent, "read-only");
      mkdirSync(workspace);
      mkdirSync(readOnly);

      const registry = new RootRegistry();
      registry.setWorkspaceRoot(workspace);
      registry.register(readOnly, { source: "session", operations: ["read"] });
      const service = new ServerPermissionService({
        sessionPermissionState: createSessionPermissionState(),
        workspaceRootProvider: () => workspace,
        rootRegistry: registry,
      });

      await assert.rejects(
        () => service.authorizePath(readOnly, "output.txt", "write", "test.read-only-root"),
        (error) => error instanceof ServerPermissionError && error.code === "confirmation_unavailable",
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
