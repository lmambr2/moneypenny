import { describe, expect, it } from "vitest";
import { VoiceFloorController } from "./floor.js";

describe("VoiceFloorController", () => {
  it("lets the player send until Talker speaking steals the floor", () => {
    const floor = new VoiceFloorController();
    expect(floor.playerSends()).toBe(true);
    expect(floor.talkerSends()).toBe(false);
    floor.onTalkerSpeaking(true);
    expect(floor.floor).toBe("duplex-speak");
    expect(floor.playerSends()).toBe(false);
    expect(floor.talkerSends()).toBe(true);
    floor.onTalkerSpeaking(false);
    expect(floor.floor).toBe("music");
    expect(floor.playerSends()).toBe(true);
  });

  it("does not steal a bumper or a Piper ack", () => {
    const floor = new VoiceFloorController();
    floor.set("bumper");
    floor.onTalkerSpeaking(true);
    expect(floor.floor).toBe("bumper");
    expect(floor.playerSends()).toBe(true);
    floor.set("piper-ack");
    floor.onTalkerSpeaking(true);
    expect(floor.floor).toBe("piper-ack");
  });

  it("one floor means one sender", () => {
    const floor = new VoiceFloorController();
    for (const name of ["music", "piper-ack", "bumper", "silence"] as const) {
      floor.set(name);
      expect(floor.playerSends()).toBe(true);
      expect(floor.talkerSends()).toBe(false);
    }
    floor.set("duplex-speak");
    expect(floor.playerSends()).toBe(false);
    expect(floor.talkerSends()).toBe(true);
  });
});
