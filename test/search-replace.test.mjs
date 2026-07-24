/**
 * Search & Replace — 后端核心逻辑测试
 *
 * 测试 doReplace() 在各种场景下的行为：
 *   - preview 模式
 *   - apply 模式
 *   - regex + capture group
 *   - case sensitive
 *   - 跳过二进制/SKIP_DIRS
 *   - 反向偏移顺序
 *   - 跨行匹配
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// 从 search-core 导入
const { doReplace } = await import("../src/server/routes/search-core.js");

function createTempDir() {
  return mkdtempSync(resolve(tmpdir(), "srtest-"));
}

function write(dir, relPath, content) {
  const full = resolve(dir, relPath);
  const parent = full.substring(0, full.lastIndexOf(sep));
  if (parent) mkdirSync(parent, { recursive: true });
  writeFileSync(full, content, "utf-8");
}

function read(dir, relPath) {
  return readFileSync(resolve(dir, relPath), "utf-8");
}

describe("doReplace — preview mode", () => {
  let dir;

  before(() => {
    dir = createTempDir();
    write(dir, "a.txt", "hello world\nfoo bar\nhello again");
    write(dir, "b.txt", "no match here");
  });

  after(() => rmSync(dir, { recursive: true }));

  it("returns correct structure and does not modify files", () => {
    const result = doReplace({
      query: "hello",
      replacement: "goodbye",
      rootDir: dir,
      caseSensitive: false,
      regex: false,
      previewOnly: true,
    });

    assert.strictEqual(result.preview, true);
    assert.strictEqual(result.totalChanges, 2);
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].matches.length, 2);
    assert.strictEqual(result.files[0].matches[0].oldText, "hello");
    assert.strictEqual(result.files[0].matches[0].newText, "goodbye");

    // file content unchanged
    assert.strictEqual(read(dir, "a.txt"), "hello world\nfoo bar\nhello again");
    assert.strictEqual(read(dir, "b.txt"), "no match here");
  });
});

describe("doReplace — apply mode", () => {
  let dir;

  before(() => {
    dir = createTempDir();
    write(dir, "a.txt", "hello world\nfoo bar\nhello again");
  });

  after(() => rmSync(dir, { recursive: true }));

  it("modifies files in place", () => {
    const result = doReplace({
      query: "hello",
      replacement: "goodbye",
      rootDir: dir,
      caseSensitive: false,
      regex: false,
      previewOnly: false,
    });

    assert.strictEqual(result.preview, false);
    assert.strictEqual(result.totalChanges, 2);
    assert.strictEqual(read(dir, "a.txt"), "goodbye world\nfoo bar\ngoodbye again");
  });
});

describe("doReplace — regex + capture groups", () => {
  let dir;

  before(() => {
    dir = createTempDir();
    write(dir, "data.txt", "foo(1)\nfoo(2)\nfoo(3)");
  });

  after(() => rmSync(dir, { recursive: true }));

  it("supports capture group references ($1, $&)", () => {
    doReplace({
      query: "foo\\((\\d+)\\)",
      replacement: "bar($1)",
      rootDir: dir,
      caseSensitive: false,
      regex: true,
      previewOnly: false,
    });

    assert.strictEqual(read(dir, "data.txt"), "bar(1)\nbar(2)\nbar(3)");
  });
});

describe("doReplace — case sensitive", () => {
  let dir;

  before(() => {
    dir = createTempDir();
    write(dir, "test.txt", "Foo\nfoo\nFOO");
  });

  after(() => rmSync(dir, { recursive: true }));

  it("only matches exact case when caseSensitive=true", () => {
    const result = doReplace({
      query: "foo",
      replacement: "bar",
      rootDir: dir,
      caseSensitive: true,
      regex: false,
      previewOnly: false,
    });

    assert.strictEqual(result.totalChanges, 1);
    assert.strictEqual(read(dir, "test.txt"), "Foo\nbar\nFOO");
  });
});

describe("doReplace — skips binary files", () => {
  let dir;

  before(() => {
    dir = createTempDir();
    write(dir, "text.txt", "hello world");
    write(dir, "image.png", "hello world");
  });

  after(() => rmSync(dir, { recursive: true }));

  it("only searches non-binary files", () => {
    const result = doReplace({
      query: "hello",
      replacement: "goodbye",
      rootDir: dir,
      caseSensitive: false,
      regex: false,
      previewOnly: true,
    });

    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].file, "text.txt");
  });
});

describe("doReplace — reverse offset ordering", () => {
  let dir;

  before(() => {
    dir = createTempDir();
    write(dir, "test.txt", "aaaaaa");
  });

  after(() => rmSync(dir, { recursive: true }));

  it("applies changes from end to start to preserve positions", () => {
    doReplace({
      query: "aa",
      replacement: "b",
      rootDir: dir,
      caseSensitive: false,
      regex: false,
      previewOnly: false,
    });

    assert.strictEqual(read(dir, "test.txt"), "bbb");
  });
});

describe("doReplace — respects SKIP_DIRS", () => {
  let dir;

  before(() => {
    dir = createTempDir();
    mkdirSync(resolve(dir, "node_modules"), { recursive: true });
    write(dir, "node_modules/ignore.txt", "hello world");
    write(dir, "keep.txt", "hello world");
  });

  after(() => rmSync(dir, { recursive: true }));

  it("skips files under SKIP_DIRS directories", () => {
    const result = doReplace({
      query: "hello",
      replacement: "goodbye",
      rootDir: dir,
      caseSensitive: false,
      regex: false,
      previewOnly: true,
    });

    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].file, "keep.txt");
  });
});

describe("doReplace — multi-line matches", () => {
  let dir;

  before(() => {
    dir = createTempDir();
    write(dir, "multi.txt", "hello\nworld\nhello\nworld");
  });

  after(() => rmSync(dir, { recursive: true }));

  it("matches across line boundaries with regex", () => {
    const result = doReplace({
      query: "hello\\nworld",
      replacement: "goodbye",
      rootDir: dir,
      caseSensitive: false,
      regex: true,
      previewOnly: true,
    });

    assert.strictEqual(result.totalChanges, 2);
    assert.strictEqual(result.files[0].matches[0].oldText, "hello\nworld");
    assert.strictEqual(result.files[0].matches[0].newText, "goodbye");
  });
});
