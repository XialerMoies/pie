import { describe, it } from "node:test";
import assert from "node:assert";

import {
  authorizeLocalApiRequest,
  clearDesktopSessionTokenEnv,
  createDesktopSecurityConfig,
  installSecurityHeaders,
  isAllowedLoopbackOrigin,
  requiresDesktopToken,
} from "../src/server/security.ts";

const security = {
  token: "test-token",
  cookieName: "mca_token",
  cookieMaxAgeSeconds: 60,
};

function req(method, url, headers = {}) {
  return { method, url, headers };
}

function res() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
      return this;
    },
    end(body) {
      this.body += body || "";
      return this;
    },
  };
}

describe("server desktop security", () => {
  it("allows loopback origins and rejects non-loopback origins", () => {
    assert.strictEqual(isAllowedLoopbackOrigin("http://127.0.0.1:5173"), true);
    assert.strictEqual(isAllowedLoopbackOrigin("http://localhost:5173"), true);
    assert.strictEqual(isAllowedLoopbackOrigin("https://example.com"), false);
    assert.strictEqual(isAllowedLoopbackOrigin("null"), false);
  });

  it("requires a desktop token for mutating API requests", () => {
    const denied = authorizeLocalApiRequest(req("POST", "/api/file/write"), security);
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.code, "bad_token");

    const allowedByCookie = authorizeLocalApiRequest(
      req("POST", "/api/file/write", { cookie: "mca_token=test-token" }),
      security,
    );
    assert.strictEqual(allowedByCookie.ok, true);

    const allowedByHeader = authorizeLocalApiRequest(
      req("POST", "/api/file/write", { "x-my-code-agent-token": "test-token" }),
      security,
    );
    assert.strictEqual(allowedByHeader.ok, true);
  });

  it("can clear the captured desktop token from process env", () => {
    const previous = process.env.MY_CODE_AGENT_DESKTOP_TOKEN;
    try {
      process.env.MY_CODE_AGENT_DESKTOP_TOKEN = "env-token";
      const config = createDesktopSecurityConfig();
      clearDesktopSessionTokenEnv();

      assert.strictEqual(config.token, "env-token");
      assert.strictEqual(process.env.MY_CODE_AGENT_DESKTOP_TOKEN, undefined);
    } finally {
      if (previous === undefined) delete process.env.MY_CODE_AGENT_DESKTOP_TOKEN;
      else process.env.MY_CODE_AGENT_DESKTOP_TOKEN = previous;
    }
  });

  it("requires a desktop token for sensitive read API requests", () => {
    const sensitiveCases = [
      "/api/file/read?root=/repo&path=README.md",
      "/api/file/raw?root=/repo&path=README.png",
      "/api/search?root=/repo&q=test&mode=text",
      "/api/sessions?workspace=/repo",
      "/api/sessions/abc/messages",
      "/api/ts/diagnostics?file=/repo/src/index.ts",
      "/api/git/status?root=/repo",
      "/api/ui-state?workspace=/repo",
      "/api/permissions/audit?limit=1",
      "/api/dashboard",
      "/api/usage/current",
      "/api/events",
    ];

    for (const url of sensitiveCases) {
      assert.strictEqual(requiresDesktopToken(req("GET", url), security), true, url);
      const denied = authorizeLocalApiRequest(req("GET", url), security);
      assert.strictEqual(denied.ok, false, url);
      assert.strictEqual(denied.code, "bad_token", url);

      const allowed = authorizeLocalApiRequest(
        req("GET", url, { cookie: "mca_token=test-token" }),
        security,
      );
      assert.strictEqual(allowed.ok, true, url);
    }
  });

  it("keeps only explicit bootstrap/catalog reads public", () => {
    const bootstrap = authorizeLocalApiRequest(req("GET", "/api/bootstrap"), security);
    const catalog = authorizeLocalApiRequest(req("GET", "/api/mcp/catalog"), security);
    const headBootstrap = authorizeLocalApiRequest(req("HEAD", "/api/bootstrap"), security);

    assert.strictEqual(requiresDesktopToken(req("GET", "/api/bootstrap")), false);
    assert.strictEqual(requiresDesktopToken(req("HEAD", "/api/bootstrap")), false);
    assert.strictEqual(requiresDesktopToken(req("GET", "/api/mcp/catalog")), false);
    assert.strictEqual(requiresDesktopToken(req("GET", "/api/dashboard")), true);
    assert.strictEqual(bootstrap.ok, true);
    assert.strictEqual(catalog.ok, true);
    assert.strictEqual(headBootstrap.ok, true);
  });

  it("rejects cross-site and non-loopback API requests", () => {
    const badOrigin = authorizeLocalApiRequest(
      req("GET", "/api/dashboard", { origin: "https://evil.example" }),
      security,
    );
    assert.strictEqual(badOrigin.ok, false);
    assert.strictEqual(badOrigin.code, "bad_origin");

    const crossSite = authorizeLocalApiRequest(
      req("POST", "/api/file/write", { "sec-fetch-site": "cross-site", cookie: "mca_token=test-token" }),
      security,
    );
    assert.strictEqual(crossSite.ok, false);
    assert.strictEqual(crossSite.code, "cross_site");
  });

  it("strips wildcard CORS and sets desktop cookie/security headers", () => {
    const response = res();
    installSecurityHeaders(req("GET", "/api/dashboard"), response, security);
    response.writeHead(200, { "Access-Control-Allow-Origin": "*" });

    assert.strictEqual(response.headers["Access-Control-Allow-Origin"], undefined);
    assert.match(response.headers["Set-Cookie"], /^mca_token=test-token; HttpOnly; SameSite=Strict; Path=\/;/);
    assert.strictEqual(response.headers["X-Content-Type-Options"], "nosniff");
  });

  it("allows preflight only from loopback origins", () => {
    const allowed = authorizeLocalApiRequest(
      req("OPTIONS", "/api/file/write", { origin: "http://127.0.0.1:5173" }),
      security,
    );
    assert.strictEqual(allowed.ok, true);

    const response = res();
    installSecurityHeaders(
      req("OPTIONS", "/api/file/write", { origin: "http://127.0.0.1:5173" }),
      response,
      security,
    );
    response.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    assert.strictEqual(response.headers["Access-Control-Allow-Origin"], "http://127.0.0.1:5173");
    assert.match(response.headers["Access-Control-Allow-Methods"], /POST/);
  });
});
