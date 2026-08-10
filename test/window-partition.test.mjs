import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { windowPartitionForInstance } from "../src/electron/window-partition.ts";

describe("window partitions", () => {
  it("uses a stable non-persistent partition per instance", () => {
    assert.equal(windowPartitionForInstance("instance-a"), "mca-window-instance-a");
    assert.equal(windowPartitionForInstance("instance-b"), "mca-window-instance-b");
    assert.ok(!windowPartitionForInstance("instance-a").startsWith("persist:"));
  });
});
