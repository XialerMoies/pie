import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

async function loadUtils() {
  const win = new Window();
  global.window = win;
  global.document = win.document;
  global.self = win;

  const moduleUrl = `../src/frontend/dashboard/settings-provider-utils.ts?${Date.now()}-${Math.random()}`;
  const { ProviderSettingsUtils } = await import(moduleUrl);
  return ProviderSettingsUtils;
}

describe("provider settings presentation utilities", () => {
  it("derives stable provider ids with a collision suffix", async () => {
    const { deriveProviderId } = await loadUtils();

    assert.equal(deriveProviderId("Acme Relay", new Set()), "acme-relay");
    assert.equal(deriveProviderId("我的服务", new Set()), "custom-provider");
    assert.equal(
      deriveProviderId("我的服务", new Set(["custom-provider", "custom-provider-2"])),
      "custom-provider-3",
    );
  });

  it("derives OpenAI model discovery paths from safe HTTP URLs", async () => {
    const { deriveOpenAiDiscoveryPath } = await loadUtils();

    assert.equal(deriveOpenAiDiscoveryPath("https://api.example.test/v1"), "/v1/models");
    assert.equal(deriveOpenAiDiscoveryPath("https://api.example.test/v1/"), "/v1/models");
    assert.equal(deriveOpenAiDiscoveryPath("https://api.example.test/"), "/models");
    assert.equal(deriveOpenAiDiscoveryPath("not a url"), null);
    assert.equal(deriveOpenAiDiscoveryPath("ftp://api.example.test/v1"), null);
    assert.equal(deriveOpenAiDiscoveryPath("https://user:secret@api.example.test/v1"), null);
  });

  it("uses official icons and derives custom provider initials", async () => {
    const source = readFileSync(resolve("src/frontend/dashboard/settings-provider-utils.ts"), "utf8");
    assert.match(source, /interface\s+ProviderIdentityDescriptor\s*\{/);
    assert.match(source, /function\s+identity\([^)]*\):\s*ProviderIdentityDescriptor\s*\{/);

    const { identity } = await loadUtils();

    const deepseek = identity("deepseek", "DeepSeek", false);
    assert.equal(deepseek.label, "DeepSeek");
    assert.equal(deepseek.iconPath, "./icons/providers/deepseek.svg");
    for (const id of ["anthropic", "google", "openai", "openrouter"]) {
      assert.equal(identity(id, id, false).iconPath, `./icons/providers/${id}.svg`);
    }

    const chineseCustom = identity("custom-provider", "我的服务", true);
    assert.equal(chineseCustom.label, "我的服务");
    assert.equal(chineseCustom.initials, "我的");
    assert.equal(Object.hasOwn(chineseCustom, "iconPath"), false);

    const acmeCustom = identity("acme-gateway", "Acme Gateway", true);
    assert.equal(acmeCustom.label, "Acme Gateway");
    assert.equal(acmeCustom.initials, "AG");
    assert.equal(Object.hasOwn(acmeCustom, "iconPath"), false);

    const unsupported = identity("unsupported", "Unsupported Relay", false);
    assert.equal(unsupported.label, "Unsupported Relay");
    assert.equal(Object.hasOwn(unsupported, "iconPath"), false);
  });

  it("returns only the hostname for valid provider URLs", async () => {
    const { providerHost } = await loadUtils();

    assert.equal(
      providerHost("https://user:secret@api.example.test:8443/v1?token=hidden#models"),
      "api.example.test",
    );
    assert.equal(providerHost("not a url"), "");
  });
});
