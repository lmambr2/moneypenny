import { describe, expect, it } from "vitest";
import { parseEconomyArgs } from "./parse.js";

describe("parseEconomyArgs", () => {
  it("parses subject + scu + method flags", () => {
    const p = parseEconomyArgs("quantainium scu:32 method:dinyx");
    expect(p.subject).toBe("quantainium");
    expect(p.scu).toBe(32);
    expect(p.method).toBe("dinyx");
  });

  it("parses multi-word subject before flags", () => {
    const p = parseEconomyArgs("quantum drive core qty:3");
    expect(p.subject).toBe("quantum drive core");
    expect(p.qty).toBe(3);
  });

  it("accepts m: as method alias", () => {
    const p = parseEconomyArgs("bex m:ferron scu:16");
    expect(p.subject).toBe("bex");
    expect(p.method).toBe("ferron");
    expect(p.scu).toBe(16);
  });
});
