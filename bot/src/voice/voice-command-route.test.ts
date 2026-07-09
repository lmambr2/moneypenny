/**
 * In-repo substitute for V-live: real watchword + command shape path
 * (voiceCommandShapeOk / parse) used under music with soft duck defaults.
 */
import { describe, expect, it } from "vitest";
import { resolveSttModelSelection } from "./stt-models.js";
import { defaultVoiceConfig } from "./types.js";
import { voiceCommandShapeOk } from "./watchword.js";

describe("V-live substitute: voice command routing + duck defaults", () => {
  it("accepts play <title> and pause/skip transport verbs", () => {
    expect(voiceCommandShapeOk("play", "toto africa")).toBe(true);
    expect(voiceCommandShapeOk("pause", "")).toBe(true);
    expect(voiceCommandShapeOk("skip", "")).toBe(true);
    // bare play is shape-ok; session silence-tail rejects bare play for routing
    expect(voiceCommandShapeOk("play", "")).toBe(true);
  });

  it("soft duck default is 20 not near-mute 2", () => {
    const v = defaultVoiceConfig();
    expect(v.duckMusicOnSpeech).toBe(true);
    expect(v.duckMusicVolume).toBe(20);
  });

  it("SBC STT selection stays base + int8 RKNN", () => {
    const s = resolveSttModelSelection({ edition: "sbc" });
    expect(s.model).toBe("base");
    expect(s.quant).toBe("int8");
    expect(s.backend).toBe("rknn");
  });
});
