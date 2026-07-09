import { describe, expect, it } from "vitest";
import { decideHarnessTool } from "./tool-policy.js";

describe("decideHarnessTool", () => {
  it("allows safe tools by default", () => {
    expect(decideHarnessTool("play_music")).toEqual({ action: "execute" });
    expect(decideHarnessTool("skip")).toEqual({ action: "execute" });
  });

  it("blocks stop/vol by default", () => {
    const d = decideHarnessTool("stop");
    expect(d.action).toBe("block");
    if (d.action === "block") expect(d.reason).toMatch(/safety policy/i);
  });

  it("dryRun never executes", () => {
    expect(decideHarnessTool("play_music", { dryRun: true })).toEqual({ action: "dry_run" });
    expect(decideHarnessTool("stop", { dryRun: true })).toEqual({ action: "dry_run" });
  });

  it("allowDangerous permits stop", () => {
    expect(decideHarnessTool("stop", { allowDangerous: true })).toEqual({ action: "execute" });
  });
});
