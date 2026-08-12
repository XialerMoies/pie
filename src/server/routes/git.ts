/**
 * Git routes — status, log, commit, push, pull
 *
 * 核心解析逻辑在 git-core.ts，此处仅 HTTP 路由分发。
 */
import type { RouteHandler } from "./types.js";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { relative } from "path";
import { parseBody } from "./parse-body.js";
import {
  createFileDiff,
  findGitRoot,
  gitWorkspacePathspec,
  literalGitPathspec,
  parsePorcelain,
  parseLog,
  parseUnifiedDiff,
  scopeGitStatusEntries,
} from "./git-core.js";
import { writePathGuardError } from "./path-guard.js";
import { authorizeRoutePath, writeServerPermissionError } from "../permission-service.js";

const cors = { "Access-Control-Allow-Origin": "*" };

export { findGitRoot } from "./git-core.js";

function git(args: string[], cwd: string, timeout = 10000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export const handleGit: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { paths: p } = ctx;

  if (!url?.startsWith("/api/git/")) return false;

  const u = new URL(url, `http://${req.headers.host || "localhost"}`);
  const queryRoot = u.searchParams.get("root") || "";

  try {
    // GET /api/git/diff
    if (url.startsWith("/api/git/diff")) {
      const root = (await authorizeRoutePath(ctx, queryRoot || p.APP_ROOT, "", "read", "git.diff.root")).path;
      const gitRoot = findGitRoot(root);
      if (!gitRoot) {
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "Current workspace is not a Git repository" }));
        return true;
      }
      const requestedPath = u.searchParams.get("path") || "";
      if (!requestedPath) {
        res.writeHead(400, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "missing_path", message: "Missing file path" }));
        return true;
      }
      const guarded = await authorizeRoutePath(ctx, gitRoot, requestedPath, "read", "git.diff");
      const filePath = relative(gitRoot, guarded.path).replace(/\\/g, "/");
      let hasHead = true;
      try { git(["rev-parse", "--verify", "HEAD"], gitRoot, 5000); } catch { hasHead = false; }
      let untracked = !hasHead;
      let diffPaths = [filePath];
      if (hasHead) {
        const status = git(["status", "--porcelain", "--untracked-files=all"], gitRoot, 5000);
        const entries = parsePorcelain(status);
        const requestedEntry = entries.find(entry => entry.path === filePath || entry.renamePath === filePath);
        untracked = requestedEntry?.x === "?" || requestedEntry?.y === "?";
        const rename = requestedEntry?.renamePath === filePath ? requestedEntry : undefined;
        if (rename) diffPaths = [rename.path, filePath];
      }

      let diff;
      if (untracked && existsSync(guarded.path)) {
        const content = readFileSync(guarded.path);
        diff = content.includes(0)
          ? { filePath, type: "create", linesAdded: 0, linesRemoved: 0, structuredPatch: [], binary: true, message: "二进制文件已更改" }
          : createFileDiff(filePath, content.toString("utf8"));
      } else {
        const output = hasHead
          ? git(["diff", "--no-color", "--no-ext-diff", "--find-renames", "HEAD", "--", ...diffPaths], gitRoot, 10000)
          : "";
        diff = parseUnifiedDiff(output, filePath);
      }
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ gitRoot, ...diff }));
      return true;
    }

    // GET /api/git/status
    if (url.startsWith("/api/git/status")) {
      const root = (await authorizeRoutePath(ctx, queryRoot || p.APP_ROOT, "", "read", "git.status")).path;
      const gitRoot = findGitRoot(root);
      if (!gitRoot) {
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      const pathspec = gitWorkspacePathspec(gitRoot, root);
      const gitPathspec = literalGitPathspec(pathspec);
      const output = git(["status", "--porcelain", ...(gitPathspec ? ["--", gitPathspec] : [])], gitRoot);
      const entries = scopeGitStatusEntries(parsePorcelain(output), pathspec);
      // 附加信息：分支 / 远程差异 / 最新 commit
      let branch = "HEAD";
      try { branch = git(["rev-parse", "--abbrev-ref", "HEAD"], gitRoot, 5000).trim(); } catch {}
      let ahead = 0, behind = 0;
      try {
        const revs = git(["rev-list", "--count", "--left-right", "HEAD...@{upstream}"], gitRoot, 5000).trim();
        const parts = revs.split("\t");
        ahead = parseInt(parts[0] || "0", 10);
        behind = parseInt(parts[1] || "0", 10);
      } catch {}
      let lastCommit = "";
      try {
        lastCommit = git(["log", "-1", "--format=%h %s", ...(gitPathspec ? ["--", gitPathspec] : [])], gitRoot, 5000).trim();
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({
        gitRoot,
        branch,
        ahead,
        behind,
        lastCommit,
        entries,
        total: entries.length,
        modified: entries.filter(e => e.y === "M" || e.x === "M").length,
        added: entries.filter(e => e.y === "?" || e.x === "A" || e.y === "A").length,
        deleted: entries.filter(e => e.x === "D" || e.y === "D").length,
      }));
      return true;
    }

    // GET /api/git/log
    if (url.startsWith("/api/git/log")) {
      const root = (await authorizeRoutePath(ctx, queryRoot || p.APP_ROOT, "", "read", "git.log")).path;
      const gitRoot = findGitRoot(root);
      if (!gitRoot) {
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      const pathspec = gitWorkspacePathspec(gitRoot, root);
      const gitPathspec = literalGitPathspec(pathspec);
      const rawCount = parseInt(u.searchParams.get("count") || "10", 10);
      const count = Number.isFinite(rawCount) ? Math.max(1, Math.min(rawCount, 100)) : 10;
      const output = git(["log", "--oneline", `-${count}`, ...(gitPathspec ? ["--", gitPathspec] : [])], gitRoot);
      const entries = parseLog(output);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ gitRoot, entries }));
      return true;
    }

    // POST /api/git/commit
    if (url.startsWith("/api/git/commit") && method === "POST") {
      const body = await parseBody(req).catch(() => ({}));
      const msg = (body.message || "").trim();
      const bodyRoot = (await authorizeRoutePath(ctx, body.root || p.APP_ROOT, "", "write", "git.commit")).path;
      const gitRoot2 = findGitRoot(bodyRoot);
      if (!gitRoot2) {
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      if (!msg) { res.writeHead(200, { ...cors }); res.end(JSON.stringify({ error: "empty_message", message: "提交信息不能为空" })); return true; }
      git(["add", "-A"], gitRoot2, 15000);
      git(["commit", "-m", msg], gitRoot2, 15000);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, message: "提交成功" }));
      return true;
    }

    // POST /api/git/push
    if (url.startsWith("/api/git/push") && method === "POST") {
      const body = await parseBody(req).catch(() => ({}));
      const bodyRoot = (await authorizeRoutePath(ctx, body.root || p.APP_ROOT, "", "write", "git.push")).path;
      const gitRoot2 = findGitRoot(bodyRoot);
      if (!gitRoot2) {
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      try {
        git(["push"], gitRoot2, 60000);
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, message: "推送成功" }));
      } catch (pushErr: unknown) {
        const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        const errMsg = (pushErr as any).stderr?.toString() || msg || "推送失败";
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ error: "push_error", message: errMsg }));
      }
      return true;
    }

    // POST /api/git/pull
    if (url.startsWith("/api/git/pull") && method === "POST") {
      const body = await parseBody(req).catch(() => ({}));
      const bodyRoot = (await authorizeRoutePath(ctx, body.root || p.APP_ROOT, "", "write", "git.pull")).path;
      const gitRoot2 = findGitRoot(bodyRoot);
      if (!gitRoot2) {
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      try {
        git(["pull"], gitRoot2, 60000);
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ ok: true, message: "拉取成功" }));
      } catch (pullErr: unknown) {
        const msg = pullErr instanceof Error ? pullErr.message : String(pullErr);
        const errMsg = (pullErr as any).stderr?.toString() || msg || "拉取失败";
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ error: "pull_error", message: errMsg }));
      }
      return true;
    }
  } catch (e: unknown) {
    if (writeServerPermissionError(res, cors, e)) return true;
    if (writePathGuardError(res, cors, e)) return true;
    res.writeHead(200, { ...cors });
    res.end(JSON.stringify({ error: (e as Error).message?.includes("not a git repository") ? "not_a_repo" : "git_error", message: (e as Error).message }));
    return true;
  }

  return false;
};
