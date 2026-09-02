import { describe, expect, it } from "vitest";
import { matchVoiceMediaCommand } from "./media-router.js";

describe("matchVoiceMediaCommand", () => {
  it("matches skip/next/pause/resume/stop without an LLM pass", () => {
    expect(matchVoiceMediaCommand("skip")?.name).toBe("skip");
    expect(matchVoiceMediaCommand("please skip")?.name).toBe("skip");
    expect(matchVoiceMediaCommand("can you skip this song")?.name).toBe("skip");
    expect(matchVoiceMediaCommand("next")?.name).toBe("next");
    expect(matchVoiceMediaCommand("Pause.")?.name).toBe("pause");
    expect(matchVoiceMediaCommand("please pause the music")?.name).toBe("pause");
    expect(matchVoiceMediaCommand("resume")?.name).toBe("resume");
    expect(matchVoiceMediaCommand("stop the music")?.name).toBe("stop");
  });

  it("maps spoken volume to !vol", () => {
    expect(matchVoiceMediaCommand("volume 40")).toEqual({
      name: "vol",
      args: "40",
      rawArgs: ["40"],
      flags: new Set(),
    });
    expect(matchVoiceMediaCommand("set the volume to 12")?.name).toBe("vol");
    expect(matchVoiceMediaCommand("set the volume to 12")?.args).toBe("12");
  });

  it("does not steal fuzzy play or questions", () => {
    expect(matchVoiceMediaCommand("play something chill")).toMatchObject({
      name: "play",
      args: "something chill",
    });
    expect(matchVoiceMediaCommand("what is a jump point")).toBeNull();
    expect(matchVoiceMediaCommand("ask what is INTSUM")).toBeNull();
  });
});
