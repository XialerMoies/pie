import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "node:test";

const moduleUrl = new URL("../src/electron/electron-http-client.ts", import.meta.url);
const mainUrl = new URL("../src/electron/electron-main.ts", import.meta.url);

async function withServer(handler, run) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(address.port);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("Electron HTTP helpers live outside electron-main", () => {
  assert.equal(existsSync(moduleUrl), true, "electron-http-client.ts should exist");

  const mainSource = readFileSync(mainUrl, "utf8");
  const clientSource = readFileSync(moduleUrl, "utf8");
  for (const name of ["requestStatus", "requestJson", "waitForServerOrigin"]) {
    assert.doesNotMatch(mainSource, new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
    assert.match(clientSource, new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`));
  }
  assert.match(mainSource, /from "\.\/electron-http-client\.js"/);
});

test("requestStatus returns the HTTP response status", async () => {
  const { requestStatus } = await import(moduleUrl.href);
  await withServer((_request, response) => {
    response.writeHead(204);
    response.end();
  }, async (port) => {
    assert.equal(await requestStatus(`http://127.0.0.1:${port}/health`), 204);
  });
});

test("requestJson sends the explicit binding token and JSON payload", async () => {
  const { requestJson } = await import(moduleUrl.href);
  await withServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/items");
    assert.equal(request.headers["x-my-code-agent-token"], "binding-token");
    assert.equal(request.headers["x-probe"], "yes");
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(body), { value: 42 });
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ saved: true }));
  }, async (port) => {
    const result = await requestJson(
      { port, token: "binding-token" },
      "/items",
      "POST",
      { value: 42 },
      { headers: { "X-Probe": "yes" } },
    );
    assert.deepEqual(result, { status: 201, body: { saved: true } });
  });
});

test("requestJson can omit the token and preserves a non-JSON response", async () => {
  const { requestJson } = await import(moduleUrl.href);
  await withServer((request, response) => {
    assert.equal(request.headers["x-my-code-agent-token"], undefined);
    response.writeHead(418, { "Content-Type": "text/plain" });
    response.end("plain response");
  }, async (port) => {
    const result = await requestJson(
      { port, token: "must-not-leak" },
      "/plain",
      "GET",
      undefined,
      { includeToken: false },
    );
    assert.deepEqual(result, { status: 418, body: "plain response" });
  });
});

test("requestJson rejects after the configured timeout", async () => {
  const { requestJson } = await import(moduleUrl.href);
  await withServer(() => {}, async (port) => {
    await assert.rejects(
      requestJson({ port, token: "token" }, "/slow", "GET", undefined, { timeoutMs: 20 }),
      /timed out.*\/slow/i,
    );
  });
});

test("waitForServerOrigin observes a binding that becomes ready", async () => {
  const { waitForServerOrigin } = await import(moduleUrl.href);
  const binding = { origin: "" };
  setTimeout(() => { binding.origin = "http://127.0.0.1:43123"; }, 10);

  assert.equal(await waitForServerOrigin(binding, 200), "http://127.0.0.1:43123");
  assert.equal(await waitForServerOrigin({ origin: "" }, 0), "");
});
