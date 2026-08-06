import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

import { withFileLock } from "../src/data/file-lock.ts";

function tempLockPath() {
  const lockPath = resolve(mkdtempSync(resolve(tmpdir(), "file-lock-test-")), "state", "resource.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  return lockPath;
}

function runChild(code, args) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", code, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", rejectChild);
    child.once("close", (codeValue) => resolveChild({ code: codeValue, stdout, stderr }));
  });
}

describe("cross-process file lock", () => {
  it("acquires exclusively and releases after the callback", async () => {
    const lockPath = tempLockPath();
    const result = await withFileLock(lockPath, { instanceId: "test-a" }, async () => {
      assert.ok(existsSync(lockPath));
      return "locked-result";
    });

    assert.strictEqual(result, "locked-result");
    assert.equal(existsSync(lockPath), false);
  });

  it("releases the lock when the callback throws", async () => {
    const lockPath = tempLockPath();
    await assert.rejects(
      () => withFileLock(lockPath, { instanceId: "test-error" }, () => {
        throw new Error("callback failed");
      }),
      /callback failed/,
    );
    assert.equal(existsSync(lockPath), false);
  });

  it("closes and removes a newly-created lock when metadata write fails", async () => {
    const lockPath = tempLockPath();
    const probePath = `${lockPath}.probe`;
    const probe = await open(probePath, "w");
    const fileHandlePrototype = Object.getPrototypeOf(probe);
    const originalWriteFile = fileHandlePrototype.writeFile;
    await probe.close();

    fileHandlePrototype.writeFile = async function () {
      const error = new Error("simulated metadata write failure");
      error.code = "EIO";
      throw error;
    };
    try {
      await assert.rejects(
        () => withFileLock(lockPath, {}, () => undefined),
        /simulated metadata write failure/,
      );
    } finally {
      fileHandlePrototype.writeFile = originalWriteFile;
    }

    assert.equal(existsSync(lockPath), false);
    await withFileLock(lockPath, { timeoutMs: 100 }, () => undefined);
  });

  it("times out while a live owner holds the lock", async () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, instanceId: "live-owner", createdAt: Date.now() }));

    await assert.rejects(
      () => withFileLock(lockPath, { timeoutMs: 40, retryMs: 5 }, () => undefined),
      /Timed out acquiring lock/,
    );
  });

  it("removes a stale lock whose process no longer exists", async () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, instanceId: "dead-owner", createdAt: Date.now() }));

    await withFileLock(lockPath, { timeoutMs: 100, retryMs: 5 }, () => undefined);
    assert.equal(existsSync(lockPath), false);
  });

  it("uses mtime to retain recent malformed locks and remove stale ones", async () => {
    const lockPath = tempLockPath();
    writeFileSync(lockPath, "{malformed");

    await assert.rejects(
      () => withFileLock(lockPath, { timeoutMs: 30, retryMs: 5, staleMs: 5_000 }, () => undefined),
      /Timed out acquiring lock/,
    );

    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockPath, staleTime, staleTime);
    await withFileLock(lockPath, { timeoutMs: 100, retryMs: 5, staleMs: 5_000 }, () => undefined);
    assert.equal(existsSync(lockPath), false);
  });

  it("serializes two operating-system processes", async () => {
    const lockPath = tempLockPath();
    const moduleUrl = new URL("../src/data/file-lock.ts", import.meta.url).href;
    const code = `
      const { withFileLock } = await import(${JSON.stringify(moduleUrl)});
      await withFileLock(process.argv[1], { instanceId: process.argv[2], timeoutMs: 2000, retryMs: 10 }, async () => {
        console.log("entered:" + process.argv[2]);
        await new Promise((resolve) => setTimeout(resolve, Number(process.argv[3])));
      });
    `;
    const first = runChild(code, [lockPath, "first", "180"]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = runChild(code, [lockPath, "second", "0"]);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.strictEqual(firstResult.code, 0, firstResult.stderr);
    assert.strictEqual(secondResult.code, 0, secondResult.stderr);
    assert.match(firstResult.stdout, /entered:first/);
    assert.match(secondResult.stdout, /entered:second/);
    assert.equal(existsSync(lockPath), false);
  });
});
