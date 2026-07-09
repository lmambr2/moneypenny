import { describe, expect, it } from "vitest";
import { ttsTimeoutForText } from "./tts.js";

describe("ttsTimeoutForText", () => {
  it("returns base timeout for short text", () => {
    expect(ttsTimeoutForText("hi", 20_000)).toBe(20_000);
  });

  it("scales with longer replies up to the cap", () => {
    expect(ttsTimeoutForText("x".repeat(600), 20_000)).toBe(24_000);
    expect(ttsTimeoutForText("x".repeat(5000), 20_000)).toBe(120_000);
  });
});
