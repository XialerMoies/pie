# Trusted Skills MVP Implementation Plan

> For agentic workers: use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

Goal: Add a local, manually trusted and enabled SKILL.md system with workspace and user scopes, runtime-only skill summaries, on-demand body loading, and no new tool or permission surface.

Architecture: Keep the committed Task 0 capability catalog deterministic. Add a small runtime SkillCatalog/SkillService that scans PI_USER_CONFIG/skills/skill-id/SKILL.md and workspace-root/agent/skills/skill-id/SKILL.md, merges workspace-over-user precedence, and combines file facts with a locked user state file. Inject only summaries by default and enabled skill bodies on demand through the existing AgentRuntime prompt refresh path. Expose the service through focused settings routes and a small Settings tab; all mutations remain server-side and fail closed.

Tech Stack: TypeScript, Node fs/promises, existing locked-json-store, Node test runner via scripts/tsx-test.mjs, existing global frontend TypeScript bundle and settings modal.

---

## File map and ownership

- Create src/agent/skills/types.ts for stable summary, parse result, state, diagnostic, and operation result types.
- Create src/agent/skills/skill-parser.ts for constrained frontmatter/body parsing; never execute content.
- Create src/agent/skills/skill-scanner.ts for safe direct-child scanning of user and workspace roots.
- Create src/agent/skills/skill-state-store.ts for locked, backed-up trust/enabled state persistence.
- Create src/agent/skills/skill-service.ts for merge, precedence, mutation, deletion, validation, and on-demand loading.
- Create src/agent/skills/skill-prompt.ts for deterministic summary/body prompt formatting with no raw state or absolute paths.
- Modify scripts/generate-capability-catalog.mjs to emit a static skills contract and never scan user/runtime skill files.
- Modify test/capability-catalog.test.mjs to assert the static skills contract remains deterministic.
- Create test/skills-parser.test.mjs, test/skills-scanner.test.mjs, test/skills-state-store.test.mjs, test/skills-service.test.mjs, and test/skills-prompt.test.mjs.
- Modify src/agent/runtime.ts to accept a SkillService and rebuild the skill prompt for session creation and refresh.
- Modify src/server/routes/types.ts, src/server/routes/settings.ts, and create src/server/routes/settings/skills.ts for the minimal server contract.
- Modify src/server/server.ts to construct one SkillService per server context with the active user config and workspace resolver.
- Modify src/frontend/dashboard/dashboard-settings.ts, src/frontend/dashboard.d.ts, and create src/frontend/dashboard/settings-skills.ts for the Skills settings tab and typed client facade.
- Modify src/frontend/dashboard.css for only the list/status/action styles required by the tab.
- Modify package.json test wiring and docs/任务清单.md only after implementation and gates pass.

## Task 1: Add parser and stable skill contracts

Files:
- Create src/agent/skills/types.ts
- Create src/agent/skills/skill-parser.ts
- Test test/skills-parser.test.mjs

- [ ] Step 1: Write failing parser tests

Use this exact valid document and failure matrix:

    const valid = '---\nname: release-check\ndescription: Run release checks\ntools:\n  - command\n  - file-read\n---\n\n# Release\n\nRun the checks.';
    it('parses minimal frontmatter and keeps body separate', () => {
      assert.deepStrictEqual(parseSkillDocument(valid, 'release-check', new Set(['command', 'file-read'])), {
        ok: true,
        skill: { id: 'release-check', name: 'release-check', description: 'Run release checks', declaredTools: ['command', 'file-read'], body: '# Release\n\nRun the checks.' },
      });
    });

Test invalid_frontmatter, name_mismatch, empty_description, unknown_tool, duplicate fields, empty tools items, and empty body.

- [ ] Step 2: Run focused test and confirm red

Run: node scripts/tsx-test.mjs --test test/skills-parser.test.mjs
Expected: FAIL because the parser module and exported contracts do not exist.

- [ ] Step 3: Implement minimal parser

Define SkillParseFailure as the listed diagnostic codes and ParsedSkill with id, name, description, declaredTools, and body. Parse only a document whose first non-empty line is the frontmatter marker, find the next marker, accept name, description, and a flat tools list, reject duplicate or malformed values, trim the body, and reject empty body. Validate name equals skillId and every declared tool against the supplied ToolRegistry name set. Do not parse or execute arbitrary YAML.

- [ ] Step 4: Verify parser

