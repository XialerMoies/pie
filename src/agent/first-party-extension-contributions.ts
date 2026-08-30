/** Host-owned activation hooks for shipped extension packages. */
import { capabilityComponentManager } from "./capability-components.js"
import { extensionLifecycle, type ExtensionLifecycleHooks } from "./extension-lifecycle.js"
import { extensionToolRegistry } from "./extension-tool-registry.js"
import { fileOutlineTool } from "./tools/file-outline.js"
import { gitStatusTool } from "./tools/git-status.js"
import type { AgentTool } from "./types.js"
import type { AgentToolAudience } from "./tool-pool.js"

type FirstPartyToolContribution = {
  componentId: string
  resourceId: string
  tool: AgentTool
  audiences: readonly AgentToolAudience[]
}

const FIRST_PARTY_TOOL_CONTRIBUTIONS: readonly FirstPartyToolContribution[] = [
  {
    componentId: "tool.file-outline",
    resourceId: "tool.file_outline",
    tool: fileOutlineTool,
    audiences: ["main", "coordinator", "subagent"],
  },
  {
    componentId: "tool.git-status",
    resourceId: "tool.git-status",
    tool: gitStatusTool,
    audiences: ["main", "coordinator", "subagent"],
  },
]

function contributionFor(componentId: string): FirstPartyToolContribution | undefined {
  return FIRST_PARTY_TOOL_CONTRIBUTIONS.find((contribution) => contribution.componentId === componentId)
}

function hooksFor(contribution: FirstPartyToolContribution): ExtensionLifecycleHooks {
  return {
    activate: ({ registerResource }) => {
      const registration = extensionToolRegistry.registerFirstParty(contribution.componentId, contribution.tool, {
        audiences: contribution.audiences,
      })
      registerResource({ id: contribution.resourceId, dispose: registration.dispose })
    },
  }
}

export function firstPartyExtensionHooks(componentId: string): ExtensionLifecycleHooks {
  const contribution = contributionFor(componentId)
  return contribution ? hooksFor(contribution) : {}
}

/** Reconcile a shipped contribution only after component state is available. */
export function ensureFirstPartyExtensionContributions(): void {
  for (const contribution of FIRST_PARTY_TOOL_CONTRIBUTIONS) {
    const state = capabilityComponentManager.get(contribution.componentId)
    if (!state || state.status !== "active" || extensionToolRegistry.has(contribution.tool.name)) continue
    const registration = extensionToolRegistry.registerFirstParty(contribution.componentId, contribution.tool, {
      audiences: contribution.audiences,
    })
    extensionLifecycle.adopt(contribution.componentId, hooksFor(contribution), [
      { id: contribution.resourceId, dispose: registration.dispose },
    ])
  }
}
