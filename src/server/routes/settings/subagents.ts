import type { RouteHandler } from "../types.js";
import { resolve } from "node:path";
import { parseBody } from "../parse-body.js";
import {
  readSubagentDefinitions,
  replaceSubagentDefinitions,
  validateSubagentDefinitions,
} from "../../../data/subagent-config.js";
import { cors, publishDashboardChanged } from "./common.js";

export const handleSubagentSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime, paths: p } = ctx;
  const modelRegistry = runtime.modelRegistry;

  if (url === "/api/subagents" && method === "GET") {
    const file = p.SUBAGENTS_FILE || resolve(p.PI_CONFIG_DIR, "subagents.json");
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({ agents: readSubagentDefinitions(file) }));
    return true;
  }

  if (url === "/api/subagents" && method === "PUT") {
    try {
      const body = await parseBody(req);
      const agents = validateSubagentDefinitions(body.agents);
      for (const agent of agents) {
        if (agent.model && !modelRegistry.find(agent.model.provider, agent.model.id)) {
          throw new Error(`Subagent model is not available: ${agent.model.provider}/${agent.model.id}`);
        }
      }
      const file = p.SUBAGENTS_FILE || resolve(p.PI_CONFIG_DIR, "subagents.json");
      const saved = await replaceSubagentDefinitions(file, agents);
      publishDashboardChanged(ctx);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, agents: saved }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
