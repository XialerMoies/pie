import type { SecurityParseResult, ShellDialect } from "../security-ast.js"

export type DangerResult =
  | { dangerous: false; requiresConfirmation?: boolean; reason?: string }
  | { dangerous: true; reason: string }

export interface DangerousCommandOptions {
  parsed?: SecurityParseResult
  shellDialect?: ShellDialect
}

export function normalizeTarget(target: string): string {
  let t = target.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1).trim()
  t = t.replace(/^\$HOME(?:\/|$)/, '~/').replace(/^\${HOME}(?:\/|$)/, '~/')
  t = t.replace(/^\$HOME$/, '~').replace(/^\${HOME}$/, '~')
  t = t.replace(/^%USERPROFILE%/, '~').replace(/^%HOMEPATH%/, '~')
  t = t.replace(/^%HOMEDRIVE%%HOMEPATH%/, '~')
  t = t.replace(/^%WINDIR%/, '/Windows').replace(/^%SystemRoot%/, '/Windows')
  if (/^[A-Za-z]:\\/.test(t)) { const rest = t.slice(2).replace(/\\/g, '/'); t = rest ? '/' + rest : '/' }
  if (t === '/*') return '/'
  if (/^\/\.+$/.test(t)) return '/'
  if (/^\/\//.test(t)) { t = t.replace(/^\/+/, '/'); if (t === '/*') return '/' }
  return t
}

export function danger(reason: string, sample: string): DangerResult {
  return { dangerous: true, reason: `${reason}: ${sample.slice(0, 120)}` }
}

export function confirmDanger(reason: string, sample: string): DangerResult {
  return { dangerous: false, requiresConfirmation: true, reason: `${reason}: ${sample.slice(0, 120)}` }
}

export function baseCommandName(token: string | undefined): string {
  if (!token) return ""
  const base = token.replace(/\\/g, "/").split("/").pop() ?? token
  const lower = base.toLowerCase()
  return lower.endsWith(".exe") ? lower.slice(0, -4) : lower
}
