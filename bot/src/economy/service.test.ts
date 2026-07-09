import { describe, it, expect } from "vitest";
import { handleEconomyCommand } from "./service.js";
import { UexClient } from "./uex.js";

describe("handleEconomyCommand", () => {
  it("mine / refine / craft return formatted orders", async () => {
    const mine = await handleEconomyCommand("mine", "stileron scu:16");
    expect(mine).toContain("Mine order");
    expect(mine).toContain("Stileron");

    const refine = await handleEconomyCommand("refine", "bex scu:8 method:cormack");
    expect(refine).toContain("Refine order");
    expect(refine).toContain("Cormack");

    const craft = await handleEconomyCommand("craft", "frame qty:1");
    expect(craft).toContain("Craft order");
    expect(craft).toContain("Bill of materials");
  });

  it("econ lists ores and methods", async () => {
    const ores = await handleEconomyCommand("econ", "ores");
    expect(ores).toContain("quantainium");
    const methods = await handleEconomyCommand("econ", "methods");
    expect(methods).toContain("dinyx");
  });

  it("econ prices uses injected UEX client", async () => {
    const uex = new UexClient({
      enabled: true,
      fetchCommodities: async () => [
        {
          id: 1,
          name: "Bexalite",
          code: "BEXA",
          is_raw: 0,
          price_sell: 28000,
          price_buy: 20000,
        },
      ],
    });
    const out = await handleEconomyCommand("econ", "prices bexalite", "!", uex);
    expect(out).toContain("28,000");
    expect(out).toMatch(/UEX/i);
  });

  it("econ prices soft-fails when disabled", async () => {
    const uex = new UexClient({ enabled: false });
    const out = await handleEconomyCommand("econ", "prices bex", "!", uex);
    expect(out).toMatch(/disabled/i);
  });
});
