# Custom Model Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有模型设置页中加入用户级自定义模型厂商，使主会话和子 Agent 能安全使用六种 PI 协议的第三方中转 API，并支持跨窗口热同步；`google-generative-ai` 仅保留在不受影响的官方 Google provider 路径中。

**Architecture:** 以项目自有的 `CustomProviderDefinition`、`ModelDescriptor` 和 `ProviderUsage` 作为稳定边界，非敏感配置与秘密通过带全局 revision 的双文件事务保存。服务层负责引用检查、脱敏和网络操作，`PiCustomProviderAdapter` 是唯一依赖 PI provider API 的模块；每个 server 通过 revision coordinator 在模型列表、切换模型、主聊天和子 Agent 创建前同步共享快照。

**Tech Stack:** TypeScript、Node.js 原生 HTTP/Fetch、PI Coding Agent 0.84.2、`@earendil-works/pi-ai@0.84.2`、Node test runner、happy-dom、全局式前端 TypeScript。

---

## File Map

**New backend modules**

- `src/model-provider/contracts.ts`: 项目自有协议、模型、凭据引用、快照、草稿和 usage 契约；不导入 PI。
- `src/model-provider/custom-provider-store.ts`: 双文件事务、全局 revision、不可变秘密引用、脱敏读取和孤立秘密清理。
- `src/model-provider/pi-custom-provider-adapter.ts`: 六种协议到 PI 的唯一适配边界，包括 keyless transport、字面量认证解析和 usage 转换。
- `src/model-provider/runtime-coordinator.ts`: 每个 `ModelRuntime` 的 loaded revision、并发合并、替换和失败回滚。
- `src/model-provider/provider-reference-checker.ts`: 当前模型、默认模型、自定义 Agent 三类引用检查。
- `src/model-provider/provider-network-client.ts`: 15 秒隔离连接测试、同源模型发现、重定向和错误脱敏。
- `src/model-provider/custom-provider-service.ts`: CRUD、revision 冲突、官方 ID 冲突、引用检查与运行时同步的应用服务。
- `src/server/routes/settings/custom-providers.ts`: 自定义厂商 HTTP API；只调用服务，不读取秘密文件。

**New frontend modules**

- `src/frontend/ui/list-add-action.ts`: 会话、子 Agent、厂商共用的无业务状态新增操作组件。
- `src/frontend/dashboard/settings-custom-provider-editor.ts`: 自定义厂商草稿、认证/Header、多模型、高级设置、测试和发现交互。

**New tests**

- `test/custom-provider-contracts.test.mjs`
- `test/custom-provider-store.test.mjs`
- `test/custom-provider-adapter.test.mjs`
- `test/custom-provider-runtime.test.mjs`
- `test/custom-provider-service.test.mjs`
- `test/custom-provider-network.test.mjs`
- `test/custom-provider-multi-server.test.mjs`
- `test/fixtures/fake-model-provider.mjs`

**Existing files changed by responsibility**

- Data/runtime/server: `src/data/data-layout.ts`, `src/agent/runtime.ts`, `src/server/server.ts`, `src/server/subagent-session.ts`, `src/server/routes/chat.ts`, `src/server/routes/settings.ts`, `src/server/routes/settings/models.ts`, `src/server/routes/types.ts`.
- Frontend: `src/frontend/pane/chat/index.ts`, `src/frontend/dashboard/settings-provider-model.ts`, `src/frontend/dashboard/settings-custom-subagents.ts`, `src/frontend/dashboard/dashboard-settings.ts`, `src/frontend/dashboard.d.ts`, `src/frontend/dashboard.css`, `scripts/compile-frontend-ts.mjs`.
- Gates/tests: `package.json`, `package-lock.json`, `test/data-layout.test.mjs`, `test/pi-sdk-contract.test.mjs`, `test/routes.test.mjs`, `test/settings-ui.test.mjs`, `test/settings-route-structure.test.mjs`, `test/frontend-component-tree.test.mjs`, `test/frontend-xss-sinks.test.mjs`.

### Task 1: Stable Contracts, Validation, and Two-File Store

**Files:**
- Create: `src/model-provider/contracts.ts`
- Create: `src/model-provider/custom-provider-store.ts`
- Create: `test/custom-provider-contracts.test.mjs`
- Create: `test/custom-provider-store.test.mjs`
- Modify: `src/data/data-layout.ts`
- Modify: `test/data-layout.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing contract and data-layout tests**

Test the six allowed custom protocols, rejection of `google-generative-ai` with `provider.protocol`, provider/model ID rules, URL validation, forbidden headers, duplicate model IDs, positive token limits, `maxTokens <= contextWindow`, non-negative USD-per-million prices, and 16 KiB limits for sampling/compatibility objects. Add these layout assertions:

```js
assert.strictEqual(layout.customProvidersFile, resolve(layout.userRoot, "custom-providers.json"))
assert.strictEqual(layout.customProviderSecretsFile, resolve(layout.userRoot, "custom-provider-secrets.json"))
```

The contract test must use this valid fixture and mutate one field per invalid case:

```js
const valid = {
  id: "acme-relay",
  name: "Acme Relay",
  protocol: "openai-responses",
  baseUrl: "https://relay.example.test/v1",
  authMode: "apiKey",
  apiKeyRef: "credential:key-1",
  headers: [{ name: "X-Tenant", credentialRef: "credential:header-1" }],
  models: [{
    id: "reasoner-v1",
    name: "Reasoner V1",
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 },
  }],
}
assert.deepEqual(validateCustomProviderDefinition(valid), valid)
```

- [ ] **Step 2: Run the tests and verify missing contracts fail**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-contracts.test.mjs test/data-layout.test.mjs`

Expected: FAIL because `src/model-provider/contracts.ts` and the two `DataLayout` fields do not exist.

- [ ] **Step 3: Implement the project-owned contracts and strict validators**

Define the public shape exactly once in `contracts.ts`:

