import { createHash, randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "http";
import { join, resolve } from "node:path";

export interface DesktopSecurityConfig {
  token: string;
  cookieName: string;
  cookieMaxAgeSeconds: number;
  allowedOrigins: readonly string[];
}

export type SecurityDecision =
  | { ok: true }
  | { ok: false; status: number; code: string; error: string };

const DEFAULT_COOKIE_NAME = "mca_token";
const DEFAULT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const DESKTOP_TOKEN_ENV = "MY_CODE_AGENT_DESKTOP_TOKEN";
const DESKTOP_ALLOWED_ORIGINS_ENV = "MY_CODE_AGENT_ALLOWED_ORIGINS";
const PUBLIC_READ_API_PATHS = new Set([
  "/api/bootstrap",
  "/api/mcp/catalog",
]);

export interface InstanceMetadata {
  version: 1;
  instanceId: string;
  pid: number;
  port: number;
  workspace: string;
  startedAt: number;
}

const INVALID_INSTANCE_GRACE_MS = 24 * 60 * 60 * 1000;

export function createDesktopSecurityConfig(token?: string, instanceId?: string): DesktopSecurityConfig {
  const configuredToken = token === undefined ? process.env[DESKTOP_TOKEN_ENV] : token;
  const cookieName = instanceId
    ? `mca_token_${createHash("sha256").update(instanceId).digest("hex").slice(0, 16)}`
    : DEFAULT_COOKIE_NAME;
  return {
    token: configuredToken?.trim() || createDesktopSessionToken(),
    cookieName,
    cookieMaxAgeSeconds: DEFAULT_COOKIE_MAX_AGE_SECONDS,
    allowedOrigins: parseAllowedOrigins(process.env[DESKTOP_ALLOWED_ORIGINS_ENV]),
  };
}

export async function writeInstanceMetadata(filePath: string, metadata: InstanceMetadata): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(metadata, null, 2), { encoding: "utf8", flag: "wx" });
    await rename(tempPath, filePath);
  } finally {
    await unlink(tempPath).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function cleanupStaleInstanceDirectories(
  dataRoot: string,
  currentInstanceId: string,
): Promise<string[]> {
  const instancesRoot = join(resolve(dataRoot), "instances");
  let entries;
  try {
    entries = await readdir(instancesRoot, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentInstanceId) continue;
    const instanceRoot = join(instancesRoot, entry.name);
    const metadata = await readInstanceMetadata(join(instanceRoot, "port.json"));
    if (metadata ? processIsAlive(metadata.pid) : !(await isExpiredInvalidInstance(instanceRoot))) continue;
    await rm(instanceRoot, { recursive: true, force: true });
    removed.push(instanceRoot);
  }
  return removed.sort();
}

export async function removeInstanceRuntimeDirectory(instanceRoot: string): Promise<void> {
  await rm(instanceRoot, { recursive: true, force: true });
}

async function readInstanceMetadata(filePath: string): Promise<InstanceMetadata | null> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<InstanceMetadata>;
    if (value.version !== 1
      || typeof value.instanceId !== "string"
      || !Number.isInteger(value.pid)
      || !Number.isInteger(value.port)
      || typeof value.workspace !== "string"
      || !Number.isFinite(value.startedAt)) return null;
    return value as InstanceMetadata;
  } catch {
    return null;
  }
}

async function isExpiredInvalidInstance(instanceRoot: string): Promise<boolean> {
  try {
    const details = await stat(instanceRoot);
    return Date.now() - details.mtimeMs >= INVALID_INSTANCE_GRACE_MS;
  } catch (error: any) {
    return error?.code === "ENOENT";
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export function clearDesktopSessionTokenEnv(): void {
  delete process.env[DESKTOP_TOKEN_ENV];
}

export function createDesktopSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function authorizeLocalApiRequest(req: IncomingMessage, security?: DesktopSecurityConfig): SecurityDecision {
  if (!security?.token || !isApiRequest(req.url || "")) return { ok: true };

  const origin = headerValue(req.headers.origin);
  if (origin && !isAllowedRequestOrigin(req, origin, security)) {
    return { ok: false, status: 403, code: "bad_origin", error: "Origin is not allowed" };
  }

  const secFetchSite = headerValue(req.headers["sec-fetch-site"])?.toLowerCase();
  if (secFetchSite === "cross-site") {
    return { ok: false, status: 403, code: "cross_site", error: "Cross-site API requests are not allowed" };
  }

  if (req.method === "OPTIONS") return { ok: true };

  const suppliedToken = getRequestToken(req, security.cookieName);
  if (!requiresDesktopToken(req)) {
    if (suppliedToken && !constantTimeEqual(suppliedToken, security.token)) {
      return { ok: false, status: 403, code: "bad_token", error: "Desktop API token is missing or invalid" };
    }
    return { ok: true };
  }
  if (!constantTimeEqual(suppliedToken, security.token)) {
    return { ok: false, status: 403, code: "bad_token", error: "Desktop API token is missing or invalid" };
  }

  return { ok: true };
}

export function requiresDesktopToken(req: IncomingMessage): boolean {
  if (!isApiRequest(req.url || "")) return false;
  if (req.method === "OPTIONS") return false;
  if (!isReadMethod(req.method)) return true;
  return !PUBLIC_READ_API_PATHS.has(getUrlPathname(req.url || ""));
}

export function isApiPreflight(req: IncomingMessage): boolean {
  return req.method === "OPTIONS" && isApiRequest(req.url || "");
}

export function installSecurityHeaders(req: IncomingMessage, res: ServerResponse, security?: DesktopSecurityConfig): void {
  const originalWriteHead = res.writeHead.bind(res) as any;
  (res as any).writeHead = (statusCode: number, reasonOrHeaders?: string | OutgoingHttpHeaders, maybeHeaders?: OutgoingHttpHeaders) => {
    const hasStatusMessage = typeof reasonOrHeaders === "string";
    const statusMessage = hasStatusMessage ? reasonOrHeaders : undefined;
    const headers = hasStatusMessage ? maybeHeaders : reasonOrHeaders;
    const mergedHeaders = withSecurityHeaders(req, headers, security);

    if (statusMessage !== undefined) {
      return originalWriteHead(statusCode, statusMessage, mergedHeaders);
    }
    return originalWriteHead(statusCode, mergedHeaders);
  };
}

export function writeSecurityError(res: ServerResponse, decision: Exclude<SecurityDecision, { ok: true }>): void {
  res.writeHead(decision.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, code: decision.code, error: decision.error }));
}

