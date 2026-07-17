import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, listOperationKeys } from "./document.js";
import { API_OPERATIONS, operationKey } from "./operations.js";

describe("OpenAPI document (PR-C2)", () => {
  it("is OpenAPI 3 with required top-level fields", () => {
    const doc = buildOpenApiDocument();
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info).toMatchObject({ title: expect.any(String), version: expect.any(String) });
    expect(doc.paths).toBeTypeOf("object");
    expect(doc.components).toBeTypeOf("object");
  });

  it("lists health and openapi discovery as public", () => {
    const keys = listOperationKeys();
    expect(keys).toContain("GET /api/health");
    expect(keys).toContain("GET /api/openapi.json");
    expect(keys).toContain("POST /api/session/login");
    expect(keys).toContain("POST /api/player/{botId}/play");
  });

  it("has unique method+path keys", () => {
    const keys = API_OPERATIONS.map(operationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers major domain prefixes", () => {
    const paths = API_OPERATIONS.map((o) => o.path);
    for (const prefix of [
      "/api/session/",
      "/api/player/",
      "/api/bot",
      "/api/music/",
      "/api/rag/",
      "/api/economy/",
      "/api/users",
      "/api/audit",
    ]) {
      expect(
        paths.some((p) => p === prefix || p.startsWith(prefix)),
        `missing prefix ${prefix}`,
      ).toBe(true);
    }
  });

  it("embeds paths into the OpenAPI paths object", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths["/api/health"]?.get).toBeDefined();
    expect(doc.paths["/api/openapi.json"]?.get).toBeDefined();
    expect(doc.paths["/api/player/{botId}/play"]?.post).toBeDefined();
    const play = doc.paths["/api/player/{botId}/play"].post as { security?: unknown };
    expect(play.security).toBeDefined();
  });

  it("documents cookie security scheme (not dual tRPC stack)", () => {
    const doc = buildOpenApiDocument() as {
      components: { securitySchemes: Record<string, unknown> };
      info: { description: string };
    };
    expect(doc.components.securitySchemes.cookieAuth).toBeDefined();
    expect(doc.info.description.toLowerCase()).toContain("not dual");
    expect(doc.info.description.toLowerCase()).toContain("mcp");
  });

  it("catalog has a meaningful number of operations", () => {
    // Guard against accidental wipe of the catalog.
    expect(API_OPERATIONS.length).toBeGreaterThanOrEqual(80);
  });
});
