import { describe, expect, it } from "vitest";
import { parseSpokenAskRequest, textForAnnouncement } from "./speak-request.js";

describe("parseSpokenAskRequest", () => {
  it("is silent by default", () => {
    expect(parseSpokenAskRequest("what is a jump point")).toEqual({
      text: "what is a jump point",
      speak: false,
    });
  });

  it("honours -s / --say flag", () => {
    expect(parseSpokenAskRequest("what is a jump point", new Set(["s"]))).toEqual({
      text: "what is a jump point",
      speak: true,
    });
  });

  it("strips leading say / speak", () => {
    expect(parseSpokenAskRequest("say what is a jump point")).toEqual({
      text: "what is a jump point",
      speak: true,
    });
    expect(parseSpokenAskRequest("speak how do I refine")).toEqual({
      text: "how do I refine",
      speak: true,
    });
  });

  it("strips trailing say it / out loud", () => {
    expect(parseSpokenAskRequest("what is a jump point, say it")).toEqual({
      text: "what is a jump point",
      speak: true,
    });
    expect(parseSpokenAskRequest("brief me on docking out loud")).toEqual({
      text: "brief me on docking",
      speak: true,
    });
  });

  it("does not treat a bare 'say' question as a speak request", () => {
    expect(parseSpokenAskRequest("say")).toEqual({ text: "say", speak: false });
  });
});

describe("textForAnnouncement", () => {
  it("strips markdown and URLs", () => {
    expect(textForAnnouncement("**Hello** see https://x.com/y world")).toBe("Hello see world");
  });

  it("caps long answers at a sentence", () => {
    const long = `${"Word. ".repeat(80)}Finale that never ends ${"x".repeat(200)}`;
    const out = textForAnnouncement(long, 80);
    expect(out.endsWith("That's the short version.")).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });
});
