# Provider Settings Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded provider split view with a configured-provider card list, a separate provider picker, and a simplified drill-down editor while preserving all existing authentication, secret, revision, and model-switch behavior.

**Architecture:** Keep `SettingsProviderModelController` as the orchestration boundary and keep `SettingsCustomProviderEditor` as the network/mutation owner. Add pure provider presentation utilities and DOM-backed views before those controllers in the frontend bundle. Reuse the existing server APIs and custom-provider contracts; only the frontend derives a temporary same-origin `/models` candidate for explicit OpenAI-compatible discovery.

**Tech Stack:** TypeScript compiled as ordered browser scripts, DOM APIs, existing CSS variables, Node test runner with happy-dom, existing Vite/Electron build scripts.

---

## File Map

**Create**

- `src/frontend/dashboard/settings-provider-utils.ts`: pure provider name, initials, icon, host, generated-ID, and discovery-path helpers.
- `src/frontend/dashboard/settings-provider-views.ts`: `ProviderCardListView`, `ProviderPickerView`, `OfficialProviderEditorView`, and provider identity DOM rendering.
- `src/frontend/dashboard/settings-custom-provider-form.ts`: common/advanced custom-provider form rendering, preset defaults, draft reads, field errors, and generated-ID state.
- `src/frontend/icons/providers/{anthropic,deepseek,google,openai,openrouter}.svg`: bundled official provider icons.
- `src/frontend/icons/providers/NOTICE.txt`: source and MIT attribution for copied icon assets.
- `test/provider-settings-ui.test.mjs`: focused tests for provider utilities, views, navigation, and form hierarchy.

**Modify**

- `src/frontend/dashboard/settings-provider-model.ts`: replace split-list rendering with three-view orchestration and configured-provider filtering.
- `src/frontend/dashboard/settings-custom-provider-editor.ts`: delegate form DOM work to `CustomProviderFormView` while preserving network and revision lifecycle.
- `src/frontend/dashboard/dashboard-settings.ts`: remove obsolete list/drag delegation and keep modal/tab ownership only.
- `src/frontend/dashboard.d.ts`: add view/form contracts and update controller APIs.
- `src/frontend/dashboard.css`: replace `.model-split/.msl-*` rules with compact card, picker, editor, and responsive rules.
- `scripts/compile-frontend-ts.mjs`: load utilities, form, and views before their controllers.
- `package.json`: add the focused frontend test file to `test:frontend`.
- `test/settings-ui.test.mjs`: update existing custom-provider lifecycle tests to the new DOM without weakening security assertions.
- `test/frontend-component-tree.test.mjs`: enforce component ownership and bundle order.

**Do not modify**

- `src/model-provider/contracts.ts`
- `src/model-provider/custom-provider-store.ts`
- `src/server/routes/settings/auth.ts`
- `src/server/routes/settings/custom-providers.ts`

The redesign must not change persisted data or server request/response contracts.

---

### Task 1: Pure Provider Utilities and Bundled Icons

**Files:**
- Create: `src/frontend/dashboard/settings-provider-utils.ts`
- Create: `src/frontend/icons/providers/anthropic.svg`
- Create: `src/frontend/icons/providers/deepseek.svg`
- Create: `src/frontend/icons/providers/google.svg`
- Create: `src/frontend/icons/providers/openai.svg`
- Create: `src/frontend/icons/providers/openrouter.svg`
- Create: `src/frontend/icons/providers/NOTICE.txt`
- Create: `test/provider-settings-ui.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing pure-helper tests**

Create `test/provider-settings-ui.test.mjs` with a fresh happy-dom window and these exact cases:

```js
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window();
global.window = win;
global.document = win.document;

let ProviderSettingsUtils;
before(async () => {
  ({ ProviderSettingsUtils } = await import("../src/frontend/dashboard/settings-provider-utils.ts"));
});

