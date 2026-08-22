/**
 * UI State — 持久化工作区 UI 状态
 *
 * 用于跨启动恢复：打开的会话标签、活动视图、左侧面板。
 * 存在 data/pi/ui-state.json 中，按 workspace 路径隔离。
 *
 * GET /api/ui-state?workspace=... → 返回该 workspace 的状态
 * PUT /api/ui-state              → 保存当前 workspace 的状态
 */
import type { RouteHandler } from "./types.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { writePathGuardError } from "./path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../permission-service.js";
import { authorizeWorkspacePath } from "./workspace-authorization.js";
import { workspaceDataPaths } from "./session-dir.js";

const FILE_NAME = "ui-state.json";

// 与服务端 type WorkspaceUiState 对齐
export interface WorkspaceUiState {
  schemaVersion: number;
  workspacePath: string;
  activeView: { type: "chat" } | { type: "session"; id: string } | { type: "file"; id: string };
  tabs: {
    sessions: string[];
    files: Array<{ id: string; label: string; lang?: string }>;
    chatOpen: boolean;
    labels: Record<string, string>;
  };
  panel: { active: string; closed: boolean; width: number };
  recent: { sessions: Record<string, number>; lastSessionId?: string };
}

interface UiStateStore {
  activeWorkspace?: string;
  workspaces: Record<string, WorkspaceUiState>;
}

function stateFile(piConfigDir: string): string {
  return resolve(piConfigDir, FILE_NAME);
}

function usesCanonicalWorkspaceData(ctx: Parameters<RouteHandler>[2]): boolean {
  return !!ctx.paths.STARTUP?.dataRoot;
}

function emptyState(workspace: string): WorkspaceUiState {
  return {
    schemaVersion: 2,
    workspacePath: workspace,
    activeView: { type: "chat" },
    tabs: { sessions: [], files: [], chatOpen: true, labels: {} },
    panel: { active: "explorer", closed: false, width: 260 },
    recent: { sessions: {} },
  };
}

function readStoreFile(filePath: string): UiStateStore {
  try {
    if (!existsSync(filePath)) return { workspaces: {} };
    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    return {
      activeWorkspace: typeof data.activeWorkspace === "string" ? data.activeWorkspace : undefined,
      workspaces: data.workspaces || {},
    };
  } catch {
    return { workspaces: {} };
  }
}

async function readAuthorizedStore(
  ctx: Parameters<RouteHandler>[2],
  piConfigDir: string,
): Promise<{ filePath: string; store: UiStateStore }> {
  const filePath = (await authorizeRoutePath(ctx, piConfigDir, FILE_NAME, "read", "ui-state.read")).path;
  return { filePath, store: readStoreFile(filePath) };
}

function writeStoreFile(filePath: string, store: UiStateStore): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(store, null, 2));
}

export async function readWorkspaceUiState(
  ctx: Parameters<RouteHandler>[2],
  workspace: string,
): Promise<WorkspaceUiState> {
  const paths = workspaceDataPaths(ctx.paths.DATA_DIR, workspace);
  const filePath = (await authorizeRoutePath(
    ctx,
    paths.workspaceRoot,
    paths.uiStateFile,
    "read",
    "ui-state.read",
  )).path;
  try {
    if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {}

  for (const legacyFile of paths.legacyUiStateFiles) {
    try {
      if (!existsSync(legacyFile)) continue;
      const legacyRoot = dirname(legacyFile);
      const authorized = (await authorizeRoutePath(
        ctx,
        legacyRoot,
        legacyFile,
        "read",
        "ui-state.legacy.read",
      )).path;
      const legacyStore = readStoreFile(authorized);
      if (legacyStore.workspaces[workspace]) return legacyStore.workspaces[workspace];
    } catch {}
  }
  return emptyState(workspace);
}

export const handleUiState: RouteHandler = async (req, res, ctx) => {
  const url = req.url ?? "";
  const method = req.method ?? "GET";
  const piConfigDir = ctx.paths.PI_CONFIG_DIR;

  if (url.startsWith("/api/ui-state") && method === "GET") {
    try {
      const params = new URL(url, "http://localhost").searchParams;
      const requestedWorkspace = params.get("workspace") || ctx.runtime.currentWorkspace || ctx.paths.STARTUP?.workspace || "_default";
      const workspace = requestedWorkspace === "_default"
        ? requestedWorkspace
        : await authorizeWorkspacePath(ctx, requestedWorkspace, "ui-state.read.workspace", { required: true });
      if (usesCanonicalWorkspaceData(ctx) && workspace !== "_default") {
        const state = await readWorkspaceUiState(ctx, workspace);
        res.writeHead(200, { "Content-Type": "application/json", "X-Request-State": "complete" });
        res.end(JSON.stringify(state));
        return true;
      }
      const { store } = await readAuthorizedStore(ctx, piConfigDir);
      const state = store.workspaces[workspace] || emptyState(workspace);
      res.writeHead(200, { "Content-Type": "application/json", "X-Request-State": "complete" });
      res.end(JSON.stringify(state));
    } catch (err) {
      if (writeServerPermissionError(res, {}, err)) return true;
      if (writePathGuardError(res, {}, err)) return true;
      res.writeHead(503, { "Content-Type": "application/json", "X-Request-State": "failed" });
      res.end(JSON.stringify({ status: "failed", code: "ui_state_failed", error: (err as Error).message }));
    }
    return true;
  }

  if (url === "/api/ui-state" && method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      const workspace = parsed.workspacePath
        ? await authorizeWorkspacePath(ctx, parsed.workspacePath, "ui-state.save.workspace", { required: true })
        : "_default";
      if (usesCanonicalWorkspaceData(ctx) && workspace !== "_default") {
        const paths = workspaceDataPaths(ctx.paths.DATA_DIR, workspace);
        mkdirSync(paths.workspaceRoot, { recursive: true });
        const filePath = (await authorizeRoutePath(
          ctx,
          paths.workspaceRoot,
          paths.uiStateFile,
          "write",
          "ui-state.save",
        )).path;
        writeStoreFile(filePath, parsed);
        res.writeHead(200, { "Content-Type": "application/json", "X-Request-State": "complete" });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }
      const { store } = await readAuthorizedStore(ctx, piConfigDir);
      store.workspaces[workspace] = parsed;
      store.activeWorkspace = workspace;
      const filePath = (await authorizeRoutePath(ctx, piConfigDir, FILE_NAME, "write", "ui-state.save")).path;
      writeStoreFile(filePath, store);
      res.writeHead(200, { "Content-Type": "application/json", "X-Request-State": "complete" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      if (writeServerPermissionError(res, {}, err)) return true;
      if (writePathGuardError(res, {}, err)) return true;
      res.writeHead(400, { "Content-Type": "application/json", "X-Request-State": "failed" });
      res.end(JSON.stringify({ status: "failed", code: "invalid_json", error: "invalid JSON" }));
    }
    return true;
  }

  return false;
};
