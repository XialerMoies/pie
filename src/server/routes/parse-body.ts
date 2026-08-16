import type { IncomingMessage } from "node:http";

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON");
    this.name = "InvalidJsonBodyError";
  }
}

export class BodyTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super("Request body is too large");
    this.name = "BodyTooLargeError";
  }
}

export interface ParseBodyOptions {
  maxBytes?: number;
}

export function parseBody(req: IncomingMessage, options: ParseBodyOptions = {}): Promise<any> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return Promise.reject(new Error("parseBody maxBytes must be a positive safe integer"));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > maxBytes) {
        settled = true;
        reject(new BodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(bytes);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8")) as unknown);
      } catch {
        reject(new InvalidJsonBodyError());
      }
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}
