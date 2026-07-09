import { describe, expect, it } from "vitest";
import { extractAssistantText } from "./client.js";

describe("extractAssistantText", () => {
  it("prefers content when present", () => {
    expect(
      extractAssistantText({
        content: "Stay sharp on formation arrivals.",
        reasoning: "* thinking about doctrine...",
      }),
    ).toBe("Stay sharp on formation arrivals.");
  });

  it("salvages a spoken line from reasoning when content is empty (Gemma-4)", () => {
    const reasoning = `*   Role: Radio announcer.
*   Constraint: under 75 words.
*   Drafting...
Heavies establish the perimeter before the larger ships jump.`;
    expect(extractAssistantText({ content: "", reasoning })).toBe(
      "Heavies establish the perimeter before the larger ships jump.",
    );
  });

  it("returns empty when nothing usable", () => {
    expect(extractAssistantText({ content: null, reasoning: "* only bullets\n* more" })).toBe("");
  });
});
