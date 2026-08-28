import { createHash } from "node:crypto"
import { lstat, realpath, rm } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { scanSkillRoots, type ScannedSkill, type SkillScanDiagnostic } from "./skill-scanner.js"
import { SkillStateStore } from "./skill-state-store.js"
import type { SkillPromptInput } from "./skill-prompt.js"
import type { SkillDiagnostic, SkillSource, SkillSummary } from "./types.js"

export interface SkillServiceOptions {
  userRoot: string
  workspaceRoot: string | (() => string | undefined)
  statePath: string
  knownTools: ReadonlySet<string>
}

export interface SkillListResult {
  skills: SkillSummary[]
  diagnostics: SkillScanDiagnostic[]
  failClosed?: true
  revision?: string
  workspaceKey?: string
}

export interface SkillFactSnapshot {
  revision: string
  generatedAt: string
  workspaceRoot?: string
  workspaceKey?: string
  result: SkillListResult
  entries: ScannedSkill[]
}

export type SkillLoadResult =
  | { ok: true; id: string; body: string }
  | { ok: false; id: string; diagnostic: SkillDiagnostic }

interface SkillScopeSnapshot {
  workspaceRoot?: string
  workspaceKey?: string
}

interface SkillListSnapshot {
  result: SkillListResult
  entries: ScannedSkill[]
}

