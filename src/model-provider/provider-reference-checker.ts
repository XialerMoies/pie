import type { SubagentDefinition } from "../data/subagent-config.js";

export type ProviderReference =
  | { kind: "currentModel"; providerId: string; modelId: string }
  | { kind: "defaultModel"; providerId: string; modelId: string }
  | {
    kind: "customAgent";
    providerId: string;
    modelId: string;
    agentId: string;
    agentName: string;
  };

export interface ProviderReferenceSources {
  currentModel(): { provider: string; id: string } | undefined;
  defaultModel(): { provider: string; id: string } | undefined;
  customAgents(): SubagentDefinition[];
}

export class CustomProviderReferenceConflict extends Error {
  constructor(public readonly references: ProviderReference[]) {
    super("Custom provider is still in use");
    this.name = "CustomProviderReferenceConflict";
  }
}

export class ProviderReferenceChecker {
  readonly #sources: ProviderReferenceSources;

  constructor(sources: ProviderReferenceSources) {
    this.#sources = sources;
  }

  find(providerId: string, modelIds?: ReadonlySet<string>): ProviderReference[] {
    const matches = (model: { provider: string; id: string } | undefined): model is { provider: string; id: string } => (
      model !== undefined
      && model.provider === providerId
      && (modelIds === undefined || modelIds.has(model.id))
    );
    const references: ProviderReference[] = [];
    const current = this.#sources.currentModel();
    if (matches(current)) {
      references.push({ kind: "currentModel", providerId, modelId: current.id });
    }
    const defaultModel = this.#sources.defaultModel();
    if (matches(defaultModel)) {
      references.push({ kind: "defaultModel", providerId, modelId: defaultModel.id });
    }
    for (const agent of this.#sources.customAgents()) {
      if (!matches(agent.model)) continue;
      references.push({
        kind: "customAgent",
        providerId,
        modelId: agent.model.id,
        agentId: agent.id,
        agentName: agent.name,
      });
    }
    return references;
  }

  assertUnused(providerId: string, modelIds?: ReadonlySet<string>): void {
    const references = this.find(providerId, modelIds);
    if (references.length > 0) throw new CustomProviderReferenceConflict(references);
  }
}
