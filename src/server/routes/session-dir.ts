/**
 * Canonical and legacy workspace data paths.
 *
 * New writes use dataRoot/workspaces/<workspace-hash>/. The basename-based
 * helpers remain only for read-only compatibility with pre-④-A sessions.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, normalize, resolve } from "node:path";
import {
  canonicalWorkspacePath,
  resolveDataLayout,
  workspaceKey,
} from "../../data/data-layout.js";

export interface WorkspaceDataPaths {
  workspace: string;
  workspaceKey: string;
  workspaceRoot: string;
  sessionsDir: string;
  usageIndexFile: string;
  uiStateFile: string;
  metadataFile: string;
  legacySessionsRoot: string;
  legacyUiStateFiles: string[];
  legacyUsageIndexFile: string;
}

export interface LegacySessionMigrationResult {
  copied: string[];
  skipped: string[];
}

export interface LegacySessionPreviewFile {
  source: string;
  destination: string;
  bytes: number;
  digest: string;
}

export interface LegacySessionMigrationPreview {
  source: string;
  destination: string;
  fileCount: number;
  bytes: number;
  files: LegacySessionPreviewFile[];
  conflicts: string[];
  previewId: string;
}

export class LegacySessionPreviewMismatchError extends Error {
  constructor() {
    super("Legacy session migration preview is stale");
    this.name = "LegacySessionPreviewMismatchError";
  }
}

export function workspaceDataPaths(dataRoot: string, workspace: string): WorkspaceDataPaths {
  const canonical = canonicalWorkspacePath(workspace);
  const layout = resolveDataLayout({
    dataRoot,
    workspace: canonical,
    instanceId: "workspace-data",
  });
  const legacyPiRoot = resolve(layout.dataRoot, "pi");
  return {
    workspace: canonical,
    workspaceKey: workspaceKey(canonical),
    workspaceRoot: layout.workspaceRoot,
    sessionsDir: layout.sessionsDir,
    usageIndexFile: layout.usageIndexFile,
    uiStateFile: layout.uiStateFile,
    metadataFile: layout.workspaceMetadataFile,
    legacySessionsRoot: resolve(legacyPiRoot, "sessions"),
    legacyUiStateFiles: [
      resolve(layout.userRoot, "ui-state.json"),
      resolve(legacyPiRoot, "ui-state.json"),
    ],
    legacyUsageIndexFile: resolve(legacyPiRoot, "usage-index.json"),
  };
}

/** Legacy basename key. Do not use for new writes. */
export function wsKey(workspace: string): string {
  if (!workspace) return "_default";
  const normalized = workspace.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || "_default";
}

/** Legacy data/pi/sessions/by-project/<basename> directory. */
export function wsDir(baseDir: string, workspace: string): string {
  if (!workspace) return baseDir;
  return resolve(baseDir, "by-project", wsKey(workspace));
}

function findJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const candidate = resolve(dir, entry.name);
    if (entry.isDirectory()) files.push(...findJsonlFiles(candidate));
    else if (entry.name.endsWith(".jsonl")) files.push(candidate);
  }
  return files;
}

function sessionWorkspace(filePath: string): string | null {
  try {
    const firstLine = readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0];
    const header = JSON.parse(firstLine || "{}");
    const workspace = typeof header.workspace === "string"
      ? header.workspace
      : typeof header.cwd === "string"
        ? header.cwd
        : "";
    return workspace ? canonicalWorkspacePath(workspace) : null;
  } catch {
    return null;
  }
}