describe("provider settings utilities", () => {
  it("generates stable provider ids and resolves collisions", () => {
    assert.equal(ProviderSettingsUtils.deriveProviderId("Acme Relay", new Set()), "acme-relay");
    assert.equal(ProviderSettingsUtils.deriveProviderId("我的中转", new Set()), "custom-provider");
    assert.equal(
      ProviderSettingsUtils.deriveProviderId("我的中转", new Set(["custom-provider", "custom-provider-2"])),
      "custom-provider-3",
    );
  });

  it("derives an OpenAI model discovery path without losing /v1", () => {
    assert.equal(ProviderSettingsUtils.deriveOpenAiDiscoveryPath("https://api.example.test/v1"), "/v1/models");
    assert.equal(ProviderSettingsUtils.deriveOpenAiDiscoveryPath("https://api.example.test/v1/"), "/v1/models");
    assert.equal(ProviderSettingsUtils.deriveOpenAiDiscoveryPath("https://api.example.test"), "/models");
    assert.equal(ProviderSettingsUtils.deriveOpenAiDiscoveryPath("not-a-url"), null);
  });

  it("uses bundled official icons and stable custom initials", () => {
    assert.equal(ProviderSettingsUtils.identity("deepseek", "DeepSeek", false).iconPath, "./icons/providers/deepseek.svg");
    assert.equal(ProviderSettingsUtils.identity("relay", "我的中转", true).initials, "我的");
    assert.equal(ProviderSettingsUtils.identity("relay", "Acme Gateway", true).initials, "AG");
  });

  it("renders only a safe hostname from provider URLs", () => {
    assert.equal(ProviderSettingsUtils.providerHost("https://user:pass@example.test/v1?q=secret"), "example.test");
    assert.equal(ProviderSettingsUtils.providerHost("invalid"), "");
  });
});
```

Add `test/provider-settings-ui.test.mjs` to the end of the existing serialized `test:frontend` file list in `package.json`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/provider-settings-ui.test.mjs
```

Expected: FAIL because `settings-provider-utils.ts` does not exist.

- [ ] **Step 3: Implement the pure helper contract**

Create `src/frontend/dashboard/settings-provider-utils.ts` with no `App.*` access:

```ts
interface ProviderIdentityDescriptor {
  iconPath?: string;
  initials: string;
  label: string;
}

const OFFICIAL_PROVIDER_ICONS: Readonly<Record<string, string>> = {
  anthropic: './icons/providers/anthropic.svg',
  deepseek: './icons/providers/deepseek.svg',
  google: './icons/providers/google.svg',
  openai: './icons/providers/openai.svg',
  openrouter: './icons/providers/openrouter.svg',
};

function providerInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, 2).map(word => word[0]).join('').toUpperCase();
  return [...(words[0] ?? '?')].slice(0, 2).join('').toUpperCase();
}

function deriveProviderId(name: string, occupied: ReadonlySet<string>): string {
  const normalized = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = normalized || 'custom-provider';
  if (!occupied.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

function deriveOpenAiDiscoveryPath(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return null;
    const basePath = parsed.pathname.replace(/\/+$/, '');
    return `${basePath}/models` || '/models';
  } catch {
    return null;
  }
}

function providerHost(baseUrl: string): string {
  try { return new URL(baseUrl).hostname; } catch { return ''; }
}

function identity(id: string, name: string, custom: boolean): ProviderIdentityDescriptor {
  return {
    ...(custom ? {} : OFFICIAL_PROVIDER_ICONS[id] ? { iconPath: OFFICIAL_PROVIDER_ICONS[id] } : {}),
    initials: providerInitials(name),
    label: name,
  };
}

export const ProviderSettingsUtils = {
  deriveProviderId,
  deriveOpenAiDiscoveryPath,
  providerHost,
  identity,
};
```

Copy the five SVG files from `example/cc-switch-main/src/icons/extracted/` into `src/frontend/icons/providers/`. Add `NOTICE.txt`:

```text
Provider SVG assets were copied from CC Switch:
https://github.com/farion1231/cc-switch

CC Switch is distributed under the MIT License.
Copyright (c) 2025 Jason Young.

Provider names and logos may be trademarks of their respective owners.
They are used only to identify user-configured services.
```

Do not inline SVG strings into dynamic HTML. Render these files through `<img>` elements only.

- [ ] **Step 4: Run the focused helper test**

Run the same focused command. Expected: 4 tests PASS.

- [ ] **Step 5: Commit the utility and icon batch**

