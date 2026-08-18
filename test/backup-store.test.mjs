import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupPath,
  createJsonBackup,
  readJsonBackup,
  restoreJsonBackup,
} from "../src/data/backup-store.ts";
import { readLockedJson, updateLockedJson } from "../src/data/locked-json-store.ts";

describe("JSON backup store", () => {
  it("creates a latest backup and restores it atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "mca-backup-"));
    const file = join(root, "settings.json");
    await writeFile(file, JSON.stringify({ version: 1 }), "utf8");

    const result = await createJsonBackup(file, { version: 1 });
    assert.equal(result.path, backupPath(file));
    assert.deepEqual(await readJsonBackup(file), { version: 1 });

    await writeFile(file, JSON.stringify({ version: 2 }), "utf8");
    assert.equal(await restoreJsonBackup(file), true);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1 });
  });

  it("returns null when no valid backup exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "mca-backup-empty-"));
    const file = join(root, "settings.json");
    assert.equal(await readJsonBackup(file), null);
    assert.equal(await restoreJsonBackup(file), false);
  });

  it("reads the last good value when the primary JSON is corrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "mca-backup-recovery-"));
    const file = join(root, "settings.json");
    await updateLockedJson(file, {}, () => ({ version: 1 }));
    await updateLockedJson(file, {}, (current) => ({ ...current, version: 2 }));
    await writeFile(file, "{broken", "utf8");

    assert.deepEqual(
      await readLockedJson(file, { fallback: true }, { recoverInvalidJson: true }),
      { version: 2 },
    );
  });
});
