import { readFileSync } from "node:fs";

import { updateLockedJson } from "./locked-json-store.js";

export const READ_ONLY_SUBAGENT_TOOL_NAMES = [
  "git-status",
  "search",
  "file_read",
  "explorer_list",
  "git_log",
  "file_outline",
] as const;

const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_SUBAGENT_TOOL_NAMES);
const MAX_AGENTS = 50;

export interface SubagentDefinitionModel {
  provider: string;
  id: string;
}

export interface SubagentDefinition {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model?: SubagentDefinitionModel;
}

interface SubagentConfigDocument {
  version: 1;
  agents: SubagentDefinition[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readText(value: unknown, field: string, maximum: number, required = true): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error(`Subagent ${field} is required`);
  if (text.length > maximum) throw new Error(`Subagent ${field} is too long`);
  return text;
}

function validateDefinition(value: unknown): SubagentDefinition {
  if (!isRecord(value)) throw new Error("Subagent definition must be an object");
  const allowed = new Set(["id", "name", "description", "prompt", "tools", "model"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Subagent definition contains unknown field: ${unknown}`);

  const id = readText(value.id, "id", 64);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("Subagent id must use lowercase letters, numbers, and hyphens");
  }
  const name = readText(value.name, "name", 80);
  const description = readText(value.description, "description", 240, false);
  const prompt = readText(value.prompt, "prompt", 8000);
  if (!Array.isArray(value.tools) || value.tools.length < 1) {
    throw new Error("Subagent tools must contain at least one read-only tool");
  }
  const tools = [...new Set(value.tools.map((tool) => readText(tool, "tool", 80)))];
  const unavailable = tools.find((tool) => !READ_ONLY_TOOL_SET.has(tool));
  if (unavailable) throw new Error(`Subagent read-only tool is unavailable: ${unavailable}`);

  let model: SubagentDefinitionModel | undefined;
  if (value.model !== undefined && value.model !== null) {
    if (!isRecord(value.model)) throw new Error("Subagent model must contain provider and id");
    const modelKeys = Object.keys(value.model);
    if (modelKeys.some((key) => key !== "provider" && key !== "id")) {
      throw new Error("Subagent model contains an unknown field");
    }
    model = {
      provider: readText(value.model.provider, "model provider", 120),
      id: readText(value.model.id, "model id", 240),
    };
  }

  return { id, name, description, prompt, tools, ...(model ? { model } : {}) };
}

export function validateSubagentDefinitions(value: unknown): SubagentDefinition[] {
  if (!Array.isArray(value)) throw new Error("Subagent definitions must be an array");
  if (value.length > MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} subagents may be configured`);
  const agents = value.map(validateDefinition);
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) throw new Error(`Duplicate subagent id: ${agent.id}`);
    seen.add(agent.id);
  }
  return agents;
}

export function readSubagentDefinitions(file: string): SubagentDefinition[] {
  try {
    const document = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(document) || document.version !== 1) return [];
    return validateSubagentDefinitions(document.agents);
  } catch {
    return [];
  }
}

export function readSubagentDefinitionsStrict(file: string): SubagentDefinition[] {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (!isRecord(document) || document.version !== 1) {
    throw new Error("Subagent configuration version must equal 1");
  }
  return validateSubagentDefinitions(document.agents);
}

export async function replaceSubagentDefinitions(
  file: string,
  value: unknown,
): Promise<SubagentDefinition[]> {
  const agents = validateSubagentDefinitions(value);
  await updateLockedJson<SubagentConfigDocument>(
    file,
    () => ({ version: 1, agents: [] }),
    () => ({ version: 1, agents }),
    { recoverInvalidJson: true, trailingNewline: false },
  );
  return agents;
}
