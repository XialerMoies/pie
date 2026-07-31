/**
 * Attachment processing — file/clip/folder → prompt context blocks
 *
 * 从 chat.ts 抽出，独立可测。
 */
import { readFileSync, readdirSync, type Dirent } from "fs";
import { resolve, relative } from "path";
import { guardPathWithinRoot, isPathGuardError } from "./path-guard.js";
import { authorizeRoutePath, type ServerPermissionService } from "../permission-service.js";

// ─── Constants ──────────────────────────────────────────────────

export const ATTACH_FILE_MAX_BYTES = 64 * 1024;   // 64KB per file
export const ATTACH_TOTAL_MAX_BYTES = 256 * 1024; // 256KB total
export const ATTACH_FOLDER_MAX_FILES = 50;        // max files per folder
export const ATTACH_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'data', '.claude']);

const BINARY_EXT = new Set([
  'png','jpg','jpeg','gif','ico','webp','bmp','svg',
  'woff','woff2','ttf','eot','otf',
  'zip','rar','7z','gz','tar','exe','dll','so','dylib',
  'pdf','doc','docx','xls','xlsx','ppt','pptx',
  'mp3','mp4','avi','mov','wav','flac','ogg',
  'pyc','class','o','a','lib',
]);

// ─── Helpers ────────────────────────────────────────────────────

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return BINARY_EXT.has(ext);
}

function isTextFile(filePath: string): boolean {
  if (isBinaryFile(filePath)) return false;
  try {
    const fd = readFileSync(filePath);
    const buf = fd.slice(0, 8192);
    return !buf.includes(0);
  } catch { return false; }
}

