# Provider Network Discovery and Connectivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Make custom provider settings automatically discover model IDs and test network reachability without sending a model-generation request.

**Architecture:** Keep `/api/custom-providers/test` and `/discover-models` as the public endpoints. Move endpoint candidate generation and the lightweight GET probe into `ProviderNetworkClient`; let `CustomProviderService` resolve saved credentials and strip a request-only model sentinel so the persisted provider contract remains unchanged. Update the form to send the sentinel only when the user has not entered models, and render HTTP reachability separately from transport failure.

**Tech Stack:** TypeScript, Node `fetch`, Express-style route handlers, happy-dom frontend tests, Node test runner, `tsx`.

---

### Task 1: Add failing network-client tests for automatic discovery and probe semantics

**Files:**
- Modify: `test/custom-provider-network.test.mjs:156-430`
- Modify: `test/custom-provider-network.test.mjs:432-700`

- [ ] **Step 1: Add the automatic candidate fallback test**

Add a test server that returns 404 for `/v1/models`, then returns an OpenAI list for `/models`. Call `discoverModels` with `modelDiscovery: undefined`, assert the request order is `['/v1/models', '/models']`, and assert the returned IDs are trimmed and stable-deduplicated.

- [ ] **Step 2: Add candidate derivation tests for version and compatibility paths**

Add cases for `https://host.test/v1`, `https://host.test/api/coding/paas/v4`, and `https://host.test/api/anthropic`. Assert that the version path tries `{base}/models` first and that compatibility paths eventually try the host-root model endpoints without leaving the original origin.

- [ ] **Step 3: Add protocol-header assertions for automatic discovery**

Run discovery with `anthropic-messages` and `azure-openai-responses`, assert `x-api-key` and `api-key` respectively, and assert a custom Header replaces a same-name default header. Keep the API key and header value out of any thrown error.

- [ ] **Step 4: Replace the real-generation connection test with a failing lightweight probe test**

Add a test whose draft has `models: []` at the resolved-client boundary, whose fetch implementation records the request, and whose runtime factory throws if called. Return HTTP 401 and assert the result has `reachable: true`, `httpStatus: 401`, `ok: false`, and `code: 'authentication'`; assert the request is `GET` and uses the protocol header.

- [ ] **Step 5: Add reachable HTTP error and transport failure cases**

Add HTTP 404 and 500 cases that return `reachable: true`, and injected DNS, TLS, timeout, and caller-abort cases that return `reachable: false` with the existing stable error codes. Add a redirect case asserting the response is recorded once and no redirect target receives credentials.

- [ ] **Step 6: Run the focused tests and verify they fail for the missing behavior**

Run:

```powershell
npx tsx --test test/custom-provider-network.test.mjs
```

Expected: the new candidate fallback and probe assertions fail against the current single-path/runtime-generation implementation; existing unrelated assertions may also identify the exact old expectations that must be migrated in Task 2.

### Task 2: Implement network candidate discovery and lightweight GET probing

**Files:**
- Modify: `src/model-provider/provider-network-client.ts:1-430`
- Modify: `src/model-provider/contracts.ts:105-145`
- Test: `test/custom-provider-network.test.mjs`

- [ ] **Step 1: Define the result shape before changing the implementation**

Change the connection result to carry `reachable`, `httpStatus`, `latencyMs`, and a stable message. Keep `ok` as `true` only for 2xx responses; return `ok: false` with `reachable: true` for HTTP errors and `reachable: false` for transport errors. Keep the existing error-code union and omit model usage fields because no generation occurs.

- [ ] **Step 2: Add private URL candidate helpers**

Implement helpers in `provider-network-client.ts` that:

```ts
function modelDiscoveryCandidates(baseUrl: string, explicitPath?: string): URL[]
function appendPath(baseUrl: URL, suffix: string): URL
```

They must normalize trailing slashes, preserve the origin, remove query/hash from generated URLs, generate `/v1/models` then `/models` for ordinary roots, generate `/models` then `/v1/models` for a trailing `/vN`, and add root fallbacks after known `/anthropic`, `/claude`, `/coding`, `/step_plan`, and related compatibility suffixes. Deduplicate by URL string.

- [ ] **Step 3: Convert discovery to candidate iteration**

Use `discoveryHeaders(input)` for every candidate. Reject unsupported protocols and cross-origin candidates before fetch. Continue only on 404/405, reject redirects without following them, parse a bounded JSON body on success, and return stable `ProviderNetworkError` codes for all terminal failures. Preserve the existing secret redaction and abort scope.

- [ ] **Step 4: Replace `testConnection` runtime setup with a GET probe**

Use the same abort scope and headers to call `GET input.provider.baseUrl` with `redirect: 'manual'`. Cancel the response body after reading only the status. For any response, set `reachable: true`, `httpStatus`, and latency; set `ok` from `response.ok`, and classify non-2xx status with `codeForStatus`. For fetch errors, classify the error and return `reachable: false` without response details. Do not call `ModelRuntime.create`, the adapter, `getModel`, or `completeSimple`.

- [ ] **Step 5: Migrate old network tests to the new contract**

Remove assertions about request bodies, usage normalization, runtime registration, and model selection. Replace them with assertions that the probe is one GET, no runtime is created, all six protocols use manual redirects, and credentials never cross an origin. Run the focused test file until it passes.

