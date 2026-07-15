/**
 * UI State — 持久化工作区 UI 状态
 *
 * 用于跨启动恢复：打开的会话标签、活动视图、左侧面板。
 * 存在 data/pi/ui-state.json 中，按 workspace 路径隔离。
 *
 * GET /api/ui-state?workspace=... → 返回该 workspace 的状态
 * PUT /api/ui-state              → 保存当前 workspace 的状态
 */
import type { RouteHandler } from "./types";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

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
  workspaces: Record<string, WorkspaceUiState>;
}

function stateFile(piConfigDir: string): string {
  return resolve(piConfigDir, FILE_NAME);
}

function readStore(piConfigDir: string): UiStateStore {
  try {
    const fp = stateFile(piConfigDir);
    if (!existsSync(fp)) return { workspaces: {} };
    const data = JSON.parse(readFileSync(fp, "utf-8"));
    return { workspaces: data.workspaces || {} };
  } catch {
    return { workspaces: {} };
  }
}

function writeStore(piConfigDir: string, store: UiStateStore): void {
  try {
    writeFileSync(stateFile(piConfigDir), JSON.stringify(store, null, 2));
  } catch { /* ignore */ }
}

export const handleUiState: RouteHandler = async (req, res, ctx) => {
  const url = req.url ?? "";
  const method = req.method ?? "GET";
  const piConfigDir = ctx.paths.PI_CONFIG_DIR;

  if (url.startsWith("/api/ui-state") && method === "GET") {
    const params = new URL(url, "http://localhost").searchParams;
    const workspace = params.get("workspace") || "_default";
    const store = readStore(piConfigDir);
    const state = store.workspaces[workspace] || { schemaVersion: 2, workspacePath: workspace, activeView: { type: "chat" }, tabs: { sessions: [], files: [], chatOpen: true, labels: {} }, panel: { active: "explorer", closed: false, width: 260 }, recent: { sessions: {} } };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return true;
  }

  if (url === "/api/ui-state" && method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      const workspace = parsed.workspacePath || "_default";
      const store = readStore(piConfigDir);
      store.workspaces[workspace] = parsed;
      writeStore(piConfigDir, store);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "invalid JSON" }));
    }
    return true;
  }

  return false;
};
