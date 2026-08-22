import type { RouteHandler } from "../types.js";
import { writeFileSync } from "fs";
import { parseBody } from "../parse-body.js";
import { writePathGuardError } from "../path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../../permission-service.js";
import { cors } from "./common.js";

export const handleLayoutSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { paths: p } = ctx.groups.storage;

  if (url === "/api/layout-config" && method === "POST") {
    try {
      const data = await parseBody(req);
      const layoutPath = (await authorizeRoutePath(ctx, p.APP_ROOT, "src/layout-config.json", "write", "settings.layout-config")).path;
      writeFileSync(layoutPath, JSON.stringify(data, null, 2));
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
