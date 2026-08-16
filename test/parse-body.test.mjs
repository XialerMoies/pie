import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  BodyTooLargeError,
  InvalidJsonBodyError,
  parseBody,
} from "../src/server/routes/parse-body.ts";

function parseChunks(chunks, options) {
  const request = new PassThrough();
  const parsed = parseBody(request, options);
  for (const chunk of chunks) request.write(chunk);
  request.end();
  return parsed;
}

describe("parseBody", () => {
  it("buffers bytes and decodes split multibyte UTF-8 exactly once", async () => {
    const encoded = Buffer.from(JSON.stringify({ message: "A\u{1f600}B" }), "utf8");
    const emojiStart = encoded.indexOf(Buffer.from("\u{1f600}"));
    const parsed = await parseChunks([
      encoded.subarray(0, emojiStart + 1),
      encoded.subarray(emojiStart + 1, emojiStart + 3),
      encoded.subarray(emojiStart + 3),
    ]);
    assert.deepEqual(parsed, { message: "A\u{1f600}B" });
  });

  it("returns typed invalid JSON and body-too-large failures", async () => {
    await assert.rejects(
      () => parseChunks([Buffer.from("{broken")]),
      (error) => error instanceof InvalidJsonBodyError,
    );
    await assert.rejects(
      () => parseChunks([Buffer.from('{"value":"'), Buffer.from("1234567890"), Buffer.from('"}')], { maxBytes: 12 }),
      (error) => error instanceof BodyTooLargeError && error.maxBytes === 12,
    );
  });
});