```ts
export const PROVIDER_PROTOCOLS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "mistral-conversations",
  "azure-openai-responses",
  "pi-messages",
] as const

export type ProviderProtocol = typeof PROVIDER_PROTOCOLS[number]
export type ProviderAuthMode = "none" | "apiKey"
export type CredentialRef = `credential:${string}`

export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface ModelDescriptor {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  input: Array<"text" | "image">
  cost: ModelCostRates // USD per million tokens
  samplingParams?: Record<string, unknown>
  compatibility?: Record<string, unknown>
}

export interface CustomProviderDefinition {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  authMode: ProviderAuthMode
  apiKeyRef?: CredentialRef
  headers: Array<{ name: string; credentialRef: CredentialRef }>
  modelDiscovery?: string
  models: ModelDescriptor[]
}

export interface CustomProviderSnapshot {
  schemaVersion: 1
  revision: number
  providers: CustomProviderDefinition[]
}

export interface ProviderUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
}

export interface CustomProviderDraft {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  authMode: ProviderAuthMode
  apiKey?: string | null
  headers: Array<{ name: string; value?: string; remove?: boolean }>
  modelDiscovery?: string
  models: ModelDescriptor[]
}

export type RedactedCustomProvider = Omit<CustomProviderDefinition, "apiKeyRef" | "headers"> & {
  apiKeyConfigured: boolean
  headers: Array<{ name: string; configured: boolean }>
}

export interface RedactedCustomProviderSnapshot {
  schemaVersion: 1
  revision: number
  providers: RedactedCustomProvider[]
}

export interface CustomProviderListResponse {
  revision: number
  official: Array<{ id: string; name: string; configured: boolean }>
  custom: RedactedCustomProvider[]
}

export interface ResolvedProviderSecrets {
  apiKey?: string
  headers: Record<string, string>
}

export interface ResolvedCustomProviderDraft {
  provider: Omit<CustomProviderDefinition, "apiKeyRef" | "headers"> & { headers: string[] }
  secrets: ResolvedProviderSecrets
  modelId?: string
}

export interface CustomProviderCapabilities {
  protocols: Array<{ id: ProviderProtocol; supportsCompatibility: boolean; authModes: ProviderAuthMode[] }>
  price: { currency: "USD"; unit: "millionTokens" }
}

// Optimistic concurrency is transport/application metadata, not provider data.
export interface CustomProviderMutationInput {
  expectedRevision: number
  provider: CustomProviderDraft
}

export interface CustomProviderDeleteInput {
  expectedRevision: number
}

export type ConnectionTestResult =
  | { ok: true; providerId: string; modelId: string; latencyMs: number; usage: ProviderUsage }
  | { ok: false; providerId: string; modelId?: string; code: "dns" | "timeout" | "tls" | "authentication" | "rate_limit" | "upstream" | "aborted"; message: string }
```

Export `validateCustomProviderDefinition(value)`, `validateCustomProviderSnapshot(value)`, and `assertSafeHeaderName(name)`. Accept only plain JSON objects; reject unknown top-level/provider/model fields, non-finite numbers, arrays where objects are required, and serialized advanced objects above 16 KiB. Reject header names failing `/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/` and these lowercase names: `host`, `content-length`, `connection`, `transfer-encoding`, `proxy-authorization`, `proxy-authenticate`, `te`, `trailer`, `upgrade`.

Add the two fields to `DataLayout` and resolve both under `userRoot`.

- [ ] **Step 4: Run contract and layout tests**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-contracts.test.mjs test/data-layout.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing transactional store tests**

Cover:

1. empty files return `{ schemaVersion: 1, revision: 0, providers: [] }`;
2. create allocates immutable API-key/Header references and revision 1;
3. omitted secret values preserve old refs, changed values allocate new refs;
4. normal reads contain only `apiKeyConfigured`/`configured` booleans;
5. API key can be explicitly revealed, Header values cannot;
6. two concurrent writers serialize and revisions become 1 then 2;
7. stale `expectedRevision` throws `CustomProviderRevisionConflict`;
8. injected failure before config rename leaves revision and old refs usable;
9. failure after config commit may leave an orphan but cannot break committed refs;
10. deletion commits config first, then removes orphan secrets;
11. malformed config fails closed instead of resetting to empty.

Use an injectable atomic writer so the rollback test is deterministic:

```js
import { writeFile } from "node:fs/promises"

const store = new CustomProviderStore({
  configFile,
  secretsFile,
  atomicWrite: async (path, value) => {
    writes.push(path)
    if (path === configFile) throw new Error("injected config failure")
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  },
})
await assert.rejects(() => store.commit(mutation), /injected config failure/)
assert.equal((await store.readSnapshot()).revision, 0)
```

- [ ] **Step 6: Run the store test and verify it fails**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-store.test.mjs`

Expected: FAIL because `CustomProviderStore` is missing.

- [ ] **Step 7: Implement the versioned two-file transaction**

Use one lock, `${configFile}.lock`, around reading both files and writing both files. Persist secrets as:

```ts
interface CustomProviderSecretsDocument {
  schemaVersion: 1
  values: Record<CredentialRef, string>
}

export interface SecretPatch {
  apiKey?: string | null // undefined=keep, string=replace, null=clear
  headers: Array<{ name: string; value?: string; remove?: boolean }>
}

export type StoredProviderMutation = Omit<CustomProviderDefinition, "apiKeyRef" | "headers"> & {
  headers: string[]
}

