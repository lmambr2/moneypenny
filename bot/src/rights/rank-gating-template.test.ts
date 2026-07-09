import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PUBLIC_COMMANDS } from "../bot/commands.js";
import { isRightsConfig } from "./index.js";

/**
 * Public commands deliberately NOT in the template's defaultAllow — granted
 * through a command group instead. Anything else missing is drift (the class
 * of bug that broke !chevron7 and !playnext).
 */
const GROUP_GRANTED = new Set([
  "analyst",
  "agent",
  "intsum",
  "aar", // @analyst
  "generate", // @dj (ACE-Step)
]);

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

  it("defaultAllow covers every public command (minus group-granted ones)", () => {
    const allowed = new Set(config.defaultAllow as string[]);
    const missing = [...PUBLIC_COMMANDS].filter((c) => !allowed.has(c) && !GROUP_GRANTED.has(c));
    expect(missing).toEqual([]);
  });

  it("defaultAllow lists no unknown commands (stale entries)", () => {
    const stale = (config.defaultAllow as string[]).filter(
      (c) => !PUBLIC_COMMANDS.has(c) && !GROUP_GRANTED.has(c),
    );
    expect(stale).toEqual([]);
  });
});
