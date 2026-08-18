import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServerContext } from "../src/server/server-bootstrap.ts";

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
  it("assembles all five ownership groups from one flat compatibility context", () => {
    const flat = createFlatContext();
    const context = createServerContext(flat);

    assert.strictEqual(context.groups.core.engine, flat.engine);
    assert.strictEqual(context.groups.security.permissionService, flat.permissionService);
    assert.strictEqual(context.groups.storage.paths, flat.paths);
    assert.strictEqual(context.groups.providers.customProviderService, flat.customProviderService);
    assert.strictEqual(context.groups.infra.tsServer, flat.tsServer);
  });

  it("keeps compatibility fields as views of the grouped source of truth", () => {
    const flat = createFlatContext();
    const context = createServerContext(flat);

    assert.strictEqual(context.engine, context.groups.core.engine);
    assert.strictEqual(context.runtime, context.groups.core.runtime);
    assert.strictEqual(context.paths, context.groups.storage.paths);
    assert.strictEqual(context.observability, context.groups.infra.observability);
  });
});
