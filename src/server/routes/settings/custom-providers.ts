import type { ServerResponse } from "node:http";

import {
  CustomProviderInvalidRequestError,
  CustomProviderValidationError,
  validateCustomProviderDraft,
  validateCustomProviderId,
  type CustomProviderDeleteInput,
  type CustomProviderMutationInput,
} from "../../../model-provider/contracts.js";
import { CustomProviderRevisionConflict } from "../../../model-provider/custom-provider-store.js";
import {
  CustomProviderApiKeyUnavailable,
  CustomProviderIdConflict,
  CustomProviderImmutableIdError,
  CustomProviderNotFoundError,
} from "../../../model-provider/custom-provider-service.js";
import { ProviderNetworkError } from "../../../model-provider/provider-network-client.js";
import { CustomProviderReferenceConflict } from "../../../model-provider/provider-reference-checker.js";
import { authorizeRoutePath, writeServerPermissionError } from "../../permission-service.js";
import { BodyTooLargeError, InvalidJsonBodyError, parseBody } from "../parse-body.js";
import { writePathGuardError } from "../path-guard.js";
import type { RouteHandler, ServerContext } from "../types.js";
import { cors } from "./common.js";

const JSON_HEADERS = { "Content-Type": "application/json", ...cors };
const ITEM_ROUTE = /^\/api\/custom-providers\/([^/]+)$/;

type CustomProviderRoute =
  | { kind: "capabilities" | "list" | "reveal" | "test" | "discover"; allow: readonly string[] }
  | { kind: "item"; allow: readonly string[]; encodedProviderId: string };

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mutationInput(value: unknown): CustomProviderMutationInput {
  if (!isRecord(value)) throw new CustomProviderInvalidRequestError();
  const unknown = Object.keys(value).find((key) => key !== "expectedRevision" && key !== "provider");
  if (unknown) throw new CustomProviderInvalidRequestError("request");
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new CustomProviderInvalidRequestError("expectedRevision");
  }
  return {
    expectedRevision: value.expectedRevision as number,
    provider: validateCustomProviderDraft(value.provider),
  };
}

function deleteInput(value: unknown): CustomProviderDeleteInput {
  if (!isRecord(value)) throw new CustomProviderInvalidRequestError();
  const unknown = Object.keys(value).find((key) => key !== "expectedRevision");
  if (unknown) throw new CustomProviderInvalidRequestError("request");
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) {
    throw new CustomProviderInvalidRequestError("expectedRevision");
  }
  return { expectedRevision: value.expectedRevision as number };
}

function networkDraftInput(value: unknown) {
  if (!isRecord(value)) throw new CustomProviderInvalidRequestError();
  const unknown = Object.keys(value).find((key) => key !== "provider");
  if (unknown) throw new CustomProviderInvalidRequestError("request");
  return validateCustomProviderDraft(value.provider);
}