Run: node scripts/tsx-test.mjs --test test/skills-parser.test.mjs and npm run typecheck
Expected: parser tests pass and typecheck exits 0.

- [ ] Step 5: Commit

    git add src/agent/skills/types.ts src/agent/skills/skill-parser.ts test/skills-parser.test.mjs
    git commit -m 'feat: add trusted skill document parser'

## Task 2: Scan safe roots and define static catalog contract

Files:
- Create src/agent/skills/skill-scanner.ts
- Modify scripts/generate-capability-catalog.mjs
- Modify test/capability-catalog.test.mjs
- Test test/skills-scanner.test.mjs

- [ ] Step 1: Write failing scanner and catalog tests

Use temporary user/workspace roots. Assert direct child scanning returns source, id, relativePath, parse status, and fingerprint, while nested directories, symlinked skill directories, and files outside the root are ignored or diagnosed. Assert workspace skill with the same id is selected over user skill.

Extend the capability catalog test with:

    assert.deepStrictEqual(first.skills, {
      schemaVersion: 1,
      runtimeSource: 'src/agent/skills/skill-service.ts',
      roots: ['<PI_USER_CONFIG>/skills', '<workspace-root>/agent/skills'],
      summaryFields: ['id', 'name', 'description', 'source', 'path', 'trust', 'enabled', 'parse', 'declaredTools'],
    });

- [ ] Step 2: Run tests and confirm red

Run: node scripts/tsx-test.mjs --test test/skills-scanner.test.mjs test/capability-catalog.test.mjs
Expected: FAIL because scanner and static contract changes are absent.

- [ ] Step 3: Implement direct-child scanning

Resolve both roots from absolute paths, enumerate direct child directories only, require a regular SKILL.md, reject symlinked skill directories/files and paths escaping the root, parse each file with the parser, and return source plus repository-relative path metadata. Missing roots return an empty list; malformed entries return diagnostics instead of aborting the whole scan. Sort by source then id using direct code-unit comparison.

- [ ] Step 4: Keep Task 0 deterministic

Change generator skills from the empty pending array to the static contract above and set sources.skills to src/agent/skills/skill-service.ts. Do not import the scanner or read PI_USER_CONFIG. Update tests to assert two serializations are equal and the output contains no SKILL.md body text.

- [ ] Step 5: Verify and commit

Run: node scripts/tsx-test.mjs --test test/skills-scanner.test.mjs test/capability-catalog.test.mjs; npm run capabilities:generate; npm run capabilities:check

    git add src/agent/skills/skill-scanner.ts scripts/generate-capability-catalog.mjs test/skills-scanner.test.mjs test/capability-catalog.test.mjs
    git add -f docs/generated/capability-catalog.json
    git commit -m 'feat: add safe skill roots and static catalog contract'

## Task 3: Persist trust and enabled state fail closed

Files:
- Create src/agent/skills/skill-state-store.ts
- Test test/skills-state-store.test.mjs

- [ ] Step 1: Write failing state tests

Cover missing state, valid state, malformed JSON, invalid records, backup recovery, and concurrent updates. The core assertions are:

    assert.deepStrictEqual(await store.read(), { records: {}, diagnostics: [] });
    await store.set('workspace', 'release-check', { trust: 'trusted', enabled: true, fingerprint: 'abc' });
    assert.deepStrictEqual((await store.read()).records['workspace:release-check'], { trust: 'trusted', enabled: true, fingerprint: 'abc' });
    await writeFile(statePath, '{broken', 'utf8');
    assert.equal((await store.read()).failClosed, true);

- [ ] Step 2: Run and confirm red

Run: node scripts/tsx-test.mjs --test test/skills-state-store.test.mjs
Expected: FAIL because the state store does not exist.

- [ ] Step 3: Implement locked state store

Use readLockedJson and updateLockedJson from src/data/locked-json-store.ts. Validate the top-level shape, ignore unknown fields, use workspace:id and user:id keys, and return failClosed true with all records treated as untrusted/disabled when JSON or record shape is invalid. Store only trust, enabled, fingerprint, and confirmation timestamp. Never store skill body text or arbitrary paths.

- [ ] Step 4: Verify and commit

Run: node scripts/tsx-test.mjs --test test/skills-state-store.test.mjs test/backup-store.test.mjs test/file-lock.test.mjs

    git add src/agent/skills/skill-state-store.ts test/skills-state-store.test.mjs
    git commit -m 'feat: persist trusted skill state fail closed'

## Task 4: Build SkillService facade

