import type { RouteHandler } from "../types.js";
import { parseBody } from "../parse-body.js";
import { cors, publishDashboardChanged } from "./common.js";

export const handleThinkingSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;

  if (url === "/api/thinking-level" && method === "GET") {
    const session = ctx.runtime.session;
    const extended = (session as any).getAvailableThinkingLevels?.() ?? ["low", "medium", "high"];
    // "off" 不在 extended levels 中（由 reasoning 开关控制），手动补上
    const available = ["off", ...extended.filter((l: string) => l !== "off")];
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      level: session.thinkingLevel ?? "off",
      availableLevels: available,
      supportsThinking: extended.length > 0,
    }));
    return true;
  }

  if (url === "/api/thinking-level" && method === "POST") {
    try {
      const { level } = await parseBody(req);
      const session = ctx.runtime.session;
      session.setThinkingLevel(level);
      const extended = (session as any).getAvailableThinkingLevels?.() ?? ["low", "medium", "high"];
      const available = ["off", ...extended.filter((l: string) => l !== "off")];
      const supportsThinking = (session as any).supportsThinking?.() ?? available.some((item: string) => item !== "off");
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
