import { describe, expect, it } from "vitest";
import { ALL_DOMAIN_BUNDLES } from "./domain-bundles.js";

describe("Nest domain modules (PR-C3)", () => {
  it("maps one bundle per product surface", () => {
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

  it("has unique order values", () => {
    const orders = ALL_DOMAIN_BUNDLES.map((b) => b.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
