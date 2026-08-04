# Unified App SSE Event Bus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Dashboard, Token and MCP polling with one authenticated application SSE connection while preserving Explorer permissions/file refresh and REST recovery behavior.

**Architecture:** The server owns one `AppEventHub` behind `/api/events`. It publishes invalidation events with a monotonically increasing revision; consumers fetch their existing REST endpoints. The browser owns one `App.Events` EventSource, dispatches typed events, and triggers `resync` on every `onopen`, including automatic reconnects. Chat SSE and Monaco diagnostics remain separate.

**Tech Stack:** Node.js HTTP server, TypeScript, native `EventSource`, existing `.mjs` test runner, esbuild frontend compiler.

---

## File Map

### New files

- `src/server/app-events.ts`: server event types, connection registry, revisioned broadcast and targeted broadcast helpers.
- `src/frontend/services/app-events.ts`: singleton browser EventSource, subscriptions, generation guard, handshake timeout and resync dispatch.
- `test/app-events-server.test.mjs`: isolated server Hub behavior.
- `test/app-events-frontend.test.mjs`: isolated browser event bus behavior and request coalescing fixtures.

### Modified files

- `src/server/routes/types.ts`: add the event Hub to `ServerContext`; remove the production need for a raw `sseClients` array.
- `src/server/server.ts`: construct the Hub, route `/api/events` through it, publish file changes, and publish session/chat lifecycle changes.
- `src/server/permission-confirmation.ts`: send `permission.confirm` through the Hub while preserving pending-response cancellation and fail-closed semantics.
- `src/server/routes/workspace-authorization.ts`: publish Dashboard/Token/MCP invalidation after a successful workspace switch.
- `src/server/routes/settings.ts`: publish Dashboard changes after model or thinking-level changes.
- `src/server/routes/sessions.ts`: publish Dashboard/Token changes after create/open/activate operations.
- `src/server/routes/dashboard.ts`: publish usage changes around compaction and keep REST response shapes unchanged.
- `src/agent/mcp/MCPClientService.ts`: expose a status-change subscription and notify only when visible MCP state changes.
- `src/frontend/dashboard.d.ts`: declare `App.Events` and the new frontend update APIs.
- `src/frontend/service/explorer-service.ts`: remove its EventSource lifecycle and subscribe to shared events.
- `src/frontend/chat/chat-token.ts`: replace `_pollTimer` and six-second polling with event-driven refresh and single-flight fetch.
- `src/frontend/dashboard/dashboard-helpers.ts`: add event-driven Dashboard refresh with single-flight request coalescing.
- `src/frontend/dashboard/dashboard-startup.ts`: register consumers before starting the shared event stream and preserve workspace-sync ordering.
- `src/frontend/dashboard.html`: remove the development-mode Dashboard polling timer from the inline bootstrap.
- `src/frontend/pane/mcp/index.ts`: remove `_mcpRefreshTimer`, subscribe while mounted, and retain open-panel immediate loading/dirty behavior.
- `scripts/compile-frontend-ts.mjs`: place `gen/services/app-events.js` before all consumers in the ordered bundle.
- `package.json`: include the new server and frontend event-bus tests in the normal unit/frontend suites.
- `test/routes.test.mjs`: assert mutation routes publish the appropriate event types.
- `test/explorer-service.test.mjs`: update fixtures from private EventSource ownership to shared event subscriptions.
- `test/frontend-event-ownership.test.mjs`: add architecture assertions for one EventSource and no target polling timers.
- `docs/desktop-capability.md`: mark the three polling migrations complete and list Monaco diagnostics as a separate remaining item.

Generated `src/frontend/gen/` and `dist/` output stays ignored and is regenerated during verification; do not force-add generated output.

## Task 1: Define The Server Event Hub

**Files:**
- Create: `src/server/app-events.ts`
- Modify: `src/server/routes/types.ts`
- Test: `test/app-events-server.test.mjs`

- [x] **Step 1: Write failing Hub tests**

Add tests for these concrete behaviors:

```js
const hub = new AppEventHub();
const a = fakeResponse();
const b = fakeResponse();
hub.addClient(a);
hub.addClient(b);

hub.publish("dashboard.changed", { reason: "model" });

assert.equal(hub.revision(), 1);
assert.equal(JSON.parse(frameFrom(a).data).type, "dashboard.changed");
assert.equal(JSON.parse(frameFrom(a).data).revision, 1);
assert.equal(frameFrom(a).data, frameFrom(b).data);
```

