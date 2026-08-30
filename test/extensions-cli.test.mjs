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

function lifecycleResult(result) {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
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
      assert.equal(result.status, 1)
      assert.match(result.stderr, /^扩展校验失败/m)
      assert.match(result.stderr, /文件: .*invalid\.json/)
      assert.match(result.stderr, /代码: invalid_manifest/)
      assert.match(result.stderr, /原因: Setting is reserved for host-owned secure storage: api-key/)
      assert.match(result.stderr, /修复建议: 根据原因修正对应 manifest 字段后重试。/)
      assert.doesNotMatch(result.stderr, /at normalizeCapabilityComponentPackageManifest/)
      assert.equal(existsSync(componentState), false)
      assert.equal(existsSync(packageState), false)
    } finally {
      rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  it("reports invalid JSON with a stable diagnostic", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "extensions-cli-json-"))
    const invalidManifest = join(dataRoot, "invalid.json")
    try {
      writeFileSync(invalidManifest, "{ invalid", "utf8")
      const result = run(["validate", "--manifest", invalidManifest], { PI_USER_CONFIG: dataRoot })
      assert.equal(result.status, 1)
      assert.match(result.stderr, /^扩展校验失败/m)
      assert.match(result.stderr, /代码: invalid_json/)
      assert.match(result.stderr, /原因: manifest 不是有效的 JSON/)
      assert.match(result.stderr, /修复建议: 检查逗号、引号和 JSON 结构后重试。/)
      assert.doesNotMatch(result.stderr, /SyntaxError/)
    } finally {
      rmSync(dataRoot, { recursive: true, force: true })
    }
  })

  it("keeps an external declaration inert until trusted and removed across CLI restarts", () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "extensions-cli-lifecycle-"))
    const componentState = join(dataRoot, "component-state.json")
    const packageState = join(dataRoot, "extension-packages.json")
    const options = ["--component-state-file", componentState, "--package-state-file", packageState]
    const env = { PI_USER_CONFIG: dataRoot }
    const id = "example.cli.extension"
    try {
      assert.equal(run(["validate", "--manifest", fixture], env).status, 0)
      const installed = lifecycleResult(run(["install", "--manifest", fixture, ...options], env))
      assert.equal(installed.lifecycle.phase, "installed")
      assert.equal(installed.package.trusted, false)

      const denied = run(["enable", id, ...options], env)
      assert.notEqual(denied.status, 0)
      assert.match(denied.stderr, /Cannot enable untrusted component/)

      const trusted = lifecycleResult(run(["trust", id, ...options], env))
      assert.equal(trusted.lifecycle.phase, "disabled")
      assert.equal(trusted.package.trusted, true)
      assert.equal(lifecycleResult(run(["enable", id, ...options], env)).lifecycle.phase, "active")
      assert.equal(lifecycleResult(run(["disable", id, ...options], env)).lifecycle.phase, "disposed")
      const removed = lifecycleResult(run(["uninstall", id, ...options], env))
      assert.equal(removed.lifecycle.phase, "uninstalled")
      assert.equal(removed.package, null)

      const restarted = lifecycleResult(run(["list", ...options], env))
      assert.deepEqual(restarted.packages, [])
      assert.deepEqual(restarted.components, [])
    } finally {
      rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})
