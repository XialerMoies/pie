/**
 * Shared parseBody helper — unified JSON body parsing for all routes
 *
 * Strict version: rejects on invalid JSON / request error.
 * For forgiving use, chain `.catch(() => ({}))` at the call site.
 */
export function parseBody(req: import("http").IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}
