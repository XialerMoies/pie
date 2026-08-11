/// <reference path="../dashboard.d.ts" />

function fileDiffLineCount(text: string): number {
  if (!text) return 0;
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

function fileDiffLines(diff: FileDiffMetadata): string[] {
  if (diff.type === "create" && typeof diff.content === "string" && !diff.structuredPatch?.length) {
    return diff.content
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .filter((line, index, lines) => index < lines.length - 1 || line !== "")
      .map(line => "+" + line);
  }
  const hunks = Array.isArray(diff.structuredPatch) ? diff.structuredPatch : [];
  return hunks.flatMap(hunk => Array.isArray(hunk?.lines) ? hunk.lines : []);
}

function renderFileDiff(diff: FileDiffMetadata, options: FileDiffRenderOptions = {}): string {
  if (!diff || typeof diff !== "object" || typeof diff.filePath !== "string") return "";
  const added = Number.isFinite(Number(diff.linesAdded))
    ? Number(diff.linesAdded)
    : (diff.type === "create" ? fileDiffLineCount(String(diff.content || "")) : 0);
  const removed = Number.isFinite(Number(diff.linesRemoved)) ? Number(diff.linesRemoved) : 0;
  const rawLines = fileDiffLines(diff);
  const visibleLines = rawLines.slice(0, 160);
  const locallyTruncated = rawLines.length > visibleLines.length;
  const rows = visibleLines.map(line => {
    const marker = line[0] === "+" || line[0] === "-" || line[0] === " " ? line[0] : " ";
    const body = line.slice(1);
    const kind = marker === "+" ? "add" : marker === "-" ? "del" : "ctx";
    return `<div class="trace-diff-line trace-diff-${kind}"><span class="trace-diff-sign">${E(marker)}</span><span class="trace-diff-text">${E(body)}</span></div>`;
  }).join("");
  const metadataOmitted = Number.isFinite(Number(diff.omittedLines)) ? Number(diff.omittedLines) : 0;
  const hiddenLines = rawLines.length - visibleLines.length + (diff.truncated ? metadataOmitted : 0);
  const emptyText = diff.binary ? (diff.message || "二进制文件已更改") : (diff.message || "无文本变更");
  const body = rows || `<div class="trace-diff-empty">${E(emptyText)}</div>`;
  const more = locallyTruncated || diff.truncated ? `<div class="trace-diff-more">已隐藏 ${hiddenLines} 行</div>` : "";
  const action = options.pathAction ? ` data-git-action="${E(options.pathAction)}"` : "";
  const expanded = options.expanded !== false;
  const toggleAction = options.toggleAction ? ` data-git-action="${E(options.toggleAction)}"` : "";
  const disclosureIconName = expanded ? "ich-down" : "ich-right";
  const disclosureIcon = typeof S === "function"
    ? S(disclosureIconName, 14)
    : `<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="#${disclosureIconName}"/></svg>`;
  const toggle = options.collapsible
    ? `<button type="button" class="trace-diff-toggle"${toggleAction} aria-expanded="${expanded}" aria-label="${expanded ? "收起" : "展开"} diff" title="${expanded ? "收起" : "展开"}">${disclosureIcon}</button>`
    : "";
  return `<div class="trace-diff"><div class="trace-diff-head"><button type="button" class="trace-diff-path" data-diff-file-path="${E(diff.filePath)}"${action} title="打开文件">${E(diff.filePath)}</button><span class="trace-diff-stat add">+${added}</span><span class="trace-diff-stat del">-${removed}</span>${toggle}</div><div class="trace-diff-code"${expanded ? "" : " hidden"}>${body}${more}</div></div>`;
}

function fileDiffAddAppBindings(): void {
  const app = (window as any).App;
  if (app) app.FileDiff = { countContentLines: fileDiffLineCount, render: renderFileDiff };
}

fileDiffAddAppBindings();
