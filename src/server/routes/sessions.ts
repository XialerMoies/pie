/**
 * Session routes — CRUD for conversation sessions
 */
import { resolveEngine, type RouteHandler, type ServerContext } from "./types.js";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, statSync, mkdirSync, renameSync } from "fs";
import { resolve, basename, dirname } from "path";
import { randomUUID } from "crypto";
import { parseBody } from "./parse-body.js";
import { workspaceDataPaths, wsKey, wsDir } from "./session-dir.js";
import { deriveReplySummary, parseSessionMessages } from "./session-message-parser.js";
import { isPathGuardError, writePathGuardError } from "./path-guard.js";
import { authorizeRoutePath, isServerPermissionError, writeServerPermissionError } from "../permission-service.js";
import { authorizeWorkspacePath, runWithWorkspaceOwnership } from "./workspace-authorization.js";

// Re-export for backward compat (tests use mod.wsKey / mod.wsDir)
export { wsKey, wsDir } from "./session-dir.js";
export { parseSessionMessages } from "./session-message-parser.js";

const cors = { "Access-Control-Allow-Origin": "*" };

function usesCanonicalWorkspaceData(ctx: ServerContext): boolean {
  return !!ctx.paths.STARTUP?.dataRoot;
}

function sessionsDirForWorkspace(ctx: ServerContext, workspace: string): string {
  if (usesCanonicalWorkspaceData(ctx)) {
    return workspaceDataPaths(ctx.paths.DATA_DIR, workspace).sessionsDir;
  }
  return wsDir(ctx.paths.SESSIONS_DIR, workspace);
}

function activeSessionsDir(ctx: ServerContext): string {
  const workspace = resolveEngine(ctx).session.workspace || ctx.paths.STARTUP?.workspace || ctx.paths.APP_ROOT;
  return usesCanonicalWorkspaceData(ctx)
    ? sessionsDirForWorkspace(ctx, workspace)
    : ctx.paths.SESSIONS_DIR;
}

function publishActiveSessionChanged(ctx: ServerContext): void {
  try { ctx.appEvents.publish("dashboard.changed"); } catch {}
  try { ctx.appEvents.publish("usage.changed"); } catch {}
}

function runWithProviderReferenceLock<T>(
  ctx: ServerContext,
  operation: () => T | Promise<T>,
): Promise<T> {
  return ctx.providerReferenceLock?.runExclusive(operation) ?? Promise.resolve(operation());
}

/** 迁移会话: 从 sessions/ 根目录按 workspace 分类移入 by-project/ */
async function migrateOldSessions(ctx: ServerContext): Promise<void> {
  const baseDir = ctx.paths.SESSIONS_DIR;
  if (!existsSync(baseDir)) return;
  const authorizedBaseDir = await authorizeSessionPath(ctx, baseDir, "read", "sessions.auto-migrate.root");
  const entries = readdirSync(authorizedBaseDir, { withFileTypes: true });
  let moved = 0;
  for (const e of entries) {
    if (e.name === "by-project") continue;
    if (!e.name.endsWith(".jsonl")) continue;
    const fp = resolve(authorizedBaseDir, e.name);
    try {
      const sourceFile = await authorizeSessionPath(ctx, fp, "read", "sessions.auto-migrate.source");
      const content = readFileSync(sourceFile, "utf-8");
      const header = JSON.parse(content.trim().split("\n")[0] || "{}");
      const ws = header.workspace || "";
      const targetDir = ws ? wsDir(baseDir, ws) : resolve(baseDir, "by-project", "_legacy");
      const targetFile = await authorizeSessionPath(ctx, resolve(targetDir, e.name), "create", "sessions.auto-migrate.destination");
      const removableSource = await authorizeSessionPath(ctx, sourceFile, "remove", "sessions.auto-migrate.source");
      if (!existsSync(dirname(targetFile))) mkdirSync(dirname(targetFile), { recursive: true });
      renameSync(removableSource, targetFile);
      moved++;
    } catch (error) {
      if (isPathGuardError(error) || isServerPermissionError(error)) throw error;
    }
  }
  if (moved > 0) console.log(`📦 Migrated ${moved} session(s) to by-project/`);
}

