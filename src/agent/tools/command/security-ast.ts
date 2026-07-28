import type { ShellDialect } from "../../types.js"
import type { ShellSegmentOperator } from "./shell-parser.js"

export type { ShellDialect }

export interface SecurityRedirect {
  operator: string
  target?: string
  fd?: number
  isOutput: boolean
  isFdRedirect: boolean
  isSafeReadOnlySink: boolean
}

export interface SimpleCommand {
  argv: string[]
  envVars: { name: string; value: string }[]
  redirects: SecurityRedirect[]
  text: string
  start: number
  end: number
  dialect: ShellDialect
  nextOperator?: ShellSegmentOperator
}

export type SecurityParseResult =
  | {
      kind: "simple"
      commands: SimpleCommand[]
      redirects: SecurityRedirect[]
      dialect: ShellDialect
    }
  | { kind: "too-complex"; reason: string; nodeType?: string }
  | { kind: "parse-unavailable"; reason?: string }

export interface SecurityParseOptions {
  shellDialect?: ShellDialect
}
