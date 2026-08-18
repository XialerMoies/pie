import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  StructuredLogger,
  createRequestContext,
  redactMetadata,
  safeRequestUrl,
} from "../src/server/observability.ts";

describe("structured observability", () => {
  it("creates stable request and trace correlation IDs", () => {
    const first = createRequestContext({ headers: { "x-request-id": "req-123", "x-trace-id": "trace-9" } });
    assert.deepEqual(first, { requestId: "req-123", traceId: "trace-9" });
    const generated = createRequestContext({ headers: {} });
    assert.match(generated.requestId, /^[a-f0-9-]{36}$/);
    assert.match(generated.traceId, /^[a-f0-9-]{36}$/);
  });

  it("redacts secrets recursively", () => {
    assert.deepEqual(redactMetadata({ apiKey: "secret", nested: { cookie: "abc", ok: "value" } }), {
      apiKey: "[redacted]",
      nested: { cookie: "[redacted]", ok: "value" },
    });
    assert.equal(safeRequestUrl("/api/chat?message=ok&api_key=secret&trace=1"), "/api/chat?message=ok&trace=1");
    assert.equal(redactMetadata("Authorization: Bearer sk-test-secret-value"), "Authorization: Bearer [redacted]");
  });

  it("keeps bounded entries and writes JSONL records", async () => {
    const root = await mkdtemp(join(tmpdir(), "mca-observability-"));
    const file = join(root, "server.log.jsonl");
    const logger = new StructuredLogger({ filePath: file, maxEntries: 2, clock: () => 1700000000000 });
    logger.info("first", { password: "hidden" });
    logger.warn("second", { status: 429 });
    logger.error("third", { error: "failed" });
    await logger.flush();

    assert.deepEqual(logger.entries().map((entry) => entry.event), ["second", "third"]);
    const lines = (await readFile(file, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].fields.password, "[redacted]");
  });
});
