import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServerContext } from "../src/server/server-bootstrap.ts";
import { authorizeRoutePath } from "../src/server/permission-service.ts";

function createFlatContext() {
  return {
    engine: { id: "engine" },
    runtime: { id: "runtime" },
    chatStream: { turnId: "" },
    appEvents: { revision: () => 0 },
    security: { token: "secret" },
    permissionService: { id: "permissions" },
    rootRegistry: { id: "roots" },
    permissionMode: { get: () => "standard" },
    workspaceLock: { id: "lock" },
    customProviderService: { id: "providers" },
    providerReferenceLock: { id: "provider-lock" },
    tsServer: { id: "tsserver" },
    observability: { id: "observability" },
    paths: {
      APP_ROOT: "app",
      DATA_DIR: "data",
      PI_CONFIG_DIR: "config",
      SESSIONS_DIR: "sessions",
      SETTINGS_FILE: "settings.json",
      FRONTEND_DIR: "dist/frontend",
      FRONTEND_SRC_DIR: "src/frontend",
      HAS_BUILT_FRONTEND: false,
    },
  };
}

describe("createServerContext", () => {
  it("assembles all five ownership groups from startup dependencies", () => {
    const flat = createFlatContext();
    const context = createServerContext(flat);

    assert.strictEqual(context.groups.core.engine, flat.engine);
    assert.strictEqual(context.groups.security.permissionService, flat.permissionService);
    assert.strictEqual(context.groups.storage.paths, flat.paths);
    assert.strictEqual(context.groups.providers.customProviderService, flat.customProviderService);
    assert.strictEqual(context.groups.infra.tsServer, flat.tsServer);
  });

  it("returns a grouped-only route context without flat compatibility getters", () => {
    const flat = createFlatContext();
    const context = createServerContext(flat);

    assert.deepEqual(Object.keys(context), ["groups"]);
    for (const field of ["engine", "runtime", "chatStream", "appEvents", "security", "permissionService", "paths", "observability"]) {
      assert.equal(Object.prototype.hasOwnProperty.call(context, field), false, field);
    }
  });

  it("carries grouped security dependencies through the real route authorization boundary", async () => {
    const flat = createFlatContext();
    const calls = [];
    flat.rootRegistry = { resolveRegisteredRoot: () => ({ path: "workspace" }) };
    flat.permissionService = {
      authorizePath(root, target, operation, source, options) {
        calls.push({ root, target, operation, source, options });
        return Promise.resolve({ path: "workspace/" + target });
      },
    };

    const context = createServerContext(flat);
    const result = await authorizeRoutePath(context, "workspace", "file.txt", "read", "test.route");

    assert.equal(result.path, "workspace/file.txt");
    assert.deepEqual(calls, [{
      root: "workspace",
      target: "file.txt",
      operation: "read",
      source: "test.route",
      options: { internalToolRequest: undefined },
    }]);
  });
});
