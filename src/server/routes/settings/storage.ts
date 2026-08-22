import type { RouteHandler } from "../types.js";
import { parseBody } from "../parse-body.js";
import { readDataRootPointer, writeDataRootPointer } from "../../../data/data-root-config.js";
import {
  LegacySessionPreviewMismatchError,
  migrateLegacySessions,
  previewLegacySessions,
} from "../session-dir.js";
import { cors } from "./common.js";

export const handleStorageSettings: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { runtime } = ctx.groups.core;
  const { paths: p } = ctx.groups.storage;

  if (url === "/api/storage-location" && method === "GET") {
    const pointerFile = p.DATA_ROOT_POINTER_FILE;
    const configuredDataRoot = pointerFile
      ? readDataRootPointer(pointerFile, p.DATA_DIR)
      : p.DATA_DIR;
    res.writeHead(200, { "Content-Type": "application/json", ...cors });
    res.end(JSON.stringify({
      dataRoot: configuredDataRoot,
      activeDataRoot: p.DATA_DIR,
      restartRequired: configuredDataRoot !== p.DATA_DIR,
      workspace: runtime.currentWorkspace || p.STARTUP?.workspace || p.APP_ROOT,
      instanceId: p.STARTUP?.instanceId || "",
      workspaceLock: {
        status: ctx.groups.storage.workspaceLock?.owner ? "locked" : "unlocked",
        ...(ctx.groups.storage.workspaceLock?.owner ? { owner: ctx.groups.storage.workspaceLock.owner } : {}),
      },
    }));
    return true;
  }

  if (url === "/api/storage-migration/preview" && method === "GET") {
    try {
      const workspace = runtime.currentWorkspace || p.STARTUP?.workspace || p.APP_ROOT;
      const preview = previewLegacySessions(p.DATA_DIR, workspace);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, ...preview }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/storage-migration/confirm" && method === "POST") {
    try {
      const data = await parseBody(req);
      if (data.confirm !== true || typeof data.previewId !== "string") {
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: "Explicit migration confirmation and preview ID are required" }));
        return true;
      }
      const workspace = runtime.currentWorkspace || p.STARTUP?.workspace || p.APP_ROOT;
      const preview = previewLegacySessions(p.DATA_DIR, workspace);
      if (preview.previewId !== data.previewId) {
        res.writeHead(409, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: false, error: "Migration preview changed; review it again" }));
        return true;
      }
      const migration = migrateLegacySessions(p.DATA_DIR, workspace, data.previewId);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, preview, migration }));
    } catch (err: unknown) {
      res.writeHead(err instanceof LegacySessionPreviewMismatchError ? 409 : 400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/storage-location" && method === "POST") {
    try {
      if (!p.DATA_ROOT_POINTER_FILE) {
        throw new Error("Data-root bootstrap pointer is unavailable");
      }
      const data = await parseBody(req);
      const result = writeDataRootPointer(p.DATA_ROOT_POINTER_FILE, data.dataRoot, p.DATA_DIR);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err: unknown) {
      res.writeHead(400, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
    return true;
  }

  return false;
};
