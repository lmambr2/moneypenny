import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Smoke: plugin composition order is intentional (auth before protected bodies, SPA last).
 */
describe("http app plugin wiring", () => {
  it("registers plugins in security → public → mcp → session → api → spa → ws order", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "app.ts"), "utf8");
    // Only the PLUGINS array (imports mention the same symbols earlier).
    const arrayStart = src.indexOf("const PLUGINS");
    expect(arrayStart).toBeGreaterThanOrEqual(0);
    const arrayEnd = src.indexOf("];", arrayStart);
    const block = src.slice(arrayStart, arrayEnd);
    const order = [
      "registerSecurity",
      "registerPublicRoutes",
      "registerOpenApi",
      "registerMcp",
      "registerSession",
      "registerProtectedApi",
      "registerStaticSpa",
      "registerWebSocket",
    ];
    let last = -1;
    for (const name of order) {
      const idx = block.indexOf(name);
      expect(idx, name).toBeGreaterThan(last);
      last = idx;
    }
  });
});
