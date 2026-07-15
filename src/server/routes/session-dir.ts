/**
 * Workspace → session 目录映射
 *
 * 统一 runtime 和 routes 使用的目录算法，避免不一致。
 *
 * 当前方案：取路径最后一段作为目录名。
 * 长期方案：basename-hash 兼顾可读性和唯一性。
 */
import { resolve } from "path";

/** 取目录名（路径最后一段），用作 workspace key */
export function wsKey(workspace: string): string {
  if (!workspace) return "_default";
  const normalized = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || "_default";
}

/** 按 workspace 分目录存储：baseDir/by-project/<dir-name>/ */
export function wsDir(baseDir: string, workspace: string): string {
  if (!workspace) return baseDir;
  return resolve(baseDir, "by-project", wsKey(workspace));
}
