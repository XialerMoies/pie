import { guardPathWithinRoot } from "./routes/path-guard.js";
import { extname } from "path";

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentTypeForStaticAsset(filePath: string): string {
  return STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function resolveStaticAssetPath(root: string, requestPath: string): string {
  const relativePath = requestPath.replace(/^[\\/]+/, "");
  return guardPathWithinRoot(root, relativePath, "read").path;
}
