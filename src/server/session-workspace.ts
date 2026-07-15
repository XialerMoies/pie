/**
 * Session workspace tagging — deprecated，保留仅用于兼容测试。
 *
 * 不再移动文件，仅在 header 中标记 workspace。
 * 生产代码使用 server.ts 的 tagSessionHeader。
 */
import { readFileSync, writeFileSync } from "fs";

/**
 * 对 session 文件标记 workspace（只写 header，不移动文件）。
 *
 * @deprecated 不再移动活跃 session 文件。仅在 header 补充 workspace 字段。
 */
export async function tagSessionWorkspace(
  sessionId: string | undefined,
  _sessionsDir: string,
  workspace: string,
): Promise<void> {
  if (!sessionId) {
    console.log(`  tagSessionWorkspace: no session id`);
    return;
  }
  // 不再扫描目录——直接从 sessionId 找不到原文件。
  // 这个函数不再实际产生效果，保留仅用于旧测试兼容。
  console.log(`  tagSessionWorkspace: deprecated, skipping (${sessionId} → ${workspace})`);
}