### Task 3: Allow request-only no-model operations at the service and route boundary

**Files:**
- Modify: `src/model-provider/custom-provider-service.ts:70-315`
- Modify: `src/server/routes/settings/custom-providers.ts:20-85,270-305`
- Modify: `test/custom-provider-service.test.mjs`
- Modify: `test/routes.test.mjs`

- [ ] **Step 1: Add failing service and route tests for the no-model sentinel**

Send a valid model descriptor with ID `__model_discovery__` to both network endpoints, assert the service passes an empty model list to the network client, and assert a normal saved mutation containing that ID still returns `invalid_request`. Add a route test that sends the sentinel to `/test` and receives a successful network-client result instead of a validation error.

- [ ] **Step 2: Generalize the request-only sentinel option**

Rename the service option to `allowNetworkSentinel`, strip the sentinel model before resolving credentials, and call it from both `testConnection` and `discoverModels`. Keep mutation paths and ordinary network drafts rejecting the sentinel.

- [ ] **Step 3: Expand route validation only for network operations**

Make `networkDraftInput` accept the sentinel when the route kind is `test` or `discover`, while keeping `mutationInput` and all other callers on `rejectDiscoverySentinel`. Keep stored credential authorization unchanged.

- [ ] **Step 4: Run service and route tests**

Run:

```powershell
npx tsx --test test/custom-provider-service.test.mjs test/routes.test.mjs
```

Expected: all existing custom-provider CRUD, authorization, revision, and redaction tests remain green.

### Task 4: Update the form and editor for automatic discovery and HTTP reachability feedback

**Files:**
- Modify: `src/frontend/dashboard/settings-custom-provider-form.ts:182-378`
- Modify: `src/frontend/dashboard/settings-custom-provider-editor.ts:184-260`
- Modify: `src/frontend/dashboard/settings-provider-utils.ts:30-72`
- Modify: `test/settings-ui.test.mjs:619-640,1813-1850`
- Modify: `test/provider-settings-ui.test.mjs`

- [ ] **Step 1: Add failing frontend tests for blank-path discovery and no-model testing**

Mount a provider with `modelDiscovery: undefined` and `models: []`, invoke `discoverModels`, assert the request draft omits `modelDiscovery` and carries the sentinel, then confirm import. Invoke `test` on the same form and assert it also sends the sentinel rather than rejecting the empty model list. Add a response with `{ ok: false, reachable: true, httpStatus: 401, code: 'authentication' }` and assert the UI says the service is reachable and does not label it as a network failure.

- [ ] **Step 2: Remove protocol-specific client-side path derivation**

Stop deriving `/models` in `CustomProviderFormView.read`. Preserve an explicit advanced path if the user entered one; otherwise omit it and let the network client choose candidates for every supported protocol. Keep the existing same-origin validation for explicit paths.

- [ ] **Step 3: Return the request-only sentinel for empty test and discover forms**

When `purpose` is `test` or `discover` and no model rows exist, return the existing valid sentinel descriptor. Include `modelDiscovery` only when explicitly entered. Keep save behavior requiring at least one real model and keep the sentinel rejected by mutation routes.

- [ ] **Step 4: Render result based on `reachable` and HTTP status**

In `SettingsCustomProviderEditor.test`, treat a non-2xx but reachable response as a non-network warning message such as `服务可达，但鉴权失败（HTTP 401） · ... ms`; only pass `error: true` to the form for `reachable === false`. Preserve redaction and cancellation checks.

- [ ] **Step 5: Remove obsolete utility tests and add candidate-independent form tests**

Delete expectations that `openai-completions` alone derives `/v1/models`; retain tests for explicit relative paths and unsafe URL rejection. Add coverage proving `openai-responses` and `anthropic-messages` both submit a blank discovery path for backend auto-discovery.

- [ ] **Step 6: Run frontend tests**

Run:

```powershell
npx tsx --test test/settings-ui.test.mjs test/provider-settings-ui.test.mjs test/frontend-component-tree.test.mjs
```

Expected: all form lifecycle, cancellation, confirmation, saved-secret, and XSS/URL validation tests pass.

### Task 5: Verify the integrated change and review the diff

**Files:**
- Modify only files covered by Tasks 1-4.

- [ ] **Step 1: Run type checking**

Run `npm run typecheck`; expected exit code 0 with no TypeScript errors.

- [ ] **Step 2: Run focused unit, route, and frontend suites**

Run `npm run test:unit`, `npm run test:routes`, and `npm run test:frontend`; expected zero failures. If the route batch is sensitive to parallelism, rerun the same route files serially and record that evidence.

- [ ] **Step 3: Run the complete test command and CSS-variable gate**

Run `npm test`; expected all suites pass. Run the repository's CSS variable scan if it is not already part of `npm test`.

- [ ] **Step 4: Inspect the diff and verify the requirements**

Run `git diff --check`, `git status --short`, and inspect changed files. Confirm no provider secret, upstream response body, or generated model ID leaks into user-visible errors; confirm no old runtime `ping` path remains in `testConnection`.

- [ ] **Step 5: Request code review before declaring completion**

Review the final diff against commit `e3adcab` and the design document. Fix any critical or important findings, rerun the relevant tests, and only then report completion.