Also test that `removeClient` prevents future writes, a destroyed response is removed after a failed write, and `sendTo` only writes to the supplied client set. Use fake `ServerResponse` objects with `write`, `destroyed`, and `writableEnded`; do not open a network listener.

- [x] **Step 2: Run the focused test and verify it fails**

Run:

```text
node scripts/tsx-test.mjs --test test/app-events-server.test.mjs
```

Expected: FAIL because `src/server/app-events.ts` does not exist.

- [x] **Step 3: Implement the minimal Hub**

Export a closed event union:

```ts
export type AppEventType =
  | "dashboard.changed"
  | "usage.changed"
  | "mcp.changed"
  | "explorer.changed"
  | "permission.confirm";
```

Implement `AppEventHub` with `addClient`, `removeClient`, `clientsSnapshot`, `publish`, `sendTo`, and `revision`. Serialize one frame as `data: ${JSON.stringify({ type, revision, payload })}\n\n`; never send event history.

Add optional `appEvents?: AppEventHub` to `ServerContext` while the raw `sseClients` field remains during this compile-safe transition. Task 2 makes `appEvents` required and removes `sseClients` after all production wiring has moved.

- [x] **Step 4: Run focused tests**

Run:

```text
node scripts/tsx-test.mjs --test test/app-events-server.test.mjs
npm run typecheck
```

Expected: all new Hub tests pass and typecheck passes.

- [x] **Step 5: Commit**

```text
git add src/server/app-events.ts src/server/routes/types.ts test/app-events-server.test.mjs
git commit -m "feat: add application SSE event hub"
```

## Task 2: Move `/api/events` And Permission Confirmation Onto The Hub

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/permission-confirmation.ts`
- Modify: `src/server/routes/types.ts`
- Test: `test/app-events-server.test.mjs`
- Test: `test/routes.test.mjs`

- [x] **Step 1: Extend failing tests for the HTTP-facing contract**

Assert that an events client receives a JSON `connected` frame, receives a revisioned `explorer.changed` frame from the file watcher publisher, and is removed after `close`. Assert that permission confirmation sends exactly one `permission.confirm` frame to each connected client and that closing the last response resolves the pending confirmation as `{ allow: false }`.

- [x] **Step 2: Implement Hub wiring**

Construct `const appEvents = new AppEventHub()` beside `chatStream` in `main()`, pass it in `baseCtx`, and route `/api/events` as follows:

```ts
if (url === "/api/events" && req.method === "GET") {
  res.writeHead(200, eventStreamHeaders);
  res.write(`data: ${JSON.stringify({ type: "connected", revision: appEvents.revision() })}\n\n`);
  appEvents.addClient(res);
  req.on("close", () => {
    appEvents.removeClient(res);
    cancelPermissionConfirmationsForResponse(res);
  });
  return;
}
```

Replace the file watcher’s direct `client.write` loop with:

```ts
appEvents.publish("explorer.changed", { file: filename });
```

Change permission confirmation to use `clientsSnapshot()` and `sendTo(clients, "permission.confirm", { id, ...request })`. Keep the same pending response set, timeout, resolve path and cancellation behavior.

Make `appEvents: AppEventHub` required in `ServerContext` and delete `sseClients` from the context and production setup.

- [x] **Step 3: Run route and permission tests**

Run:

```text
node scripts/tsx-test.mjs --test test/app-events-server.test.mjs test/routes.test.mjs
npm run typecheck
```

Expected: existing permission confirmation tests remain green; no duplicate confirmation frame is emitted.

- [x] **Step 4: Commit**

```text
git add src/server/server.ts src/server/permission-confirmation.ts src/server/routes/types.ts test/app-events-server.test.mjs test/routes.test.mjs
git commit -m "refactor: route application events through shared SSE hub"
```

## Task 3: Add The Browser Event Bus

**Files:**
- Create: `src/frontend/services/app-events.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `scripts/compile-frontend-ts.mjs`
- Test: `test/app-events-frontend.test.mjs`

- [x] **Step 1: Write failing browser-bus tests**

Use a fake `EventSource` that records instances and exposes `onopen`, `onmessage`, and `onerror`. Cover:

- two `start()` calls construct one EventSource;
- a message reaches only subscribers for its type;
- every `onopen` dispatches `resync`;
- an old generation’s message is ignored after replacement;
- the first-open timeout rejects readiness without invoking a second EventSource;
- unsubscribe prevents later callbacks.

- [x] **Step 2: Implement `App.Events`**

Use a singleton with the following behavior:

