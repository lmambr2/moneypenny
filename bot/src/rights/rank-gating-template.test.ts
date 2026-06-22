import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRightsConfig } from "./index.js";

/** Starter template must stay aligned with PUBLIC_COMMANDS the bot documents as public. */
describe("scripts/rights-rank-gating.json", () => {
  const path = fileURLToPath(new URL("../../../scripts/rights-rank-gating.json", import.meta.url));
  const config = JSON.parse(readFileSync(path, "utf-8"));

  it("is valid RightsConfig JSON", () => {
    expect(isRightsConfig(config)).toBe(true);
  });

  it("allows !test for everyone (demo track smoke command)", () => {
    expect(config.defaultAllow).toContain("test");
  });
});