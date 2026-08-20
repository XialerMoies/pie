# Scoped Memory Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move long-lived memory to user/workspace roots aligned with skills, add explicit scope and minimal management, and keep prompt injection index-only.

**Architecture:** Add a small filesystem-backed memory store module responsible for root selection, metadata/index rebuilding, and legacy migration. Extend the existing tool context/runtime extra context so memory tools receive host-owned roots; keep `read_memory` and `write_memory` compatible while registering list/delete/enable operations. Prompt code reads merged indexes for the active runtime workspace and never reads memory bodies.

**Tech Stack:** TypeScript ESM, Node `fs`/`path`, existing `defineAgentTool`, `authorizeToolPath`, Node test runner via the repository's existing `.mjs` tests.

---

### Task 1: Define host-owned memory roots and pure store primitives

**Files:**
- Create: `src/agent/memory-store.ts`
- Modify: `src/agent/types.ts:292-335`
- Modify: `src/agent/runtime.ts:22-95`
- Modify: `src/agent/tools/index.ts:40-85`
- Modify: `src/server/server.ts:245-265`
- Modify: `src/server/main.ts:28-42`
- Test: `test/agent-memory.test.mjs`

- [ ] **Step 1: Write failing root and metadata tests**

Add tests for `resolveMemoryRoot({ scope: "user", userMemoryRoot, workspace })`, workspace root resolution, rejection without workspace, and metadata/index reconstruction from Markdown files.

- [ ] **Step 2: Run the focused test and verify the expected missing-export failure**

Run: `node --import tsx --test test/agent-memory.test.mjs`
Expected: FAIL because `src/agent/memory-store.ts` and the new root resolver do not yet exist.

- [ ] **Step 3: Implement the minimal store and context fields**

Add host-only context fields and pass them from both desktop and CLI entrypoints:

```ts
userMemoryRoot?: string
workspaceMemoryRoot?: string
```

Add `resolveMemoryRoot` and `MemoryScope` in `memory-store.ts`. Require absolute roots, use `<workspace>/agent/memory` when only `workspace` is available, and reject `workspace` scope with no workspace. Add JSON metadata read/rebuild helpers and deterministic `MEMORY.md` rendering. Thread the fields through `RuntimeConfig`, `buildToolContextExtra`, `RuntimeToolExtraContext`, and `ExtraCtx`; `server.ts` passes `join(PI_CONFIG_DIR, "memory")` and `main.ts` passes `join(CLI_PATHS.agentDir, "memory")`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `node --import tsx --test test/agent-memory.test.mjs` and `npm run typecheck`.
Expected: new root/index tests PASS and typecheck PASS.

- [ ] **Step 5: Commit the primitives**

```powershell
git add src/agent/memory-store.ts src/agent/types.ts src/agent/runtime.ts src/agent/tools/index.ts test/agent-memory.test.mjs
git commit -m "feat: add scoped memory roots"
```

### Task 2: Migrate existing memory tools and add management operations

**Files:**
- Modify: `src/agent/tools/memory.ts`
- Modify: `src/agent/tools/index.ts`
- Test: `test/agent-memory.test.mjs`

- [ ] **Step 1: Write failing scoped-tool tests**

Cover default `user`, explicit `workspace`, same-name files in both scopes, `list_memory`, `delete_memory`, `set_memory_enabled`, path traversal rejection, and no-workspace rejection.

- [ ] **Step 2: Run focused tests and verify failures**

Run: `node --import tsx --test test/agent-memory.test.mjs`
Expected: FAIL on scope routing and missing management tools.

- [ ] **Step 3: Implement minimal scoped tools**

Refactor `memory.ts` to resolve roots from `ToolContext`, preserve default user behavior, store metadata (`source`, timestamps, enabled, traceId), and update `memory-index.json` plus `MEMORY.md`. Register `list_memory`, `delete_memory`, and `set_memory_enabled`. Reuse `authorizeToolPath` for every file operation and call `refreshSystemPrompt()` after successful mutations.

- [ ] **Step 4: Run focused tests and existing memory/security tests**

Run: `node --import tsx --test test/agent-memory.test.mjs test/command-security.test.mjs`.
Expected: PASS with no writes to the old path.

- [ ] **Step 5: Commit the tools**

```powershell
git add src/agent/tools/memory.ts src/agent/tools/index.ts test/agent-memory.test.mjs
git commit -m "feat: add scoped memory management tools"
```

### Task 3: Add lazy legacy migration and prompt index merge

**Files:**
- Modify: `src/agent/memory-store.ts`
- Modify: `src/agent/tools/memory.ts`
- Modify: `src/agent/prompts.ts`
- Modify: `src/agent/runtime.ts`
- Test: `test/agent-memory.test.mjs`

- [ ] **Step 1: Write failing migration and prompt tests**

Cover migration from `<APP_ROOT>/data/pi/memory` to user memory, no overwrite on conflicts, idempotence, damaged-index reconstruction, workspace-over-user prompt precedence, and body exclusion from prompt output.

- [ ] **Step 2: Run focused tests and verify failures**

Run: `node --import tsx --test test/agent-memory.test.mjs`
Expected: FAIL because migration and merged prompt index are not implemented.

- [ ] **Step 3: Implement lazy migration and merged index prompt**

Run migration only when a memory tool operation needs it; migrate legal `.md` files to the user root, preserve conflicts and sources, write a marker, and never write the old directory. Update `global_memory` prompt section to load enabled user/workspace indexes, apply workspace name precedence, and render summary lines only.

- [ ] **Step 4: Run focused tests**

Run: `node --import tsx --test test/agent-memory.test.mjs`.
Expected: PASS, including migration and prompt assertions.

- [ ] **Step 5: Commit migration and prompt behavior**

```powershell
git add src/agent/memory-store.ts src/agent/tools/memory.ts src/agent/prompts.ts src/agent/runtime.ts test/agent-memory.test.mjs
git commit -m "feat: migrate and index scoped memory"
```

### Task 4: Regression verification and task documentation

**Files:**
- Modify: `docs/任务清单.md`
- Test: `test/agent-memory.test.mjs`

- [ ] **Step 1: Run the focused suite and full required checks**

Run: `node --import tsx --test test/agent-memory.test.mjs`, `npm run typecheck`, `npm test`.
Expected: all commands exit 0. Existing unrelated failures must be reported with their baseline status.

- [ ] **Step 2: Update the task checklist**

Mark Task 3 implementation items complete and record the actual storage paths, migration behavior, and verification commands. Do not add future automation or a management UI.

- [ ] **Step 3: Commit documentation and final verification**

```powershell
git add docs/任务清单.md
git commit -m "docs: record scoped memory data layer"
git status --short
```

Expected: only pre-existing user-owned untracked files remain; no generated memory data is staged.
