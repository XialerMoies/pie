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
import type { RouteHandler } from "./types.js";
import { parseBody } from "./parse-body.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { authorizeRoutePath, writeServerPermissionError } from "../permission-service.js";
import { PathGuardError, writePathGuardError } from "./path-guard.js";

const cors = { "Access-Control-Allow-Origin": "*" };
// Multiple renderer timers can ask for the same file while tsserver is still
// loading its project. Share one computation per manager/file instead of
// queueing duplicate semantic and syntactic requests in the child process.
const diagnosticsInFlight = new WeakMap<object, Map<string, Promise<unknown[]>>>();

function diagnosticsFailure(err: unknown): { status: "pending" | "timeout" | "failed"; code: string; error: string } {
  const message = err instanceof Error ? err.message : String(err || "diagnostics failed");
  if (/queue is full|pending|project loading|not ready/i.test(message)) {
    return { status: "pending", code: "diagnostics_pending", error: message };
  }
  if (/timeout|timed out/i.test(message)) {
    return { status: "timeout", code: "timeout", error: message };
  }
  return { status: "failed", code: "diagnostics_failed", error: message };
}

async function getTsServer(ctx: import("./types.js").ServerContext): Promise<import("../ts-server.js").TsserverManager> {
  const tsServer = ctx.groups.infra.tsServer;
  if (!tsServer) throw new Error("TSServer not available");
  if (!tsServer.isRunning()) {
    const startPromise = tsServer.start(ctx.groups.storage.paths.APP_ROOT);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("tsserver startup timeout")), 8000));
    await Promise.race([startPromise, timeout]);
    // 初始化：发送 configure + compilerOptionsForInferredProjects
    // 告诉 tsserver 用推断项目，避免 tsconfig.json 的 rootDir 限制导致 Debug Failure
    if (tsServer.isRunning()) {
      await tsServer.init(ctx.groups.storage.paths.APP_ROOT).catch(() => {});
    }
  }
  if (!tsServer.isRunning()) throw new Error("tsserver failed to start");
  return tsServer;
}

async function authorizeTsFile(
  ctx: import("./types.js").ServerContext,
  file: unknown,
  operation: "read" | "write",
  source: string,
  projectRoot?: unknown,
): Promise<{ path: string; root: string }> {
  if (typeof file !== "string" || !file.trim()) {
    throw new PathGuardError("Missing 'file'", 400, "missing_file");
  }
  const root = typeof projectRoot === "string" && projectRoot.trim()
    ? projectRoot
    : (ctx.groups.core.runtime?.currentWorkspace || ctx.groups.storage.paths.APP_ROOT);
  const guarded = await authorizeRoutePath(ctx, root, file, operation, source);
  return { path: guarded.path, root: guarded.root };
}

