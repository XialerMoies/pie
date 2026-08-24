import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionManager } from "@xiamol/pi-coding-agent";

import {
  AgentProfileRegistry,
  agentProfileRef,
  persistAgentProfileLifecycle,
  readAgentProfileLifecycle,
  resolveAgentProfile,
} from "../src/agent/agent-profile.ts";
import { AgentRuntime } from "../src/agent/runtime.ts";
import { handleSessions } from "../src/server/routes/sessions.ts";

function request(method, url, body) {
  const req = {
    method,
    url,
    headers: { host: "localhost", "content-type": "application/json" },
    on(event, callback) {
      if (event === "data" && body !== undefined) callback(Buffer.from(JSON.stringify(body)));
      if (event === "end") callback();
      return req;
    },
  };
  return req;
}

async function call(ctx, method, url, body) {
  const res = {
    status: 0,
    body: "",
    headers: {},
    writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); return this; },
    end(chunk) { if (chunk) this.body += String(chunk); },
  };
  const handled = await handleSessions(request(method, url, body), res, ctx);
  return { handled, status: res.status, body: JSON.parse(res.body || "null") };
}

describe("AP-06 profile lifecycle catalog and generation", () => {
  it("reports ready, broken, and unavailable without exposing broken profiles as executable", () => {
    const registry = new AgentProfileRegistry();
    registry.register({
      id: "ready-profile", revision: 1, description: "ready", toolNames: [], presentation: "native",
      promptSections: [], featureGates: [], allowMcp: false, includeSkills: false,
    });
    const broken = registry.registerBroken("broken-profile", 2, "workspace", "bad yaml");
    const unavailable = registry.markUnavailable("missing-profile", 1, "user");
    assert.equal(registry.getSnapshot("ready-profile").health, "ready");
    assert.equal(broken.health, "broken");
    assert.equal(unavailable.health, "unavailable");
    assert.throws(() => registry.require("broken-profile"), /Unknown agent profile/);
    assert.throws(() => registry.resolveRef({ id: "broken-profile", revision: 2, generation: broken.generation }), /Unavailable agent profile generation/);
  });

  it("keeps old generation resolvable while new sessions see the replacement", () => {
    const registry = new AgentProfileRegistry();
    const first = { id: "versioned", revision: 1, description: "one", toolNames: [], presentation: "native", promptSections: [], featureGates: [], allowMcp: false, includeSkills: false };
    registry.register(first);
    const firstSnapshot = registry.getSnapshot("versioned");
    const secondSnapshot = registry.replace({ ...first, description: "two", revision: 2 });
    assert.ok(secondSnapshot.generation > firstSnapshot.generation);
    assert.equal(registry.resolveRef({ id: "versioned", revision: 1, generation: firstSnapshot.generation }).profile.description, "one");
    assert.equal(registry.get("versioned").description, "two");
  });

  it("persists applied lifecycle facts through cold read", () => {
    const root = mkdtempSync(resolve(tmpdir(), "agent-profile-lifecycle-"));
    try {
      const manager = SessionManager.create(root, root);
      const profile = resolveAgentProfile("standard");
      const ref = agentProfileRef(profile);
      persistAgentProfileLifecycle(manager, {
        requested: ref,
        effective: ref,
        source: "builtin",
        action: "create",
        status: "applied",
        timestamp: new Date().toISOString(),
      });
      manager.appendMessage({ role: "assistant", content: [], timestamp: Date.now() });
      const reopened = SessionManager.open(manager.getSessionFile(), undefined, root);
      const fact = readAgentProfileLifecycle(reopened.getEntries());
      assert.equal(fact.action, "create");
      assert.deepEqual(fact.effective, ref);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("AP-06 route and runtime boundaries", () => {
  it("serves profile health catalog and blocks switching a non-empty session", async () => {
    const runtime = Object.create(AgentRuntime.prototype);
    const standard = resolveAgentProfile("standard");
    runtime._activeProfile = standard;
    runtime._activeProfileRef = agentProfileRef(standard);
    runtime._session = {
      messages: [{ role: "user", content: "already used" }],
      sessionManager: { buildSessionContext: () => ({ messages: [{ role: "user" }] }) },
      sessionFile: "",
    };
    runtime._transitionTail = Promise.resolve();
    runtime._sessionSwitching = false;
    runtime.currentWorkspace = process.cwd();
    const engine = {
      session: { id: "used", workspace: process.cwd(), profile: { id: "standard", revision: 1 } },
      async switchProfile(id) { return runtime.switchProfile(id); },
    };
    const ctx = {
      groups: {
        core: { engine, runtime, appEvents: { publish() {} } },
        storage: { paths: { APP_ROOT: process.cwd(), DATA_DIR: process.cwd(), SESSIONS_DIR: process.cwd() } },
        providers: {}, security: {},
      },
    };
    const catalog = await call(ctx, "GET", "/api/profiles");
    assert.equal(catalog.status, 200);
    assert.ok(catalog.body.profiles.some((profile) => profile.id === "standard" && profile.health === "ready"));
    assert.deepStrictEqual(catalog.body.catalogs.map((profile) => profile.id), ["fact-verification", "minimal", "standard"]);
    assert.ok(catalog.body.catalogs.every((profile) => profile.health === "ready" && profile.fingerprint.length === 64));
    const rejected = await call(ctx, "POST", "/api/sessions/profile", { profileId: "minimal" });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.error, /non-empty/);
    assert.equal(runtime._activeProfile.id, "standard");
  });

  it("serializes empty-session switch and leaves lifecycle facts attached to the assembled session", async () => {
    const runtime = Object.create(AgentRuntime.prototype);
    const standard = resolveAgentProfile("standard");
    const minimal = resolveAgentProfile("minimal");
    runtime._activeProfile = standard;
    runtime._activeProfileRef = agentProfileRef(standard);
    runtime._session = { messages: [], sessionManager: { buildSessionContext: () => ({ messages: [] }) }, sessionFile: "" };
    runtime._transitionTail = Promise.resolve();
    runtime._sessionSwitching = false;
    runtime.currentWorkspace = process.cwd();
    runtime._replaceSessionWithRollback = async (...args) => {
      const replacement = args[5];
      runtime._activeProfile = replacement;
      runtime._activeProfileRef = agentProfileRef(replacement);
      runtime._activeProfileLifecycle = { requested: runtime._activeProfileRef, effective: runtime._activeProfileRef, source: "builtin", action: "switch", status: "applied", timestamp: new Date().toISOString() };
    };
    const [first, second] = await Promise.all([runtime.switchProfile("minimal"), runtime.switchProfile("standard")]);
    assert.deepEqual(first, { id: "minimal", revision: 1 });
    assert.deepEqual(second, { id: "standard", revision: 1 });
    assert.equal(runtime._activeProfile.id, "standard");
    assert.equal(runtime._activeProfileLifecycle.action, "switch");
  });
});
