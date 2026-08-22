import { describe, it } from "node:test"
import { deepEqual, equal } from "node:assert/strict"
import { commandSecurityVerdictShadowDiff } from "../src/agent/tools/command.ts"
import {
  parseCommandForSecurityAsync,
  parseCommandForSecurityLegacyFallback,
  parseCommandForSecurityWithTreeSitterAsync,
  securityParseResultsDifferForShadow,
} from "../src/agent/tools/command/security-parser.ts"

const WORKSPACE = process.cwd()

// Keep this matrix small and deterministic. It is the CI contract for the
// two supported dialect branches, not a second collection of ad-hoc examples.
const PARITY_FIXTURES = [
  { dialect: "posix-bash", command: "echo hello" },
  { dialect: "posix-bash", command: "printf \"a b\" | wc -l" },
  { dialect: "posix-bash", command: "FOO=bar grep \"a|b\" file.txt > count.txt" },
  { dialect: "posix-bash", command: "cat foo 2>&1" },
  { dialect: "posix-bash", command: "bash -lc \"echo hi > out.txt\"" },
  { dialect: "posix-bash", command: "echo $(touch marker)" },
  { dialect: "cmd", command: "echo hello" },
  { dialect: "cmd", command: "dir /b" },
  { dialect: "cmd", command: "echo hello > out.txt" },
  { dialect: "cmd", command: "type package.json" },
  { dialect: "cmd", command: "where node" },
]

describe("M-05 command security parser parity flow", () => {
  it("keeps the canonical parser and explicit fallback on one SecurityParseResult contract", async () => {
    for (const fixture of PARITY_FIXTURES) {
      const canonical = await parseCommandForSecurityAsync(fixture.command, { shellDialect: fixture.dialect })
      const fallback = parseCommandForSecurityLegacyFallback(fixture.command, { shellDialect: fixture.dialect })
      equal(typeof canonical.kind, "string", `${fixture.dialect}: canonical result must be structured`)
      equal(typeof fallback.kind, "string", `${fixture.dialect}: fallback result must be structured`)

      if (fixture.dialect === "posix-bash") {
        const explicitTreeSitter = await parseCommandForSecurityWithTreeSitterAsync(fixture.command, { shellDialect: fixture.dialect })
        equal(explicitTreeSitter.kind === "parse-unavailable", false, `${fixture.command}: Tree-sitter fixture must be available`)
        equal(securityParseResultsDifferForShadow(canonical, explicitTreeSitter), false, `${fixture.command}: canonical/tree-sitter parity drift`)
      } else {
        equal(securityParseResultsDifferForShadow(canonical, fallback), false, `${fixture.command}: cmd fallback parity drift`)
      }
    }
  })

  it("fails CI on a production verdict shadow difference instead of logging it", async () => {
    for (const fixture of PARITY_FIXTURES.filter(({ dialect, command }) => dialect === "posix-bash" && !command.includes("$("))) {
      const diff = await commandSecurityVerdictShadowDiff(fixture.command, {
        cwd: WORKSPACE,
        workspaceRoot: WORKSPACE,
        shellDialect: fixture.dialect,
      })
      equal(diff, null, `${fixture.command}: security verdict shadow drift`)
    }
  })

  it("keeps an unavailable explicit Tree-sitter branch distinguishable for unsupported dialects", async () => {
    const result = await parseCommandForSecurityWithTreeSitterAsync("echo hello", { shellDialect: "cmd" })
    deepEqual(result, { kind: "parse-unavailable", reason: "Tree-sitter bash parser only supports POSIX shell" })
  })

  it("does not let shadow-only switch production POSIX parsing back to legacy", async () => {
    const previous = process.env.MY_CODE_AGENT_TREE_SITTER_SHADOW_ONLY
    process.env.MY_CODE_AGENT_TREE_SITTER_SHADOW_ONLY = "1"
    try {
      const result = await parseCommandForSecurityAsync("echo $(touch marker)", { shellDialect: "posix-bash" })
      equal(result.kind, "too-complex", "shadow-only must not bypass the canonical fail-closed parser")
    } finally {
      if (previous === undefined) delete process.env.MY_CODE_AGENT_TREE_SITTER_SHADOW_ONLY
      else process.env.MY_CODE_AGENT_TREE_SITTER_SHADOW_ONLY = previous
    }
  })
})
