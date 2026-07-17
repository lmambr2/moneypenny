import { SESSION_COOKIE_NAME } from "../../web/auth/validateSession.js";
import { API_OPERATIONS, type ApiOperation, type AuthLevel } from "./operations.js";

const OPENAPI_VERSION = "3.0.3";
const API_VERSION = "0.1.0";

function securityFor(auth: AuthLevel): Record<string, string[]>[] | undefined {
  if (auth === "public") return undefined;
  return [{ cookieAuth: [] }];
}

function pathItemFor(ops: ApiOperation[]): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (const op of ops) {
    const operation: Record<string, unknown> = {
      operationId: `${op.method}_${op.path.replace(/[{}/]/g, "_").replace(/_+/g, "_")}`,
      summary: op.summary,
      tags: op.tags,
      parameters: pathParams(op.path),
      responses: {
        "200": { description: "Success (shape varies by endpoint)" },
        "400": { description: "Validation error" },
        "401": { description: "Unauthenticated" },
        "403": { description: "Forbidden (admin or rights)" },
      },
    };
    const sec = securityFor(op.auth);
    if (sec) {
      operation.security = sec;
      if (op.auth === "admin") {
        operation["x-moneypenny-auth"] = "admin";
      } else {
        operation["x-moneypenny-auth"] = "session";
      }
    } else {
      operation["x-moneypenny-auth"] = "public";
    }
    if (op.body) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: op.body },
        },
      };
    }
    item[op.method] = operation;
  }
  return item;
}

function pathParams(path: string): Record<string, unknown>[] {
  const params: Record<string, unknown>[] = [];
  for (const m of path.matchAll(/\{([a-zA-Z]+)\}/g)) {
    params.push({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    });
  }
  return params;
}

/** Build OpenAPI 3 document from {@link API_OPERATIONS}. */
export function buildOpenApiDocument(opts?: { serverUrl?: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of API_OPERATIONS) {
    if (!paths[op.path]) paths[op.path] = {};
    Object.assign(paths[op.path], pathItemFor([op]));
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Moneypenny station HTTP API",
      version: API_VERSION,
      description: [
        "Cookie-session REST API for the Vue WebUI and operators.",
        "",
        "**Not dual-stacked:** this is the only HTTP application API (PR-C2).",
        "MCP agents use a separate Bearer-token surface at `/mcp` when enabled",
        "(see docs/mcp-server.md) — not listed here as session routes.",
        "",
        "WebSocket player events: `GET /ws` (session cookie + Origin check).",
        "",
        "CSRF: mutating `/api/*` requests require a same-origin `Origin`/`Referer`.",
      ].join("\n"),
    },
    servers: [{ url: opts?.serverUrl ?? "/", description: "Station bind (often http://127.0.0.1:3000)" }],
    tags: [
      { name: "system", description: "Health and discovery" },
      { name: "session", description: "Login / setup / me" },
      { name: "auth", description: "External provider auth status" },
      { name: "player", description: "Playback control" },
      { name: "bot", description: "Bot instances and admin settings" },
      { name: "music", description: "Library, search, tags" },
      { name: "rag", description: "Doctrine / retrieval (admin)" },
      { name: "economy", description: "Star Citizen economy tools" },
      { name: "users", description: "User admin" },
      { name: "audit", description: "Audit log" },
      { name: "brain", description: "Phase D turn API (brain proposes / bot disposes)" },
    ],
    paths,
    components: {
      securitySchemes: {
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: SESSION_COOKIE_NAME,
          description: "HttpOnly session cookie set by POST /api/session/login",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
          required: ["error"],
        },
        Health: {
          type: "object",
          properties: {
            status: { type: "string", example: "ok" },
            version: { type: "string" },
          },
        },
      },
    },
  };
}

/** Serialize OpenAPI document to JSON string (stable key order not required). */
export function openApiJson(opts?: { serverUrl?: string }): string {
  return JSON.stringify(buildOpenApiDocument(opts));
}

export function listOperationKeys(): string[] {
  return API_OPERATIONS.map((o) => `${o.method.toUpperCase()} ${o.path}`);
}
