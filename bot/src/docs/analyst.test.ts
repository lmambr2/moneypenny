import { describe, expect, it } from "vitest";
import { analystSavePath, parseAnalystCommand } from "./analyst.js";

describe("parseAnalystCommand", () => {
  it("parses task without flags", () => {
    const p = parseAnalystCommand({ args: "summarise fleet doctrine", flags: new Set() });
    expect(p).toEqual({
      task: "summarise fleet doctrine",
      save: false,
      classification: "restricted",
    });
  });

  it("parses -s and class: flags", () => {
    const p = parseAnalystCommand({
      args: "class:secret draft op brief for TF18",
      flags: new Set(["s"]),
    });
    expect(p).toMatchObject({
      save: true,
      classification: "secret",
      task: "draft op brief for TF18",
    });
  });

  it("errors on empty args", () => {
    expect(parseAnalystCommand({ args: "", flags: new Set() })).toHaveProperty("error");
  });
});

describe("analystSavePath", () => {
  it("uses reports/analyst-YYYY-MM-DD.md", () => {
    expect(analystSavePath(new Date("2026-06-22T12:00:00Z"))).toBe("reports/analyst-2026-06-22.md");
  });
});
