import { buildOpenApiDocument } from "../openapi/document.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

/**
 * Public OpenAPI discovery (PR-C2).
 * REST-only contract — no tRPC dual stack.
 */
export const registerOpenApi: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options } = ctx;

  // Cache document once; paths are static. serverUrl is relative for portability.
  const doc = buildOpenApiDocument({
    serverUrl: (options.config.publicUrl ?? "").trim().replace(/\/+$/, "") || "/",
  });

  app.get("/api/openapi.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(doc);
  });
};
