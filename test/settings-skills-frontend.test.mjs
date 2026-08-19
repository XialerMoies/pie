import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync("src/frontend/dashboard/dashboard-settings.ts", "utf8");
const skills = readFileSync("src/frontend/dashboard/settings-skills.ts", "utf8");
const compiler = readFileSync("scripts/compile-frontend-ts.mjs", "utf8");

describe("skills settings frontend contract", () => {
  it("registers the Chinese skills tab before the settings facade", () => {
    assert.match(shell, /data-st="skills">技能</);
    assert.ok(compiler.indexOf('"gen/dashboard/settings-skills.js"') < compiler.indexOf('"gen/dashboard/dashboard-settings.js"'));
  });

  it("uses only summary management routes and offers all MVP actions", () => {
    assert.match(skills, /\/api\/settings\/skills/);
    for (const action of ["trust", "untrust", "enable", "disable", "remove", "rescan"]) assert.match(skills, new RegExp(`['\"]${action}['\"]`));
    assert.doesNotMatch(skills, /\.body\b|SKILL\.md.*write|absolutePath/);
  });

  it("renders dynamic fields as text and requires a second remove action", () => {
    assert.match(skills, /textContent = skill\.name/);
    assert.match(skills, /this\.removeArmed !== key/);
    assert.doesNotMatch(skills, /innerHTML\s*=.*skill\./);
  });

  it("groups installed skills by workspace and user source", () => {
    assert.match(skills, /renderGroup\(['"]workspace['"],\s*['"]工作区技能['"]/);
    assert.match(skills, /renderGroup\(['"]user['"],\s*['"]应用技能['"]/);
  });
});