export class CustomProviderRevisionConflict extends Error {
  constructor(readonly expectedRevision: number, readonly currentRevision: number) {
    super(`Custom provider revision changed from ${expectedRevision} to ${currentRevision}`)
  }
}
```

Expose these methods:

```ts
class CustomProviderStore {
  readSnapshot(): Promise<CustomProviderSnapshot>
  readRedacted(): Promise<RedactedCustomProviderSnapshot>
  revealApiKey(providerId: string): Promise<string | undefined>
  resolveSecrets(provider: CustomProviderDefinition): Promise<ResolvedProviderSecrets>
  commit(input: {
    expectedRevision: number
    provider?: StoredProviderMutation
    removeProviderId?: string
    secretPatch: SecretPatch
  }): Promise<CustomProviderSnapshot>
}
```

`commit()` must create refs with ``credential:${randomUUID()}``, write a secrets document containing old plus new refs, atomically rename the config document as the commit point, then best-effort rewrite secrets with only refs reachable from the committed config. Do not use `recoverInvalidJson`; malformed persisted data must throw.

- [ ] **Step 8: Add the new tests to the serialized unit command and run them**

Modify `test:unit` so `test/custom-provider-contracts.test.mjs` and `test/data-layout.test.mjs` run in its normal section, while `test/custom-provider-store.test.mjs` runs in the final `--test-concurrency=1` section with file-lock tests.

Run: `npm run test:unit`

Expected: PASS, including store concurrency and rollback tests.

- [ ] **Step 9: Commit the contracts and store**

```bash
git add src/model-provider/contracts.ts src/model-provider/custom-provider-store.ts src/data/data-layout.ts test/custom-provider-contracts.test.mjs test/custom-provider-store.test.mjs test/data-layout.test.mjs package.json
git commit -m "feat: add custom provider contracts and store"
```

### Task 2: PI Adapter and Seven-Protocol Mapping

**Files:**
- Create: `src/model-provider/pi-custom-provider-adapter.ts`
- Create: `test/custom-provider-adapter.test.mjs`
- Modify: `test/pi-sdk-contract.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install PI AI as an exact direct dependency**

Run: `npm install --save-exact @earendil-works/pi-ai@0.84.2`

Expected: `package.json` contains `"@earendil-works/pi-ai": "0.84.2"`; `package-lock.json` resolves a registry tarball and contains no `file:` reference.

- [ ] **Step 2: Write failing SDK-boundary and adapter tests**

Extend `pi-sdk-contract.test.mjs` to assert `createProvider` and `lazyApi` are exported by the direct dependency, `ModelRuntime.prototype.registerNativeProvider` exists, and the official Google provider remains unchanged. In the adapter test, table-drive all six custom protocols:

```js
for (const protocol of PROVIDER_PROTOCOLS) {
  const prepared = adapter.prepare(definition({ protocol }), secrets())
  assert.equal(prepared.providerId, "acme-relay")
  assert.equal(prepared.models[0].api, protocol)
}
```

Also assert:

- both modes construct native providers and call only `registerNativeProvider(provider)`;
- resolved API Key and Header values remain literal when they contain `!command`, `$NAME` or `${NAME}` and are absent from diagnostics/serialization;
- all six custom protocols support `none` through request-local wrapped streams; SDK-generated auth Header/query values never reach transport, while explicitly configured Header values remain unchanged;
- Google Generative AI is absent from custom capabilities and fails draft validation at `provider.protocol`; the official Google provider keeps its existing auth, models, and sessions;
- keyless `provider.auth.apiKey.check()` returns `{ type: "api_key", source: "custom-provider" }`;
- keyless `resolve()` returns the explicitly configured Headers without a dedicated API Key;
- model costs remain USD per million tokens;
- PI usage maps to project `ProviderUsage` and does not double-count reasoning.

- [ ] **Step 3: Run adapter tests and verify they fail**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-adapter.test.mjs test/pi-sdk-contract.test.mjs`

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement the only PI-specific adapter**

Use the direct package only in this module. Build protocol streams with `lazyApi` so SDK modules load on first request:

```ts
const API_STREAMS: Record<ProviderProtocol, ProviderStreams> = {
  "openai-completions": lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
  "openai-responses": lazyApi(() => import("@earendil-works/pi-ai/api/openai-responses"), { fetchDeferred: true, cancelDeferred: true }),
  "anthropic-messages": lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages")),
  "mistral-conversations": lazyApi(() => import("@earendil-works/pi-ai/api/mistral-conversations")),
  "azure-openai-responses": lazyApi(() => import("@earendil-works/pi-ai/api/azure-openai-responses"), { fetchDeferred: true, cancelDeferred: true }),
  "pi-messages": lazyApi(() => import("@earendil-works/pi-ai/api/pi-messages")),
}
```

Map each project model to PI without leaking PI types to callers:

```ts
function toPiModel(provider: CustomProviderDefinition, model: ModelDescriptor): Model<Api> {
  return {
    id: model.id,
    name: model.name,
    api: provider.protocol,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    samplingParams: model.samplingParams,
    compat: model.compatibility,
  }
}
```

Create a native provider for both auth modes. Resolve literal secrets from a private closure rather than PI configuration expressions:

```ts
auth: {
  apiKey: {
    name: provider.name,
    check: async () => ({ type: "api_key", source: "custom-provider" }),
    resolve: async () => ({ auth: { apiKey, headers }, source: "custom-provider" }),
  },
}
```

For `none`, omit `apiKey` from the resolved auth and wrap `stream`/`streamSimple` for all six custom protocols with a request-local keyless transport. Use a unique in-memory compatibility value only to pass SDK prechecks, remove only sentinel-derived authentication before the actual fetch, preserve explicit custom Header values, and redact the sentinel from events/results/errors. Do not mutate `globalThis.fetch`. Reject every protocol outside the project-owned six-protocol set, including Google Generative AI, with a typed validation error before adapter construction.

Expose `prepare()`, async `replaceRuntimeProviders()`, and `toProviderUsage()`. `prepare()` must finish all validation and provider construction before mutating a runtime. `replaceRuntimeProviders()` unregisters only exact provider objects previously owned by this adapter, registers the complete prepared set, and awaits a targeted non-network `ModelRuntime.refresh()` before succeeding. Registration or refresh failure restores and refreshes the previous set; incomplete rollback reports a distinct aggregate failure while retaining truthful ownership of every exact adapter-installed object still present.

- [ ] **Step 5: Run adapter and SDK tests**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-adapter.test.mjs test/pi-sdk-contract.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run typecheck and commit**

Run: `npm run typecheck`

Expected: PASS with no import from PI internals outside the adapter and SDK contract test.

```bash
git add package.json package-lock.json src/model-provider/pi-custom-provider-adapter.ts test/custom-provider-adapter.test.mjs test/pi-sdk-contract.test.mjs
git commit -m "feat: adapt custom providers to pi runtime"
```

### Task 3: Revision Coordinator and Main/Subagent Sync Hooks

**Files:**
- Create: `src/model-provider/runtime-coordinator.ts`
- Create: `test/custom-provider-runtime.test.mjs`
- Modify: `src/agent/runtime.ts`
- Modify: `src/server/subagent-session.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/routes/settings/models.ts`
- Modify: `test/subagent-session-factory.test.mjs`
- Modify: `test/pi-sdk-contract.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing coordinator tests**

