/**
 * TypeScript API routes — 通过真实的 tsserver 提供 TS 语言服务
 *
 *   POST /api/ts/open   { file, content? }
 *   POST /api/ts/change { file, content }
 *   POST /api/ts/close  { file }
 *   POST /api/ts/completions        { file, line, offset }
 *   POST /api/ts/completionDetails  { file, line, offset, names }
 *   POST /api/ts/quickinfo          { file, line, offset }
 *   POST /api/ts/definition         { file, line, offset }
 *   POST /api/ts/references         { file, line, offset }
 *   GET  /api/ts/diagnostics?file=...&projectRoot=...
 *   POST /api/ts/code-actions        { file, line, offset, endLine?, endOffset?, errorCodes? }
 *   POST /api/ts/apply-code-action   { changes: FileCodeEdits[] }
 *   POST /api/ts/organize-imports    { file }
 */
import type { RouteHandler } from "./types";
import { parseBody } from "./parse-body";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

const cors = { "Access-Control-Allow-Origin": "*" };

async function getTsServer(ctx: import("./types").ServerContext): Promise<import("../ts-server").TsserverManager> {
  const tsServer = ctx.tsServer;
  if (!tsServer) throw new Error("TSServer not available");
  if (!tsServer.isRunning()) {
    const startPromise = tsServer.start(ctx.paths.APP_ROOT);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("tsserver startup timeout")), 8000));
    await Promise.race([startPromise, timeout]);
    // 初始化：发送 configure + compilerOptionsForInferredProjects
    // 告诉 tsserver 用推断项目，避免 tsconfig.json 的 rootDir 限制导致 Debug Failure
    if (tsServer.isRunning()) {
      await tsServer.init(ctx.paths.APP_ROOT).catch(() => {});
    }
  }
  if (!tsServer.isRunning()) throw new Error("tsserver failed to start");
  return tsServer;
}

