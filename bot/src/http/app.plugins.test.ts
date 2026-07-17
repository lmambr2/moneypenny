import { describe, expect, it } from "vitest";
import { orderedHttpPlugins } from "./app.js";
import { ALL_DOMAIN_BUNDLES } from "./nest/domain-bundles.js";

/**
 * Smoke: domain bundles compose plugins in security → … → ws order.
 */
describe("http app plugin wiring", () => {
  it("orders domain bundles by ascending order field", () => {
    const sorted = [...ALL_DOMAIN_BUNDLES].sort((a, b) => a.order - b.order);
    const names = sorted.map((b) => b.name);
    expect(names).toEqual([
      "system",
      "mcp",
      "session",
      "brain",
      "station-api",
      "spa",
      "websocket",
    ]);
  });

  it("flattened plugin list is non-empty and stable length", () => {
    const plugins = orderedHttpPlugins();
    expect(plugins.length).toBeGreaterThanOrEqual(7);
    // Same plugins as sum of bundles
    const expected = ALL_DOMAIN_BUNDLES.reduce((n, b) => n + b.plugins.length, 0);
    expect(plugins.length).toBe(expected);
  });
});
