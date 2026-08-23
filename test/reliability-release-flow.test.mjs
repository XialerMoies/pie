import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

import { replayChatEvents, writeChatEvent } from "../src/server/chat-stream.ts";
import { workspaceDataPaths, writeWorkspaceMetadata } from "../src/server/routes/session-dir.ts";
import { waitForServerBootstrap } from "./helpers/server-process-readiness.mjs";

const children = new Set();
const servers = new Set();
const fixtureRoots = new Set();

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function response() {
  return {
    body: "",
    writableEnded: false,
    destroyed: false,
    write(chunk) { this.body += String(chunk); return true; },
  };
}

function createFixture(name) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  fixtureRoots.add(root);
  const workspace = join(root, "workspace");
  const dataRoot = join(root, "data");
  mkdirSync(workspace, { recursive: true });
  return { root, workspace, dataRoot };
}

function seedLargeSession(dataRoot, workspace) {
  const id = "large-reliability-session";
  const paths = workspaceDataPaths(dataRoot, workspace);
  mkdirSync(paths.sessionsDir, { recursive: true });
  const payload = "x".repeat(2048);
  const lines = [JSON.stringify({
    type: "session", id, workspace, cwd: workspace, timestamp: new Date().toISOString(),
  })];
  for (let index = 0; index < 1_500; index += 1) {
    lines.push(JSON.stringify({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: `message-${index}-${payload}` }] },
    }));
  }
  const file = join(paths.sessionsDir, `${id}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { file, id, bytes: Buffer.byteLength(lines.join("\n"), "utf8") };
}

function startServer({ workspace, dataRoot, instanceId, token }) {
  return new Promise((resolveServer, rejectServer) => {
    const childNodeOptions = `${(process.env.NODE_OPTIONS || "").replace(/--max-old-space-size=\d+/gu, "").trim()} --max-old-space-size=512`.trim();
    const child = spawn(process.execPath, [
      "--import", "tsx", resolve("src/server/server.ts"),
      "--workspace", workspace,
      "--data-root", dataRoot,
      "--instance-id", instanceId,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: childNodeOptions, MY_CODE_AGENT_DESKTOP_TOKEN: token, PI_DEV_PORT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let listenObserved = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectServer(new Error(`server startup timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/SERVER_PORT:(\d+)/u);
      if (!match || settled || listenObserved) return;
      listenObserved = true;
      const port = Number(match[1]);
      void waitForServerBootstrap({
        child,
        port,
        token,
        stdout: () => stdout,
        stderr: () => stderr,
      }).then((readiness) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveServer({
          child,
          port,
          token,
          stdout: () => stdout,
          stderr: () => stderr,
          readinessAttempts: readiness.attempts,
        });
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectServer(error);
      });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectServer(error);
    });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectServer(new Error(`server exited before ready (${code ?? "null"}, ${signal || "none"})\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit, rejectExit) => {
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      rejectExit(new Error(`child ${child.pid} did not exit`));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.stdin.write("PI_SERVER_SHUTDOWN\n");
  server.child.stdin.end();
  await waitForExit(server.child);
}

async function crashServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill();
  await waitForExit(server.child);
}

async function getSessions(server, workspace) {
  const responseResult = await fetch(`http://127.0.0.1:${server.port}/api/sessions?workspace=${encodeURIComponent(workspace)}`, {
    headers: { "X-My-Code-Agent-Token": server.token },
  });
  return { status: responseResult.status, body: await responseResult.json() };
}

afterEach(async () => {
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await waitForExit(child).catch(() => undefined);
  }));
  children.clear();
  for (const server of servers) {
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  }
  servers.clear();
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

