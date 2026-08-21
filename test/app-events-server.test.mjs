import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppEventHub } from "../src/server/app-events.ts";
import { openAppEventStream } from "../src/server/server.ts";
import { WorkspaceFileWatcher } from "../src/server/workspace-file-watcher.ts";

function response() {
  return {
    destroyed: false,
    writableEnded: false,
    writes: [],
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(frame) { this.writes.push(String(frame)); return true; },
    end() { this.writableEnded = true; },
  };
}

describe("AppEventHub", () => {
  it("registers clients once and publishes sequenced frames", () => {
    const hub = new AppEventHub();
    const client = response();
    hub.addClient(client);
    hub.addClient(client);
    hub.publish("dashboard.changed", { source: "test" });

    assert.equal(hub.clientsSnapshot().length, 1);
    assert.equal(client.writes.length, 1);
    assert.deepEqual(JSON.parse(client.writes[0].slice(6)), {
      type: "dashboard.changed", revision: 1, payload: { source: "test" },
    });
  });

  it("removes ended clients without affecting healthy clients", () => {
    const hub = new AppEventHub();
    const healthy = response();
    const ended = response();
    ended.writableEnded = true;
    hub.addClient(healthy);
    hub.addClient(ended);
    hub.publish("usage.changed");

    assert.equal(hub.clientsSnapshot().length, 1);
    assert.equal(healthy.writes.length, 1);
  });

  it("closes clients and stops future delivery", () => {
    const hub = new AppEventHub();
    const client = response();
    hub.addClient(client);
    hub.closeAll();
    hub.publish("mcp.changed");

    assert.equal(client.writableEnded, true);
    assert.equal(hub.clientsSnapshot().length, 0);
  });
});

describe("application event stream", () => {
  it("sends the current revision and unregisters the client on close", () => {
    const hub = new AppEventHub();
    hub.publish("dashboard.changed");
    const reqHandlers = new Map();
    const req = { on(event, handler) { reqHandlers.set(event, handler); return this; } };
    const res = response();

    openAppEventStream(req, res, hub, { "Access-Control-Allow-Origin": "*" }, { requestId: "req-1", traceId: "trace-1" });
    assert.equal(res.status, 200);
    assert.match(res.writes[0], /"type":"connected"/);
    assert.match(res.writes[0], /"revision":1/);
    assert.equal(hub.clientsSnapshot().length, 1);
    reqHandlers.get("close")?.();
    assert.equal(hub.clientsSnapshot().length, 0);
  });
});

describe("WorkspaceFileWatcher", () => {
  it("debounces workspace changes and ignores generated paths", async () => {
    let listener;
    const changed = [];
    const watcher = new WorkspaceFileWatcher({
      appRoot: "E:/app",
      debounceMs: 1,
      onChange: (file) => changed.push(file),
      watch: (_root, _options, next) => { listener = next; return { close() {} }; },
    });

    watcher.watchWorkspace("E:/app");
    listener("change", "src/main.ts");
    listener("change", "dist/main.js");
    await new Promise((resolve) => setTimeout(resolve, 10));
    watcher.close();

    assert.deepEqual(changed, ["src/main.ts"]);
  });
});
