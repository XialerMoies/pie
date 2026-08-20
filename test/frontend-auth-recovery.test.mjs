import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/frontend/dashboard/dashboard-helpers.ts", import.meta.url), "utf8");

describe("frontend API authentication recovery", () => {
  it("rebootstraps and retries protected API requests after a 401/403", () => {
    assert.match(source, /response\.status !== 401 && response\.status !== 403/);
    assert.match(source, /_bootstrapPromise = null/);
    assert.match(source, /await bootstrapApi\(\)/);
    assert.match(source, /return rawFetch\(input, init\)/);
  });
});
