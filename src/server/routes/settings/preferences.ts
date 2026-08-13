import type { RouteHandler } from "../types.js";
import { parseBody } from "../parse-body.js";
import { writePathGuardError } from "../path-guard.js";
import { writeServerPermissionError } from "../../permission-service.js";
import { patchUserPreferences, readUserPreferences } from "../../../data/user-settings.js";
import { cors } from "./common.js";

export const handlePreferenceSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { paths: p } = ctx;

  if (url === "/api/preferences" && method === "GET") {
    try {
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ preferences: readUserPreferences(p.SETTINGS_FILE) }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/preferences" && method === "PATCH") {
    try {
      const patch = await parseBody(req);
      const preferences = await patchUserPreferences(p.SETTINGS_FILE, patch);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, preferences }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