describe("release reliability cross-layer flows", () => {
  it("bounds a long-running event stream while preserving a reconnectable suffix", () => {
    const live = response();
    const state = { response: live, eventSeq: 0, eventHistory: [] };
    for (let index = 1; index <= 2_000; index += 1) {
      writeChatEvent(state, { type: "content.delta", turnId: "long-turn", seq: index, text: `chunk-${index}` });
    }
    writeChatEvent(state, { type: "done", turnId: "long-turn", status: "completed" });

    assert.equal(state.eventSeq, 2_001);
    assert.equal(state.eventHistory.length, 512, "long streams must keep a bounded history");
    assert.ok(state.eventHistory.every((entry, index, entries) => index === 0 || entry.id > entries[index - 1].id));
    const resumed = response();
    const replayed = replayChatEvents(state, resumed, 1_900);
    assert.equal(replayed, 101);
    assert.match(resumed.body, /"type":"done"/u);
    assert.ok(process.memoryUsage().rss < 2_048 * 1024 * 1024, "long-running flow must remain below the test RSS limit");
  });

  it("recovers a real HTTP SSE client after a disconnected socket", async () => {
    const state = { response: null, eventSeq: 0, eventHistory: [] };
    const server = createServer((req, res) => {
      if (req.url !== "/stream") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (!req.headers["last-event-id"]) {
        state.response = res;
        writeChatEvent(state, { type: "text", value: "before-disconnect" });
        res.destroy();
        return;
      }
      replayChatEvents(state, res, req.headers["last-event-id"]);
      res.end();
    });
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;
    let disconnected = false;
    try {
      const first = await fetch(`http://127.0.0.1:${port}/stream`);
      await first.text();
    } catch {
      disconnected = true;
    }
    assert.equal(disconnected, true, "the first stream must observe the dropped socket");
    state.response = null;
    writeChatEvent(state, { type: "text", value: "after-disconnect" });
    writeChatEvent(state, { type: "done", status: "completed" });
    // A delayed reconnect models the event-loop gap introduced by suspend/resume.
    await delay(50);
    const resumed = await fetch(`http://127.0.0.1:${port}/stream`, { headers: { "Last-Event-ID": "1" } });
    const body = await resumed.text();
    assert.equal(resumed.status, 200);
    assert.match(body, /after-disconnect/u);
    assert.match(body, /"type":"done"/u);
    assert.doesNotMatch(body, /before-disconnect/u);
  });

  it("restores a large session after an ungraceful server crash and fails closed on corruption", async () => {
    const fixture = createFixture("reliability-crash");
    const seeded = seedLargeSession(fixture.dataRoot, fixture.workspace);
    assert.ok(seeded.bytes > 3 * 1024 * 1024, "fixture must exercise a multi-megabyte session");
    const token = "reliability-token";
    const first = await startServer({ ...fixture, instanceId: "reliability-crash", token });
    assert.equal(first.readinessAttempts.at(-1)?.outcome, "success");
    const initial = await getSessions(first, fixture.workspace);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.status, "ok");
    assert.equal(initial.body.sessions.find((session) => session.id === seeded.id)?.messageCount, 1_500);
    await crashServer(first);

    const restarted = await startServer({ ...fixture, instanceId: "reliability-crash", token });
    assert.equal(restarted.readinessAttempts.at(-1)?.outcome, "success");
    const recovered = await getSessions(restarted, fixture.workspace);
    assert.equal(recovered.status, 200);
    assert.equal(recovered.body.sessions.find((session) => session.id === seeded.id)?.messageCount, 1_500);

    writeFileSync(seeded.file, "{ this is a truncated session\n");
    const failed = await getSessions(restarted, fixture.workspace);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.code, "sessions_failed");
  }, { timeout: 90_000 });

  it("reports atomic metadata disk failures and removes temporary files", async () => {
    const fixture = createFixture("reliability-disk");
    const paths = workspaceDataPaths(fixture.dataRoot, fixture.workspace);
    mkdirSync(paths.workspaceRoot, { recursive: true });
    mkdirSync(paths.metadataFile, { recursive: true });

    await assert.rejects(
      async () => writeWorkspaceMetadata(fixture.dataRoot, fixture.workspace),
      (error) => ["EEXIST", "EISDIR", "ENOTDIR", "EPERM"].includes(error?.code),
    );
    const temporaryFiles = readdirSync(paths.workspaceRoot).filter((name) => name.includes(".tmp"));
    assert.deepEqual(temporaryFiles, [], "failed metadata writes must not leave atomic temporary files");
  });
});
