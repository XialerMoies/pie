import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { createUiContributionRegistry } = await import(`../src/frontend/ui-contribution-registry.ts?test=${Date.now()}`);

describe("host UI contribution registry", () => {
  it("validates identity and exposes pane/settings/language-service kinds", () => {
    const registry = createUiContributionRegistry();
    const handle = registry.register({ id: "ui.pane.search", componentId: "ui.pane.search", kind: "pane", render() {} });
    registry.register({ id: "settings.models", componentId: "settings.models", kind: "settings", render() {} });
    registry.register({ id: "language-service.typescript", componentId: "language-service.typescript", kind: "language-service", activate() {} });
    registry.register({ id: "settings.dashboard", componentId: "settings.dashboard", kind: "settings", activate() {} });
    assert.equal(handle.id, "ui.pane.search");
    assert.equal(registry.list().length, 4);
    assert.throws(() => registry.register({ id: "ui.pane.search", componentId: "other", kind: "pane", render() {} }), /Duplicate/);
  });

  it("rejects new mounts for inactive components and cleans up idempotently", () => {
    let active = false;
    let renders = 0;
    let disposes = 0;
    const registry = createUiContributionRegistry({ isComponentActive: () => active });
    const handle = registry.register({
      id: "ui.pane.git", componentId: "ui.pane.git", kind: "pane",
      mount() { renders += 1; return () => { disposes += 1; }; },
    });
    assert.throws(() => handle.mount({}), /inactive/);
    active = true;
    const unmount = handle.mount({});
    assert.equal(renders, 1);
    unmount(); unmount();
    assert.equal(disposes, 1);
    handle.dispose();
    assert.equal(disposes, 1);
  });

  it("supports non-DOM activation and component state reconfiguration", () => {
    let active = true;
    let started = 0;
    const registry = createUiContributionRegistry({ isComponentActive: () => active });
    const handle = registry.register({ id: "language-service.ts", componentId: "language-service.ts", kind: "language-service", activate() { started += 1; return () => { started -= 1; }; } });
    const stop = handle.activate();
    assert.equal(started, 1);
    stop();
    registry.configure({ isComponentActive: () => active = false });
    assert.equal(registry.isActive("language-service.ts"), false);
    assert.throws(() => handle.activate(), /inactive/);
  });

  it("reports unknown contributions as inactive without treating them as mounted", () => {
    const registry = createUiContributionRegistry();
    assert.equal(registry.isActive("ui.pane.unknown"), false);
    registry.register({ id: "ui.pane.search", componentId: "ui.pane.search", kind: "pane", render() {} });
    assert.equal(registry.isActive("ui.pane.search"), true);
  });

  it("disposes active language services even when callers do not retain cleanup", () => {
    let stopped = 0;
    const registry = createUiContributionRegistry();
    const handle = registry.register({ id: "language-service.css", componentId: "language-service.css", kind: "language-service", activate() { return () => { stopped += 1; }; } });
    handle.activate();
    handle.dispose();
    handle.dispose();
    assert.equal(stopped, 1);
  });
});