```ts
type AppEventHandler = (event: AppEvent) => void;
type AppEventSubscriptionType = AppEventType | "resync";

const appEvents = {
  start,
  stop,
  subscribe,
  resync,
};
```

`start()` creates `/api/events` once, attaches listeners, resolves on the first open, and rejects after 5 seconds if no open occurs while leaving the current EventSource alive for browser-managed reconnect. `onopen` calls all `resync` subscribers. `onmessage` parses JSON, ignores malformed frames and stale generations, and isolates handler exceptions. `stop()` increments generation, clears timers, unsubscribes internal listeners, and closes the source.

Expose it as `window.App.Events` and place `gen/services/app-events.js` first in `bundleOrder`, before `dashboard-helpers.js` and `explorer-service.js`.

- [x] **Step 3: Run focused frontend tests**

Run:

```text
node scripts/tsx-test.mjs --test test/app-events-frontend.test.mjs
npm run typecheck
```

Expected: all browser-bus tests pass and the generated bundle order check passes.

- [x] **Step 4: Commit**

```text
git add src/frontend/services/app-events.ts src/frontend/dashboard.d.ts scripts/compile-frontend-ts.mjs test/app-events-frontend.test.mjs
git commit -m "feat: add shared frontend application event bus"
```

## Task 4: Migrate Explorer

**Files:**
- Modify: `src/frontend/service/explorer-service.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `src/frontend/dashboard/dashboard-startup.ts`
- Test: `test/explorer-service.test.mjs`
- Test: `test/app-events-frontend.test.mjs`

- [x] **Step 1: Add migration regression tests**

Assert that importing and starting Explorer does not construct an EventSource. Emit `explorer.changed` through the shared bus and assert `refreshTree()` runs. Emit `permission.confirm` and assert the existing permission dialog/POST payload is unchanged. Verify a stale unsubscribe cannot refresh a newly mounted tree.

- [x] **Step 2: Move Explorer handlers**

Extract the current `handleMessage` branches into shared-bus handlers. Map:

```ts
App.Events.subscribe("explorer.changed", () => ExplorerService.refreshTree());
App.Events.subscribe("permission.confirm", handlePermissionConfirm);
```

Delete `_eventSource`, `_eventGeneration`, `_eventsReady`, `_eventReadyTimer`, `startEvents`, and `stopEvents` from Explorer. Keep tree reconciliation, editing guard, permission payload normalization and `refreshPermissionsPanel` calls.

- [x] **Step 3: Update startup ordering**

Register the subscriptions during module initialization, then call `App.Events.start()` once before `syncStartupWorkspace()`. Remove the Explorer-specific `startEvents()` call. Do not start the connection from MCP, Token, or Dashboard modules.

- [x] **Step 4: Run focused tests and commit**

Run:

```text
node scripts/tsx-test.mjs --test test/explorer-service.test.mjs test/app-events-frontend.test.mjs
npm run typecheck
```

Expected: Explorer still refreshes on file changes, permission confirmation still resolves/rejects correctly, and exactly one shared EventSource exists.

```text
git add src/frontend/service/explorer-service.ts src/frontend/dashboard.d.ts src/frontend/dashboard/dashboard-startup.ts test/explorer-service.test.mjs test/app-events-frontend.test.mjs
git commit -m "refactor: move Explorer onto shared SSE events"
```

## Task 5: Add Server Lifecycle Publishers

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/routes/workspace-authorization.ts`
- Modify: `src/server/routes/settings.ts`
- Modify: `src/server/routes/sessions.ts`
- Modify: `src/server/routes/dashboard.ts`
- Modify: `src/agent/mcp/MCPClientService.ts`
- Modify: `test/routes.test.mjs`
- Modify: `test/app-events-server.test.mjs`

- [x] **Step 1: Write publisher tests before wiring**

Add route-level assertions using a fake `appEvents.publish`:

```js
assert.deepEqual(published.map(e => e.type), ["dashboard.changed", "usage.changed"]);
```

Cover model switch, thinking-level change, session create/open/activate, successful workspace switch, and compaction success/failure. Add MCP service tests that repeated `_setStatus` with the same visible state emits once, while state/error/tools changes emit once each.

- [x] **Step 2: Add server publishers at the actual mutation boundaries**

Use `ctx.appEvents.publish(...)` only after successful mutation. In `attachSessionEvents`, publish `dashboard.changed` and `usage.changed` at the agent lifecycle boundaries; publish `usage.changed` after compaction begins/ends, including the catch/finally state reset. In settings, sessions and workspace routes publish after the runtime call or persisted mutation succeeds.

