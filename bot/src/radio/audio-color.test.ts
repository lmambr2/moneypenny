import { describe, expect, it } from "vitest";
import { AUDIO_COLOR_PRESETS, audioColorFilter, parseAudioColorPreset } from "./audio-color.js";

describe("parseAudioColorPreset", () => {
  it("accepts known presets and aliases", () => {
    expect(parseAudioColorPreset("am")).toBe("am");
    expect(parseAudioColorPreset("AM-RADIO")).toBe("am");
    expect(parseAudioColorPreset("phone")).toBe("telephone");
    expect(parseAudioColorPreset("lo-fi")).toBe("lofi");
    expect(parseAudioColorPreset("off")).toBe("off");
    expect(parseAudioColorPreset("")).toBe("off");
    expect(parseAudioColorPreset("nope")).toBe("off");
  });
});

describe("audioColorFilter", () => {
  it("returns null for off", () => {
    expect(audioColorFilter("off")).toBeNull();
    expect(audioColorFilter(undefined)).toBeNull();
  });

  it("returns a non-empty -af chain for every non-off preset", () => {
    for (const p of AUDIO_COLOR_PRESETS) {
      if (p === "off") continue;
      const f = audioColorFilter(p);
      expect(f, p).toBeTruthy();
      expect(f!).toContain("highpass");
      expect(f!).toContain("lowpass");
      // Safe for argv — no spaces that break unquoted filter graphs oddly; commas ok
      expect(f!).not.toMatch(/[\n\r]/);
    }
  });

  it("AM is narrower than FM (lower lowpass cutoff in the string)", () => {
    const am = audioColorFilter("am")!;
    const fm = audioColorFilter("fm")!;
    const amLp = Number(am.match(/lowpass=f=(\d+)/)?.[1]);
    const fmLp = Number(fm.match(/lowpass=f=(\d+)/)?.[1]);
    expect(amLp).toBeLessThan(fmLp);
    expect(amLp).toBeLessThanOrEqual(5000);
  });
});
