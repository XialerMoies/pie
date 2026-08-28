import {
  capabilityComponentManager,
  type CapabilityComponentHealth,
  type CapabilityComponentState,
} from "../agent/capability-components.js"
import { PROVIDER_PROTOCOLS, type ProviderProtocol } from "./contracts.js"

/** Stable component identity for one model wire-protocol adapter. */
export function modelProtocolComponentId(protocol: ProviderProtocol): string {
  return `model-adapter.${protocol}`
}

export const MODEL_PROTOCOL_COMPONENT_MANIFESTS = Object.freeze(PROVIDER_PROTOCOLS.map((protocol) => ({
  id: modelProtocolComponentId(protocol),
  version: "1.0.0",
  kind: "optional" as const,
  capability: "model-protocol",
  parentId: "model-router",
  providedBy: `my-code-agent.model-adapter.${protocol}`,
  source: "builtin" as const,
  description: `Model protocol adapter: ${protocol}`,
})))

/** Seed shipped protocol adapters without replacing persisted user state. */
export function registerModelProtocolComponents(): void {
  for (const manifest of MODEL_PROTOCOL_COMPONENT_MANIFESTS) {
    if (capabilityComponentManager.get(manifest.id)) continue
    capabilityComponentManager.register(manifest, {
      trusted: true,
      enabled: true,
      health: "healthy",
    })
  }
}

registerModelProtocolComponents()

export function modelProtocolComponent(protocol: ProviderProtocol): CapabilityComponentState | undefined {
  return capabilityComponentManager.get(modelProtocolComponentId(protocol))
}

export function isModelProtocolEnabled(protocol: ProviderProtocol): boolean {
  return modelProtocolComponent(protocol)?.status === "active"
}

export function assertModelProtocolEnabled(protocol: ProviderProtocol): void {
  const state = modelProtocolComponent(protocol)
  if (!state || state.status !== "active") {
    throw new Error(`Model protocol adapter is unavailable: ${protocol}`)
  }
}

/** Host-side health update for adapter probes and recovery tooling. */
export function setModelProtocolHealth(protocol: ProviderProtocol, health: CapabilityComponentHealth): CapabilityComponentState {
  return capabilityComponentManager.setHealth(modelProtocolComponentId(protocol), health)
}