Files:
- Create src/agent/skills/skill-service.ts
- Test test/skills-service.test.mjs

- [ ] Step 1: Write failing service tests

Test list, rescan, trust, untrust, enable, disable, remove, and load with temporary roots and a fake ToolRegistry name set:

    const listed = await service.list();
    assert.equal(listed.skills.find(skill => skill.id === 'release-check').enabled, false);
    await assert.rejects(() => service.enable('user', 'release-check'), /untrusted/);
    await service.trust('user', 'release-check');
    await service.enable('user', 'release-check');
    assert.equal((await service.load('user', 'release-check')).body.includes('Release'), true);
    await service.disable('user', 'release-check');
    assert.equal((await service.load('user', 'release-check')).ok, false);

Also test workspace-over-user precedence, content fingerprint changes, invalid tools, path traversal ids, remove scope, and fail-closed state.

- [ ] Step 2: Run and confirm red

Run: node scripts/tsx-test.mjs --test test/skills-service.test.mjs
Expected: FAIL because the service facade does not exist.

- [ ] Step 3: Implement one service boundary

Expose list, rescan, trust, untrust, enable, disable, remove, and load. list scans, merges workspace over user, overlays state, checks declared tools, and returns one effective summary per id plus diagnostics. trust records the current fingerprint only for a valid skill. enable requires trusted, valid, unchanged content and known tools. load repeats these checks and returns either body or structured failure. remove resolves only the selected source/id under its configured root and refuses arbitrary paths. No operation accepts an absolute path.

- [ ] Step 4: Verify and commit

Run: node scripts/tsx-test.mjs --test test/skills-service.test.mjs test/path-guard.test.mjs test/shared-store-locking.test.mjs

    git add src/agent/skills/skill-service.ts test/skills-service.test.mjs
    git commit -m 'feat: add trusted skill service facade'

## Task 5: Inject summaries and enabled bodies into AgentRuntime

Files:
- Create src/agent/skills/skill-prompt.ts
- Modify src/agent/runtime.ts
- Test test/skills-prompt.test.mjs

- [ ] Step 1: Write failing prompt tests

