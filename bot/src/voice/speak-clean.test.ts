import { describe, expect, it } from "vitest";
import {
  splitCompleteSentences,
  splitSpokenSentences,
  stripMarkdownForSpeech,
  textToSpoken,
} from "./speak-clean.js";

describe("stripMarkdownForSpeech", () => {
  it("strips bold, bullets, fences, and the Sources footer", () => {
    const raw = [
      "**Hold** the line.",
      "",
      "- item one",
      "```js",
      "code()",
      "```",
      "",
      "📎 Sources: combat-doctrine.md, hangar.md",
    ].join("\n");
    expect(stripMarkdownForSpeech(raw)).toBe("Hold the line. item one");
  });

  it("flattens markdown links and URLs", () => {
    expect(stripMarkdownForSpeech("See [docs](https://x.test/a) https://y.test/b now")).toBe(
      "See docs now",
    );
  });
});

describe("textToSpoken", () => {
  it("expands 600i, INTSUM, and ranks", () => {
    expect(textToSpoken("The 600i holds the INTSUM for COL Beaumont.")).toBe(
      "The six-hundred-i holds the int-sum for Colonel Beaumont.",
    );
  });
});

describe("splitCompleteSentences", () => {
  it("emits finished sentences and keeps a fragment", () => {
    const { sentences, rest } = splitCompleteSentences("On it. Still working");
    expect(sentences).toEqual(["On it."]);
    expect(rest).toBe("Still working");
  });
});

describe("splitSpokenSentences", () => {
  it("flushes leftover without terminal punctuation", () => {
    expect(splitSpokenSentences("Hold the line")).toEqual(["Hold the line"]);
  });
});
