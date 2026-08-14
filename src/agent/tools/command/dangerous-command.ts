import { parseCommandForSecurity } from "./security-parser.js"
import { checkAstDangerousPatterns } from "./dangerous-command/ast-rules.js"
import {
  checkLegacyDangerousPatterns,
  checkTextPreparseDangerousPatterns,
} from "./dangerous-command/text-rules.js"
import {
  baseCommandName,
  type DangerResult,
  type DangerousCommandOptions,
} from "./dangerous-command/shared.js"

export { baseCommandName }
export type { DangerResult, DangerousCommandOptions }

export function isDangerousCommand(cmd: string, options: DangerousCommandOptions = {}): DangerResult {
  const trimmed = cmd.trim()
  if (!trimmed) return { dangerous: false }

  const textResult = checkTextPreparseDangerousPatterns(trimmed)
  if (textResult) return textResult

  const astParsed = options.parsed ?? parseCommandForSecurity(trimmed, { shellDialect: options.shellDialect })
  const astResult = checkAstDangerousPatterns(astParsed, trimmed)
  if (astResult) return astResult

  return checkLegacyDangerousPatterns(trimmed) ?? { dangerous: false }
}
