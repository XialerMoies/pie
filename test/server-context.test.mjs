import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const source = (file) => readFileSync(resolve(ROOT, file), "utf8");

describe("server context boundaries", () => {
  it("requires the five grouped ownership contexts", () => {
    const contextTypes = source("src/server/server-context.ts");
    const routeTypes = source("src/server/routes/types.ts");

    for (const group of ["core", "security", "storage", "providers", "infra"]) {
      assert.match(contextTypes, new RegExp(`\\b${group}: Server[A-Za-z]+Context;`));
    }
    assert.match(routeTypes, /groups: ServerContextGroups;/);
    assert.doesNotMatch(routeTypes, /groups\?: ServerContextGroups;/);
  });

  it("keeps HTTP dispatch, static serving, and process lifecycle outside server.ts", () => {
    const server = source("src/server/server.ts");

    assert.doesNotMatch(server, /dispatchRoute\(/);
    assert.doesNotMatch(server, /resolveStaticAssetPath\(/);
    assert.doesNotMatch(server, /createRequestContext\(/);
    assert.doesNotMatch(server, /process\.once\("SIG(?:INT|TERM)"/);
    assert.doesNotMatch(server, /process\.stdin\.on\("data"/);
    assert.doesNotMatch(server, /const closeInstanceStreams\s*=/);
  });

  it("prevents routes from importing the server entrypoint", () => {
    for (const file of [
      "src/server/routes/chat.ts",
      "src/server/routes/dashboard.ts",
      "src/server/routes/sessions.ts",
      "src/server/routes/settings/models.ts",
    ]) {
      assert.doesNotMatch(source(file), /from\s+["'][^"']*server\.js["']/i, file);
    }
  });

  it("requires explicit engine injection and does not construct PI adapters in routes", () => {
    const routeTypes = source("src/server/routes/types.ts");
    assert.doesNotMatch(routeTypes, /new\s+PiAgentEngineAdapter/);
    assert.doesNotMatch(routeTypes, /legacyEngines/);
    assert.match(routeTypes, /return ctx\.groups\.core\.engine/);
    assert.doesNotMatch(routeTypes, /ctx\.engine/);
    assert.doesNotMatch(routeTypes, /groups\?\./);
  });

  it("keeps the grouped contract at every server route boundary", () => {
    for (const file of [
      "src/server/http-app.ts",
      "src/server/agent-event-router.ts",
      "src/server/routes/chat.ts",
      "src/server/routes/dashboard.ts",
      "src/server/routes/permissions.ts",
      "src/server/routes/settings/skills.ts",
      "src/server/routes/typescript.ts",
    ]) {
      const text = source(file);
      assert.doesNotMatch(text, /ctx\.(runtime|paths|appEvents|permissionService|permissionMode|workspaceLock|providerReferenceLock|skillService|tsServer|observability|security)\b/, file);
      assert.doesNotMatch(text, /ctx\?\.(runtime|paths|appEvents|permissionService|permissionMode|workspaceLock|providerReferenceLock|skillService|tsServer|observability|security)\b/, file);
    }
  });
});
