import * as http from "http";

import type { ServerBinding } from "./server-binding.js";

type ServerRequestBinding = Pick<ServerBinding, "port" | "token">;
type ServerOriginBinding = Pick<ServerBinding, "origin">;

export interface RequestJsonOptions {
  includeToken?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export function requestStatus(url: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolveStatus(response.statusCode || 0);
    });
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("E2E HTTP request timed out")));
  });
}

export function requestJson(
  binding: ServerRequestBinding,
  pathname: string,
  method = "GET",
  payload?: unknown,
  options: RequestJsonOptions = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolveRequest, reject) => {
    const body = payload === undefined ? "" : JSON.stringify(payload);
    const request = http.request(`http://127.0.0.1:${binding.port}${pathname}`, {
      method,
      headers: {
        ...(options.includeToken === false ? {} : { "X-My-Code-Agent-Token": binding.token }),
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
        ...options.headers,
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => {
        let parsed: unknown = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolveRequest({ status: response.statusCode || 0, body: parsed });
      });
    });
    request.once("error", reject);
    request.setTimeout(options.timeoutMs ?? 10_000, () => request.destroy(new Error(`E2E HTTP request timed out: ${pathname}`)));
    if (body) request.write(body);
    request.end();
  });
}

export async function waitForServerOrigin(
  binding: ServerOriginBinding,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (binding.origin) return binding.origin;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return binding.origin;
}