Use a fake store and adapter to prove:

- revision 0 loads once;
- unchanged revisions do not rebuild;
- three concurrent calls share one Promise and one store read/apply;
- revision 2 finishing before an older revision 1 cannot be overwritten;
- adapter failure preserves `loadedRevision` and the previous runtime providers;
- the next call retries the failed revision.

Required API:

```ts
const coordinator = new CustomProviderRuntimeCoordinator({ store, adapter })
assert.equal(await coordinator.sync(modelRuntime), 4)
assert.equal(coordinator.loadedRevision(modelRuntime), 4)
```

- [ ] **Step 2: Run coordinator tests and verify they fail**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-runtime.test.mjs`

Expected: FAIL because `runtime-coordinator.ts` is missing.

- [ ] **Step 3: Implement per-runtime monotonic synchronization**

Use `WeakMap<ModelRuntime, RuntimeSyncState>` so workspace session rebuilds do not inherit stale state:

```ts
interface RuntimeSyncState {
  loadedRevision: number
  requestedGeneration: number
  inFlight?: Promise<number>
}

sync(runtime: ModelRuntime): Promise<number> {
  const state = this.stateFor(runtime)
  state.requestedGeneration++
  if (state.inFlight) return state.inFlight
  const pending = Promise.resolve().then(() => this.drain(runtime, state))
  state.inFlight = pending
  return pending
}
```

Start the first drain in a microtask so same-tick callers share one generation, Promise, read, and apply. Each later boundary increments `requestedGeneration`; if it arrives after the drain captured its current generation, the shared Promise performs another inspection before resolving, including when the trailing revision is unchanged. `loadAndApply` reads the validated snapshot, skips `revision <= loadedRevision`, resolves secrets only for that snapshot, prepares all providers, awaits one apply, then sets `loadedRevision`. Never advance revision before adapter success and provider availability refresh. A normal failed apply preserves the prior revision; an explicitly incomplete rollback poisons it to `-1` so the same disk revision fully reconciles on the next boundary. Any drain failure rejects all shared callers, clears `inFlight`, and remains retryable without polling.

- [ ] **Step 4: Run coordinator tests**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-runtime.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing runtime wiring tests**

Assert source and behavior for all safe boundaries:

```text
AgentRuntime._initSession: after ModelRuntime.create, before ModelRegistry/createAgentSession
GET /api/models: before reading modelRegistry
POST /api/model/switch: before find(provider, modelId)
POST /api/chat: before session.prompt
embedded subagent factory: before resolveModel/createAgentSession
```

Add a runtime behavioral test where `session.isStreaming` is true: a background refresh waits for `waitForIdle()`, while a foreground chat call awaits the same synchronization promise.

- [ ] **Step 6: Run wiring tests and verify missing sync calls fail**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-runtime.test.mjs test/subagent-session-factory.test.mjs test/pi-sdk-contract.test.mjs`

Expected: FAIL because `RuntimeConfig.syncModelProviders` and the safe-boundary calls do not exist.

- [ ] **Step 7: Add the runtime API and safe-boundary calls**

Extend `RuntimeConfig` and `AgentRuntime`:

```ts
syncModelProviders?: (runtime: ModelRuntime) => Promise<number>

async syncModelProviders(): Promise<number> {
  if (!this.config.syncModelProviders) return 0
  if (this._session?.isStreaming) await this._session.waitForIdle()
  const active = this._session?.model
  const revision = await this.config.syncModelProviders(this.modelRuntime)
  if (active && this._session) {
    const refreshed = this.modelRegistry.find(active.provider, active.id)
    if (refreshed && refreshed !== active) await this._session.setModel(refreshed)
  }
  return revision
}

syncModelProvidersForSubagent(): Promise<number> {
  return this.config.syncModelProviders?.(this.modelRuntime) ?? Promise.resolve(0)
}
```

Call the config hook directly after `ModelRuntime.create()` during initialization, before constructing `ModelRegistry`. Foreground model-list/chat boundaries call `await runtime.syncModelProviders()` before capturing `session` or `modelRegistry`; this method waits for an active stream to become idle and may rebind the active model object. The embedded subagent boundary instead awaits `syncModelProvidersForSubagent()` before `resolveModel()`; it synchronizes only the shared `ModelRuntime`, never waits on or rebinds the invoking parent session, avoiding a delegate-tool deadlock. Serialize model switching with session transitions, then synchronize, re-resolve against the current registry, call `setModel()` on that same stable session, and persist only after the switch succeeds; restore the prior model if persistence fails. If pre-prompt synchronization fails, terminate the attached SSE turn through the normal sanitized error lifecycle before returning an HTTP error.

Saving settings later will trigger `void runtime.syncModelProviders()` so persistence can respond immediately; foreground model/chat operations still await it.

- [ ] **Step 8: Run runtime, subagent, and route tests**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-runtime.test.mjs test/subagent-session-factory.test.mjs test/pi-sdk-contract.test.mjs test/routes.test.mjs`

Expected: PASS and existing model switching/chat tests remain green.

- [ ] **Step 9: Add tests to unit command and commit**

Add `test/custom-provider-adapter.test.mjs` and `test/custom-provider-runtime.test.mjs` to `test:unit`.

```bash
git add src/model-provider/runtime-coordinator.ts src/agent/runtime.ts src/server/subagent-session.ts src/server/routes/chat.ts src/server/routes/settings/models.ts test/custom-provider-runtime.test.mjs test/subagent-session-factory.test.mjs test/pi-sdk-contract.test.mjs package.json
git commit -m "feat: synchronize custom providers at runtime boundaries"
```

### Task 4: Service, Reference Checks, and CRUD Routes

**Files:**
- Create: `src/model-provider/provider-reference-checker.ts`
- Create: `src/model-provider/custom-provider-service.ts`
- Create: `src/server/routes/settings/custom-providers.ts`
- Create: `test/custom-provider-service.test.mjs`
- Modify: `src/server/routes/types.ts`
- Modify: `src/server/routes/settings.ts`
- Modify: `src/server/server.ts`
- Modify: `test/routes.test.mjs`
- Modify: `test/settings-route-structure.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing reference-checker and service tests**

