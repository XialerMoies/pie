/**
 * UI State — 持久化工作区 UI 状态
 *
 * 用于跨启动恢复：打开的会话标签、活动视图、左侧面板。
 * 存在 data/pi/ui-state.json 中，不受随机端口影响。
 *
 * GET /api/ui-state    → 返回 { openSessionIds, activeView, activePanel, panelClosed }
 * PUT /api/ui-state    → 保存状态
 */
import type { RouteHandler } from "./types";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";

const FILE_NAME = "ui-state.json";

export interface UiState {
  openSessionIds: string[];
  activeView: { type: "session"; id: string } | { type: "file"; id: string } | { type: "chat" };
  activePanel: string;
  panelClosed: boolean;
}

const DEFAULT_STATE: UiState = {
  openSessionIds: [],
  activeView: { type: "chat" },
  activePanel: "explorer",
  panelClosed: false,
};

function stateFile(piConfigDir: string): string {
  return resolve(piConfigDir, FILE_NAME);
}

function readState(piConfigDir: string): UiState {
  try {
    const fp = stateFile(piConfigDir);
    if (!existsSync(fp)) return { ...DEFAULT_STATE };
    const data = JSON.parse(readFileSync(fp, "utf-8"));
    return { ...DEFAULT_STATE, ...data };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(piConfigDir: string, state: UiState): void {
  try {
    writeFileSync(stateFile(piConfigDir), JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

export const handleUiState: RouteHandler = async (req, res, ctx) => {
  const url = req.url ?? "";
  const method = req.method ?? "GET";
  const piConfigDir = ctx.paths.PI_CONFIG_DIR;

  if (url === "/api/ui-state" && method === "GET") {
    const state = readState(piConfigDir);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(state));
    return true;
  }

  if (url === "/api/ui-state" && method === "PUT") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const parsed = JSON.parse(body);
      const state: UiState = { ...DEFAULT_STATE, ...parsed };
      writeState(piConfigDir, state);
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