Add an MCP status listener API that compares the externally visible `{ name, state, tools, error, enabled/config identity }` state before invoking listeners. The server registers one listener that publishes `mcp.changed`; MCP code must not import server code.

- [x] **Step 3: Keep event publication non-blocking**

Publish calls must never delay or fail the underlying chat, session, settings or MCP operation. Wrap listener invocation in try/catch and never await UI broadcast from a route mutation.

- [x] **Step 4: Run focused server tests and commit**

Run:

```text
node scripts/tsx-test.mjs --test --test-concurrency=1 test/routes.test.mjs test/app-events-server.test.mjs
npm run typecheck
```

Expected: all mutation event tests pass, and existing route response bodies remain unchanged.

```text
git add src/server/server.ts src/server/routes/workspace-authorization.ts src/server/routes/settings.ts src/server/routes/sessions.ts src/server/routes/dashboard.ts src/agent/mcp/MCPClientService.ts test/routes.test.mjs test/app-events-server.test.mjs
git commit -m "feat: publish dashboard usage and MCP lifecycle events"
```

## Task 6: Replace Dashboard Polling

**Files:**
- Modify: `src/frontend/dashboard/dashboard-helpers.ts`
- Modify: `src/frontend/dashboard/dashboard-startup.ts`
- Modify: `src/frontend/dashboard.html`
- Modify: `src/frontend/dashboard/layout-panel.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Test: `test/app-events-frontend.test.mjs`
- Test: `test/frontend-event-ownership.test.mjs`

- [x] **Step 1: Add a failing single-flight refresh test**

Call the Dashboard event handler twice while the first `/api/dashboard` request is unresolved. Assert one active request, one pending follow-up after resolution, and no stale response overwrite.

- [x] **Step 2: Implement event-driven Dashboard refresh**

Remove `setInterval(refresh, 3000)` from both `dashboard-startup.ts` and the development inline bootstrap in `dashboard.html`. Keep `getD()` as the explicit REST loader used by startup and existing settings actions. Add one shared event subscription for `dashboard.changed` and `resync` that invokes the single-flight loader.

The legacy system-information panel and its local runtime counter no longer exist, so no runtime baseline compensation is needed. Keep the existing REST response shape unchanged and route event-triggered refreshes through the same single-flight Dashboard loader.

- [x] **Step 3: Verify no duplicate startup loop**

The source startup module and inline `dashboard.html` bootstrap must have one canonical startup path. Remove only the active `setInterval`; do not leave a second generated/inline timer. Add a source architecture assertion that no Dashboard polling interval remains.

- [x] **Step 4: Run tests and commit**

Run:

```text
node scripts/tsx-test.mjs --test test/app-events-frontend.test.mjs test/frontend-event-ownership.test.mjs
npm run typecheck
```

```text
git add src/frontend/dashboard/dashboard-helpers.ts src/frontend/dashboard/dashboard-startup.ts src/frontend/dashboard.html src/frontend/dashboard/layout-panel.ts src/frontend/dashboard.d.ts test/app-events-frontend.test.mjs test/frontend-event-ownership.test.mjs
git commit -m "refactor: update dashboard state from application events"
```

## Task 7: Replace Token Polling

**Files:**
- Modify: `src/frontend/chat/chat-token.ts`
- Modify: `src/frontend/dashboard/dashboard-chat.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Test: `test/app-events-frontend.test.mjs`
- Test: `test/frontend-event-ownership.test.mjs`

- [x] **Step 1: Add failing Token event tests**

Assert that startup performs one `/api/usage/current` request, `usage.changed` triggers one refresh, two events during an unresolved request produce only one follow-up, and no six-second timer is created. Assert the compact action still refreshes the current usage after completion.

- [x] **Step 2: Replace the timer with an event subscription**

Replace `startTokenPoll`/`stopTokenPoll` with `startTokenUpdates`/`stopTokenUpdates` and update every caller and declaration; do not retain polling-named compatibility aliases. `startTokenUpdates()` must stop any previous subscription, perform an immediate fetch, subscribe to `usage.changed`, and subscribe to `resync`. Remove `_pollTimer` and `setInterval` entirely. Keep rail positioning `ResizeObserver` and window resize behavior unchanged.

- [x] **Step 3: Update existing callers**

Change `dashboard-chat.ts` startup wiring from `startTokenPoll()` to the event-driven entry point. Keep the explicit refresh after `/api/compact`, but route it through the same single-flight loader.