```powershell
git add package.json test/provider-settings-ui.test.mjs src/frontend/dashboard/settings-provider-utils.ts src/frontend/icons/providers
git commit -m "feat: add provider presentation utilities"
```

---

### Task 2: Provider Card, Picker, and Official Editor Views

**Files:**
- Create: `src/frontend/dashboard/settings-provider-views.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `scripts/compile-frontend-ts.mjs`
- Modify: `test/provider-settings-ui.test.mjs`
- Modify: `test/frontend-component-tree.test.mjs`

- [ ] **Step 1: Add failing DOM-view tests**

Extend `test/provider-settings-ui.test.mjs` with state factories and these assertions:

```js
it("renders compact provider cards without turning the card into an action", () => {
  const host = document.createElement("div");
  const calls = [];
  const view = new ProviderCardListView({
    onUse: (providerId, modelId) => calls.push(["use", providerId, modelId]),
    onEdit: (providerId) => calls.push(["edit", providerId]),
    onAdd: () => calls.push(["add"]),
  });
  view.render(host, {
    current: { providerId: "deepseek", modelId: "deepseek-chat" },
    providers: [{
      id: "deepseek", name: "DeepSeek", custom: false, configured: true,
      baseUrl: "https://api.deepseek.com/v1", protocolLabel: "官方",
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
    }],
  });
  assert.ok(host.querySelector('.provider-card[data-provider-id="deepseek"]'));
  assert.ok(host.querySelector('img[src="./icons/providers/deepseek.svg"]'));
  host.querySelector(".provider-card").click();
  assert.deepEqual(calls, []);
  host.querySelector('[data-provider-action="use"]').click();
  assert.deepEqual(calls, [["use", "deepseek", "deepseek-chat"]]);
});

it("renders an empty state instead of opening an editor", () => {
  const host = document.createElement("div");
  new ProviderCardListView({ onUse() {}, onEdit() {}, onAdd() {} }).render(host, {
    current: null,
    providers: [],
  });
  assert.match(host.querySelector(".provider-empty")?.textContent ?? "", /添加厂商/);
  assert.equal(host.querySelector(".cpe-editor"), null);
});

