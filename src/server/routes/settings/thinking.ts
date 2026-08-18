import { resolveEngine, type RouteHandler } from "../types.js";
import { parseBody } from "../parse-body.js";
import { cors, publishDashboardChanged } from "./common.js";

export const handleThinkingSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const engine = resolveEngine(ctx);

  if (url === "/api/thinking-level" && method === "GET") {
    const session = engine.session;
    const available = session.availableThinkingLevels ?? ["off", "low", "medium", "high"];
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      level: session.thinkingLevel ?? "off",
      availableLevels: available,
      supportsThinking: session.supportsThinking ?? available.some((level) => level !== "off"),
    }));
    return true;
  }

  if (url === "/api/thinking-level" && method === "POST") {
    try {
      const { level } = await parseBody(req);
      await engine.setThinkingLevel(level);
      const session = engine.session;
      const available = session.availableThinkingLevels ?? ["off", "low", "medium", "high"];
      const supportsThinking = session.supportsThinking ?? available.some((item) => item !== "off");
      publishDashboardChanged(ctx);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({
        ok: true,
        level: session.thinkingLevel,
        availableLevels: available,
        supportsThinking,
      }));
    } catch (err: unknown) {
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
