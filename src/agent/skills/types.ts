export type SkillSource = "user" | "workspace"
export type SkillTrust = "untrusted" | "trusted"
export type SkillParseStatus = "valid" | "invalid"

export type SkillDiagnosticCode =
  | "invalid_frontmatter"
  | "name_mismatch"
  | "empty_description"
  | "unknown_tool"
  | "empty_body"
  | "path_rejected"
  | "overridden"
  | "state_corrupt"
  | "untrusted"
  | "disabled"
  | "content_changed"

export interface SkillStateRecord {
  trust: SkillTrust
  enabled: boolean
  fingerprint: string
  confirmedAt?: string
}

export interface SkillSummary {
  id: string
  name: string
  description: string
  source: SkillSource
  path: string
  trust: SkillTrust
  enabled: boolean
  /** Content fingerprint used by declaration catalogs and trust state. */
  fingerprint?: string
  parse: SkillParseStatus
  declaredTools: string[]
  diagnostic?: SkillDiagnostic
}

export interface SkillDiagnostic {
  code: SkillDiagnosticCode
  message: string
}

export interface ParsedSkill {
  id: string
  name: string
  description: string
  declaredTools: string[]
  body: string
}

export type SkillParseResult =
  | { ok: true; skill: ParsedSkill }
  | { ok: false; diagnostic: SkillDiagnostic }