function filesHaveSameContent(left: string, right: string): boolean {
  try {
    if (statSync(left).size !== statSync(right).size) return false;
    return readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

function fileDigest(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function previewIdFor(
  workspace: string,
  files: LegacySessionPreviewFile[],
  conflicts: string[],
): string {
  return createHash("sha256").update(JSON.stringify({
    workspace,
    files: files.map((file) => ({
      source: file.source,
      destination: file.destination,
      bytes: file.bytes,
      digest: file.digest,
    })),
    conflicts,
  })).digest("hex");
}

function legacyCandidates(paths: WorkspaceDataPaths): string[] {
  const projectName = wsKey(paths.workspace);
  const roots = [
    paths.legacySessionsRoot,
    resolve(paths.legacySessionsRoot, "by-project", projectName),
    resolve(paths.sessionsDir, "by-project", projectName),
  ];
  const unique = new Map<string, string>();
  const normalizedSessionsDir = normalize(resolve(paths.sessionsDir));
  const sessionsDirKey = process.platform === "win32" ? normalizedSessionsDir.toLowerCase() : normalizedSessionsDir;
  for (const root of roots) {
    for (const file of findJsonlFiles(root)) {
      const normalizedFile = normalize(resolve(file));
      const fileKey = process.platform === "win32" ? normalizedFile.toLowerCase() : normalizedFile;
      if (!fileKey.startsWith(sessionsDirKey + "\\") && !fileKey.startsWith(sessionsDirKey + "/")) {
        unique.set(fileKey, normalizedFile);
        continue;
      }
      const relative = normalizedFile.slice(normalizedSessionsDir.length).replace(/^[/\\]+/, "");
      if (relative.includes("/") || relative.includes("\\")) unique.set(fileKey, normalizedFile);
    }
  }
  return [...unique.values()];
}

export function previewLegacySessions(dataRoot: string, workspace: string): LegacySessionMigrationPreview {
  const paths = workspaceDataPaths(dataRoot, workspace);
  const candidates = legacyCandidates(paths);
  const sourcesByDestination = new Map<string, { destinationName: string; sources: string[] }>();
  const conflicts: string[] = [];
  const caseInsensitiveDestinations = process.platform === "win32" || process.platform === "darwin";

  for (const source of candidates) {
    if (sessionWorkspace(source) !== paths.workspace) continue;
    const destinationName = basename(source);
    const destinationKey = caseInsensitiveDestinations ? destinationName.toLowerCase() : destinationName;
    const group = sourcesByDestination.get(destinationKey) || { destinationName, sources: [] };
    group.sources.push(source);
    sourcesByDestination.set(destinationKey, group);
  }

  const files: LegacySessionPreviewFile[] = [];
  for (const { destinationName, sources } of sourcesByDestination.values()) {
    const destination = resolve(paths.sessionsDir, destinationName);
    if (sources.length !== 1) {
      conflicts.push(`filename collision: ${destinationName}`);
      continue;
    }
    if (existsSync(destination)) {
      if (filesHaveSameContent(sources[0], destination)) continue;
      conflicts.push(`destination exists: ${destinationName}`);
      continue;
    }
    try {
      files.push({
        source: sources[0],
        destination,
        bytes: statSync(sources[0]).size,
        digest: fileDigest(sources[0]),
      });
    } catch {
      conflicts.push(`source unavailable: ${destinationName}`);
    }
  }

  files.sort((left, right) => left.destination.localeCompare(right.destination));
  conflicts.sort();

  return {
    source: paths.legacySessionsRoot,
    destination: paths.sessionsDir,
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
    conflicts,
    previewId: previewIdFor(paths.workspace, files, conflicts),
  };
}

export function migrateLegacySessions(
  dataRoot: string,
  workspace: string,
  expectedPreviewId?: string,
): LegacySessionMigrationResult {
  const paths = workspaceDataPaths(dataRoot, workspace);
  const copied: string[] = [];
  const skipped: string[] = [];
  mkdirSync(paths.sessionsDir, { recursive: true });
  const preview = previewLegacySessions(dataRoot, workspace);
  if (expectedPreviewId !== undefined && preview.previewId !== expectedPreviewId) {
    throw new LegacySessionPreviewMismatchError();
  }
  const selectedSources = new Set(preview.files.map((file) => file.source));
  for (const source of legacyCandidates(paths)) {
    if (!selectedSources.has(source)) skipped.push(source);
  }

  for (const { source, destination, digest } of preview.files) {
    try {
      if (sessionWorkspace(source) !== paths.workspace || fileDigest(source) !== digest) {
        skipped.push(source);
        continue;
      }
      copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
      copied.push(destination);
    } catch {
      skipped.push(source);
    }
  }

  return { copied, skipped };
}

export function writeWorkspaceMetadata(dataRoot: string, workspace: string): string {
  const paths = workspaceDataPaths(dataRoot, workspace);
  mkdirSync(paths.workspaceRoot, { recursive: true });
  const temporary = `${paths.metadataFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({
      workspace: paths.workspace,
      workspaceKey: paths.workspaceKey,
      updatedAt: new Date().toISOString(),
    }, null, 2));
    renameSync(temporary, paths.metadataFile);
    return paths.metadataFile;
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw error;
  }
}
