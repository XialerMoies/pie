import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { parseSkillDocument } from "./skill-parser.js"
import type { ParsedSkill, SkillDiagnostic, SkillParseStatus, SkillSource } from "./types.js"

export interface ScannedSkill {
  id: string
  source: SkillSource
  relativePath: string
  absolutePath: string
  fingerprint: string
  parse: SkillParseStatus
  skill?: ParsedSkill
  diagnostic?: SkillDiagnostic
}

export interface SkillScanDiagnostic extends SkillDiagnostic {
  id: string
  source: SkillSource
}

export interface SkillScanResult {
  skills: ScannedSkill[]
  diagnostics: SkillScanDiagnostic[]
}

export interface SkillRootOptions {
  userRoot: string
  workspaceRoot?: string
  knownTools: ReadonlySet<string>
}

const posix = (value: string) => value.split(sep).join("/")
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const validId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) && id !== "." && id !== ".."

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

async function scanRoot(root: string | undefined, source: SkillSource, knownTools: ReadonlySet<string>): Promise<SkillScanResult> {
  if (!root) return { skills: [], diagnostics: [] }
  const resolvedRoot = resolve(root)
  try {
    const rootStat = await lstat(resolvedRoot)
    const parentStat = source === "workspace" ? await lstat(dirname(resolvedRoot)) : undefined
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || parentStat?.isSymbolicLink()) {
      return { skills: [], diagnostics: [{ id: "<root>", source, code: "path_rejected", message: "skill root must not use a symbolic link" }] }
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return { skills: [], diagnostics: [] }
    return { skills: [], diagnostics: [{ id: "<root>", source, code: "path_rejected", message: "skill root cannot be inspected" }] }
  }
  let entries
  try {
    entries = await readdir(resolvedRoot, { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === "ENOENT") return { skills: [], diagnostics: [] }
    return { skills: [], diagnostics: [{ id: "<root>", source, code: "path_rejected" as SkillDiagnostic["code"], message: "skill root cannot be read" }] }
  }
  const skills: ScannedSkill[] = []
  const diagnostics: SkillScanDiagnostic[] = []
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    const id = entry.name
    if (!validId(id)) {
      diagnostics.push({ id, source, code: "path_rejected", message: "skill directory name is invalid" })
      continue
    }
    const directory = resolve(resolvedRoot, id)
    if (!isContained(resolvedRoot, directory) || id === "." || id === ".." || id.includes("/") || id.includes("\\")) continue
    let directoryStat
    try { directoryStat = await lstat(directory) } catch { continue }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) continue
    const filePath = resolve(directory, "SKILL.md")
    if (!isContained(resolvedRoot, filePath)) continue
    let fileStat
    try { fileStat = await lstat(filePath) } catch (error: any) {
      if (error?.code !== "ENOENT") diagnostics.push({ id, source, code: "path_rejected" as SkillDiagnostic["code"], message: "skill file cannot be read" })
      continue
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      diagnostics.push({ id, source, code: "path_rejected" as SkillDiagnostic["code"], message: "SKILL.md must be a regular file" })
      continue
    }
    let document: string
    try { document = await readFile(filePath, "utf8") } catch {
      diagnostics.push({ id, source, code: "path_rejected" as SkillDiagnostic["code"], message: "skill file cannot be read" })
      continue
    }
    const fingerprint = createHash("sha256").update(document).digest("hex")
    const parsed = parseSkillDocument(document, id, knownTools)
    const item: ScannedSkill = {
      id,
      source,
      relativePath: posix(relative(resolvedRoot, filePath)),
      absolutePath: filePath,
      fingerprint,
      parse: parsed.ok ? "valid" : "invalid",
      ...(parsed.ok ? { skill: parsed.skill } : { diagnostic: parsed.diagnostic }),
    }
    skills.push(item)
    if (!parsed.ok) diagnostics.push({ id, source, ...parsed.diagnostic })
  }
  return { skills, diagnostics }
}

export async function scanSkillRoots(options: SkillRootOptions): Promise<SkillScanResult> {
  const [user, workspace] = await Promise.all([
    scanRoot(options.userRoot, "user", options.knownTools),
    scanRoot(options.workspaceRoot, "workspace", options.knownTools),
  ])
  const effective = new Map<string, ScannedSkill>()
  for (const skill of user.skills) effective.set(skill.id, skill)
  for (const skill of workspace.skills) effective.set(skill.id, skill)
  return {
    skills: [...effective.values()].sort((a, b) => compare(`${a.source}:${a.id}`, `${b.source}:${b.id}`)),
    diagnostics: [...user.diagnostics, ...workspace.diagnostics].sort((a, b) => compare(`${a.source}:${a.id}`, `${b.source}:${b.id}`)),
  }
}
