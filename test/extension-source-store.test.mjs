import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"
import { ExtensionSourceStore } from "../src/agent/extension-source-store.ts"

describe("extension source store", () => {
  it("persists user-owned local source registrations across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "extension-source-store-"))
    const stateFile = join(root, "extension-sources.json")
    try {
      const first = new ExtensionSourceStore()
      first.add({ id: "demo.local", displayName: "Demo local", kind: "file", indexPath: join(root, "index.json") })
      await first.save(stateFile)

      const restarted = new ExtensionSourceStore()
      await restarted.restore(stateFile)
      assert.deepEqual(restarted.list().map((source) => ({ id: source.id, displayName: source.displayName, kind: source.kind })), [{ id: "demo.local", displayName: "Demo local", kind: "file" }])
      assert.equal(restarted.remove("demo.local"), true)
      await restarted.save(stateFile)

      const afterRemoval = new ExtensionSourceStore()
      await afterRemoval.restore(stateFile)
      assert.deepEqual(afterRemoval.list(), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
