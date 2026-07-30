# Agent and Desktop Governance Plan

> Status: active goal. This document is the working blueprint for making
> my-code-agent a desktop-first local code agent with explicit, auditable,
> fail-closed control over privileged actions.

## North Star

my-code-agent should feel like a capable local coding assistant, but every
high-privilege path must pass through one governed boundary. The model should
not be able to bypass safety by choosing a different route, frontend action,
IPC call, MCP config path, or shell syntax.

The desired end state:

- Agent tool execution, server routes, desktop IPC, MCP config, and frontend
  confirmations share the same permission vocabulary.
- All read/write/create/remove operations have a known root, operation type,
  source label, decision, and audit record.
- All mutating local APIs require desktop authentication and loopback origin
  checks.
- Destructive or ambiguous actions fail closed unless a user-visible permission
  flow grants them.
- Tests cover both the happy paths and the weird edge cases that real shells,
  Windows paths, symlinks, and desktop integrations create.

## Governance Layers

### 1. Agent Tool Governance

Scope:

- `command` tool
- file tools
- web/MCP/tool adapters
- future plugin/skill tools

Required controls:

- Keep `isDangerousCommand` as a non-bypassable hard gate.
- Keep `readOnly` as a hard constraint before `permissionMode`.
- Use AST-backed shell parsing where available, with fail-closed fallback for
  shell expansion, unclear fanout, heredoc/subshell ambiguity, or unresolved
  variable/glob writes.
- Extract path operations as `read`, `write`, `create`, and `remove`, then
  evaluate them through shared permission primitives.
- Expand command-specific validators for `git`, `sed`, `jq`, `xargs`, archive
  tools, package managers, PowerShell, and Windows native commands.
- Preserve a clear distinction between dangerous command denial, read-only
  denial, path confirmation, and user permission denial.

Current status:

- Agent direct-write/read tools (`file_write`, `str_replace_editor`,
  `write_agent_md`, `read_memory`, `write_memory`) use the shared path
  authorizer with operation and source labels.
- `ToolRegistry.toPITools()` and `agentToolToPiTool()` now run a generic tool
  authorizer before executing tools that declare `needsPermission`.
- MCP tool adapters declare high-risk external `execute` operations and are
  denied before `client.callTool()` when permission is unavailable or rejected.
- Shared permission primitives now include `Tool(...)` session rules with the
  same exact/prefix/wildcard match vocabulary as path rules.

Acceptance:

- Security unit tests include red-team corpora for POSIX, PowerShell, cmd, Git
  Bash, quoted Windows paths, env vars, redirects, pipes, and nested shells.
- Every command decision can be explained with a machine-readable reason.
- Session allow/ask/deny rules apply consistently to command paths and server
  route paths.

### 2. Server Route Governance

Scope:

- Explorer/file routes
- Search/replace routes
- Git routes
- TypeScript edit routes
- Settings/UI-state routes
- Chat attachments
- MCP config and trust routes

Required controls:

- `PathGuard` owns symlink-aware path containment.
- `ServerPermissionService` owns allow/ask/deny decisions and audit entries.
- Route handlers must call `authorizeRoutePath` or a domain helper before
  touching local filesystem paths.
- Server-side `ask` emits a UI-backed `permission_confirm` event over
  `/api/events`, resolves through `/api/permissions/confirm`, and fails closed
  when no desktop client is connected, the prompt times out, or the user denies.
- Internal app config writes must use explicit domain helpers, not user-chosen
  roots.
- All permission failures return structured JSON with `code` and `error`.

Current status:

- PathGuard is integrated into explorer, attach, search, git, TypeScript,
  settings, UI-state, and sessions routes.
- Sessions route recursion now authorizes directories before descending, so
  session listing and recursive lookup fail closed on denied subdirectories and
  symlink/junction escape attempts.
- TypeScript language-service routes now authorize `open`, `change`, `close`,
  completions, completion details, quickinfo, definition, references,
  diagnostics, formatting, and code-action lookup before passing a file to
  tsserver.
- TypeScript disk edits from `apply-code-action` and `organize-imports`
  preflight every returned target file before any write is applied, preventing
  partial writes when a later file is outside the governed root.
- ServerPermissionService shares the Agent session permission state and exposes
  `/api/permissions/audit`.
- Agent `file_write`, `str_replace_editor`, `write_agent_md`, `read_memory`, and
  `write_memory` now use the injected shared path authorizer with operation and
  source labels; the local guard remains as a defense-in-depth boundary.
- PathGuard regression tests now cover sibling-prefix traversal, Windows
  absolute paths, UNC paths, and symlink/junction escapes.
- Chat attachment reads are now audited.
- MCP toggle/install/custom install/uninstall/trust writes are now authorized
  and audited.
- Session permission rules can now be listed, added, removed, and cleared via
  `/api/permissions/rules`.
