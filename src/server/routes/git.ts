/**
 * Git routes — status, log, commit, push, pull
 *
 * 核心解析逻辑在 git-core.ts，此处仅 HTTP 路由分发。
 */
import type { RouteHandler } from "./types";
import { execSync } from "child_process";
import { parseBody } from "./parse-body";
import { findGitRoot, parsePorcelain, parseLog } from "./git-core";

const cors = { "Access-Control-Allow-Origin": "*" };

export { findGitRoot } from "./git-core";

export const handleGit: RouteHandler = async (req, res, ctx) => {
  const { url, method } = req;
  const { paths: p } = ctx;

  if (!url?.startsWith("/api/git/")) return false;

  const u = new URL(url, `http://${req.headers.host || "localhost"}`);
  const queryRoot = u.searchParams.get("root") || "";

  try {
    // GET /api/git/status
    if (url.startsWith("/api/git/status")) {
      const root = queryRoot || p.APP_ROOT;
      const gitRoot = findGitRoot(root);
      if (!gitRoot) {
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      const output = execSync("git status --porcelain", {
        cwd: gitRoot,
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const entries = parsePorcelain(output);
      // 附加信息：分支 / 远程差异 / 最新 commit
      let branch = "HEAD";
      try { branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: gitRoot, encoding: "utf-8", timeout: 5000, stdio: "pipe" }).trim(); } catch {}
      let ahead = 0, behind = 0;
      try {
        const revs = execSync("git rev-list --count --left-right HEAD...@{upstream}", { cwd: gitRoot, encoding: "utf-8", timeout: 5000, stdio: "pipe" }).trim();
        const parts = revs.split("\t");
        ahead = parseInt(parts[0] || "0", 10);
        behind = parseInt(parts[1] || "0", 10);
      } catch {}
      let lastCommit = "";
      try { lastCommit = execSync("git log -1 --format=%h %s", { cwd: gitRoot, encoding: "utf-8", timeout: 5000, stdio: "pipe" }).trim(); } catch {}
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
      const root = queryRoot || p.APP_ROOT;
      const gitRoot = findGitRoot(root);
      if (!gitRoot) {
        res.writeHead(200, { "Content-Type": "application/json", ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      const count = parseInt(u.searchParams.get("count") || "10", 10);
      const output = execSync(`git log --oneline -${count}`, {
        cwd: gitRoot,
        encoding: "utf-8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const entries = parseLog(output);
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ gitRoot, entries }));
      return true;
    }

    // POST /api/git/commit
    if (url.startsWith("/api/git/commit") && method === "POST") {
      const body = await parseBody(req).catch(() => ({}));
      const msg = (body.message || "").trim();
      const bodyRoot = body.root || p.APP_ROOT;
      const gitRoot2 = findGitRoot(bodyRoot);
      if (!gitRoot2) {
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      if (!msg) { res.writeHead(200, { ...cors }); res.end(JSON.stringify({ error: "empty_message", message: "提交信息不能为空" })); return true; }
      execSync(`git add -A`, { cwd: gitRoot2, encoding: "utf-8", timeout: 15000, stdio: "pipe" });
      execSync(`git commit -m "${msg.replace(/"/g, '\\"')}"`, { cwd: gitRoot2, encoding: "utf-8", timeout: 15000, stdio: "pipe" });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ ok: true, message: "提交成功" }));
      return true;
    }

    // POST /api/git/push
    if (url.startsWith("/api/git/push") && method === "POST") {
      const body = await parseBody(req).catch(() => ({}));
      const bodyRoot = body.root || p.APP_ROOT;
      const gitRoot2 = findGitRoot(bodyRoot);
      if (!gitRoot2) {
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      try {
        execSync(`git push`, { cwd: gitRoot2, encoding: "utf-8", timeout: 60000, stdio: "pipe" });
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
      const bodyRoot = body.root || p.APP_ROOT;
      const gitRoot2 = findGitRoot(bodyRoot);
      if (!gitRoot2) {
        res.writeHead(200, { ...cors });
        res.end(JSON.stringify({ error: "not_a_repo", message: "当前工作区不是 Git 仓库" }));
        return true;
      }
      try {
        execSync(`git pull`, { cwd: gitRoot2, encoding: "utf-8", timeout: 60000, stdio: "pipe" });
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
    res.writeHead(200, { ...cors });
    res.end(JSON.stringify({ error: (e as Error).message?.includes("not a git repository") ? "not_a_repo" : "git_error", message: (e as Error).message }));
    return true;
  }

  return false;
};