it("separates official providers from the three custom templates", () => {
  const host = document.createElement("div");
  new ProviderPickerView({ onBack() {}, onOfficial() {}, onCustom() {} }).render(host, {
    official: [{ id: "openai", name: "OpenAI", configured: false }],
    customAvailable: true,
  });
  assert.equal(host.querySelectorAll(".provider-preset-official").length, 1);
  assert.deepEqual(
    [...host.querySelectorAll("[data-custom-template]")].map(node => node.dataset.customTemplate),
    ["openai", "anthropic", "other"],
  );
});
```

Import `ProviderCardListView`, `ProviderPickerView`, and `OfficialProviderEditorView` in the test `before()` hook.

- [ ] **Step 2: Run the focused test and verify missing views fail**

Expected: FAIL because `settings-provider-views.ts` and the view constructors do not exist.

- [ ] **Step 3: Define the view contracts in `dashboard.d.ts`**

Add these stable types:

```ts
interface ProviderCardModel { id: string; name: string; }
interface ProviderCardItem {
  id: string;
  name: string;
  custom: boolean;
  configured: boolean;
  baseUrl: string;
  protocolLabel: string;
  models: ProviderCardModel[];
}
interface ProviderCardListState {
  current: { providerId: string; modelId: string } | null;
  providers: ProviderCardItem[];
}
interface ProviderPickerState {
  official: Array<{ id: string; name: string; configured: boolean }>;
  customAvailable: boolean;
}
interface ProviderCardListCallbacks {
  onUse(providerId: string, modelId: string): void;
  onEdit(providerId: string): void;
  onAdd(): void;
}
interface ProviderPickerCallbacks {
  onBack(): void;
  onOfficial(providerId: string): void;
  onCustom(template: 'openai' | 'anthropic' | 'other'): void;
}
```

- [ ] **Step 4: Implement DOM-backed views**

Create `settings-provider-views.ts` with exported classes. Requirements:

- `ProviderIdentityView.create(id, name, custom)` returns a wrapper containing either an `<img>` with `alt=""` plus visible name, or a text fallback with `aria-hidden="true"`.
- `ProviderCardListView.render(container, state)` uses `replaceChildren`, `textContent`, `dataset`, and direct listeners; it must not interpolate server strings into `innerHTML`.
- The card root is an `<article>`, not a button.
- Each model `<select>` owns only its provider's models. “使用” reads that select at click time.
- “编辑” uses the existing icon symbol helper only if it can be injected as static markup; otherwise use the text `···` with `aria-label="编辑厂商"` and `title="编辑厂商"`.
- `ProviderPickerView` renders official provider tiles from state and exactly three custom templates.
- `OfficialProviderEditorView` renders the existing API-key field, reveal control, model list, loading/error states, and a back command. It accepts callbacks; it performs no fetch itself.

- [ ] **Step 5: Register bundle order and architecture gates**

Insert these entries in both `REQUIRED_BUNDLE_ENTRIES` and `bundleOrder`:

```js
"gen/dashboard/settings-provider-utils.js",
"gen/dashboard/settings-provider-views.js",
```

They must appear after `gen/ui/list-add-action.js` and before `gen/dashboard/settings-custom-provider-editor.js` and `gen/dashboard/settings-provider-model.js`.

Extend `test/frontend-component-tree.test.mjs` to assert:

```js
assertClass(source("src/frontend/dashboard/settings-provider-views.ts"), "ProviderCardListView");
assertClass(source("src/frontend/dashboard/settings-provider-views.ts"), "ProviderPickerView");
assertClass(source("src/frontend/dashboard/settings-provider-views.ts"), "OfficialProviderEditorView");
assert.doesNotMatch(source("src/frontend/dashboard/settings-provider-views.ts"), /\bApp\./);
```

- [ ] **Step 6: Run focused tests and typecheck**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/provider-settings-ui.test.mjs test/frontend-component-tree.test.mjs
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit the view batch**

```powershell
git add src/frontend/dashboard/settings-provider-views.ts src/frontend/dashboard.d.ts scripts/compile-frontend-ts.mjs test/provider-settings-ui.test.mjs test/frontend-component-tree.test.mjs
git commit -m "feat: add provider settings views"
```

---

### Task 3: Three-View Provider Orchestration

**Files:**
- Modify: `src/frontend/dashboard/settings-provider-model.ts`
- Modify: `src/frontend/dashboard/dashboard-settings.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `test/provider-settings-ui.test.mjs`
- Modify: `test/settings-ui.test.mjs`

- [ ] **Step 1: Write failing controller behavior tests**

Add tests for these exact behaviors:

1. `/api/custom-providers` returns OpenAI unconfigured, Anthropic configured, and one custom provider; the card list contains only Anthropic and the custom provider.
2. The current dashboard provider is OpenAI while OpenAI is unconfigured; OpenAI remains visible during load.
3. Clicking add renders the picker without creating `.cpe-editor`.
4. Clicking an official preset renders `OfficialProviderEditorView`; clicking a custom template calls `startNew` with the expected preset.
5. Changing the card model select does not POST; clicking “使用” POSTs `{ provider, modelId }` once.
6. Returning from editor calls `customEditor.unmount()` and renders the card list.

Use fetch fixtures shaped like:

```js
if (url === "/api/auth") return response({
  providers: [
    { provider: "openai", hasKey: false, canReveal: false, keyPreview: "" },
    { provider: "anthropic", hasKey: true, canReveal: false, keyPreview: "" },
  ],
});
if (url === "/api/custom-providers") return response({
  revision: 4,
  official: [
    { id: "openai", name: "OpenAI", configured: false },
    { id: "anthropic", name: "Anthropic", configured: true },
  ],
  custom: [customProvider()],
});
if (url === "/api/models") return response({
  models: [
    { provider: "openai", id: "gpt-5" },
    { provider: "anthropic", id: "claude-sonnet" },
  ],
});
```

- [ ] **Step 2: Run focused tests and verify old split-view assertions fail**

Run the provider and settings UI tests. Expected: the new card/picker assertions fail and the old “one ordered list” assertion still sees `.msl-item`.

- [ ] **Step 3: Refactor `SettingsProviderModelController` into explicit view state**

Use this state union:

```ts
type ProviderSettingsView =
  | { kind: 'list' }
  | { kind: 'picker' }
  | { kind: 'official'; providerId: string }
  | { kind: 'custom'; providerId: string }
  | { kind: 'new-custom'; template: 'openai' | 'anthropic' | 'other' };
```

Controller rules:

- `renderTab()` resets to `{ kind: 'list' }`, renders one root shell, and starts auth/custom/capabilities/models loads without selecting the first provider.
- Build visible cards from configured official providers, all saved custom providers, and the current dashboard provider.
- Official models come from `/api/models`; custom models come from the custom snapshot. Stable-deduplicate by `(provider, id)`.
- Preserve the existing `providers_order` preference only as an ordering hint; append unknown visible IDs. Do not expose drag handlers in the new card UI.
- `showPicker`, `showOfficial`, `showCustom`, `startCustom`, and `showList` are private navigation methods that increment a view generation before rendering.
- `showList()` never auto-opens an editor, including an empty list.
- Saving official API keys refreshes auth and models, then returns to the list with the new card visible.
- Successful custom save/delete consumes the authoritative revision snapshot and returns to the list.
- Current provider/model comes from `chatState.getDashboard()` and is refreshed after successful switch.

- [ ] **Step 4: Remove obsolete modal delegation**

From `dashboard-settings.ts`, remove handling and facade wrappers for:

```ts
selectProvider
loadProviderModels
provDragStart
provDragOver
provDrop
```

Keep `selectModel`, `toggleKeyVis`, and `saveApiKey` only if the official editor still routes through the facade; prefer direct view callbacks and remove those wrappers too when no external call site remains. Confirm with `rg` before deletion.

Update `SettingsProviderModelApi` in `dashboard.d.ts` to the actual public surface:

```ts
interface SettingsProviderModelApi {
  customEditor: SettingsCustomProviderEditor;
  renderTab(container: HTMLElement): void;
  unmount(): void;
}
```

- [ ] **Step 5: Replace stale tests without weakening retained behavior**

Replace the old “official and custom providers in one ordered list” test with configured-only card assertions. Preserve tests for:

- capabilities failure leaves official auth and models usable;
- official reveal is explicit and redacted;
- stale custom revisions do not overwrite newer authority;
- leaving the model tab aborts custom work;
- hostile provider/model names remain inert text.

- [ ] **Step 6: Run controller, settings, and type tests**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/provider-settings-ui.test.mjs test/settings-ui.test.mjs test/frontend-component-tree.test.mjs
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 7: Commit the orchestration batch**

```powershell
git add src/frontend/dashboard/settings-provider-model.ts src/frontend/dashboard/dashboard-settings.ts src/frontend/dashboard.d.ts test/provider-settings-ui.test.mjs test/settings-ui.test.mjs
git commit -m "feat: reorganize provider settings flow"
```

---

### Task 4: Simplified Custom Provider Form and Generated IDs

**Files:**
- Create: `src/frontend/dashboard/settings-custom-provider-form.ts`
- Modify: `src/frontend/dashboard/settings-custom-provider-editor.ts`
- Modify: `src/frontend/dashboard.d.ts`
- Modify: `scripts/compile-frontend-ts.mjs`
- Modify: `test/provider-settings-ui.test.mjs`
- Modify: `test/settings-ui.test.mjs`
- Modify: `test/frontend-component-tree.test.mjs`

- [ ] **Step 1: Write failing form-hierarchy tests**

Add tests that mount new and existing custom providers and assert:

```js
assert.ok(host.querySelector("#cpe-name"));
assert.ok(host.querySelector("#cpe-base-url"));
assert.ok(host.querySelector("#cpe-api-key"));
assert.ok(host.querySelector(".cpe-model-rows"));
assert.equal(host.querySelector("#cpe-id")?.closest("details")?.open, false);
assert.equal(host.querySelector("#cpe-protocol")?.closest("details")?.open, false);
assert.equal(host.querySelector(".cpe-header-rows")?.closest("details")?.open, false);
```

Also assert:

- OpenAI template starts with `openai-completions` and `apiKey` selected.
- Anthropic template starts with `anthropic-messages` and `apiKey` selected.
- Other template requires an explicit supported protocol.
- Typing `Acme Relay` generates `acme-relay` until the ID input is manually edited.
- Typing a Chinese-only name generates `custom-provider`, then the first unoccupied suffix.
- Existing provider IDs remain read-only.
- A backend field error under `models[0].compatibility` opens advanced settings and focuses the matching textarea.

- [ ] **Step 2: Run focused tests and verify the flat form fails**

Expected: FAIL because all fields still share the flat `.cpe-form` and `startNew` has no template argument.

- [ ] **Step 3: Introduce `CustomProviderFormView`**

Create `settings-custom-provider-form.ts` with no network calls and no `App.*` access. Define:

```ts
type CustomProviderTemplate = 'openai' | 'anthropic' | 'other';
interface CustomProviderFormOptions {
  provider: RedactedCustomProvider | null;
  template?: CustomProviderTemplate;
  protocols: readonly CustomProviderProtocol[];
  occupiedProviderIds: ReadonlySet<string>;
}
interface CustomProviderFormReadOptions {
  showErrors: boolean;
  purpose: 'save' | 'test' | 'discover';
}
```

`CustomProviderFormView` owns:

- rendering the common and advanced sections;
- model and Header row add/remove behavior;
- generated-ID state (`generated` until a user edits the ID control);
- field-error mapping and advanced-section opening;
- safe draft reads and secret capture;
- returning the root and action buttons to the network owner.

The common section contains only name, Base URL, API Key/no-auth control, and model ID/display-name rows. Put ID, protocol, Headers, discovery path, model capabilities, costs, and JSON fields in one closed `<details class="cpe-advanced">`.

- [ ] **Step 4: Make `SettingsCustomProviderEditor` a network/lifecycle owner**

Update constructor dependencies to accept `formType`, and replace direct DOM builders/readers with the form instance. Extend the public API:

```ts
startNew(
  container: HTMLElement,
  revision: number,
  options: { template: CustomProviderTemplate; occupiedProviderIds: ReadonlySet<string> },
): void;
```

Preserve unchanged:

- query/mutation generation checks;
- abort behavior;
- secret redaction;
- expectedRevision writes;
- equal/newer revision authority rules;
- save/delete late-settle handling;
- explicit secret clear semantics;
- two-click delete and reference conflicts.

- [ ] **Step 5: Register form ownership and bundle order**

Insert `gen/dashboard/settings-custom-provider-form.js` after utilities/views and before `settings-custom-provider-editor.js`. Extend the component-tree gate:

```js
assertClass(source("src/frontend/dashboard/settings-custom-provider-form.ts"), "CustomProviderFormView");
assert.doesNotMatch(source("src/frontend/dashboard/settings-custom-provider-form.ts"), /\bApp\./);
assert.ok(formIndex < editorIndex && editorIndex < providerIndex);
```

- [ ] **Step 6: Run focused and existing custom-provider tests**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/provider-settings-ui.test.mjs test/settings-ui.test.mjs test/frontend-component-tree.test.mjs
npm run typecheck
```

Expected: exit 0, including all existing secret, revision, race, XSS, delete, and reference-conflict tests.

- [ ] **Step 7: Commit the form batch**

```powershell
git add src/frontend/dashboard/settings-custom-provider-form.ts src/frontend/dashboard/settings-custom-provider-editor.ts src/frontend/dashboard.d.ts scripts/compile-frontend-ts.mjs test/provider-settings-ui.test.mjs test/settings-ui.test.mjs test/frontend-component-tree.test.mjs
git commit -m "feat: simplify custom provider editing"
```

---

### Task 5: Explicit Default Model Discovery

**Files:**
- Modify: `src/frontend/dashboard/settings-custom-provider-form.ts`
- Modify: `src/frontend/dashboard/settings-custom-provider-editor.ts`
- Modify: `test/provider-settings-ui.test.mjs`
- Modify: `test/settings-ui.test.mjs`

- [ ] **Step 1: Write failing discovery-flow tests**

Add these cases:

1. OpenAI template, Base URL `https://api.example.test/v1`, empty advanced discovery field: clicking “获取模型” sends `modelDiscovery: "/v1/models"`.
2. A trailing slash produces the same request path.
3. The derived path is not written into the visible field when discovery fails.
4. After success and user confirmation, the field contains `/v1/models` and imported rows are added.
5. Anthropic and other templates with no discovery path do not request; they show an inline instruction to configure a same-origin path or add models manually.
6. Discovery can run before any real model row exists; the request uses one private valid sentinel descriptor, and save never persists that sentinel.