Build fixtures for these references:

```ts
type ProviderReference =
  | { kind: "currentModel"; providerId: string; modelId: string }
  | { kind: "defaultModel"; providerId: string; modelId: string }
  | { kind: "customAgent"; providerId: string; modelId: string; agentId: string; agentName: string }

class CustomProviderReferenceConflict extends Error {
  constructor(readonly references: ProviderReference[]) {
    super("Custom provider is still in use")
  }
}
```

Assert removing a provider or removing one model in `PUT` returns every matching reference; editing name/Base URL does not. Service tests must also cover official-provider collision, duplicate custom ID, stale revision, immutable provider ID on update, successful create/update/delete, and redacted list output.

- [ ] **Step 2: Run service tests and verify they fail**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-service.test.mjs`

Expected: FAIL because the checker and service do not exist.

- [ ] **Step 3: Implement reference checking and application service**

Read existing state through injected functions so tests do not need a server:

```ts
interface ProviderReferenceSources {
  currentModel(): { provider: string; id: string } | undefined
  defaultModel(): { provider: string; id: string } | undefined
  customAgents(): SubagentDefinition[]
}
```

Expose this service API:

```ts
class CustomProviderService {
  capabilities(): CustomProviderCapabilities
  list(runtime: ModelRuntime): Promise<CustomProviderListResponse>
  create(input: CustomProviderMutationInput, runtime: ModelRuntime): Promise<RedactedCustomProviderSnapshot>
  update(id: string, input: CustomProviderMutationInput, runtime: ModelRuntime): Promise<RedactedCustomProviderSnapshot>
  delete(id: string, input: CustomProviderDeleteInput, runtime: ModelRuntime): Promise<RedactedCustomProviderSnapshot>
  revealApiKey(id: string): Promise<string>
  syncRuntime(runtime: ModelRuntime): Promise<number>
}
```

Capture official IDs independently for each runtime before its first custom sync, and retain a process-lifetime set of IDs observed as custom. Do not infer that a delayed runtime entry is official merely because it is absent from the current disk snapshot. Every mutation must require `expectedRevision`. On removed models/provider, throw `CustomProviderReferenceConflict` with `references`; on stale revision throw a stable conflict containing current revision. The service returns after persistence and does not own `AgentRuntime` lifecycle.

HTTP write bodies use the same explicit envelopes: create/update receive `{ expectedRevision, provider }`, and delete receives `{ expectedRevision }`. `expectedRevision` must not be added to or inferred from `CustomProviderDraft`.

Hardening requirements for this task:

- Validate exact request and draft shapes in project contracts and again at the service boundary, with typed safe field paths. Unknown-field and corrupt JSON errors use stable parent paths/messages and never echo attacker-controlled keys or credential data.
- Treat `apiKey: null` as an explicit clear; stored API-key definitions may be unconfigured and the runtime coordinator skips them until a non-empty key is restored.
- Use one user-level cross-process provider-reference lock. Lock order is provider-reference lock, runtime stable-session/transition lock, then the existing settings/subagent/provider-store file lock.
- Hold that outer lock across strict reference reads and destructive provider commit. Model/default-model and custom-agent writers acquire the same lock before syncing, validating, and mutating references.
- Strict settings/subagent readers fail closed for malformed or unreadable data during destructive checks; tolerant readers remain for non-destructive UI paths.
- Custom-provider routes authorize the secrets read for reveal and both config/secrets writes for mutations, then use the established permission response and audit path.

- [ ] **Step 4: Run service tests**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-service.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing CRUD route tests**

Add route tests for:

- `GET /api/custom-providers/capabilities` returns the six custom protocols and USD-per-million price metadata;
- `GET /api/custom-providers` returns official summaries plus redacted custom definitions;
- `POST`, `PUT`, `DELETE` pass revision and return the new snapshot;
- official collision is 409;
- stale revision is 409 with `code: "revision_conflict"`;
- references are 409 with `code: "provider_in_use"` and a structured list;
- missing `ctx.customProviderService` is 503 fail-closed;
- `POST /api/custom-providers/reveal` returns only an explicitly requested API key and never Header values;
- ordinary responses and thrown error bodies do not contain fixture secrets.

- [ ] **Step 6: Run route tests and verify 404/failures**

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/routes.test.mjs test/settings-route-structure.test.mjs`

Expected: FAIL because the dispatcher has no custom-provider handler.

- [ ] **Step 7: Implement the route and server wiring**

Add `customProviderService?: CustomProviderService` to `ServerContext`. The route must use `parseBody`, JSON responses, stable status mapping, and no direct file reads:

```ts
if (!ctx.customProviderService) {
  res.writeHead(503, { "Content-Type": "application/json", ...cors })
  res.end(JSON.stringify({ error: "Custom providers unavailable", code: "service_unavailable" }))
  return true
}
```

Register `handleCustomProviderSettings` before `handleModelSettings` in `settings.ts`.

After a successful create/update/delete response payload is ready, the route schedules `void ctx.runtime.syncModelProviders().catch(() => console.error("[custom-provider] background sync failed"))` without awaiting it. This lets a save complete during streaming while the same runtime waits for idle; foreground safe boundaries still await synchronization.

In `server.ts`, construct the store from `STARTUP.layout.customProvidersFile` and `customProviderSecretsFile`, then construct adapter, coordinator, checker and service. Pass:

```ts
syncModelProviders: modelRuntime => customProviderService.syncRuntime(modelRuntime)
```