Assert summaries never include body text and only trusted/enabled unchanged skills contribute body sections:

    const prompt = formatSkillPrompt({ summaries: [summary('disabled', false), summary('enabled', true)], bodies: new Map([['enabled', '# Enabled body']]) });
    assert.match(prompt, /enabled/);
    assert.doesNotMatch(prompt, /disabled body/);
    assert.match(prompt, /# Enabled body/);

- [ ] Step 2: Run and confirm red

Run: node scripts/tsx-test.mjs --test test/skills-prompt.test.mjs
Expected: FAIL because the prompt formatter does not exist.

- [ ] Step 3: Implement prompt formatting and runtime wiring

Add an optional SkillService dependency to RuntimeConfig with a no-op default. During _initSession(cwd), call the service for the current workspace, build a prompt containing summaries and only eligible bodies, then append it alongside resolveSystemPrompt(). Update refreshSystemPrompt() to asynchronously rebuild the same combined prompt after trust, enable, disable, or remove operations. Keep the existing session/tool permission path unchanged.

- [ ] Step 4: Verify and commit

Run: node scripts/tsx-test.mjs --test test/skills-prompt.test.mjs test/subagent-session-factory.test.mjs test/chat-runtime-store.test.mjs; npm run typecheck

    git add src/agent/skills/skill-prompt.ts src/agent/runtime.ts test/skills-prompt.test.mjs
    git commit -m 'feat: load trusted skills on demand in runtime prompts'

## Task 6: Add server settings contract and refresh behavior

Files:
- Modify src/server/routes/types.ts
- Modify src/server/routes/settings.ts
- Create src/server/routes/settings/skills.ts
- Modify src/server/server.ts
- Test test/skills-settings-route.test.mjs

- [ ] Step 1: Write failing route tests

Cover GET /api/settings/skills, POST /api/settings/skills/rescan, POST /api/settings/skills/:source/:id/trust, untrust, enable, disable, and DELETE for remove. Assert invalid ids/sources return 400, untrusted enable returns 409, and successful mutations call runtime.refreshSystemPrompt().

- [ ] Step 2: Run and confirm red

Run: node scripts/tsx-test.mjs --test test/skills-settings-route.test.mjs
Expected: FAIL because route and server SkillService wiring do not exist.

- [ ] Step 3: Implement thin route adapter

Construct SkillService once in the server context with the active PI user config, current workspace resolver, and ToolRegistry names. Route handlers parse JSON with existing parseBody, pass only validated source/id values, return structured ok/skills/diagnostics payloads, and call ctx.runtime.refreshSystemPrompt() after successful state or deletion mutations. Do not expose absolute paths or skill bodies from list routes.

- [ ] Step 4: Verify and commit

Run: node scripts/tsx-test.mjs --test test/skills-settings-route.test.mjs test/settings-route-structure.test.mjs test/server-event-router-structure.test.mjs; npm run typecheck

    git add src/server/routes/types.ts src/server/routes/settings.ts src/server/routes/settings/skills.ts src/server/server.ts test/skills-settings-route.test.mjs
    git commit -m 'feat: expose trusted skills settings routes'

## Task 7: Add minimal Settings Skills tab

Files:
- Create src/frontend/dashboard/settings-skills.ts
- Modify src/frontend/dashboard/dashboard-settings.ts
- Modify src/frontend/dashboard.d.ts
- Modify src/frontend/dashboard.css
- Test test/settings-skills-frontend.test.mjs

- [ ] Step 1: Write failing frontend contract tests

Assert the tab is registered, uses only the skills routes, displays source/trust/enabled/diagnostic state, has actions for trust, untrust, enable, disable, remove, and rescan, and never embeds body text or absolute paths in list HTML.

- [ ] Step 2: Run and confirm red

Run: node scripts/tsx-test.mjs --test test/settings-skills-frontend.test.mjs
Expected: FAIL because the tab and frontend facade do not exist.

- [ ] Step 3: Implement small tab

Add one sidebar item labeled 技能. Render a list grouped by source with status badges and concise diagnostics. Require a second click/confirmation for remove, disable invalid operations in the UI, and refresh after each mutation. Keep the tab free of file writes, absolute-path inputs, prompt-body rendering, and direct global state projections.

- [ ] Step 4: Verify and commit

Run: node scripts/tsx-test.mjs --test test/settings-skills-frontend.test.mjs test/settings-dom-boundary.test.mjs test/frontend-state-ownership.test.mjs; npm run typecheck

    git add src/frontend/dashboard/settings-skills.ts src/frontend/dashboard/dashboard-settings.ts src/frontend/dashboard.d.ts src/frontend/dashboard.css test/settings-skills-frontend.test.mjs
    git commit -m 'feat: add skills settings tab'

## Task 8: Wire release gates, update task status, and verify scope

Files:
- Modify package.json
- Modify docs/任务清单.md
- Modify the focused capability test only for final wiring assertions.

- [ ] Step 1: Add focused tests to unit suite

Add all new parser, scanner, state, service, prompt, route, and frontend tests to test:unit. Assert capabilities:check remains in the unit suite and the static catalog does not read either runtime skill root.

- [ ] Step 2: Mark Task 1 complete without installed-skill counts

Replace the Task 1 pending block with a concise record naming SkillService and the two supported roots. Do not record the number of installed skills.

- [ ] Step 3: Run complete verification

    node scripts/tsx-test.mjs --test test/skills-parser.test.mjs test/skills-scanner.test.mjs test/skills-state-store.test.mjs test/skills-service.test.mjs test/skills-prompt.test.mjs test/skills-settings-route.test.mjs test/settings-skills-frontend.test.mjs
    npm run capabilities:generate
    npm run capabilities:check
    npm run typecheck
    npm test
    npm run release:check
    git diff --check

Expected: every command exits 0; capabilities:generate output is unchanged by user/workspace test fixtures; no skill body appears in static catalog.

- [ ] Step 4: Review prohibited scope

    rg -n 'fetch\(|https?://|git clone|npm install|child_process|process\.env|typescript\.createSourceFile|ts-morph|plugin|marketplace|generate.*skill|SKILL\.md.*write' src/agent/skills src/server/routes/settings/skills.ts src/frontend/dashboard/settings-skills.ts scripts/generate-capability-catalog.mjs

Expected: no network installation, skill generation, AST platform, subprocess, environment governance, or plugin runtime appears in new skill code.

- [ ] Step 5: Commit completed Task 1

    git add package.json docs/任务清单.md
    git commit -m 'feat: complete trusted skills mvp'

## Final handoff

After all tasks and verification pass, use finishing-a-development-branch. Keep implementation on codex/task1-trusted-skills until the user chooses merge, PR, keep, or discard.
