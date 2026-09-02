import { describe, expect, it, vi } from "vitest";
import { TtsAckCache } from "./ack-cache.js";

describe("TtsAckCache", () => {
  it("serves warmed phrases without a second synthesize", async () => {
    const synthesize = vi.fn(async (text: string) => ({
      audio: Buffer.from(text),
      format: "wav",
    }));
    const cache = new TtsAckCache();
    await cache.warm({ synthesize });
    expect(synthesize).toHaveBeenCalled();
    synthesize.mockClear();
    const hit = cache.get("Paused.");
    expect(hit?.audio.toString()).toBe("Paused.");
    const again = await cache.speakOrSynthesize("paused");
    expect(again?.audio.toString()).toBe("Paused.");
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("synthesizes on miss and remembers", async () => {
    const synthesize = vi.fn(async () => ({ audio: Buffer.from("x"), format: "wav" }));
    const cache = new TtsAckCache();
    cache.attach({ synthesize });
    const first = await cache.speakOrSynthesize("On it.");
    const second = await cache.speakOrSynthesize("On it.");
    expect(first?.audio).toBe(second?.audio);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});
