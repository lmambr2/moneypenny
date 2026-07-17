import { createRequire } from "node:module";
import { dirname } from "node:path";
import express from "express";
import { buildOpenApiDocument } from "../openapi/document.js";
import type { HttpAppContext, HttpPlugin } from "../types.js";

const require = createRequire(import.meta.url);

function swaggerUiAssetDir(): string | null {
  try {
    return dirname(require.resolve("swagger-ui-dist/package.json"));
  } catch {
    return null;
  }
}

function sendDocsHtml(_req: express.Request, res: express.Response): void {
  res.type("html").send(docsHtml());
}

function sendDocsMissing(_req: express.Request, res: express.Response): void {
  res.status(503).type("html").send(
    `<!doctype html><meta charset="utf-8"><title>API docs</title>
     <p>Install <code>swagger-ui-dist</code> or open
     <a href="/api/openapi.json">/api/openapi.json</a>.</p>`,
  );
}

/**
 * Public OpenAPI discovery (PR-C2) + interactive docs UI.
 * REST-only contract — no tRPC dual stack.
 */
export const registerOpenApi: HttpPlugin = (ctx: HttpAppContext) => {
  const { app, options, logger } = ctx;

  const doc = buildOpenApiDocument({
    serverUrl: (options.config.publicUrl ?? "").trim().replace(/\/+$/, "") || "/",
  });

  app.get("/api/openapi.json", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(doc);
  });

  // Interactive UI (Swagger UI). Assets from swagger-ui-dist; offline-capable once installed.
  const assetDir = swaggerUiAssetDir();
  if (assetDir) {
    app.use("/api/docs/static", express.static(assetDir, { maxAge: "1d", index: false }));
    app.get("/api/docs", sendDocsHtml);
    app.get("/api/docs/", sendDocsHtml);
  } else {
    logger.warn("swagger-ui-dist not installed — /api/docs disabled (JSON still at /api/openapi.json)");
    app.get("/api/docs", sendDocsMissing);
    app.get("/api/docs/", sendDocsMissing);
  }
};

function docsHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Moneypenny API</title>
  <link rel="stylesheet" href="/api/docs/static/swagger-ui.css" />
  <style>
    body { margin: 0; background: #1b1b1b; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/docs/static/swagger-ui-bundle.js"></script>
  <script src="/api/docs/static/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: "/api/openapi.json",
      dom_id: "#swagger-ui",
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: "StandaloneLayout",
      tryItOutEnabled: true,
      persistAuthorization: true,
    });
  </script>
</body>
</html>`;
}