import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reduceEngineEvent } from "../src/server/event-domain-reducer.ts";

const base = { version: 1, sessionId: "s", turnId: "t", seq: 1, timestamp: 1 };

describe("runtime event domain reducer", () => {
  it("routes user runtime events to domain presentation candidates", () => {
    const reduced = reduceEngineEvent({ ...base, type: "content.delta", text: "正文" });
    assert.equal(reduced.kind, "content");
    assert.equal(reduced.visibility, "user");
    assert.equal(reduced.presentationEligible, true);
  });

  it("keeps diagnostics out of the presentation boundary", () => {
    const reduced = reduceEngineEvent({
      ...base,
      type: "diagnostic",
      level: "warning",
      code: "internal",
      message: "debug only",
    });
    assert.equal(reduced.kind, "debug");
    assert.equal(reduced.visibility, "debug");
    assert.equal(reduced.presentationEligible, false);
  });

  it("honors an explicit internal visibility override", () => {
    const reduced = reduceEngineEvent({
      ...base,
      type: "content.delta",
      text: "not for chat",
      visibility: "internal",
    });
    assert.equal(reduced.kind, "content");
    assert.equal(reduced.presentationEligible, false);
  });
});
