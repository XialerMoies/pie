export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileDiffMetadata {
  filePath: string;
  type: "create" | "update";
  structuredPatch: StructuredPatchHunk[];
  linesAdded: number;
  linesRemoved: number;
  content?: string;
  truncated?: boolean;
  omittedLines?: number;
}

const MAX_LCS_CELLS = 1_000_000;
const MAX_METADATA_LINES = 400;
const MAX_CREATE_CONTENT_CHARS = 50_000;

function splitLines(text: string): string[] {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function countLines(text: string): number {
  if (!text) return 0;
  return splitLines(text).length;
}

function truncateLines(lines: string[]): { lines: string[]; truncated: boolean; omittedLines: number } {
  if (lines.length <= MAX_METADATA_LINES) return { lines, truncated: false, omittedLines: 0 };
  return {
    lines: lines.slice(0, MAX_METADATA_LINES),
    truncated: true,
    omittedLines: lines.length - MAX_METADATA_LINES,
  };
}

function truncateCreateContent(content: string): { content: string; truncated: boolean; omittedLines: number } {
  if (content.length <= MAX_CREATE_CONTENT_CHARS && countLines(content) <= MAX_METADATA_LINES) {
    return { content, truncated: false, omittedLines: 0 };
  }
  const lines = splitLines(content);
  const byLine = truncateLines(lines);
  const joined = byLine.lines.join("\n");
  if (joined.length <= MAX_CREATE_CONTENT_CHARS) {
    return { content: joined, truncated: byLine.truncated, omittedLines: byLine.omittedLines };
  }
  const trimmed = joined.slice(0, MAX_CREATE_CONTENT_CHARS);
  const keptLines = countLines(trimmed);
  return {
    content: trimmed,
    truncated: true,
    omittedLines: Math.max(0, lines.length - keptLines),
  };
}

function fallbackPatch(oldLines: string[], newLines: string[]): StructuredPatchHunk[] {
  return [{
    oldStart: oldLines.length > 0 ? 1 : 0,
    oldLines: oldLines.length,
    newStart: newLines.length > 0 ? 1 : 0,
    newLines: newLines.length,
    lines: [
      ...oldLines.map((line) => "-" + line),
      ...newLines.map((line) => "+" + line),
    ],
  }];
}

function diffLines(oldLines: string[], newLines: string[]): string[] {
  const width = newLines.length + 1;
  const cells = (oldLines.length + 1) * (newLines.length + 1);
  if (cells > MAX_LCS_CELLS) {
    return fallbackPatch(oldLines, newLines)[0].lines;
  }

  const table = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const index = i * width + j;
      table[index] = oldLines[i] === newLines[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push(" " + oldLines[i]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      lines.push("-" + oldLines[i]);
      i++;
    } else {
      lines.push("+" + newLines[j]);
      j++;
    }
  }
  while (i < oldLines.length) lines.push("-" + oldLines[i++]);
  while (j < newLines.length) lines.push("+" + newLines[j++]);
  return lines;
}

export function countPatchLines(hunks: StructuredPatchHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

export function buildFileDiffMetadata(filePath: string, before: string | null, after: string): FileDiffMetadata {
  if (before === null) {
    const preview = truncateCreateContent(after);
    return {
      filePath,
      type: "create",
      structuredPatch: [],
      linesAdded: countLines(after),
      linesRemoved: 0,
      content: preview.content,
      ...(preview.truncated ? { truncated: true, omittedLines: preview.omittedLines } : {}),
    };
  }

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const rawPatch = before === after
    ? []
    : [{
        oldStart: oldLines.length > 0 ? 1 : 0,
        oldLines: oldLines.length,
        newStart: newLines.length > 0 ? 1 : 0,
        newLines: newLines.length,
        lines: diffLines(oldLines, newLines),
      }];
  const counts = countPatchLines(rawPatch);
  const structuredPatch = rawPatch.map((hunk) => {
    const truncated = truncateLines(hunk.lines);
    return { ...hunk, lines: truncated.lines };
  });
  const omittedLines = rawPatch.reduce((total, hunk) => total + Math.max(0, hunk.lines.length - MAX_METADATA_LINES), 0);
  return {
    filePath,
    type: "update",
    structuredPatch,
    linesAdded: counts.added,
    linesRemoved: counts.removed,
    ...(omittedLines > 0 ? { truncated: true, omittedLines } : {}),
  };
}