function writeError(res: ServerResponse, error: unknown): void {
  if (error instanceof InvalidJsonBodyError) {
    writeJson(res, 400, { error: error.message, code: "invalid_json" });
    return;
  }
  if (error instanceof BodyTooLargeError) {
    writeJson(res, 413, { error: error.message, code: "body_too_large" });
    return;
  }
  if (error instanceof CustomProviderRevisionConflict) {
    writeJson(res, 409, {
      error: "Custom provider revision conflict",
      code: "revision_conflict",
      currentRevision: error.currentRevision,
    });
    return;
  }
  if (error instanceof CustomProviderReferenceConflict) {
    writeJson(res, 409, {
      error: error.message,
      code: "provider_in_use",
      references: error.references,
    });
    return;
  }
  if (error instanceof CustomProviderIdConflict) {
    writeJson(res, 409, {
      error: "Provider ID is already in use",
      code: "provider_id_conflict",
      providerId: error.providerId,
    });
    return;
  }
  if (error instanceof CustomProviderImmutableIdError) {
    writeJson(res, 409, {
      error: "Provider ID is immutable",
      code: "immutable_provider_id",
      providerId: error.providerId,
    });
    return;
  }
  if (error instanceof CustomProviderApiKeyUnavailable) {
    writeJson(res, 404, {
      error: "Custom provider API key is not configured",
      code: "api_key_unavailable",
      providerId: error.providerId,
    });
    return;
  }
  if (error instanceof CustomProviderNotFoundError) {
    writeJson(res, 404, { error: error.message, code: "provider_not_found" });
    return;
  }
  if (error instanceof CustomProviderInvalidRequestError || error instanceof CustomProviderValidationError) {
    writeJson(res, 400, {
      error: "Invalid custom provider request",
      code: "invalid_request",
      ...(error.fieldPath ? { fieldPath: error.fieldPath } : {}),
    });
    return;
  }
  if (error instanceof ProviderNetworkError) {
    writeJson(res, 502, { error: error.message, code: error.code });
    return;
  }
  writeJson(res, 500, { error: "Custom provider request failed", code: "internal_error" });
}

function scheduleRuntimeSync(ctx: ServerContext): void {
  void Promise.resolve()
    .then(() => ctx.runtime.syncModelProviders())
    .catch(() => console.error("[custom-provider] background sync failed"));
}

function routeFor(url: string): CustomProviderRoute | undefined {
  const pathname = new URL(url, "http://localhost").pathname;
  if (pathname === "/api/custom-providers/capabilities") return { kind: "capabilities", allow: ["GET"] };
  if (pathname === "/api/custom-providers/reveal") return { kind: "reveal", allow: ["POST"] };
  if (pathname === "/api/custom-providers/test") return { kind: "test", allow: ["POST"] };
  if (pathname === "/api/custom-providers/discover-models") return { kind: "discover", allow: ["POST"] };
  if (pathname === "/api/custom-providers") return { kind: "list", allow: ["GET", "POST"] };
  const match = ITEM_ROUTE.exec(pathname);
  return match ? { kind: "item", allow: ["PUT", "DELETE"], encodedProviderId: match[1] } : undefined;
}

function createRequestLifecycleScope(
  req: Parameters<RouteHandler>[0],
  res: Parameters<RouteHandler>[1],
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const abortOnIncompleteRequest = () => {
    if (req.aborted || !req.complete) abort();
  };
  const abortOnIncompleteResponse = () => {
    if (!res.writableEnded) abort();
  };
  req.on("aborted", abort);
  req.on("close", abortOnIncompleteRequest);
  res.on("close", abortOnIncompleteResponse);
  if (
    req.aborted
    || (req.destroyed && !req.complete)
    || (!res.writableEnded && (res.destroyed || res.closed))
  ) abort();
  return {
    signal: controller.signal,
    dispose: () => {
      req.off?.("aborted", abort);
      req.off?.("close", abortOnIncompleteRequest);
      res.off?.("close", abortOnIncompleteResponse);
    },
  };
}

async function authorizeMutationFiles(ctx: ServerContext): Promise<void> {
  await authorizeRoutePath(
    ctx,
    ctx.paths.PI_CONFIG_DIR,
    "custom-providers.json",
    "write",
    "settings.custom-providers.config",
  );
  await authorizeRoutePath(
    ctx,
    ctx.paths.PI_CONFIG_DIR,
    "custom-provider-secrets.json",
    "write",
    "settings.custom-providers.secrets",
  );
}

async function authorizeStoredCredentialsIfNeeded(
  ctx: ServerContext,
  draft: ReturnType<typeof validateCustomProviderDraft>,
): Promise<void> {
  const needsStoredCredentials = (
    (draft.authMode === "apiKey" && draft.apiKey === undefined)
    || draft.headers.some((header) => header.remove !== true && header.value === undefined)
  );
  if (!needsStoredCredentials) return;
  await authorizeRoutePath(
    ctx,
    ctx.paths.PI_CONFIG_DIR,
    "custom-provider-secrets.json",
    "read",
    "settings.custom-providers.network",
  );
}