/** 扫描所有项目的session目录 */
async function findAuthorizedProjectDirs(ctx: ServerContext, baseDir: string, source: string): Promise<string[]> {
  const projectsDir = resolve(baseDir, "by-project");
  if (!existsSync(projectsDir)) return [];
  const authorizedProjectsDir = await authorizeSessionPath(ctx, projectsDir, "read", source);
  return readdirSync(authorizedProjectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => resolve(authorizedProjectsDir, d.name));
}

async function findAuthorizedJsonl(ctx: ServerContext, dir: string, source: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const authorizedDir = await authorizeSessionPath(ctx, dir, "read", `${source}.dir`);
  const entries = readdirSync(authorizedDir, { withFileTypes: true });
  const files: string[] = [];
  for (const e of entries) {
    const candidate = resolve(authorizedDir, e.name);
    if (e.isDirectory()) {
      files.push(...await findAuthorizedJsonl(ctx, candidate, source));
    } else if (e.name.endsWith(".jsonl")) {
      files.push(await authorizeSessionPath(ctx, candidate, "read", source));
    }
  }
  return files;
}

export async function findAuthorizedSessionFileById(
  ctx: ServerContext,
  id: string,
  source: string,
  workspace?: string,
): Promise<string | null> {
  if (typeof id !== "string" || !id.trim()) return null;
  const sessionsRoot = workspace ? sessionsDirForWorkspace(ctx, workspace) : activeSessionsDir(ctx);
  return findAuthorizedSessionFileInDir(ctx, sessionsRoot, id, source, sessionsRoot);
}

async function findAuthorizedSessionFileInDir(
  ctx: ServerContext,
  dir: string,
  id: string,
  source: string,
  sessionsRoot: string,
): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const authorizedDir = await authorizeSessionPath(ctx, dir, "read", `${source}.dir`, sessionsRoot);
  const entries = readdirSync(authorizedDir, { withFileTypes: true });
  for (const e of entries) {
    const candidate = resolve(authorizedDir, e.name);
    if (e.isDirectory()) {
      const found = await findAuthorizedSessionFileInDir(ctx, candidate, id, source, sessionsRoot);
      if (found) return found;
      continue;
    }
    if (!e.name.endsWith(".jsonl")) continue;

    const authorizedFile = await authorizeSessionPath(ctx, candidate, "read", source, sessionsRoot);
    try {
      const headerLine = readFileSync(authorizedFile, "utf-8").trim().split("\n")[0];
      const header = JSON.parse(headerLine);
      if (header.id === id || e.name.includes(id)) return authorizedFile;
    } catch {}
  }
  return null;
}

type SessionBranchInfo = { id: string; name?: string };

type SessionMeta = {
  name: string;
  titleSource?: "auto" | "manual";
  pinned: boolean;
  archived?: boolean;
  branchFrom?: SessionBranchInfo;
};

function readSessionMeta(lines: string[]): SessionMeta {
  const meta: SessionMeta = { name: "", pinned: false };
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "session_info") continue;
      if (typeof entry.name === "string") meta.name = entry.name;
      if (entry.titleSource === "auto" || entry.titleSource === "manual") meta.titleSource = entry.titleSource;
      if (typeof entry.pinned === "boolean") meta.pinned = entry.pinned;
      if (typeof entry.archived === "boolean") meta.archived = entry.archived;
      if (entry.branchFrom && typeof entry.branchFrom.id === "string") {
        meta.branchFrom = {
          id: entry.branchFrom.id,
          name: typeof entry.branchFrom.name === "string" ? entry.branchFrom.name : undefined,
        };
      }
    } catch {}
  }
  return meta;
}