/** Walk a directory, returning text file paths (relative to workspace). */
async function walkFolder(dir: string, baseDir: string, maxFiles: number, permissionService?: ServerPermissionService): Promise<string[]> {
  const results: string[] = [];
  const root = resolve(baseDir);

  async function authorizeWalkPath(current: string, source: string): Promise<string | null> {
    try {
      const rel = relative(root, current).replace(/\\/g, "/");
      return (await authorizeRoutePath({ permissionService }, root, rel || ".", "read", source)).path;
    } catch {
      return null;
    }
  }

  async function walk(current: string) {
    if (results.length >= maxFiles) return;
    const authorizedCurrent = await authorizeWalkPath(current, "chat.attachment.folder.dir");
    if (!authorizedCurrent) return;
    let entries: Dirent[];
    try { entries = readdirSync(authorizedCurrent, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxFiles) return;
      if (ATTACH_EXCLUDE_DIRS.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      const full = resolve(authorizedCurrent, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const authorizedFile = await authorizeWalkPath(full, "chat.attachment.folder");
        if (!authorizedFile) continue;
        const rel = relative(root, authorizedFile).replace(/\\/g, '/');
        if (isTextFile(authorizedFile)) results.push(rel);
      }
    }
  }
  await walk(dir);
  return results.slice(0, maxFiles);
}

// ─── Public types ───────────────────────────────────────────────

export interface ProcessedAttach {
  path: string;
  content: string;
  truncated: boolean;
  kind: string;
  startLine?: number;
  endLine?: number;
}

// ─── Public API ─────────────────────────────────────────────────

export async function processAttachments(atts: Array<Record<string, unknown>>, workspace: string, permissionService?: ServerPermissionService): Promise<{ blocks: ProcessedAttach[]; totalBytes: number }> {
  const blocks: ProcessedAttach[] = [];
  let totalBytes = 0;
  const ws = resolve(workspace || '');

  for (const att of atts) {
    const kind: string = (att as Record<string, unknown>).kind as string || 'file';
    const attPath: string = (att as Record<string, unknown>).path as string || '';
    if (!attPath) continue;

    let fullPath: string;
    try {
      fullPath = (await authorizeRoutePath({ permissionService }, ws, attPath, "read", "chat.attachment")).path;
    } catch (err) {
      if (isPathGuardError(err)) continue;
      continue;
    }

    if (kind === 'folder') {
      const files = await walkFolder(fullPath, ws, ATTACH_FOLDER_MAX_FILES, permissionService);
      let folderBytes = 0;
      for (const relPath of files) {
        if (totalBytes >= ATTACH_TOTAL_MAX_BYTES) break;
        try {
          const fp = (await authorizeRoutePath({ permissionService }, ws, relPath, "read", "chat.attachment.folder")).path;
          let content = readFileSync(fp, 'utf-8');
          let truncated = false;
          if (content.length > ATTACH_FILE_MAX_BYTES) {
            content = content.slice(0, ATTACH_FILE_MAX_BYTES) + '\n\n// [truncated: 文件超过64KB]';
            truncated = true;
          }
          const bytes = content.length;
          if (totalBytes + bytes > ATTACH_TOTAL_MAX_BYTES) {
            const remaining = ATTACH_TOTAL_MAX_BYTES - totalBytes;
            content = content.slice(0, Math.max(remaining, 100)) + '\n\n// [truncated: 上下文限制]';
            totalBytes = ATTACH_TOTAL_MAX_BYTES;
            blocks.push({ path: relPath, content, truncated: true, kind: 'file' });
            break;
          }
          totalBytes += bytes;
          folderBytes += bytes;
          blocks.push({ path: relPath, content, truncated, kind: 'file' });
        } catch { /* skip unreadable */ }
      }
      if (files.length > ATTACH_FOLDER_MAX_FILES) {
        blocks.push({
          path: attPath,
          content: '',
          truncated: true,
          kind: 'folder',
        });
      }
    } else if (kind === 'clip') {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const startLine = Math.max(1, (att as Record<string, unknown>).startLine as number || 1);
        const endLine = Math.min(lines.length, (att as Record<string, unknown>).endLine as number || startLine);
        const clipContent = lines.slice(startLine - 1, endLine).join('\n');
        blocks.push({
          path: attPath,
          content: clipContent || '(empty)',
          truncated: clipContent.length > ATTACH_FILE_MAX_BYTES,
          kind: 'clip',
          startLine,
          endLine,
        });
        totalBytes += clipContent.length;
      } catch { /* skip unreadable */ }
    } else {
      try {
        let content = readFileSync(fullPath, 'utf-8');
        let truncated = false;
        if (content.length > ATTACH_FILE_MAX_BYTES) {
          content = content.slice(0, ATTACH_FILE_MAX_BYTES) + '\n\n// [truncated: 文件超过64KB]';
          truncated = true;
        }
        if (totalBytes + content.length > ATTACH_TOTAL_MAX_BYTES) {
          const remaining = ATTACH_TOTAL_MAX_BYTES - totalBytes;
          content = content.slice(0, Math.max(remaining, 100)) + '\n\n// [truncated: 上下文限制]';
          truncated = true;
        }
        totalBytes += content.length;
        blocks.push({ path: attPath, content, truncated, kind: 'file' });
      } catch { /* skip unreadable */ }
    }
  }
  return { blocks, totalBytes };
}

export function buildContextBlock(blocks: ProcessedAttach[]): string {
  if (blocks.length === 0) return '';
  const parts: string[] = ['\n\n引用上下文：'];
  for (const b of blocks) {
    if (b.kind === 'folder' && b.content === '') {
      parts.push(`  folder: ${b.path} (包含超过${ATTACH_FOLDER_MAX_FILES}个文件，已截断)`);
      continue;
    }
    if (b.kind === 'clip') {
      parts.push(`\`\`\`${b.path} (${b.startLine}-${b.endLine})`);
    } else {
      parts.push(`\`\`\`${b.path}`);
    }
    parts.push(b.content);
    if (b.truncated) parts.push('// [truncated]');
    parts.push('```');
  }
  return parts.join('\n');
}
