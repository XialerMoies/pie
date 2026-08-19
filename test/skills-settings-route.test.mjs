import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { handleSkillSettings } = await import("../src/server/routes/settings/skills.ts");

function response() {
  return {
    status: 0,
    body: "",
    writeHead(status) { this.status = status; },
    end(value = "") { this.body += value; },
  };
}

function context(overrides = {}) {
  let refreshes = 0;
  const skill = { id: "release-check", source: "user" };
  const service = {
    list: async () => ({ skills: [skill], diagnostics: [] }),
    rescan: async () => ({ skills: [skill], diagnostics: [] }),
    trust: async () => {}, untrust: async () => {}, enable: async () => {}, disable: async () => {}, remove: async () => {},
    ...overrides,
  };
  return { ctx: { skillService: service, runtime: { refreshSystemPrompt: async () => { refreshes += 1; } } }, refreshes: () => refreshes };
}

async function request(method, url, setup = {}) {
  const res = response();
  const state = context(setup);
  const handled = await handleSkillSettings({ method, url }, res, state.ctx);
  return { handled, status: res.status, body: JSON.parse(res.body), refreshes: state.refreshes() };
}

describe("skills settings route", () => {
  it("lists without refreshing and rescans with an immediate prompt refresh", async () => {
    assert.equal((await request("GET", "/api/settings/skills")).status, 200);
    const rescanned = await request("POST", "/api/settings/skills/rescan");
    assert.equal(rescanned.status, 200);
    assert.equal(rescanned.refreshes, 1);
  });

  it("supports state actions and remove, then refreshes the prompt", async () => {
    for (const action of ["trust", "untrust", "enable", "disable"]) {
      const result = await request("POST", `/api/settings/skills/user/release-check/${action}`);
      assert.equal(result.status, 200);
      assert.equal(result.refreshes, 1);
    }
    const removed = await request("DELETE", "/api/settings/skills/user/release-check");
    assert.equal(removed.status, 200);
    assert.equal(removed.refreshes, 1);
  });

  it("returns 400 for invalid source or id and 409 for untrusted enable", async () => {
    assert.equal((await request("POST", "/api/settings/skills/global/x/trust")).status, 400);
    assert.equal((await request("POST", "/api/settings/skills/user/../trust")).status, 400);
    const conflict = await request("POST", "/api/settings/skills/user/release-check/enable", { enable: async () => { throw new Error("Skill is untrusted"); } });
    assert.equal(conflict.status, 409);
  });
});