to `initAgent`, and pass `customProviderService` into the route context. Reference sources must read `runtime.session.model`, `readUserPreferences(SETTINGS_FILE)`, and `readSubagentDefinitions(SUBAGENTS_FILE)` at check time, not cache startup copies.

- [ ] **Step 8: Run focused service/routes tests**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-service.test.mjs test/settings-route-structure.test.mjs`

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/routes.test.mjs`

Expected: both commands PASS.

- [ ] **Step 9: Add service tests to unit command and commit**

```bash
git add src/model-provider/provider-reference-checker.ts src/model-provider/custom-provider-service.ts src/server/routes/settings/custom-providers.ts src/server/routes/types.ts src/server/routes/settings.ts src/server/server.ts test/custom-provider-service.test.mjs test/routes.test.mjs test/settings-route-structure.test.mjs package.json
git commit -m "feat: add custom provider management routes"
```

### Task 5: Isolated Connection Test and Same-Origin Model Discovery

**Files:**
- Create: `src/model-provider/provider-network-client.ts`
- Create: `test/custom-provider-network.test.mjs`
- Modify: `src/model-provider/custom-provider-service.ts`
- Modify: `src/server/routes/settings/custom-providers.ts`
- Modify: `test/routes.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing network-client tests**

Start local HTTP fixtures on random ports and verify:

- discovery runs only when called and parses `{ data: [{ id: "a" }, { id: "b" }] }`;
- a relative discovery path resolves against Base URL;
- a different-origin URL is rejected before fetch;
- 301/302/307/308 are rejected instead of followed;
- forbidden/invalid response shape reports `unsupported_response`;
- 15-second timeout maps to `timeout` (inject a shorter timeout in tests);
- DNS, TLS, 401/403, 429 and 5xx map to stable codes;
- API key/Header values are removed from messages and truncated response excerpts;
- connection tests receive an in-memory draft and do not call store `commit()` or current runtime `setModel()`.

- [ ] **Step 2: Run network tests and verify they fail**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-network.test.mjs`

Expected: FAIL because `ProviderNetworkClient` is missing.

- [ ] **Step 3: Implement explicit network operations**

Expose:

```ts
class ProviderNetworkClient {
  testConnection(input: ResolvedCustomProviderDraft, signal?: AbortSignal): Promise<ConnectionTestResult>
  discoverModels(input: ResolvedCustomProviderDraft, signal?: AbortSignal): Promise<{ ids: string[] }>
}
```

Create an internal abort controller, combine caller cancellation with a default 15,000 ms timeout, and always clear the timer. Discovery must compare `new URL(discoveryUrl, baseUrl).origin === new URL(baseUrl).origin`, call `fetch(..., { redirect: "manual" })`, reject every 3xx, cap body reads at 64 KiB, and return unique non-empty IDs only.

Connection testing must create an isolated `ModelRuntime` with `refreshOnCreate: false` and `modelsPath: null`, register only the draft through the adapter, choose the explicitly requested model, and call `completeSimple()` with one minimal user message. Return model identity, latency, normalized `ProviderUsage`, and a redacted error category; never return raw response headers or full body.

- [ ] **Step 4: Run network tests**

Run: `node scripts/tsx-test.mjs --test test/custom-provider-network.test.mjs`

Expected: PASS.

- [ ] **Step 5: Add failing route tests for test/discovery**

Assert `POST /api/custom-providers/test` and `/discover-models` accept a draft plus in-memory secrets, do not persist, return stable result shapes, and preserve the saved snapshot revision. Assert testing failure still permits a later save request.

- [ ] **Step 6: Wire service and route methods, then run tests**

Add service methods:

```ts
testConnection(draft: CustomProviderDraft, signal?: AbortSignal): Promise<ConnectionTestResult>
discoverModels(draft: CustomProviderDraft, signal?: AbortSignal): Promise<{ ids: string[] }>
```

For saved credentials, resolve missing draft values in memory; for an unsaved provider, require values needed by its selected auth mode/Header list. Pass request abort/close to the network client without logging the draft.

Run: `node scripts/tsx-test.mjs --test test/custom-provider-network.test.mjs`

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/routes.test.mjs`

Expected: both PASS.

- [ ] **Step 7: Add the network test to unit and commit**

```bash
git add src/model-provider/provider-network-client.ts src/model-provider/custom-provider-service.ts src/server/routes/settings/custom-providers.ts test/custom-provider-network.test.mjs test/routes.test.mjs package.json
git commit -m "feat: test and discover custom provider models"
```

### Task 6: Shared ListAddAction Component

**Files:**
- Create: `src/frontend/ui/list-add-action.ts`
- Modify: `src/frontend/pane/chat/index.ts`
- Modify: `src/frontend/dashboard/settings-custom-subagents.ts`
- Modify: `src/frontend/dashboard.css`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `scripts/compile-frontend-ts.mjs`
- Modify: `test/settings-ui.test.mjs`
- Modify: `test/frontend-component-tree.test.mjs`
- Modify: `test/frontend-xss-sinks.test.mjs`

- [ ] **Step 1: Write failing component-tree and interaction tests**

Assert the shared module exports/installs one `ListAddAction` component; chat and subagent source call it and no longer contain copied `.ch-new`/`.sa-add-btn` markup. In happy-dom, verify click and Enter/Space activation call once, disabled blocks activation, and text is set with `textContent` so hostile labels stay inert.

- [ ] **Step 2: Run frontend tests and verify component is missing**

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs`

Expected: FAIL because `ListAddAction` and its bundle entry do not exist.

- [ ] **Step 3: Implement and bundle the shared component**

Create a DOM-based component, not an HTML string helper:

```ts
interface ListAddActionOptions {
  id?: string
  label: string
  disabled?: boolean
  onActivate: () => void
}

class ListAddAction {
  static create(options: ListAddActionOptions): HTMLButtonElement {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "list-add-action"
    if (options.id) button.id = options.id
    button.disabled = options.disabled === true
    const icon = document.createElement("span")
    icon.className = "list-add-action-icon"
    icon.textContent = "+"
    const label = document.createElement("span")
    label.textContent = options.label
    button.append(icon, label)
    button.addEventListener("click", options.onActivate)
    return button
  }
}
```

