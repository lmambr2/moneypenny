import { describe, expect, it } from "vitest";
import { ALL_DOMAIN_BUNDLES, NEST_DOMAIN_BUNDLES } from "./domain-bundles.js";

describe("Nest domain modules (PR-C3)", () => {
  it("maps one bundle per product surface (Express plugins path)", () => {
    const names = new Set(ALL_DOMAIN_BUNDLES.map((b) => b.name));
    for (const required of [
      "system",
      "mcp",
      "session",
      "brain",
      "station-api",
      "spa",
      "websocket",
    ]) {
      expect(names.has(required), required).toBe(true);
    }
  });

  it("Nest path uses system-nest (controllers own health/OpenAPI)", () => {
    const names = NEST_DOMAIN_BUNDLES.map((b) => b.name);
    expect(names).toContain("system-nest");
    expect(names).not.toContain("system");
    expect(names).toEqual(
      expect.arrayContaining([
        "system-nest",
        "mcp",
        "session",
        "brain",
        "station-api",
        "spa",
        "websocket",
      ]),
    );
  });

  it("has unique order values on both compositions", () => {
    for (const bundles of [ALL_DOMAIN_BUNDLES, NEST_DOMAIN_BUNDLES]) {
      const orders = bundles.map((b) => b.order);
      expect(new Set(orders).size).toBe(orders.length);
    }
  });
});