function appendSessionInfo(sessionFile: string, info: Record<string, unknown>): void {
  const content = readFileSync(sessionFile, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  lines.splice(1, 0, JSON.stringify({ type: "session_info", ...info, timestamp: new Date().toISOString() }));
  writeFileSync(sessionFile, lines.join("\n") + "\n");
}

async function authorizeSessionPath(
  ctx: ServerContext,
  targetPath: string,
  operation: "read" | "write" | "create" | "remove",
  source: string,
  sessionsRoot = activeSessionsDir(ctx),
): Promise<string> {
  return (await authorizeRoutePath(ctx, sessionsRoot, targetPath, operation, source)).path;
}


export const handleSessions: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { paths: p } = ctx;
  const engine = resolveEngine(ctx);
  const session = engine.session;

  // List sessions — filtered by workspace, with "other projects" section
  if ((url === "/api/sessions" || url?.startsWith("/api/sessions?")) && method === "GET") {
    try {
      const u = new URL(url, `http://${req.headers.host || "localhost"}`);
      const currentWs = await authorizeWorkspacePath(ctx, u.searchParams.get("workspace"), "sessions.list.workspace");
      const includeOther = u.searchParams.get("other") === "1";
      const curId = session.id;

      // Canonical legacy copies are opt-in through the Settings migration flow.
      if (!usesCanonicalWorkspaceData(ctx)) {
        // Legacy contexts retain the old in-place migration behavior.
        await migrateOldSessions(ctx);
      }

      // Current workspace sessions dir
      const curSessionsDir = sessionsDirForWorkspace(ctx, currentWs || engine.session.workspace);
      const activeSession = { id: engine.session.id, file: engine.session.sessionFile };
      const runningSessionId = session.isStreaming ? curId : "";

      // Helper to parse session from a dir
      async function readSessionsFromDir(dir: string): Promise<Array<Record<string, unknown>>> {
        if (!existsSync(dir)) return [];
        const records: Array<Record<string, unknown>> = [];
        for (const fullPath of await findAuthorizedJsonl(ctx, dir, "sessions.list")) {
          const stat = existsSync(fullPath) ? statSync(fullPath) : null;
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.trim().split("\n");
          const header = lines[0] ? JSON.parse(lines[0]) : {};
          const id = header.id || basename(fullPath, ".jsonl");
          const meta = readSessionMeta(lines);
          const replySummary = meta.name ? "" : deriveReplySummary(lines);
          const hasError = lines.some((line: string) => line.includes('"isError":true') || line.includes('"status":"error"') || line.includes('"error"'));
          records.push({
            id, name: meta.name || replySummary || "新会话", active: id === curId,
            messageCount: lines.filter((l: string) => l.includes('"type":"message"')).length,
            createdAt: stat?.birthtime?.toISOString() || header.timestamp || "",
            updatedAt: stat?.mtime?.toISOString() || header.timestamp || "",
            file: basename(fullPath),
            workspace: header.workspace || "",
            pinned: meta.pinned,
            titleSource: meta.titleSource,
            archived: Boolean(meta.archived),
            hasError,
            isRunning: id === runningSessionId,
            branchFrom: meta.branchFrom,
          });
        }
        return records.sort((a: Record<string, unknown>, b: Record<string, unknown>) => String(b["updatedAt"] || b["createdAt"] || "").localeCompare(String(a["updatedAt"] || a["createdAt"] || "")));
      }

      const sessions = await readSessionsFromDir(curSessionsDir);

      // Other projects
      let other: { project: string; path: string; sessions: Record<string, unknown>[] }[] = [];
      if (includeOther && !usesCanonicalWorkspaceData(ctx)) {
        const allDirs = await findAuthorizedProjectDirs(ctx, p.SESSIONS_DIR, "sessions.list.projects");
        const curKey = wsKey(currentWs);
        for (const dir of allDirs) {
          const projName = basename(dir);
          if (projName === curKey) continue;
          const projSessions = await readSessionsFromDir(dir);
          if (projSessions.length > 0) {
            // Get workspace path from the first session's header
            const wsPath = (projSessions[0] as any)?.workspace || "";
            other.push({ project: projName === "_legacy" ? "未分类" : projName, path: wsPath, sessions: projSessions as any[] });
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ sessions, other, activeSessionId: activeSession?.id || null }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ sessions: [], other: [], error: (err as Error).message }));
    }
    return true;
  }

  // Create new session — 由 SessionManager.create() 创建文件，runtime 立即切到新 session
  if (url === "/api/sessions/new" && method === "POST") {
    try {
      const body = await parseBody(req).catch(() => ({}));
      const workspace = await authorizeWorkspacePath(ctx, body.workspace, "sessions.new.workspace");
      const targetWorkspace = workspace || engine.session.workspace || "";
      const targetSessionsDir = sessionsDirForWorkspace(ctx, targetWorkspace);
      if (existsSync(targetSessionsDir)) {
        await authorizeSessionPath(ctx, targetSessionsDir, "create", "sessions.new.destination", targetSessionsDir);
      }
      // 如果 workspace 与当前不同，先切 workspace 再创建
      if (workspace && engine.session.workspace !== workspace) {
        await runWithWorkspaceOwnership(ctx, workspace, () => engine.switchWorkspace(workspace));
      }
      const id = await engine.createNewSession();
      publishActiveSessionChanged(ctx);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Migrate session to workspace (move from _legacy to project dir)
  if (url === "/api/sessions/migrate" && method === "POST") {
    try {
      const body = await parseBody(req);
      const { id } = body;
      const workspace = await authorizeWorkspacePath(ctx, body.workspace, "sessions.migrate.workspace");
      const sFile = await findAuthorizedSessionFileById(ctx, id, "sessions.migrate.lookup");
      if (!sFile) { res.writeHead(404, { ...cors }); res.end(JSON.stringify({ error: "not found" })); return true; }
      const sourceRoot = activeSessionsDir(ctx);
      const sourceFile = await authorizeSessionPath(ctx, sFile, "read", "sessions.migrate.source", sourceRoot);
      const targetDir = sessionsDirForWorkspace(ctx, workspace || engine.session.workspace || "");
      const targetFile = await authorizeSessionPath(
        ctx,
        resolve(targetDir, basename(sourceFile)),
        "create",
        "sessions.migrate.destination",
        targetDir,
      );
      if (!existsSync(dirname(targetFile))) mkdirSync(dirname(targetFile), { recursive: true });
      // Read, tag, and move
      const content = readFileSync(sourceFile, "utf-8");
      const lines = content.trim().split("\n");
      const header = JSON.parse(lines[0]);
      header.workspace = workspace || "";
      lines[0] = JSON.stringify(header);
      writeFileSync(targetFile, lines.join("\n") + "\n");
      if (sourceFile !== targetFile) {
        const removeSource = await authorizeSessionPath(ctx, sourceFile, "remove", "sessions.migrate.source", sourceRoot);
        unlinkSync(removeSource);
      }
      console.log(`📦 Migrated session ${id} → by-project/${wsKey(workspace)}/`);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Save session (no-op, auto-saved by PI)
  if (url === "/api/sessions/save" && method === "POST") {
    res.writeHead(200, { ...cors });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // Pin/unpin session — 追加 session_info 元数据，不改 PI message 记录
  if (url === "/api/sessions/pin" && method === "POST") {
    try {
      const { id, pinned } = await parseBody(req);
      const sessionFile = await findAuthorizedSessionFileById(ctx, id, "sessions.pin.lookup");
      if (!sessionFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      const authorizedFile = await authorizeSessionPath(ctx, sessionFile, "write", "sessions.pin");
      appendSessionInfo(authorizedFile, { pinned: Boolean(pinned) });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id, pinned: Boolean(pinned) }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Branch session — 复制现有历史为新 JSONL，换新 id 后立即激活
  if (url === "/api/sessions/branch" && method === "POST") {
    try {
      const { id, workspace: requestedWorkspace, name } = await parseBody(req);
      const workspace = await authorizeWorkspacePath(ctx, requestedWorkspace, "sessions.branch.workspace");
      const sourceFile = await findAuthorizedSessionFileById(ctx, id, "sessions.branch.lookup");
      if (!sourceFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      const authorizedSource = await authorizeSessionPath(ctx, sourceFile, "read", "sessions.branch.source");
      const sourceContent = readFileSync(authorizedSource, "utf-8");
      const sourceLines = sourceContent.trim().split("\n").filter(Boolean);
      const sourceHeader = sourceLines[0] ? JSON.parse(sourceLines[0]) : {};
      const sourceMeta = readSessionMeta(sourceLines);
      const newId = `branch-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const targetDir = dirname(authorizedSource);
      const targetFile = await authorizeSessionPath(ctx, resolve(targetDir, `${newId}.jsonl`), "create", "sessions.branch.destination");
      const branchName = typeof name === "string" && name.trim()
        ? name.trim()
        : `${sourceMeta.name || "未命名会话"} · 分支`;
      const branchHeader = {
        ...sourceHeader,
        id: newId,
        timestamp: new Date().toISOString(),
        workspace: workspace || sourceHeader.workspace || engine.session.workspace || "",
      };
      const branchInfo = JSON.stringify({
        type: "session_info",
        name: branchName,
        pinned: false,
        branchFrom: { id, name: sourceMeta.name || "未命名会话" },
        timestamp: new Date().toISOString(),
      });
      writeFileSync(targetFile, [JSON.stringify(branchHeader), branchInfo, ...sourceLines.slice(1)].join("\n") + "\n");
      const targetWorkspace = workspace || engine.session.workspace;
      await runWithProviderReferenceLock(
        ctx,
        () => runWithWorkspaceOwnership(
          ctx,
          targetWorkspace,
          () => engine.openSession(targetFile, targetWorkspace),
        ),
      );
      publishActiveSessionChanged(ctx);
      const readableTarget = await authorizeSessionPath(ctx, targetFile, "read", "sessions.branch.result");
      const messages = parseSessionMessages(readFileSync(readableTarget, "utf-8"));
      const activeSessionId = engine.session.id || newId;
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, id: newId, activeSessionId, messages }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Activate session — 让 runtime 加载该 session 作为活跃 session
  if (url === "/api/sessions/activate" && method === "POST") {
    try {
      const body = await parseBody(req);
      const { id } = body;
      const workspace = await authorizeWorkspacePath(ctx, body.workspace, "sessions.activate.workspace");
      const sessionFile = await findAuthorizedSessionFileById(ctx, id, "sessions.activate.lookup", workspace);
      if (!sessionFile) {
        const activeSession = engine.session;
        if (activeSession?.id === id) {
          res.writeHead(200, { "Content-Type": "application/json", ...cors });
          res.end(JSON.stringify({ ok: true, activeSessionId: id, messages: [] }));
          return true;
        }
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      // openSession 会重建 session，同 workspace 下切换不同 session 文件
      const targetSessionsDir = sessionsDirForWorkspace(ctx, workspace || engine.session.workspace);
      const authorizedFile = await authorizeSessionPath(
        ctx,
        sessionFile,
        "read",
        "sessions.activate",
        targetSessionsDir,
      );
      const targetWorkspace = workspace || engine.session.workspace;
      await runWithProviderReferenceLock(
        ctx,
        () => runWithWorkspaceOwnership(
          ctx,
          targetWorkspace,
          () => engine.openSession(authorizedFile, targetWorkspace),
        ),
      );
      publishActiveSessionChanged(ctx);
      const content = readFileSync(authorizedFile, "utf-8");
      const messages = parseSessionMessages(content);
      const activeSessionId = engine.session.id || "";
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, activeSessionId, messages }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Get session messages
  if (method === "GET" && url?.startsWith("/api/sessions/") && url?.endsWith("/messages")) {
    try {
      const idMatch = url.match(/\/api\/sessions\/(.+?)\/messages/);
      const sessionId = idMatch ? idMatch[1] : "";
      const sessionFile = await findAuthorizedSessionFileById(ctx, sessionId, "sessions.messages.lookup");
      if (!sessionFile) {
        res.writeHead(404, { ...cors });
        res.end(JSON.stringify({ error: "not found" }));
        return true;
      }
      const authorizedFile = await authorizeSessionPath(ctx, sessionFile, "read", "sessions.messages");
      const content = readFileSync(authorizedFile, "utf-8");
      const messages = parseSessionMessages(content);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ messages }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      res.writeHead(400, { ...cors });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return true;
  }

  // Rename session
  if (url === "/api/sessions/rename" && method === "POST") {
    try {
      const parsed = await parseBody(req);
      const { id, name } = parsed;
      const titleSource = parsed.titleSource === "auto" || parsed.titleSource === "manual" ? parsed.titleSource : undefined;
      const sessionFile = await findAuthorizedSessionFileById(ctx, id, "sessions.rename.lookup");
      if (sessionFile) {
        const authorizedFile = await authorizeSessionPath(ctx, sessionFile, "write", "sessions.rename");
        appendSessionInfo(authorizedFile, titleSource ? { name, titleSource } : { name });
      }
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

  // Delete session
  if (url === "/api/sessions/delete" && method === "POST") {
    try {
      const { id } = await parseBody(req);
      const sessionFile = await findAuthorizedSessionFileById(ctx, id, "sessions.delete.lookup");
      if (sessionFile) {
        const authorizedFile = await authorizeSessionPath(ctx, sessionFile, "remove", "sessions.delete");
        unlinkSync(authorizedFile);
      }
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
