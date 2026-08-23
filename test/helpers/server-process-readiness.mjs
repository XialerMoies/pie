function valueOf(source) {
  return typeof source === "function" ? source() : source || "";
}

function errorCodes(error) {
  const codes = [];
  let current = error;
  const seen = new Set();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string") codes.push(current.code.toUpperCase());
    current = current.cause;
  }
  return codes;
}

function errorText(error) {
  const parts = [];
  let current = error;
  const seen = new Set();
  while (current && !seen.has(current)) {
    if (typeof current === "object") seen.add(current);
    parts.push(current instanceof Error ? current.message : String(current));
    current = typeof current === "object" && current ? current.cause : undefined;
  }
  return parts.join(" ");
}

function childHasExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

export function classifyServerReadinessFailure(error, snapshot = {}) {
  const codes = errorCodes(error);
  const diagnosticText = `${errorText(error)} ${snapshot.stderr || ""}`;
  if (codes.includes("EADDRINUSE") || /EADDRINUSE|address already in use/iu.test(diagnosticText)) {
    return "port_conflict";
  }
  if (
    codes.some((code) => ["ENOMEM", "ENOBUFS", "EMFILE", "ENFILE"].includes(code))
    || /ENOMEM|ENOBUFS|uv_os_get_passwd|out of memory|allocation failed/iu.test(diagnosticText)
  ) {
    return "resource_exhausted";
  }
  if (snapshot.exited) return "child_exited";
  if (codes.includes("ECONNREFUSED") || /ECONNREFUSED|connection refused/iu.test(diagnosticText)) {
    return "connection_refused";
  }
  if (codes.includes("ETIMEDOUT") || codes.includes("UND_ERR_CONNECT_TIMEOUT") || /timed? out/iu.test(diagnosticText)) {
    return "transport_timeout";
  }
  return "transport_error";
}

function childSnapshot(child, stderr) {
  return {
    pid: child?.pid ?? null,
    exitCode: child?.exitCode ?? null,
    signalCode: child?.signalCode ?? null,
    exited: childHasExited(child),
    stderr: valueOf(stderr),
  };
}

function sanitize(value, secret) {
  const text = String(value || "");
  return secret ? text.split(secret).join("[redacted]") : text;
}

function attemptSummary(attempt) {
  const code = attempt.code ? ` code=${attempt.code}` : "";
  const status = attempt.status ? ` status=${attempt.status}` : "";
  return `+${attempt.atMs}ms ${attempt.outcome}${code}${status}`;
}

function readinessError({ classification, port, elapsedMs, attempts, child, stdout, stderr, token, cause }) {
  const snapshot = childSnapshot(child, stderr);
  const lines = [
    `server bootstrap readiness failed: ${classification}`,
    `stage=bootstrap-readiness port=${port} elapsedMs=${elapsedMs}`,
    `child pid=${snapshot.pid ?? "unknown"} exitCode=${snapshot.exitCode ?? "null"} signalCode=${snapshot.signalCode ?? "null"}`,
    `attempts: ${attempts.map(attemptSummary).join("; ") || "none"}`,
    `stdout:\n${sanitize(valueOf(stdout), token) || "<empty>"}`,
    `stderr:\n${sanitize(valueOf(stderr), token) || "<empty>"}`,
  ];
  const error = new Error(lines.join("\n"), { cause });
  error.name = "ServerReadinessError";
  error.stage = "bootstrap-readiness";
  error.classification = classification;
  error.attempts = attempts;
  error.child = snapshot;
  return error;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function firstErrorCode(error) {
  return errorCodes(error)[0] || null;
}

async function boundedFetch(fetchImpl, url, request, timeoutMs) {
  const controller = new AbortController();
  const timeoutError = Object.assign(new Error(`bootstrap probe timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" });
  let timer;
  try {
    return await Promise.race([
      fetchImpl(url, { ...request, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForServerBootstrap({
  child,
  port,
  token,
  stdout,
  stderr,
  timeoutMs = 3_000,
  intervalMs = 50,
  requestTimeoutMs = 750,
  fetchImpl = globalThis.fetch,
}) {
  if (!Number.isInteger(port) || port <= 0) throw new TypeError("port must be a positive integer");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const attempts = [];
  let lastError;

  while (Date.now() <= deadline) {
    const before = childSnapshot(child, stderr);
    if (before.exited) {
      const classification = classifyServerReadinessFailure(lastError, before);
      throw readinessError({
        classification,
        port,
        elapsedMs: Date.now() - startedAt,
        attempts,
        child,
        stdout,
        stderr,
        token,
        cause: lastError,
      });
    }

    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await boundedFetch(fetchImpl, `http://127.0.0.1:${port}/api/bootstrap`, {
        method: "GET",
        headers: { "X-My-Code-Agent-Token": token },
      }, Math.min(requestTimeoutMs, remainingMs));
      attempts.push({
        atMs: Date.now() - startedAt,
        outcome: response.ok ? "success" : "http_error",
        status: response.status,
        code: null,
        child: childSnapshot(child, stderr),
      });
      return {
        response,
        attempts,
        diagnostics: {
          child: childSnapshot(child, stderr),
          stdout: sanitize(valueOf(stdout), token),
          stderr: sanitize(valueOf(stderr), token),
        },
      };
    } catch (error) {
      lastError = error;
      const snapshot = childSnapshot(child, stderr);
      const classification = classifyServerReadinessFailure(error, snapshot);
      attempts.push({
        atMs: Date.now() - startedAt,
        outcome: classification,
        status: null,
        code: firstErrorCode(error),
        message: sanitize(errorText(error), token),
        child: snapshot,
      });
      if (snapshot.exited || ["port_conflict", "resource_exhausted", "child_exited"].includes(classification)) {
        throw readinessError({
          classification,
          port,
          elapsedMs: Date.now() - startedAt,
          attempts,
          child,
          stdout,
          stderr,
          token,
          cause: error,
        });
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await delay(Math.min(intervalMs, remainingMs));
  }

  const snapshot = childSnapshot(child, stderr);
  const classification = snapshot.exited
    ? classifyServerReadinessFailure(lastError, snapshot)
    : "startup_timeout";
  throw readinessError({
    classification,
    port,
    elapsedMs: Date.now() - startedAt,
    attempts,
    child,
    stdout,
    stderr,
    token,
    cause: lastError,
  });
}