- Route-level ask decisions now surface in the desktop confirmation UI through
  `permission_confirm` SSE events. One-shot approvals allow the current action;
  session approvals apply the suggested session rules before retrying future
  decisions.
- Permission audit history is persisted app-locally in
  `permission-audit.json` and reloaded on server startup, while retaining the
  bounded in-memory audit view for the active process.
- Permission Center refresh hooks run after route-level confirmations so audit
  and session rule changes can be reflected without reopening the pane.

Acceptance:

- No route writes to a user-controlled path without PathGuard plus permission
  evaluation.
- Route traversal tests cover sibling-prefix escapes, `..`, absolute paths,
  missing roots, and first-time config creation.
- Session route tests now cover denied recursive subdirectories, lookup
  recursion, and symlink/junction escape handling.
- TypeScript route tests cover workspace file authorization, outside-root
  rejection before tsserver, diagnostics authorization, and no-partial-write
  behavior for code actions and organize imports.
- Permission audit entries include `source`, `operation`, `root`, `path`,
  `decision`, and reason/code when denied.

### 3. Desktop App Governance

Scope:

- Electron main process
- BrowserWindow configuration
- IPC handlers
- local HTTP server authentication
- shell integration such as open/trash/show-in-folder

Required controls:

- Renderer runs with sandbox and web security enabled.
- Navigation, window.open, and webview entry points are restricted.
- Mutating `/api/*` calls require a desktop token/cookie and pass loopback
  origin checks.
- IPC handlers expose a small allowlist and validate paths against trusted
  workspace/app roots.
- OS shell actions such as reveal/trash/open must never accept arbitrary
  renderer-provided paths without root validation.
- The desktop token is per app session and not stored in project files.

Current status:

- Desktop token, loopback origin checks, preflight handling, wildcard CORS
  stripping, and security headers are implemented.
- Sensitive read APIs now require the same desktop token/cookie as mutating
  APIs. `/api/bootstrap` is the only cookie-seeding public read endpoint, and
  `/api/mcp/catalog` remains a static catalog read endpoint.
- `/api/dashboard` is token-only, and `/api/auth` returns only key presence and
  preview metadata instead of full stored API keys.
- Agent tools that reuse local read APIs (`file_read`, `file_outline`,
  `explorer_list`, `search`, `git-status`, `git_log`) now forward the desktop
  API token through `X-My-Code-Agent-Token` instead of relying on unauthenticated
  localhost GET access.
- The server clears `MY_CODE_AGENT_DESKTOP_TOKEN` from `process.env` after
  capturing it, and the command tool also scrubs that token from spawned shell
  environments.
- Electron has sandbox/webSecurity enabled and restricts navigation,
  window.open, webview, reveal, and trash paths.
- Trusted workspace roots are loaded from persisted UI state.
- Desktop IPC handlers are registered through a typed allowlist in
  `src/electron/desktop-ipc.ts`; renderer arguments are validated before any
  dialog, reveal, trash, terminal, or window-control action runs.
- Preload exposure now has a regression check for the `openFile` dialog bridge.

Acceptance:

- Mutating API calls without token are rejected.
- Sensitive read API calls without token are rejected, while explicit bootstrap
  reads remain documented.
- Cross-site requests are rejected.
- Renderer IPC path attempts outside trusted roots are denied.
- Packaged app settings preserve the same constraints as development mode.

### 4. Permission Model Governance

Scope:

- Session permissions
- Future local/project permissions
- Confirmation UI
- Audit and rule management

Required controls:

- Shared rule schema: tool name, rule content, match mode
  (`exact`, `prefix`, `wildcard`), destination (`once`, `session`, later
  `local`/`project`).
- Shared operations: `read`, `write`, `create`, `remove`, plus generic tool
  `execute` for external/plugin/MCP capability calls.
- Rule precedence: deny > ask > workspace/authorized roots > allow > ask.
- Session `Tool(...)` rules apply to permission-gated tool calls such as MCP
  adapters, so a session approval does not repeatedly prompt for the same tool.
- Server routes must not silently auto-allow `ask`; they must either complete a
  user-visible confirmation or fail closed.
- Permission suggestions should be scoped to the narrowest practical directory.

Next milestone:

- Extend the Permission Center from session rules/audit to app-local history,
  prompt state visibility, and empty/error state polish.
- Add local persistence only after session rules are well tested.

Acceptance:

- The user can see what was allowed, denied, or would require confirmation.
- The user can revoke session rules without restarting.
- Local persistent rules are explicit, inspectable, and never created by
  accident.

### 5. MCP Governance

Scope:

- MCP discovery
- MCP config validation
- MCP trust store
- MCP server launch
- MCP UI install/uninstall/toggle/trust actions

Required controls:

- MCP configs are loaded from project `.mcp.json`, project `.vscode/mcp.json`,
  and global config with clear priority.
- UI responses redact env and other sensitive launch fields.
- Config writes are authorized against either the workspace config file or the
  exact global config file.
