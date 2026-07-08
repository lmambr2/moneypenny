import { describe, expect, it } from "vitest";
import { isMusicSearchRouteText, voiceRouteNeedsPendingAck } from "./music-command.js";

describe("music voice commands", () => {
  it("detects play/search route text", () => {
    expect(isMusicSearchRouteText("play toto africa")).toBe(true);
    expect(isMusicSearchRouteText("pause")).toBe(false);
    expect(isMusicSearchRouteText("skip")).toBe(false);
  });

  it("requests pending ack for deterministic play", async () => {
    const decision = {
      type: "deterministic" as const,
      command: { name: "play", args: "toto africa", rawArgs: ["toto", "africa"], flags: new Set<string>() },
    };
    expect(voiceRouteNeedsPendingAck(decision, "play toto africa")).toBe(true);
  });

  it("does not request pending ack for transport", async () => {
    const decision = {
      type: "deterministic" as const,
      command: { name: "pause", args: "", rawArgs: [], flags: new Set<string>() },
    };
    expect(voiceRouteNeedsPendingAck(decision, "pause")).toBe(false);
  });
});