import { describe, expect, it } from "vitest";
import { getDefaultConfig, mergeBotConfig } from "./config.js";

describe("mergeBotConfig (M-CFG-1)", () => {
  it("deep-merges reconnect so sibling defaults survive", () => {
    const defaults = getDefaultConfig();
    const merged = mergeBotConfig(defaults, {
      reconnect: { eventDriven: false },
    } as Partial<ReturnType<typeof getDefaultConfig>>);
    expect(merged.reconnect.eventDriven).toBe(false);
    expect(merged.reconnect.baseMs).toBe(2_000);
    expect(merged.reconnect.maxMs).toBe(60_000);
    expect(merged.reconnect.voiceErrorThreshold).toBe(5);
  });

  it("deep-merges voice without dropping duck defaults", () => {
    const defaults = getDefaultConfig();
    const merged = mergeBotConfig(defaults, {
      voice: { enabled: true, ttsBargeIn: false },
    } as Partial<ReturnType<typeof getDefaultConfig>>);
    expect(merged.voice.enabled).toBe(true);
    expect(merged.voice.ttsBargeIn).toBe(false);
    expect(merged.voice.duckMusicVolume).toBe(defaults.voice.duckMusicVolume);
    expect(merged.voice.karaokeMode).toBe(false);
    expect(merged.voice.watchword).toBe(defaults.voice.watchword);
    expect(merged.voice.mode).toBe("cascaded");
    expect(merged.voice.duplexVoice).toBe("NATF2");
  });

  it("deep-merges duplex fields without dropping cascade defaults", () => {
    const defaults = getDefaultConfig();
    const merged = mergeBotConfig(defaults, {
      voice: { mode: "duplex", duplexUrl: "http://personaplex:8999" },
    } as Partial<ReturnType<typeof getDefaultConfig>>);
    expect(merged.voice.mode).toBe("duplex");
    expect(merged.voice.duplexUrl).toBe("http://personaplex:8999");
    expect(merged.voice.duplexWatch).toBe("gated");
    expect(merged.voice.sttUrl).toBe(defaults.voice.sttUrl);
  });

  it("deep-merges ragClaimCheck", () => {
    const defaults = getDefaultConfig();
    const merged = mergeBotConfig(defaults, {
      ragClaimCheck: { enabled: true, maxClaims: 3 },
    } as Partial<ReturnType<typeof getDefaultConfig>>);
    expect(merged.ragClaimCheck?.enabled).toBe(true);
    expect(merged.ragClaimCheck?.maxClaims).toBe(3);
  });
});