- Trust writes are authorized and audited.
- Server launch should require trust based on command hash and workspace.
- Future install flows should distinguish "installed", "enabled", and
  "trusted" instead of bundling them into one implicit action.

Current status:

- Config validation and env redaction exist.
- Toggle/install/custom install/uninstall/trust routes are now under permission
  audit.
- Trust identity uses workspace plus command hash.
- MCP tool execution now has a second gate after trust: high-risk external tools
  require generic tool authorization, emit `tool` audit entries, and can be
  session-allowed through `Tool(mcp__server__tool)` rules.
- MCP permission decisions and session rules are visible from the desktop
  Permission Center.

Acceptance:

- A malicious renderer cannot write arbitrary JSON by pretending it is an MCP
  config source.
- A changed MCP command hash requires re-trust.
- MCP route tests cover project, `.vscode`, global, and denied-rule cases.

### 6. Frontend State Governance

Scope:

- Dashboard global state
- session/chat/tab state
- workspace switching
- SSE lifecycle
- command/permission confirmation dialogs
- future Permission Center

Required controls:

- One owner per state domain; avoid scattered global mutation.
- Workspace switch clears or partitions cross-workspace state.
- SSE events have stable lifecycle states: connecting, streaming, done, error,
  cancelled.
- Permission prompts should render the exact command/path, source, operation,
  suggested scope, and consequence.
- Sensitive state is not persisted to localStorage unless intentionally
  designed as app-local state.

Acceptance:

- Frontend tests cover tab/session/workspace isolation, confirmation actions,
  stale stream handling, and permission audit rendering.
- UI never implies an action succeeded until the server confirms it.

### 7. Test and Release Governance

Required checks:

- `npm run typecheck`
- `npm run test:unit`
- `npm run test:routes`
- `npm run test:frontend`
- `npm test`

Additional suites to add:

- Desktop IPC security tests for allowlisted channels, argument validation, and
  trusted-root path guarding.
- Local API token/origin end-to-end tests in real HTTP mode.
- Local API security unit tests cover sensitive GET token enforcement and
  bootstrap GET exceptions.
- Agent local API helper tests cover forwarding the desktop token header for
  internal tool calls.
- Command security tests cover preventing spawned commands from inheriting the
  desktop API token.
- Permission Center UI tests.
- MCP launch trust tests.
- Shell red-team corpus snapshots against command security decisions.
- Windows path/symlink regression tests.

Release gate:

- Full suite green.
- No new unaudited high-privilege file writes.
- No broad CORS or token bypass in desktop server mode.
- New permission behavior documented with tests.

## Roadmap

### P0 - Boundary Unification

Status: mostly complete.

- Shared PathGuard for route filesystem boundaries.
- Shared ServerPermissionService with audit.
- Desktop local API token/origin hardening.
- Electron navigation and IPC path restrictions.
- Chat attachments and MCP config/trust writes under permission audit.

### P1 - User-Visible Permission Control

Status: route confirmation implemented; persistence and polish remain.

- Permission Center UI is available as a desktop side pane.
- Rule management APIs for session rules are available.
- Route-level confirmation events for server-side ask decisions are available
  through `/api/events` plus `/api/permissions/confirm`.
- Route confirmation tests cover allow, deny/no callback, event resolution, and
  timeout fail-closed behavior.
- Agent direct-write tool tests cover create/write/read authorization and
  fail-closed denial behavior.
- MCP tool execution is permission-gated with `Tool(...)` session rules and
  server audit coverage.
- Permission Center refresh hooks are covered by frontend event handling tests.
- Extend audit from memory-only to app-local history. Implemented for route
  permission audits; local/project rule persistence remains separate.
- Add tests for app-local persistence, Permission Center refresh hooks, and
  packaged desktop security behavior.

### P2 - Shell and Validator Parity

Status: ongoing.

- Expand Tree-sitter shell semantic coverage.
- Add dedicated validators for shell fanout, heredoc, subshell, xargs, sed, jq,
  git, archive tools, package managers, and Windows/PowerShell operations.
- Split command decisions into parse, dangerous, read-only, path, permission,
  and sandbox stages.

### P3 - Desktop Product Hardening

Status: in progress.

- Packaged-app security audit.
- IPC handler registry with typed schemas is implemented for current desktop
  channels.
- Permission Center polish and empty/error states.
- End-to-end desktop smoke tests.
- Plugin/skill governance for install, update, trust, and removal.

## Working Definition of Done

The governance work is "done enough" when:

- Agent commands and desktop/server actions use the same permission primitives.
- All high-privilege filesystem operations are guarded, permission-checked, and
  auditable.
- Mutating local API calls cannot be made by arbitrary web pages.
- Desktop IPC cannot escape trusted roots.
- The user has a UI to inspect and revoke session permissions.
- Full regression plus targeted security suites pass consistently.
