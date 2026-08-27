import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|js|mjs)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

function readSources(root) {
  return sourceFiles(root).map((path) => ({ path, source: readFileSync(path, "utf8") }));
}

function importsAny(source, patterns) {
  return patterns.some((pattern) => pattern.test(source));
}

describe("architecture dependency direction", () => {
  it("keeps frontend source behind the desktop HTTP/SSE boundary", () => {
    const violations = readSources(join(SRC, "frontend"))
      .filter(({ path, source }) => importsAny(source, [
        /from\s+["'][^"']*src\/(?:agent|server|electron)\//u,
        /import\s*\(\s*["'][^"']*src\/(?:agent|server|electron)\//u,
        /from\s+["'](?:\.\.\/)+(?:agent|server|electron)\//u,
      ]))
      .map(({ path }) => relative(ROOT, path));
    assert.deepEqual(violations, [], `frontend must not import host implementation: ${violations.join(", ")}`);
  });

  it("keeps route handlers on project contracts instead of PI session construction", () => {
    const violations = readSources(join(SRC, "server", "routes"))
      .filter(({ source }) => importsAny(source, [
        /createAgentSession\s*\(/u,
        /from\s+["'][^"']*agent-engine\/pi-runtime(?:\.js)?["']/u,
        /from\s+["']@xiamol\/pi-coding-agent["']/u,
        /from\s+["']@earendil-works\/pi-ai/u,
        /\b(?:ModelRuntime|AgentSession)\b/u,
        /\btoolRegistry\b/u,
      ]));
    assert.deepEqual(violations, [], "route handlers must not construct PI sessions or use global tool registry");
  });

  it("keeps ordinary agent tools independent from desktop and server governance implementations", () => {
    const violations = readSources(join(SRC, "agent", "tools"))
      .filter(({ source }) => importsAny(source, [
        /from\s+["'][^"']*(?:electron|server)\//u,
        /import\s*\(\s*["'][^"']*(?:electron|server)\//u,
        /from\s+["']electron(?:\/|["'])/u,
      ]));
    assert.deepEqual(violations, [], "ordinary tools must use host context contracts, not server/Electron implementations");
  });

  it("keeps direct PI SDK imports inside adapter/provider boundaries", () => {
    const allowedRoots = [join(SRC, "agent-engine"), join(SRC, "model-provider")];
    const violations = readSources(SRC)
      .filter(({ path, source }) => {
        const allowed = allowedRoots.some((root) => path === root || path.startsWith(root + "\\") || path.startsWith(root + "/"));
        return !allowed && importsAny(source, [
          /from\s+["']@xiamol\/pi-coding-agent(?:["'/])/u,
          /from\s+["']@earendil-works\/pi-ai(?:["'/])/u,
        ]);
      })
      .map(({ path }) => relative(ROOT, path));
    assert.deepEqual(violations, [], `direct PI imports must stay in adapter/provider boundaries: ${violations.join(", ")}`);
  });
});