export const handleTypeScript: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;

  if (!url?.startsWith("/api/ts/")) return false;

  // GET /api/ts/diagnostics?file=... — 同步诊断
  if (url.startsWith("/api/ts/diagnostics") && method === "GET") {
    try {
      const u = new URL(url, `http://${req.headers.host || "localhost"}`);
      const file = u.searchParams.get("file") || "";
      const authorized = await authorizeTsFile(ctx, file, "read", "ts.diagnostics", u.searchParams.get("projectRoot"));
      const ts = await getTsServer(ctx);

      let byFile = diagnosticsInFlight.get(ts as object);
      if (!byFile) {
        byFile = new Map();
        diagnosticsInFlight.set(ts as object, byFile);
      }
      let pending = byFile.get(authorized.path);
      if (!pending) {
        pending = Promise.all([
          ts.sendRequest("semanticDiagnosticsSync", { file: authorized.path }),
          ts.sendRequest("syntacticDiagnosticsSync", { file: authorized.path }),
        ]).then(([semantic, syntactic]) => [...(semantic || []), ...(syntactic || [])]);
        byFile.set(authorized.path, pending);
        void pending.then(() => {
          if (byFile?.get(authorized.path) === pending) byFile.delete(authorized.path);
        }, () => {
          if (byFile?.get(authorized.path) === pending) byFile.delete(authorized.path);
        });
      }
      const all = await pending;
      res.writeHead(200, { "Content-Type": "application/json", ...cors, "X-Request-State": "complete" });
      res.end(JSON.stringify({ status: "ok", diagnostics: all }));
    } catch (err: unknown) {
      if (writeServerPermissionError(res, cors, err)) return true;
      if (writePathGuardError(res, cors, err)) return true;
      const failure = diagnosticsFailure(err);
      const httpStatus = failure.status === "pending" ? 202 : failure.status === "timeout" ? 504 : 503;
      res.writeHead(httpStatus, { "Content-Type": "application/json", ...cors, "X-Request-State": failure.status });
      res.end(JSON.stringify({ ...failure, diagnostics: [] }));
    }
    return true;
  }

  if (method !== "POST") return false;

  try {
    const body = await parseBody(req);
    const file = body.file;

    switch (true) {
      case url === "/api/ts/open": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.open", body.projectRoot);
        const ts = await getTsServer(ctx);
        const result = await ts.sendRequest("open", {
          file: authorized.path,
          fileContent: body.content || "",
          scriptKindName: body.scriptKindName || "TS",
          projectRootPath: authorized.root,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      case url === "/api/ts/change": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.change", body.projectRoot);
        const ts = await getTsServer(ctx);
        const lines = (body.content || "").split("\n");
        const endLine = lines.length;
        const endOffset = (lines[lines.length - 1] || "").length + 1;
        await ts.sendRequest("change", {
          file: authorized.path,
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
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.close", body.projectRoot);
        const ts = await getTsServer(ctx);
        await ts.sendRequest("close", { file: authorized.path });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ ok: true }));
        return true;
      }

      case url === "/api/ts/completions": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.completions", body.projectRoot);
        const ts = await getTsServer(ctx);
        const result = await ts.sendRequest("completionInfo", {
          file: authorized.path,
          line: body.line,
          offset: body.offset,
          triggerKind: body.triggerKind || 0,
        });
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify(result || { entries: [] }));
        return true;
      }

      case url === "/api/ts/completionDetails": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.completion-details", body.projectRoot);
        const ts = await getTsServer(ctx);
        const result = await ts.sendRequest("completionEntryDetails", {
          file: authorized.path,
          line: body.line,
          offset: body.offset,
          entryNames: body.names || [],
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result || []));
        return true;
      }

      case url === "/api/ts/quickinfo": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.quickinfo", body.projectRoot);
        const ts = await getTsServer(ctx);
        const result = await ts.sendRequest("quickinfo", {
          file: authorized.path,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      case url === "/api/ts/definition": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.definition", body.projectRoot);
        const ts = await getTsServer(ctx);
        const result = await ts.sendRequest("definitionAndBoundSpan", {
          file: authorized.path,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      case url === "/api/ts/references": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.references", body.projectRoot);
        const ts = await getTsServer(ctx);
        const result = await ts.sendRequest("references", {
          file: authorized.path,
          line: body.line,
          offset: body.offset,
        });
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify(result));
        return true;
      }

      // ─── Code Actions ──────────────────────────────────

      case url === "/api/ts/code-actions": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.code-actions", body.projectRoot);
        const ts = await getTsServer(ctx);
        const errorCodes: number[] = body.errorCodes || [];
        const startLine = body.line;
        const startOffset = body.offset;
        const endLine = body.endLine || body.line;
        const endOffset = body.endOffset || body.offset;

        if (errorCodes.length === 0) {
          const refactors = await ts.sendRequest("getApplicableRefactors", {
            file: authorized.path,
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
                  file: authorized.path,
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
          file: authorized.path,
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
        const authorizedChanges: Array<{ edit: typeof changes[number]; absPath: string }> = [];
        const appliedFiles: string[] = [];
        const errors: string[] = [];

        for (const edit of changes) {
          const absPath = (await authorizeTsFile(ctx, edit.fileName, "write", "ts.apply-code-action", body.projectRoot)).path;
          if (!existsSync(absPath)) {
            errors.push(`File not found: ${edit.fileName}`);
            continue;
          }
          authorizedChanges.push({ edit, absPath });
        }

        if (errors.length > 0) {
          res.writeHead(200, { ...cors });
          res.end(JSON.stringify({ ok: false, partial: false, files: [], errors }));
          return true;
        }

        for (const { edit, absPath } of authorizedChanges) {
          try {
            // 检查文件是否存在
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

      case url === "/api/ts/format": {
        const { file, tabSize, useTabs } = body;
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.format", body.projectRoot);
        const ts = await getTsServer(ctx);
        const result = await ts.sendRequest("getFormattingEditsForDocument", {
          file: authorized.path,
          options: {
            tabSize: tabSize ?? 2,
            indentSize: tabSize ?? 2,
            convertTabsToSpaces: useTabs !== true,
            newLineCharacter: "\n",
          },
          host: ctx.groups.storage.paths.APP_ROOT,
        });
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ edits: result || [] }));
        return true;
      }

      case url === "/api/ts/organize-imports": {
        const authorized = await authorizeTsFile(ctx, file, "read", "ts.organize-imports.source", body.projectRoot);
        const ts = await getTsServer(ctx);
        const result = await ts.sendRequest("organizeImports", {
          file: authorized.path,
          scope: "",
          host: ctx.groups.storage.paths.APP_ROOT,
        });
        if (result && Array.isArray(result)) {
          // apply changes to disk
          const authorizedEdits: Array<{ edit: any; absPath: string }> = [];
          const appliedFiles: string[] = [];
          const errors: string[] = [];
          for (const edit of result as any[]) {
            const absPath = (await authorizeTsFile(ctx, edit.fileName, "write", "ts.organize-imports", body.projectRoot)).path;
            if (!existsSync(absPath)) {
              errors.push(`File not found: ${edit.fileName}`);
              continue;
            }
            authorizedEdits.push({ edit, absPath });
          }
          if (errors.length > 0) {
            res.writeHead(200, { ...cors });
            res.end(JSON.stringify({ ok: false, partial: false, files: [], errors }));
            return true;
          }
          for (const { edit, absPath } of authorizedEdits) {
            try {
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
    if (writeServerPermissionError(res, cors, err)) return true;
    if (writePathGuardError(res, cors, err)) return true;
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
