# Security Model

my-code-agent is a desktop-first local code agent. It can execute commands,
read and modify files, invoke MCP tools, and expose local HTTP endpoints. These
capabilities are privileged and must remain behind explicit, auditable
boundaries.

## Trust Boundaries

The security model has five boundaries:

1. The Electron main process owns operating-system capabilities and exposes a
   small, validated IPC allowlist through preload.
2. The loopback HTTP server authenticates local API requests and rejects
   untrusted origins and cross-site requests.
3. `PathGuard` resolves filesystem targets, checks containment, and follows
   existing path segments to prevent symlink or junction escapes.
4. `ServerPermissionService` evaluates path and tool rules, prompts when
   required, and records audit entries.
5. The command tool applies a non-bypassable danger gate, read-only policy,
   shell/path analysis, and permission confirmation before process creation.

Binding to `127.0.0.1` is defense in depth, not authentication.

## Local API

The Electron main process creates a random desktop session token for each app
run. It passes the token to the server through
`MY_CODE_AGENT_DESKTOP_TOKEN`, then both processes clear their inherited copy
after capture. Development mode generates one token in the launcher and shares
it with the Electron and server child processes.

API requests are checked as follows:

- `Origin` must match the current server origin or an explicitly configured
  development origin; arbitrary loopback ports are rejected.
- `Sec-Fetch-Site: cross-site` is rejected.
- Mutations and sensitive reads require the desktop token.
- `/api/bootstrap` and `/api/mcp/catalog` are the only public read endpoints,
  but anonymous responses never receive the desktop cookie.
- The token may be supplied through the `X-My-Code-Agent-Token` header or the
  HttpOnly, `SameSite=Strict` desktop cookie.
- The trusted Electron window obtains the token through a sender-validated IPC
  call and supplies it to `/api/bootstrap`; only a valid supplied token can
  seed or refresh the cookie.
- Route-provided wildcard CORS headers are stripped when desktop security is
  active; only an allowed loopback origin is reflected.

New API routes must be classified before merge. A new unauthenticated read
endpoint requires an explicit entry in `PUBLIC_READ_API_PATHS` and a security
test.

## Filesystem Access

Filesystem operations use the vocabulary `read`, `write`, `create`, and
`remove`. User-controlled paths must pass through `guardPathWithinRoot()` and
the shared permission service before filesystem access.

Required invariants:

- An empty or missing root is rejected.
- Sibling-prefix paths and `..` traversal are rejected.
- Existing path segments are resolved with `realpath` before containment is
  accepted.
- Windows drive letters, case-insensitive paths, UNC paths, symlinks, and
  junctions require regression coverage when affected.
- Do not use string-prefix containment checks such as
  `fullPath.startsWith(root)`.

Internal persistence, including session headers, traces, UI state, usage
indexes, and permission audit records, is also treated as filesystem access.

## Permissions And Audit

Session permission rules support `allow`, `ask`, and `deny` decisions with
exact, prefix, and wildcard matching. Rule scope currently includes one-shot
confirmation and the active session. Workspace-local persistent rules are not
implemented yet.

Policy is graded by intent and risk:

- a workspace or path explicitly selected through the desktop establishes a
  trusted root or exact-file grant;
- ordinary external reads are allowed without prompting;
- external credential, key, browser-profile, and selected system-config reads
  require confirmation and can be allowed for the active session;
- external writes/removes and permission-gated tools continue to require
  confirmation, while explicit deny and ask rules retain precedence.

Audit history records asks, denials, user confirmation outcomes, path
mutations, and high-risk tools. Routine read allows and low/medium-risk
permission-free tool allows are intentionally omitted. Recorded entries retain:

- source and operation;
- root, absolute path, and relative path when applicable;
- decision, reason, and error code;
- tool name, declared operations, risk, and workspace scope for tool calls.

Missing confirmation channels fail closed. Synchronous persistence paths also
fail closed when a rule requires interactive confirmation.

## Agent Tools And MCP

Built-in tools declare `operations`, `riskLevel`, `needsPermission`, and
`workspaceBounded`. Registry adapters apply the shared authorization hook
before execution. File tools also authorize their resolved target paths.

MCP servers are untrusted by default. Server trust and tool execution
permission are separate gates: trusting a server does not grant all of its
tools unrestricted local authority.

## Electron

Renderer windows use `sandbox: true`, `contextIsolation: true`, and
`nodeIntegration: false`. Navigation and popup creation are restricted to the
active loopback application origin. The preload exposes only named IPC
operations. IPC handlers validate argument count and type; path operations are
restricted to trusted workspace roots or files returned by native dialogs.
The desktop-token IPC handler additionally verifies that the caller is the
active application window and that its frame URL is an allowed app URL.

## Known Gaps

- Packaged Windows desktop E2E is not yet a release gate.
- Workspace-local persistent permission rules are not implemented.
- Shell semantic coverage is intentionally conservative but not yet equivalent
  to Claude Code's complete Bash validator system.
- Frontend legacy state and HTML rendering paths remain under migration.
- The application does not currently provide an operating-system process
  sandbox tied to permission write allowlists.

These are tracked in `docs/governance-plan.md` and must not be described as
completed controls.

## Reporting A Security Issue

Do not include secrets, tokens, private source code, or destructive proof of
concepts in public issue text. Provide the affected version, platform, entry
point, expected boundary, observed behavior, and a minimal non-destructive
reproduction to the project maintainer through a private channel.
