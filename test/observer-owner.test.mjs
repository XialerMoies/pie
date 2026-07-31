import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ObserverOwner } from "../src/frontend/editor/observer-owner.ts";

describe("ObserverOwner", () => {
  it("disconnects the previous observer on replacement and the current observer on clear", () => {
    const calls = [];
    const first = { disconnect: () => calls.push("first") };
    const second = { disconnect: () => calls.push("second") };
    const owner = new ObserverOwner();

    owner.replace(first);
    owner.replace(second);
    assert.deepStrictEqual(calls, ["first"]);

    owner.clear();
    owner.clear();
    assert.deepStrictEqual(calls, ["first", "second"]);
  });
});