const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== "." && id !== ".."

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`
}

export class SkillService {
  private readonly state: SkillStateStore

  constructor(private readonly options: SkillServiceOptions) {
    this.state = new SkillStateStore(options.statePath)
  }

  private workspaceRoot(): string | undefined {
    return typeof this.options.workspaceRoot === "function" ? this.options.workspaceRoot() : this.options.workspaceRoot
  }

  private scopeSnapshot(workspaceSkillRoot?: string): SkillScopeSnapshot {
    const root = workspaceSkillRoot ?? this.workspaceRoot()
    if (!root) return {}
    const normalized = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root)
    return {
      workspaceRoot: root,
      workspaceKey: createHash("sha256").update(normalized).digest("hex"),
    }
  }

  private stateKey(source: SkillSource, id: string, scope: SkillScopeSnapshot): string {
    return source === "user" ? `user:${id}` : `workspace:${scope.workspaceKey}:${id}`
  }

  async rescan(): Promise<SkillListResult> {
    return this.list()
  }

  async list(): Promise<SkillListResult> {
    const snapshot = await this.snapshot()
    return { ...snapshot.result, revision: snapshot.revision, ...(snapshot.workspaceKey ? { workspaceKey: snapshot.workspaceKey } : {}) }
  }

  async snapshot(workspaceSkillRoot?: string): Promise<SkillFactSnapshot> {
    const scope = this.scopeSnapshot(workspaceSkillRoot)
    const snapshot = await this.listSnapshot(scope)
    const revision = createHash("sha256").update(stable({
      scope,
      skills: snapshot.result.skills,
      diagnostics: snapshot.result.diagnostics,
      failClosed: snapshot.result.failClosed === true,
      fingerprints: snapshot.entries.map((entry) => ({ id: entry.id, source: entry.source, fingerprint: entry.fingerprint })),
    })).digest("hex")
    const resultWithRevision: SkillListResult = {
      ...snapshot.result,
      revision,
      ...(scope.workspaceKey ? { workspaceKey: scope.workspaceKey } : {}),
    }
    return {
      revision,
      generatedAt: new Date().toISOString(),
      ...(scope.workspaceRoot ? { workspaceRoot: scope.workspaceRoot } : {}),
      ...(scope.workspaceKey ? { workspaceKey: scope.workspaceKey } : {}),
      result: resultWithRevision,
      entries: snapshot.entries,
    }
  }

  async promptInput(workspaceSkillRoot: string, factSnapshot?: SkillFactSnapshot): Promise<SkillPromptInput> {
    const snapshot = factSnapshot || await this.snapshot(workspaceSkillRoot)
    const expectedScope = this.scopeSnapshot(workspaceSkillRoot)
    if (snapshot.workspaceKey !== expectedScope.workspaceKey || snapshot.workspaceRoot !== expectedScope.workspaceRoot) {
      throw new Error("Skill snapshot scope does not match the requested workspace")
    }
    const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]))
    const bodies = new Map<string, string>()
    for (const summary of snapshot.result.skills) {
      if (!summary.enabled || summary.trust !== "trusted" || summary.parse !== "valid") continue
      const entry = entries.get(summary.id)
      if (entry?.skill) bodies.set(summary.id, entry.skill.body)
    }
    return {
      summaries: snapshot.result.skills,
      bodies,
      revision: snapshot.revision,
      workspaceKey: snapshot.workspaceKey,
      diagnostics: snapshot.result.diagnostics,
    }
  }

  private async listSnapshot(scope: SkillScopeSnapshot): Promise<SkillListSnapshot> {
    const scan = await scanSkillRoots({ userRoot: this.options.userRoot, workspaceRoot: scope.workspaceRoot, knownTools: this.options.knownTools })
    const state = await this.state.read()
    const skills = scan.skills.map((entry): SkillSummary => {
      const record = state.records[this.stateKey(entry.source, entry.id, scope)]
      let diagnostic = entry.diagnostic
      let trust = record?.trust ?? "untrusted"
      let enabled = record?.enabled === true
      if (state.failClosed) {
        trust = "untrusted"
        enabled = false
        diagnostic = { code: "state_corrupt", message: "skill state is corrupt" }
      } else if (record && record.fingerprint !== entry.fingerprint) {
        trust = "untrusted"
        enabled = false
        diagnostic = { code: "content_changed", message: "skill content changed after trust confirmation" }
      } else if (entry.parse === "invalid") {
        trust = "untrusted"
        enabled = false
      } else if (trust !== "trusted") {
        enabled = false
      }
      return {
        id: entry.id,
        name: entry.skill?.name ?? entry.id,
        description: entry.skill?.description ?? "",
        source: entry.source,
        path: entry.relativePath,
        trust,
        enabled,
        fingerprint: entry.fingerprint,
        parse: entry.parse,
        declaredTools: entry.skill?.declaredTools ?? [],
        ...(diagnostic ? { diagnostic } : {}),
      }
    })
    return {
      result: { skills, diagnostics: [...scan.diagnostics, ...state.diagnostics.map((diagnostic) => ({ id: "<state>", source: "user" as const, ...diagnostic }))], ...(state.failClosed ? { failClosed: true as const } : {}) },
      entries: scan.skills,
    }
  }

  private async effective(source: SkillSource, id: string, scope: SkillScopeSnapshot): Promise<{ entry: ScannedSkill; failClosed: boolean }> {
    if (!validId(id)) throw new Error("Invalid skill id")
    const scan = await scanSkillRoots({ userRoot: this.options.userRoot, workspaceRoot: scope.workspaceRoot, knownTools: this.options.knownTools })
    const entry = scan.skills.find((item) => item.id === id)
    if (!entry) throw new Error("Skill not found")
    if (entry.source !== source) throw new Error("Skill source is overridden")
    if (entry.parse !== "valid" || !entry.skill) throw new Error("Skill is invalid")
    const state = await this.state.read()
    return { entry, failClosed: state.failClosed === true }
  }

  async trust(source: SkillSource, id: string): Promise<void> {
    const scope = this.scopeSnapshot()
    const { entry, failClosed } = await this.effective(source, id, scope)
    if (failClosed) throw new Error("Skill state is corrupt")
    await this.state.set(source, id, { trust: "trusted", enabled: false, fingerprint: entry.fingerprint, confirmedAt: new Date().toISOString() }, scope.workspaceKey)
  }

  async untrust(source: SkillSource, id: string): Promise<void> {
    const scope = this.scopeSnapshot()
    const { entry, failClosed } = await this.effective(source, id, scope)
    if (failClosed) throw new Error("Skill state is corrupt")
    await this.state.set(source, id, { trust: "untrusted", enabled: false, fingerprint: entry.fingerprint }, scope.workspaceKey)
  }

  async enable(source: SkillSource, id: string): Promise<void> {
    const scope = this.scopeSnapshot()
    const { entry, failClosed } = await this.effective(source, id, scope)
    if (failClosed) throw new Error("Skill state is corrupt")
    await this.state.update(source, id, (record) => {
      if (record?.trust !== "trusted" || record.fingerprint !== entry.fingerprint) throw new Error("Skill is untrusted")
      return { ...record, enabled: true }
    }, scope.workspaceKey)
  }

  async disable(source: SkillSource, id: string): Promise<void> {
    const scope = this.scopeSnapshot()
    const { entry, failClosed } = await this.effective(source, id, scope)
    if (failClosed) throw new Error("Skill state is corrupt")
    await this.state.update(source, id, (record) => ({
      trust: record?.trust ?? "untrusted",
      enabled: false,
      fingerprint: record?.fingerprint ?? entry.fingerprint,
      ...(record?.confirmedAt ? { confirmedAt: record.confirmedAt } : {}),
    }), scope.workspaceKey)
  }

  async load(source: SkillSource, id: string): Promise<SkillLoadResult> {
    try {
      const scope = this.scopeSnapshot()
      const { entry, failClosed } = await this.effective(source, id, scope)
      if (failClosed) return { ok: false, id, diagnostic: { code: "state_corrupt", message: "skill state is corrupt" } }
      const state = await this.state.read()
      const record = state.records[this.stateKey(source, id, scope)]
      if (!record || record.trust !== "trusted") return { ok: false, id, diagnostic: { code: "untrusted", message: "skill is untrusted" } }
      if (record.fingerprint !== entry.fingerprint) return { ok: false, id, diagnostic: { code: "content_changed", message: "skill content changed" } }
      if (!record.enabled) return { ok: false, id, diagnostic: { code: "disabled", message: "skill is disabled" } }
      return { ok: true, id, body: entry.skill!.body }
    } catch (error: any) {
      return { ok: false, id, diagnostic: { code: "path_rejected", message: error?.message || "skill cannot be loaded" } }
    }
  }

  async remove(source: SkillSource, id: string): Promise<void> {
    if (!validId(id)) throw new Error("Invalid skill id")
    const scope = this.scopeSnapshot()
    const scan = await scanSkillRoots({ userRoot: this.options.userRoot, workspaceRoot: scope.workspaceRoot, knownTools: this.options.knownTools })
    const entry = scan.skills.find((item) => item.id === id)
    if (!entry) throw new Error("Skill not found")
    if (entry.source !== source) throw new Error("Skill source is overridden")
    if ((await this.state.read()).failClosed) throw new Error("Skill state is corrupt")
    const root = resolve(source === "user" ? this.options.userRoot : scope.workspaceRoot || "")
    const target = resolve(root, id)
    if (!validId(id) || !contained(root, target)) throw new Error("Invalid skill path")
    const [rootStat, parentStat, stat, canonicalRoot, canonicalTarget] = await Promise.all([
      lstat(root),
      source === "workspace" ? lstat(dirname(root)) : Promise.resolve(undefined),
      lstat(target),
      realpath(root),
      realpath(target),
    ])
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || parentStat?.isSymbolicLink()
      || !stat.isDirectory() || stat.isSymbolicLink() || !contained(canonicalRoot, canonicalTarget)) throw new Error("Invalid skill path")
    await rm(target, { recursive: true })
    await this.state.delete(source, id, scope.workspaceKey)
  }
}