export const handleTypeScript: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;

  if (!url?.startsWith("/api/ts/")) return false;

  // GET /api/ts/diagnostics?file=... — 同步诊断
  if (url.startsWith("/api/ts/diagnostics") && method === "GET") {
    try {
      const ts = await getTsServer(ctx);
      const u = new URL(url, `http://${req.headers.host || "localhost"}`);
      const file = u.searchParams.get("file") || "";
      if (!file) { res.writeHead(400, { ...cors }); res.end(JSON.stringify({ error: "Missing 'file'" })); return true; }

      const [semantic, syntactic] = await Promise.all([
        ts.sendRequest("semanticDiagnosticsSync", { file }).catch(() => []),
        ts.sendRequest("syntacticDiagnosticsSync", { file }).catch(() => []),
      ]);
      const all = [...(semantic || []), ...(syntactic || [])];
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify(all));
    } catch (err: unknown) {
      res.writeHead(200, { ...cors });
      res.end(JSON.stringify({ success: false, error: (err as Error).message }));
    }
    return true;
  }

  if (method !== "POST") return false;

  try {
    const ts = await getTsServer(ctx);
    const body = await parseBody(req);
    const file = body.file;

    switch (true) {
      case url === "/api/ts/open": {
        if (!file) {
          res.writeHead(400, { ...cors });
          res.end(JSON.stringify({ error: "Missing 'file'" }));
          return true;
        }
        const result = await ts.sendRequest("open", {
          file,
          fileContent: body.content || "",
          scriptKindName: body.scriptKindName || "TS",
          projectRootPath: ctx.paths.APP_ROOT,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      case url === "/api/ts/change": {
        const lines = (body.content || "").split("\n");
        const endLine = lines.length;
        const endOffset = (lines[lines.length - 1] || "").length + 1;
        await ts.sendRequest("change", {
          file,
          line: 1,
          offset: 1,
          endLine,
          endOffset,
          insertString: body.content,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      case url === "/api/ts/close": {
        await ts.sendRequest("close", { file });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      case url === "/api/ts/completions": {
        const result = await ts.sendRequest("completionInfo", {
          file,
          line: body.line,
          offset: body.offset,
          triggerKind: body.triggerKind || 0,
        });
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify(result || { entries: [] }));
        return true;
      }

      case url === "/api/ts/completionDetails": {
        const result = await ts.sendRequest("completionEntryDetails", {
          file,
          line: body.line,
          offset: body.offset,
          entryNames: body.names || [],
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result || []));
        return true;
      }

      case url === "/api/ts/quickinfo": {
        const result = await ts.sendRequest("quickinfo", {
          file,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      case url === "/api/ts/definition": {
        const result = await ts.sendRequest("definitionAndBoundSpan", {
          file,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      case url === "/api/ts/references": {
        const result = await ts.sendRequest("references", {
          file,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      // ─── Code Actions ──────────────────────────────────

      case url === "/api/ts/code-actions": {
        const errorCodes: number[] = body.errorCodes || [];
        const startLine = body.line;
        const startOffset = body.offset;
        const endLine = body.endLine || body.line;
        const endOffset = body.endOffset || body.offset;

        if (errorCodes.length === 0) {
          const refactors = await ts.sendRequest("getApplicableRefactors", {
            file,
            startLine,
            startOffset,
            endLine,
            endOffset,
            triggerReason: body.triggerReason || "invoked",
            kind: body.kind,
            includeInteractiveActions: body.includeInteractiveActions ?? false,
          });

          const actions: any[] = [];
          for (const refactor of refactors || []) {
            for (const action of refactor.actions || []) {
              if (action?.notApplicableReason || action?.isInteractive) continue;
              try {
                const edits = await ts.sendRequest("getEditsForRefactor", {
                  file,
                  startLine,
                  startOffset,
                  endLine,
                  endOffset,
                  refactor: refactor.name,
                  action: action.name,
                  interactiveRefactorArguments: body.interactiveRefactorArguments,
                });
                if (!edits?.edits?.length) continue;
                actions.push({
                  description: action.description || refactor.description,
                  changes: edits.edits,
                  commands: edits.commands,
                  fixId: undefined,
                  fixName: undefined,
                  fixAllDescription: undefined,
                  kind: action.kind || "refactor",
                  renameFilename: edits.renameFilename,
                  renameLocation: edits.renameLocation,
                });
              } catch {
                // ignore refactor-specific failures; keep other actions
              }
            }
          }

          res.writeHead(200, { ...cors });
          res.end(JSON.stringify({ actions }));
          return true;
        }

        const fixes = await ts.sendRequest("getCodeFixes", {
          file,
          startLine,
          startOffset,
          endLine,
          endOffset,
          errorCodes,
        });
        const actions = (fixes || []).map((f: any) => ({
          description: f.description,
          changes: f.changes,
          commands: f.commands,
          fixId: f.fixId,
          fixName: f.fixName,
          fixAllDescription: f.fixAllDescription,
          kind: "quickfix",
        }));

        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ actions }));
        return true;
      }

      case url === "/api/ts/apply-code-action": {
        const changes: { fileName: string; textChanges: { span: { start: { line: number; offset: number }; end: { line: number; offset: number } }; newText: string }[] }[] = body.changes || [];
        const appliedFiles: string[] = [];
        const errors: string[] = [];

        for (const edit of changes) {
          try {
            const absPath = resolve(ctx.paths.APP_ROOT, edit.fileName);
            // 检查文件是否存在
            if (!existsSync(absPath)) {
              errors.push(`File not found: ${edit.fileName}`);
              continue;
            }

            let content = readFileSync(absPath, "utf-8");
            const lines = content.split("\n");

            // 从后往前应用变更（避免位置偏移）
            const sorted = [...(edit.textChanges || [])].sort((a, b) => {
              const aStart = (a.span.start.line - 1) * 100000 + a.span.start.offset;
              const bStart = (b.span.start.line - 1) * 100000 + b.span.start.offset;
              return bStart - aStart; // 降序
            });

            for (const tc of sorted) {
              const { start, end } = tc.span;
              const startIdx = _posToOffset(lines, start.line, start.offset);
              const endIdx = _posToOffset(lines, end.line, end.offset);
              if (startIdx < 0 || endIdx < 0 || startIdx > endIdx) {
                errors.push(`Invalid span at ${edit.fileName}:${start.line}:${start.offset}`);
                continue;
              }
              content = content.slice(0, startIdx) + tc.newText + content.slice(endIdx);
              // 重新分割行（后续变更需要准确的行列映射）
              // 由于从后往前处理，后续变更的位置不会受影响，但重新分割 improve safety
              // （实际上从后往前处理，只影响旧行号，不影响前面变更的位置）
              // 为了安全，重新同步 lines
              lines.splice(0, lines.length, ...content.split("\n"));
            }

            writeFileSync(absPath, content, "utf-8");
            appliedFiles.push(edit.fileName);
          } catch (e: any) {
            errors.push(`Failed to apply: ${edit.fileName} — ${e.message}`);
          }
        }

        res.writeHead(200, { ...cors });
        const allOk = errors.length === 0;
        res.end(JSON.stringify({
          ok: allOk,
          partial: !allOk && appliedFiles.length > 0,
          files: appliedFiles,
          errors: errors.length > 0 ? errors : undefined,
        }));
        return true;
      }

      case url === "/api/ts/organize-imports": {
        const result = await ts.sendRequest("organizeImports", {
          file,
          scope: "",
          host: ctx.paths.APP_ROOT,
        });
        if (result && Array.isArray(result)) {
          // apply changes to disk
          const appliedFiles: string[] = [];
          const errors: string[] = [];
          for (const edit of result as any[]) {
            try {
              const absPath = resolve(ctx.paths.APP_ROOT, edit.fileName);
              if (!existsSync(absPath)) { errors.push(`File not found: ${edit.fileName}`); continue; }
              let content = readFileSync(absPath, "utf-8");
              const lines = content.split("\n");
              const sorted = [...(edit.textChanges || [])].sort((a: any, b: any) => {
                const aStart = (a.span.start.line - 1) * 100000 + a.span.start.offset;
                const bStart = (b.span.start.line - 1) * 100000 + b.span.start.offset;
                return bStart - aStart;
              });
              for (const tc of sorted) {
                const { start, end } = tc.span;
                const startIdx = _posToOffset(lines, start.line, start.offset);
                const endIdx = _posToOffset(lines, end.line, end.offset);
                if (startIdx < 0 || endIdx < 0) continue;
                content = content.slice(0, startIdx) + tc.newText + content.slice(endIdx);
                lines.splice(0, lines.length, ...content.split("\n"));
              }
              writeFileSync(absPath, content, "utf-8");
              appliedFiles.push(edit.fileName);
            } catch (e: any) {
              errors.push(`organizeImports error: ${edit.fileName} — ${e.message}`);
            }
          }
          res.writeHead(200, { ...cors });
          const _allOk = errors.length === 0;
          res.end(JSON.stringify({ ok: _allOk, partial: !_allOk && appliedFiles.length > 0, files: appliedFiles, errors: errors.length > 0 ? errors : undefined }));
        } else {
          res.writeHead(200, { ...cors });
          res.end(JSON.stringify({ ok: false, files: [], error: "No changes from organizeImports" }));
        }
        return true;
      }

      default:
        return false;
    }
  } catch (err: unknown) {
    res.writeHead(200, { ...cors });
    res.end(JSON.stringify({ success: false, error: (err as Error).message }));
    return true;
  }
};

/** 将 1-based 行列转换为字符串偏移量 */
function _posToOffset(lines: string[], line: number, offset: number): number {
  if (line < 1 || line > lines.length) return -1;
  let pos = 0;
  for (let i = 0; i < line - 1; i++) {
    pos += lines[i].length + 1; // +1 为换行符
  }
  return pos + (offset - 1);
}