Publish it through `App.Ui.ListAddAction`, declare it in `dashboard.d.ts`, and add its generated JS before chat/subagent/settings consumers in `compile-frontend-ts.mjs`. Style a full-width, fixed-height action with the current `.ch-new` spacing and focus-visible state; remove obsolete `.ch-new`, `.ch-new-icon`, and `.sa-add-btn` rules after migration.

In chat, create a mount placeholder and prepend `ListAddAction.create({ id: "ch-new-btn", label: "开启新对话", onActivate: () => App.Session.newSession() })`. In subagents, mount `label: "新建 Agent"` and call `startNew()`.

- [ ] **Step 4: Run frontend tests**

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs`

Expected: PASS with no new unapproved HTML sink.

- [ ] **Step 5: Compile frontend and commit**

Run: `npm run compile:frontend-ts`

Expected: PASS.

```bash
git add src/frontend/ui/list-add-action.ts src/frontend/pane/chat/index.ts src/frontend/dashboard/settings-custom-subagents.ts src/frontend/dashboard.css src/frontend/dashboard.d.ts scripts/compile-frontend-ts.mjs test/settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs
git commit -m "refactor: share list add action component"
```

### Task 7: Unified Provider List and Custom Provider Editor

**Files:**
- Create: `src/frontend/dashboard/settings-custom-provider-editor.ts`
- Modify: `src/frontend/dashboard/settings-provider-model.ts`
- Modify: `src/frontend/dashboard/dashboard-settings.ts`
- Modify: `src/frontend/dashboard.css`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `scripts/compile-frontend-ts.mjs`
- Modify: `test/settings-ui.test.mjs`
- Modify: `test/frontend-component-tree.test.mjs`
- Modify: `test/frontend-xss-sinks.test.mjs`

- [ ] **Step 1: Write failing settings UI tests**

Mock `/api/auth`, `/api/custom-providers`, `/capabilities`, `/test`, `/discover-models`, and CRUD responses. Verify:

- official and custom providers are in one `.msl-list`;
- custom items show `自定义` and the shared `添加自定义厂商` action;
- `providers_order` contains both dynamic official IDs and custom IDs, preserving saved order and appending unseen IDs;
- official selection still renders API key/reveal/models behavior unchanged;
- new custom draft requires explicit `none` or `apiKey`;
- provider ID becomes read-only after create and duplicate/official IDs show field errors;
- Header values display only `已保存`, empty means keep, and no Header reveal request exists;
- multiple models can be added/removed; advanced settings are collapsed initially;
- discover modifies only the draft after user confirms imported IDs;
- failed test displays a redacted error and does not disable Save;
- stale revision reloads latest state and preserves unsaved form values in an explicit conflict banner;
- provider/model reference conflicts render the structured occupancy list;
- delete requires two clicks;
- hostile names, IDs, model IDs and network error text remain inert DOM text.

- [ ] **Step 2: Run settings tests and verify they fail**

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs`

Expected: FAIL because the editor and dynamic custom provider list are missing.

- [ ] **Step 3: Implement the focused custom editor controller**

Give the editor an explicit dependency boundary:

```ts
interface SettingsCustomProviderEditorDependencies {
  notify: typeof toast
  listAddAction: typeof ListAddAction
  onSaved: (snapshot: RedactedCustomProviderSnapshot, selectedId: string) => void
  onDeleted: (snapshot: RedactedCustomProviderSnapshot) => void
}

class SettingsCustomProviderEditor {
  mount(container: HTMLElement, provider: RedactedCustomProvider | null, revision: number): void
  startNew(container: HTMLElement, revision: number): void
  save(): Promise<void>
  test(): Promise<void>
  discoverModels(): Promise<void>
  delete(): Promise<void>
}
```

Build form controls with DOM APIs and `textContent`; do not interpolate provider-originated values into `innerHTML`. The basic form contains name, ID, protocol and Base URL. Authentication is a segmented `none`/`apiKey` control. Header rows contain name, password input and configured status. Model rows contain ID/name/context/max/reasoning/input; a `<details>` element owns USD-per-million costs, sampling JSON and compatibility JSON.

Send `expectedRevision` in every write. Omit unchanged secret values, send `null` only for explicit API-key clearing, and send Header `remove: true` only after an explicit row deletion. Keep test/discovery drafts in memory and never merge them into the saved snapshot until Save succeeds.

- [ ] **Step 4: Refactor provider owner to dynamic unified ordering**

`SettingsProviderModelController.renderTab()` must fetch `/api/auth`, `/api/custom-providers`, and `/api/custom-providers/capabilities` together. Replace the hardcoded array with:

```ts
const allProviderIds = [
  ...providerSnapshot.official.map(provider => provider.id),
  ...providerSnapshot.custom.map(provider => provider.id),
]
const saved = this.dependencies.preferences.getJson<string[]>("providers_order", [])
const order = saved.filter(id => allProviderIds.includes(id))
for (const id of allProviderIds) if (!order.includes(id)) order.push(id)
```

Use `SettingsCustomProviderEditor` only for custom selections; official selections retain existing `/api/auth/reveal`, key saving, model list and switch behavior. Mount `ListAddAction` at the provider-list edge with `添加自定义厂商`. Drag/drop must persist the unified order.

- [ ] **Step 5: Declare/bundle the editor and run frontend tests**

