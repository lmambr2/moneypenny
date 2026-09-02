import { describe, expect, it } from "vitest";
import { applySpeakLexicon, WHISPER_INITIAL_PROMPT } from "./org-lexicon.js";

describe("org lexicon", () => {
  it("includes org hotwords for Whisper", () => {
    expect(WHISPER_INITIAL_PROMPT).toMatch(/Moneypenny/);
    expect(WHISPER_INITIAL_PROMPT).toMatch(/INTSUM/);
    expect(WHISPER_INITIAL_PROMPT).toMatch(/600i/);
  });

  it("does not expand substrings inside other words", () => {
    expect(applySpeakLexicon("The color of the coat.")).toBe("The color of the coat.");
  });
});
