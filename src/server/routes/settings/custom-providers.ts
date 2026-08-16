import type { ServerResponse } from "node:http";

import type {
  CustomProviderDeleteInput,
  CustomProviderMutationInput,
} from "../../../model-provider/contracts.js";
import { CustomProviderRevisionConflict } from "../../../model-provider/custom-provider-store.js";
import {
  CustomProviderApiKeyUnavailable,
  CustomProviderIdConflict,
  CustomProviderImmutableIdError,
} from "../../../model-provider/custom-provider-service.js";
import { CustomProviderReferenceConflict } from "../../../model-provider/provider-reference-checker.js";
import { parseBody } from "../parse-body.js";
import type { RouteHandler, ServerContext } from "../types.js";
import { cors } from "./common.js";

const JSON_HEADERS = { "Content-Type": "application/json", ...cors };
const ITEM_ROUTE = /^\/api\/custom-providers\/([^/]+)$/;

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mutationInput(value: unknown): CustomProviderMutationInput {
  if (!isRecord(value) || !Number.isSafeInteger(value.expectedRevision) || !isRecord(value.provider)) {
    throw new InvalidCustomProviderRequest();
  }
  return {
    expectedRevision: value.expectedRevision as number,
    provider: value.provider as unknown as CustomProviderMutationInput["provider"],
  };
}

function deleteInput(value: unknown): CustomProviderDeleteInput {
  if (!isRecord(value) || !Number.isSafeInteger(value.expectedRevision)) {
    throw new InvalidCustomProviderRequest();
  }
  return { expectedRevision: value.expectedRevision as number };
}

class InvalidCustomProviderRequest extends Error {}

function writeError(res: ServerResponse, error: unknown): void {
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
  if (error instanceof InvalidCustomProviderRequest) {
    writeJson(res, 400, { error: "Invalid custom provider request", code: "invalid_request" });
    return;
  }
  writeJson(res, 500, { error: "Custom provider request failed", code: "internal_error" });
}

function scheduleRuntimeSync(ctx: ServerContext): void {
  void Promise.resolve()
    .then(() => ctx.runtime.syncModelProviders())
    .catch(() => console.error("[custom-provider] background sync failed"));
}

function handlesRoute(url: string, method: string | undefined): boolean {
  if (url === "/api/custom-providers/capabilities") return method === "GET";
  if (url === "/api/custom-providers/reveal") return method === "POST";
  if (url === "/api/custom-providers") return method === "GET" || method === "POST";
  return ITEM_ROUTE.test(url) && (method === "PUT" || method === "DELETE");
}

export const handleCustomProviderSettings: RouteHandler = async (req, res, ctx) => {
  const url = req.url ?? "";
  if (!handlesRoute(url, req.method)) return false;

  const service = ctx.customProviderService;
  if (!service) {
    writeJson(res, 503, { error: "Custom providers unavailable", code: "service_unavailable" });
    return true;
  }

  try {
    if (url === "/api/custom-providers/capabilities") {
      writeJson(res, 200, service.capabilities());
      return true;
    }
    if (url === "/api/custom-providers" && req.method === "GET") {
      writeJson(res, 200, await service.list(ctx.runtime.modelRuntime));
      return true;
    }
    if (url === "/api/custom-providers/reveal") {
      const body = await parseBody(req);
      if (!isRecord(body) || typeof body.providerId !== "string" || body.providerId.length === 0) {
        throw new InvalidCustomProviderRequest();
      }
      writeJson(res, 200, { apiKey: await service.revealApiKey(body.providerId) });
      return true;
    }
    if (url === "/api/custom-providers" && req.method === "POST") {
      const snapshot = await service.create(mutationInput(await parseBody(req)), ctx.runtime.modelRuntime);
      const payload = JSON.stringify(snapshot);
      scheduleRuntimeSync(ctx);
      res.writeHead(201, JSON_HEADERS);
      res.end(payload);
      return true;
    }

    const match = ITEM_ROUTE.exec(url);
    if (!match) return false;
    const providerId = decodeURIComponent(match[1]);
    const snapshot = req.method === "PUT"
      ? await service.update(providerId, mutationInput(await parseBody(req)), ctx.runtime.modelRuntime)
      : await service.delete(providerId, deleteInput(await parseBody(req)), ctx.runtime.modelRuntime);
    const payload = JSON.stringify(snapshot);
    scheduleRuntimeSync(ctx);
    res.writeHead(200, JSON_HEADERS);
    res.end(payload);
    return true;
  } catch (error) {
    writeError(res, error);
    return true;
  }
};