export const handleCustomProviderSettings: RouteHandler = async (req, res, ctx) => {
  let route: CustomProviderRoute | undefined;
  try {
    route = routeFor(req.url ?? "");
  } catch {
    writeError(res, new CustomProviderInvalidRequestError("url"));
    return true;
  }
  if (!route) return false;
  if (!route.allow.includes(req.method ?? "")) {
    res.writeHead(405, { ...JSON_HEADERS, Allow: route.allow.join(", ") });
    res.end(JSON.stringify({ error: "Method not allowed", code: "method_not_allowed" }));
    return true;
  }

  const service = ctx.customProviderService;
  if (!service) {
    writeJson(res, 503, { error: "Custom providers unavailable", code: "service_unavailable" });
    return true;
  }

  try {
    if (route.kind === "capabilities") {
      writeJson(res, 200, service.capabilities());
      return true;
    }
    if (route.kind === "list" && req.method === "GET") {
      writeJson(res, 200, await service.list(ctx.runtime.modelRuntime));
      return true;
    }
    if (route.kind === "reveal") {
      const body = await parseBody(req);
      if (!isRecord(body) || Object.keys(body).some((key) => key !== "providerId")) {
        throw new CustomProviderInvalidRequestError("providerId");
      }
      const providerId = validateCustomProviderId(body.providerId, "providerId");
      await authorizeRoutePath(
        ctx,
        ctx.paths.PI_CONFIG_DIR,
        "custom-provider-secrets.json",
        "read",
        "settings.custom-providers.reveal",
      );
      writeJson(res, 200, { apiKey: await service.revealApiKey(providerId) });
      return true;
    }
    if (route.kind === "test" || route.kind === "discover") {
      const lifecycle = createRequestLifecycleScope(req, res);
      try {
        const draft = networkDraftInput(await parseBody(req));
        await authorizeStoredCredentialsIfNeeded(ctx, draft);
        const result = route.kind === "test"
          ? await service.testConnection(draft, lifecycle.signal)
          : await service.discoverModels(draft, lifecycle.signal);
        if (!res.destroyed && !res.closed) writeJson(res, 200, result);
        return true;
      } finally {
        lifecycle.dispose();
      }
    }
    if (route.kind === "list" && req.method === "POST") {
      const input = mutationInput(await parseBody(req));
      await authorizeMutationFiles(ctx);
      const snapshot = await service.create(input, ctx.runtime.modelRuntime);
      const payload = JSON.stringify(snapshot);
      scheduleRuntimeSync(ctx);
      res.writeHead(201, JSON_HEADERS);
      res.end(payload);
      return true;
    }

    if (route.kind !== "item") return false;
    let providerId: string;
    try {
      providerId = validateCustomProviderId(decodeURIComponent(route.encodedProviderId), "providerId");
    } catch (error) {
      if (error instanceof URIError) throw new CustomProviderInvalidRequestError("providerId");
      throw error;
    }
    const input = req.method === "PUT"
      ? mutationInput(await parseBody(req))
      : deleteInput(await parseBody(req));
    await authorizeMutationFiles(ctx);
    const snapshot = req.method === "PUT"
      ? await service.update(providerId, input as CustomProviderMutationInput, ctx.runtime.modelRuntime)
      : await service.delete(providerId, input as CustomProviderDeleteInput, ctx.runtime.modelRuntime);
    const payload = JSON.stringify(snapshot);
    scheduleRuntimeSync(ctx);
    res.writeHead(200, JSON_HEADERS);
    res.end(payload);
    return true;
  } catch (error) {
    if (writeServerPermissionError(res, cors, error)) return true;
    if (writePathGuardError(res, cors, error)) return true;
    writeError(res, error);
    return true;
  }
};