Add its API types to `dashboard.d.ts`. Place `gen/dashboard/settings-custom-provider-editor.js` after `ui/list-add-action.js` and before `settings-provider-model.js` in `compile-frontend-ts.mjs`. Extend the component-tree gate to enforce that ownership and keep `dashboard-settings.ts` thin.

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs`

Expected: PASS.

- [ ] **Step 6: Run frontend typecheck/build and commit**

Run: `npm run typecheck:frontend`

Run: `npm run test:build`

Expected: both PASS.

```bash
git add src/frontend/dashboard/settings-custom-provider-editor.ts src/frontend/dashboard/settings-provider-model.ts src/frontend/dashboard/dashboard-settings.ts src/frontend/dashboard.css src/frontend/dashboard.d.ts scripts/compile-frontend-ts.mjs test/settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs
git commit -m "feat: add custom provider settings editor"
```

### Task 8: Multi-Server and Protocol Integration, Regression Gates, Manual Acceptance

**Files:**
- Create: `test/fixtures/fake-model-provider.mjs`
- Create: `test/custom-provider-multi-server.test.mjs`
- Modify: `test/custom-provider-adapter.test.mjs`
- Modify: `test/routes.test.mjs`
- Modify: `package.json`
- Modify: `docs/任务清单.md`

- [ ] **Step 1: Write failing two-server synchronization test**

Create two independent stores/services/coordinators using the same config/secrets files and separate `ModelRuntime` instances. Prove:

1. server A saves revision 1;
2. server B remains at revision 0 until a safe-boundary sync;
3. server B syncs once, sees the new model, and reports revision 1;
4. concurrent A/B writes with expected revision 1 produce one revision 2 and one 409-equivalent conflict, never a lost update;
5. deleting a referenced model is rejected before either runtime changes;
6. a failed runtime reload leaves disk revision newer, B keeps its previous usable model, and the next safe boundary retries successfully.

- [ ] **Step 2: Run the multi-server test and verify any missing behavior fails**

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/custom-provider-multi-server.test.mjs`

Expected: FAIL until the complete revision/retry path is connected.

- [ ] **Step 3: Close multi-server gaps without adding polling**

Fix only behaviors exposed by Step 2. The accepted mechanism is file revision inspection at the four foreground boundaries plus background sync scheduled after a local save; do not add `setInterval`, file watchers, renderer polling, or cross-window broadcast requirements.

The final assertion must be:

```js
assert.equal(await coordinatorB.sync(runtimeB), committedRevision)
assert.ok(registryB.find("acme-relay", "reasoner-v1"))
const serverSource = await readFile(resolve("src/server/server.ts"), "utf8")
assert.doesNotMatch(serverSource, /setInterval\(|fs\.watch\(/)
```

- [ ] **Step 4: Add deterministic six-protocol fake-provider coverage**

Implement `startFakeModelProvider(protocol)` as a local random-port fixture that records method/path/headers/body, emits protocol-valid streaming text, one tool call, terminal usage, and supports abort. Extend adapter tests with API-Key and keyless tables over all six custom protocols. Assert:

- configured Base URL and custom headers reach the fixture;
- keyless requests send no SDK-generated authentication, while explicitly configured auth Header values are preserved;
- `apiKey` sends the configured key but test output/log capture does not contain it;
- streamed text and tool call reach PI's normalized event stream;
- terminal usage converts exactly to `ProviderUsage`;
- abort closes the request and yields an aborted terminal state.

- [ ] **Step 5: Run integration tests**

Run: `node scripts/tsx-test.mjs --test --test-concurrency=1 test/custom-provider-adapter.test.mjs test/custom-provider-multi-server.test.mjs`

Expected: PASS for all six API-Key mappings, all six keyless mappings, and both server runtimes.

- [ ] **Step 6: Register final tests and update the task document**

Add the multi-server test to the final serialized unit segment. Mark only “设置页模型页增加用户自定义厂商选项” complete in `docs/任务清单.md`; keep NativeAgentEngine and unrelated roadmap work unchanged. Record the stable boundaries: project contract, PI adapter, shared userRoot storage, USD per million tokens, and revision sync.

- [ ] **Step 7: Run all automated gates**

Run: `npm run typecheck`

Expected: PASS.

Run: `npm test`

Expected: PASS, including unit/routes/frontend suites and CSS variable gate.

Run: `npm run build`

Expected: PASS.

Run: `git diff --check`

Expected: no output and exit code 0.

- [ ] **Step 8: Perform desktop manual acceptance**

Run: `npm run dev`

Verify in order:

1. Settings > Models shows official providers unchanged and an `添加自定义厂商` action matching the chat/subagent add controls.
2. Add one relay provider with two models, one secret Header, and explicit `apiKey`; test succeeds and Save is independent.
3. Switch to the first model and complete a chat containing one tool call; usage updates from the provider response.
4. Select the custom model in a custom Agent and complete one delegated task.
5. Attempt to delete the active model/provider and confirm the current/default/custom-Agent occupancy list blocks it.
6. Open a second project window, edit the provider in the first, then send from the second; it synchronizes before the request without restart.
7. Restart the application and confirm provider/model/order return while API key and Header values remain masked.
8. Add a supported custom `none` provider to a local endpoint and verify no SDK-generated authentication header is sent; then configure an explicit secret Header and verify its exact value is preserved.
9. Enter a failing URL, verify the test error is redacted, then save successfully anyway.

- [ ] **Step 9: Commit integration and documentation**

```bash
git add test/fixtures/fake-model-provider.mjs test/custom-provider-multi-server.test.mjs test/custom-provider-adapter.test.mjs test/routes.test.mjs package.json docs/任务清单.md
git commit -m "test: verify custom providers end to end"
```

## Self-Review Checklist

- [x] Every design requirement maps to Tasks 1-8: six custom protocols excluding Google Generative AI, unchanged official Google behavior, explicit auth mode, secret Headers, optional discovery, isolated testing, deletion references, global storage, revision sync, usage conversion, unified list, shared add action, and manual acceptance.
- [x] Confirm the plan contains no placeholder markers, deferred implementation promises, or vague error-handling instructions.
- [x] Confirm names stay consistent: `CustomProviderDefinition`, `CustomProviderSnapshot`, `ModelDescriptor`, `ProviderUsage`, `CustomProviderStore`, `PiCustomProviderAdapter`, `CustomProviderRuntimeCoordinator`, `CustomProviderService`, and `SettingsCustomProviderEditor`.
- [x] Confirm no module outside `pi-custom-provider-adapter.ts` and `pi-sdk-contract.test.mjs` imports PI provider-construction types.
- [x] Confirm every mutation carries `expectedRevision`, configuration is the transaction commit point, and Header values have no reveal API.
- [x] Confirm price units remain USD per million tokens from form labels through contract, PI model cost, and tests.