- [x] **Step 4: Run tests and commit**

Run:

```text
node scripts/tsx-test.mjs --test test/app-events-frontend.test.mjs test/frontend-event-ownership.test.mjs
npm run typecheck
```

```text
git add src/frontend/chat/chat-token.ts src/frontend/dashboard/dashboard-chat.ts src/frontend/dashboard.d.ts test/app-events-frontend.test.mjs test/frontend-event-ownership.test.mjs
git commit -m "refactor: refresh token usage from application events"
```

## Task 8: Replace MCP Panel Polling

**Files:**
- Modify: `src/frontend/pane/mcp/index.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Test: `test/app-events-frontend.test.mjs`
- Test: `test/frontend-event-ownership.test.mjs`

- [x] **Step 1: Add failing MCP lifecycle tests**

Assert that mounting the MCP pane creates no interval, opening the installed tab performs one immediate fetch, an `mcp.changed` event refreshes only when the pane is mounted on the installed tab, and events while unmounted are reflected by the next mount fetch.

- [x] **Step 2: Implement mounted subscription and dirty state**

Remove `_mcpRefreshTimer` and its `setInterval`. Subscribe on pane mount and unsubscribe when the pane is replaced/disposed. Keep `_activeMcpTab`, immediate fetch on installed-tab selection, and all existing toggle/trust/remove handlers. A closed pane only records dirty; it does not fetch.

- [x] **Step 3: Run tests and commit**

Run:

```text
node scripts/tsx-test.mjs --test test/app-events-frontend.test.mjs test/frontend-event-ownership.test.mjs
npm run typecheck
```

```text
git add src/frontend/pane/mcp/index.ts src/frontend/dashboard.d.ts test/app-events-frontend.test.mjs test/frontend-event-ownership.test.mjs
git commit -m "refactor: update MCP pane from application events"
```

## Task 9: Bundle, Architecture Gates And Documentation

**Files:**
- Modify: `scripts/compile-frontend-ts.mjs`
- Modify: `package.json`
- Modify: `test/frontend-event-ownership.test.mjs`
- Modify: `docs/desktop-capability.md`

- [x] **Step 1: Add architecture assertions**

Assert source text has exactly one `new EventSource('/api/events')` owner in `src/frontend/services/app-events.ts`, no `new EventSource` in `explorer-service.ts`, and no `setInterval` in Dashboard startup, Token usage, or MCP pane. Do not flag Chat SSE or Monaco diagnostics.

Add `test/app-events-server.test.mjs` to `test:unit` and `test/app-events-frontend.test.mjs` to `test:frontend` in `package.json`, so `npm test` always exercises the new contracts.

- [x] **Step 2: Rebuild the frontend**

Run:

```text
npm run build:vite
```

Expected: `src/frontend/gen/dashboard.js` is generated successfully, `app-events.js` appears before `explorer-service.js`, and no bundle syntax collision occurs.

- [x] **Step 3: Update capability documentation**

Move unified SSE from “remaining” to “completed” and describe the actual Phase 1 boundary: Dashboard/Token/MCP plus Explorer; Monaco diagnostics remains a separate follow-up.

- [x] **Step 4: Run the full verification gate**

Run:

```text
npm test
npm run typecheck
git diff --check
git status --short
```

Expected: all tests and type checks pass, diff check is clean, and only intended source/tests/docs remain changed. Generated output remains ignored.

- [x] **Step 5: Commit**

```text
git add scripts/compile-frontend-ts.mjs package.json test/frontend-event-ownership.test.mjs docs/desktop-capability.md
git commit -m "docs: close unified SSE polling debt"
```

## Task 10: Real-Machine Acceptance

After all automated checks pass, start the desktop dev server and verify manually:

1. DevTools Network shows one `/api/events` connection plus the independent Chat SSE only during a reply.
2. Leave the app idle for 30 seconds; no periodic `/api/dashboard`, `/api/usage/current`, or `/api/mcp/servers` requests appear.
3. Send a message; Dashboard busy/idle and Token update at the start/end boundaries.
4. Switch session, workspace, model and thinking level; Dashboard and Token state update without refresh.
5. Open MCP, change a server state, close the pane, and reopen it; state is current and no hidden-pane polling occurs.
6. Modify a workspace file; Explorer refreshes. Trigger an external path operation; the existing confirmation UI still appears once and remains above the chat composer.
7. Force-close the application event connection, wait for automatic reconnect, and confirm `onopen` resync restores all visible state.

Record each result and keep a clean worktree before declaring the phase complete.
