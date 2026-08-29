/** Product-facing records for external service instances. */
export const INTEGRATION_RECORD_SCHEMA_VERSION = 1 as const

export type IntegrationKind = "mcp-server" | (string & {})
export type IntegrationHealth = "unknown" | "healthy" | "broken" | "unavailable"
export type IntegrationLifecycle = "configured" | "connecting" | "connected" | "disconnected" | "error" | "disposed"

export interface IntegrationRecord {
  readonly schemaVersion: typeof INTEGRATION_RECORD_SCHEMA_VERSION
  readonly id: string
  readonly kind: IntegrationKind
  readonly name: string
  /** Opaque reference to connection configuration; never the secret-bearing config. */
  readonly configRef: string
  readonly trustFingerprint: string
  readonly trusted: boolean
  readonly enabled: boolean
  readonly health: IntegrationHealth
  readonly lifecycle: IntegrationLifecycle
  readonly capabilities: readonly string[]
}

export interface McpIntegrationInput {
  name: string
  workspace: string
  trustFingerprint: string
  trusted: boolean
  enabled: boolean
  state: "connecting" | "connected" | "disconnected" | "error"
  tools?: readonly string[]
}

function integrationId(kind: string, name: string): string {
  return `${kind}.${name.trim().toLocaleLowerCase().replace(/[^a-z0-9._-]+/gu, "-")}`
}

/** Build an MCP record without exposing command, URL, headers, env, or secrets. */
export function mcpIntegrationRecord(input: McpIntegrationInput): Readonly<IntegrationRecord> {
  const health: IntegrationHealth = input.state === "connected" ? "healthy" : input.state === "error" ? "broken" : "unknown"
  const lifecycle: IntegrationLifecycle = input.state
  return Object.freeze({
    schemaVersion: INTEGRATION_RECORD_SCHEMA_VERSION,
    id: integrationId("mcp-server", input.name),
    kind: "mcp-server",
    name: input.name,
    configRef: `mcp://${encodeURIComponent(input.workspace)}/${encodeURIComponent(input.name)}`,
    trustFingerprint: input.trustFingerprint,
    trusted: input.trusted,
    enabled: input.enabled,
    health,
    lifecycle,
    capabilities: Object.freeze([...(input.tools || [])].filter((tool): tool is string => typeof tool === "string").sort()),
  })
}