Use a sentinel only for request validation:

```js
{
  id: "__model_discovery__",
  name: "Model discovery",
  contextWindow: 1,
  maxTokens: 1,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
```

- [ ] **Step 2: Run focused tests and verify discovery currently requires manual path/model**

Expected: FAIL because `readDraft(false)` rejects the empty discovery path and empty model row.

- [ ] **Step 3: Add a discovery-only draft read**

Implement `CustomProviderFormView.readDraft({ purpose: 'discover' })` so that it:

- validates name, ID, Base URL, auth, Headers, and credentials;
- derives the candidate only for `openai-completions` when the field is empty;
- permits zero completed model rows by inserting the sentinel into the request object only;
- returns `derivedDiscoveryPath?: string` separately from the request draft;
- never writes the sentinel into DOM or the save draft.

Update `discoverModels()` to commit `derivedDiscoveryPath` into the advanced field only after a successful response and explicit import confirmation.

- [ ] **Step 4: Preserve server security behavior**

Do not change the route or service. Confirm the request still passes through existing:

- `validateCustomProviderDraft`;
- same-origin URL validation;
- redirect rejection;
- timeout and body-size limits;
- secret redaction.

- [ ] **Step 5: Run frontend and route discovery tests**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/provider-settings-ui.test.mjs test/settings-ui.test.mjs
node scripts/tsx-test.mjs --test --test-concurrency=4 test/routes.test.mjs test/custom-provider-network.test.mjs
```

Expected: exit 0.

- [ ] **Step 6: Commit discovery UX**

```powershell
git add src/frontend/dashboard/settings-custom-provider-form.ts src/frontend/dashboard/settings-custom-provider-editor.ts test/provider-settings-ui.test.mjs test/settings-ui.test.mjs
git commit -m "feat: streamline provider model discovery"
```

---

### Task 6: Responsive Styling and Accessibility

**Files:**
- Modify: `src/frontend/dashboard.css`
- Modify: `test/provider-settings-ui.test.mjs`
- Modify: `test/frontend-component-tree.test.mjs`
- Modify: `test/frontend-xss-sinks.test.mjs`

- [ ] **Step 1: Add failing structural and accessibility assertions**

Assert all of the following:

- card grid uses `repeat(2, minmax(0, 1fr))`;
- a dedicated breakpoint changes it to one column;
- cards have a stable minimum block size and no nested card containers;
- form content owns bottom padding at least equal to the fixed footer height;
- icon buttons have `aria-label` and `title`;
- status text is visible alongside status color;
- long provider/model strings use overflow protection;
- all server-derived provider/model text is inserted by DOM text APIs, not `innerHTML`;
- the new view/form files contain no inline event attributes.

- [ ] **Step 2: Run focused structural tests and verify old CSS fails**

Expected: FAIL because `.model-split/.msl-*` still define the old split layout and new classes are absent.

- [ ] **Step 3: Replace old provider CSS**

Delete obsolete `.model-split`, `.ms-left`, `.msl-*`, `.ms-right`, `.rp-model-item`, and drag-handle rules after confirming no references remain.

Add grouped rules for:

```css
.provider-settings-shell
.provider-settings-header
.provider-current-summary
.provider-card-grid
.provider-card
.provider-identity
.provider-card-actions
.provider-empty
.provider-picker
.provider-preset-grid
.provider-editor-shell
.provider-editor-scroll
.provider-editor-footer
.cpe-common
.cpe-advanced
```

Constraints:

- border radius no greater than 6px;
- no gradients, decorative floating cards, or nested cards;
- use existing `--bg/--bs/--bc/--bd/--tx/--ts/--tm/--am/--em/--rs` variables;
- fixed footer height with matching scroll padding;
- two-column cards only while each card retains at least 300px;
- one-column cards and one-column form fields below the existing Electron narrow width;
- font sizes remain fixed and do not scale with viewport width;
- letter spacing remains `0` except existing uppercase micro-labels, which must also be changed to `0` for this new surface.

- [ ] **Step 4: Run frontend gates**

```powershell
node scripts/tsx-test.mjs --test --test-concurrency=1 test/provider-settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs
node test/css-vars.mjs
npm run typecheck
```

Expected: all exit 0.

- [ ] **Step 5: Commit the visual batch**

```powershell
git add src/frontend/dashboard.css test/provider-settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs
git commit -m "style: refine provider settings layout"
```

---

### Task 7: Build, Full Regression, and Manual Acceptance

**Files:**
- Modify only if verification exposes a defect in files already listed above.

- [ ] **Step 1: Run formatting and source checks**

```powershell
git diff --check
rg -n "model-split|msl-item|msl-drag|添加自定义厂商" src/frontend test
```

Expected: `git diff --check` exits 0; the old split-view selectors and old add label have no production matches.

- [ ] **Step 2: Run typecheck and production build**

```powershell
npm run typecheck
npm run build
```

Expected: both exit 0; `dist/frontend/icons/providers/` contains all five SVG files and `NOTICE.txt`.

- [ ] **Step 3: Run the full test suite**

```powershell
npm test
```

Expected: exit 0 with unit, routes, frontend, and CSS variable gates all passing.

- [ ] **Step 4: Start the development app**

```powershell
npm run dev
```

Wait for Vite, PI server, and Electron readiness. Do not leave the process detached when acceptance is complete.

- [ ] **Step 5: Manually verify the six design scenarios**

1. With no configured official providers or custom providers, Models shows only the empty state and Add Provider command.
2. Add official DeepSeek, save a key, return to the list, and verify the local DeepSeek icon and model picker.
3. Add an OpenAI-compatible relay using only name, Base URL, API key, and model discovery/manual model fields.
4. Change a card select and verify no switch occurs until “使用” is clicked.
5. Edit a custom provider and verify advanced fields are closed, Provider ID is read-only after save, testing works, and delete remains two-step.
6. Repeat list, picker, and editor inspection at the Electron minimum width and in light theme; no text or controls overlap.

- [ ] **Step 6: Inspect runtime console and network behavior**

Expected:

- no 4xx requests during normal list rendering;
- no remote icon requests;
- no model discovery request until explicit click;
- no duplicate `/api/model/switch` POST;
- no uncaught promise rejection during rapid list/picker/editor navigation.

- [ ] **Step 7: Stop the dev process and verify repository state**

Send `Ctrl+C`, wait for Electron/server exit, then run:

```powershell
git status --short
git diff --check
```

Expected: only intentional implementation changes remain; no generated `src/frontend/gen`, `dist`, data, auth, or temporary files are staged.

- [ ] **Step 8: Commit any final verification fix, otherwise record completion**

If verification required a code fix, rerun the smallest failed test plus `npm test`, then commit only that fix:

```powershell
git add src/frontend/dashboard/settings-provider-utils.ts src/frontend/dashboard/settings-provider-views.ts src/frontend/dashboard/settings-custom-provider-form.ts src/frontend/dashboard/settings-provider-model.ts src/frontend/dashboard/settings-custom-provider-editor.ts src/frontend/dashboard/dashboard-settings.ts src/frontend/dashboard.d.ts src/frontend/dashboard.css scripts/compile-frontend-ts.mjs package.json test/provider-settings-ui.test.mjs test/settings-ui.test.mjs test/frontend-component-tree.test.mjs test/frontend-xss-sinks.test.mjs
git commit -m "fix: close provider settings acceptance gaps"
```

If no fix was needed, do not create an empty commit.

---

## Plan Self-Review

- Spec sections 4-7 map to Tasks 2-5.
- Official/local icon and custom-initial behavior maps to Tasks 1-2.
- Existing API, secret, revision, and reference semantics are retained in Tasks 3-5 and full regression in Task 7.
- Responsive, theme, keyboard, overflow, and XSS requirements map to Task 6 and manual acceptance.
- No server or persistence contract file is modified.
- The OpenAI discovery default remains explicit-click only and uses the existing server validator through a request-only sentinel model.
- No third-party provider preset, remote icon source, icon upload, telemetry, or chat model-picker redesign is introduced.
