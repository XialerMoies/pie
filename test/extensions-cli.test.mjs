import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { describe, it } from "node:test"

const root = resolve(import.meta.dirname, "..")
const fixture = resolve(root, "test/fixtures/extension-manifest.json")

function run(args, env = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/extensions.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

describe("extensions validate CLI", () => {
  it("prints normalized declaration facts without creating extension state", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "extensions-cli-"))
    const componentState = join(dataRoot, "component-state.json")
    const packageState = join(dataRoot, "extensions.json")
    try {
      const result = run(["validate", "--manifest", fixture, "--component-state-file", componentState, "--package-state-file", packageState], {
        PI_USER_CONFIG: dataRoot,
      })
      assert.equal(result.status, 0, result.stderr)
      for (const text of ["扩展校验通过", "标题: CLI 示例扩展", "作者: XialerMoies", "贡献点: agent-tool", "权限: read", "Agent 限额: 超时 30000 ms；并发 2", "设置项: 结果数量 (number)、安全搜索 (boolean)", "兼容性: 宿主 ^1.0.0；契约 1"]) {
        assert.match(result.stdout, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")))
      }
      assert.equal(existsSync(componentState), false)
      assert.equal(existsSync(packageState), false)
    } finally {
      rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  it("rejects an invalid declaration without creating extension state", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "extensions-cli-invalid-"))
    const invalidManifest = join(dataRoot, "invalid.json")
    const componentState = join(dataRoot, "component-state.json")
    const packageState = join(dataRoot, "extensions.json")
    try {
      const manifest = JSON.parse(readFileSync(fixture, "utf8"))
      manifest.component.settings[0].id = "api-key"
      writeFileSync(invalidManifest, JSON.stringify(manifest), "utf8")
      const result = run(["validate", "--manifest", invalidManifest, "--component-state-file", componentState, "--package-state-file", packageState], {
        PI_USER_CONFIG: dataRoot,
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /Setting is reserved for host-owned secure storage: api-key/)
      assert.equal(existsSync(componentState), false)
      assert.equal(existsSync(packageState), false)
    } finally {
      rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
