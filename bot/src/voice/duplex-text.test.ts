import { describe, expect, it } from "vitest";
import { acceptUserAsr, userTextFromAgentMonologue } from "./duplex-text.js";

describe("duplex text split", () => {
  it("never treats Talker 0x02 as a user command, even if it says skip", () => {
    expect(userTextFromAgentMonologue("skip")).toBeNull();
    expect(userTextFromAgentMonologue("play the fleet anthem")).toBeNull();
  });

  it("keeps Whisper text", () => {
    expect(acceptUserAsr("  skip  ")).toBe("skip");
    expect(acceptUserAsr("   ")).toBe("");
  });
});