function withSecurityHeaders(req: IncomingMessage, headers: OutgoingHttpHeaders | undefined, security?: DesktopSecurityConfig): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = { ...(headers || {}) };
  out["X-Content-Type-Options"] = "nosniff";
  out["Cross-Origin-Resource-Policy"] = "same-origin";

  if (!security?.token) return out;

  removeHeader(out, "access-control-allow-origin");
  removeHeader(out, "access-control-allow-credentials");
  removeHeader(out, "access-control-allow-methods");
  removeHeader(out, "access-control-allow-headers");

  const origin = headerValue(req.headers.origin);
  if (origin && isAllowedRequestOrigin(req, origin, security)) {
    out["Access-Control-Allow-Origin"] = origin;
    out["Access-Control-Allow-Credentials"] = "true";
    appendVary(out, "Origin");
  }

  if (isApiPreflight(req)) {
    out["Access-Control-Allow-Methods"] = "GET,HEAD,POST,PUT,DELETE,OPTIONS";
    out["Access-Control-Allow-Headers"] = "Content-Type, X-My-Code-Agent-Token";
    out["Access-Control-Max-Age"] = "600";
  }

  const suppliedToken = getRequestToken(req, security.cookieName);
  if (isApiRequest(req.url || "") && constantTimeEqual(suppliedToken, security.token)) {
    appendSetCookie(out, `${security.cookieName}=${security.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${security.cookieMaxAgeSeconds}`);
  }
  return out;
}

function isApiRequest(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?");
}

function getUrlPathname(url: string): string {
  try {
    return new URL(url, "http://127.0.0.1").pathname;
  } catch {
    const queryIdx = url.indexOf("?");
    return queryIdx >= 0 ? url.slice(0, queryIdx) : url;
  }
}

function isReadMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getRequestToken(req: IncomingMessage, cookieName: string): string | undefined {
  const headerToken = headerValue(req.headers["x-my-code-agent-token"]);
  if (headerToken) return headerToken;
  const cookieHeader = headerValue(req.headers.cookie);
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if (name === cookieName) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function isAllowedLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isAllowedRequestOrigin(req: IncomingMessage, origin: string, security: DesktopSecurityConfig): boolean {
  const normalizedOrigin = normalizeLoopbackOrigin(origin);
  if (!normalizedOrigin) return false;

  const host = headerValue(req.headers.host);
  const requestOrigin = host ? normalizeLoopbackOrigin(`http://${host}`) : null;
  if (requestOrigin === normalizedOrigin) return true;

  return security.allowedOrigins.some((allowed) => normalizeLoopbackOrigin(allowed) === normalizedOrigin);
}

function normalizeLoopbackOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !isLoopbackHost(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const origins = new Set<string>();
  for (const value of raw.split(",")) {
    const normalized = normalizeLoopbackOrigin(value.trim());
    if (normalized) origins.add(normalized);
  }
  return [...origins];
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

function constantTimeEqual(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function removeHeader(headers: OutgoingHttpHeaders, name: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) delete headers[key];
  }
}

function appendVary(headers: OutgoingHttpHeaders, value: string): void {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === "vary");
  if (!existingKey) {
    headers.Vary = value;
    return;
  }
  const current = headers[existingKey];
  const values = Array.isArray(current) ? current.join(",") : String(current || "");
  const parts = values.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (!parts.includes(value.toLowerCase())) {
    headers[existingKey] = values ? `${values}, ${value}` : value;
  }
}

function appendSetCookie(headers: OutgoingHttpHeaders, cookie: string): void {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === "set-cookie");
  if (!existingKey) {
    headers["Set-Cookie"] = cookie;
    return;
  }
  const current = headers[existingKey];
  headers[existingKey] = Array.isArray(current) ? [...current, cookie] : [String(current), cookie];
}
