import { createRequire } from "node:module";
import { dirname } from "node:path";
import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { buildOpenApiDocument } from "../../openapi/document.js";
import type { WebServerOptions } from "../../types.js";
import { WEB_OPTIONS } from "../tokens.js";

const require = createRequire(import.meta.url);

/**
 * Nest controllers for public system routes (PR-C3 follow-up).
 * Health / OpenAPI JSON / docs HTML — no session required.
 */
@Controller()
export class SystemController {
  constructor(@Inject(WEB_OPTIONS) private readonly options: WebServerOptions) {}

  @Get("api/health")
  health() {
    return { status: "ok", version: "0.1.0" };
  }

  @Get("api/config/public-url")
  publicUrl() {
    const raw = (this.options.config.publicUrl ?? "").trim();
    return { publicUrl: raw ? raw.replace(/\/+$/, "") : null };
  }

  @Get("api/openapi.json")
  @Header("Cache-Control", "public, max-age=60")
  openapiJson() {
    return buildOpenApiDocument({
      serverUrl: (this.options.config.publicUrl ?? "").trim().replace(/\/+$/, "") || "/",
    });
  }

  @Get(["api/docs", "api/docs/"])
  docsHtml(@Res() res: Response) {
    try {
      dirname(require.resolve("swagger-ui-dist/package.json"));
      res.type("html").send(docsHtmlPage());
    } catch {
      res
        .status(503)
        .type("html")
        .send(
          `<!doctype html><meta charset="utf-8"><title>API docs</title>
         <p>Install <code>swagger-ui-dist</code> or open
         <a href="/api/openapi.json">/api/openapi.json</a>.</p>`,
        );
    }
  }
}

function docsHtmlPage(): string {
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
