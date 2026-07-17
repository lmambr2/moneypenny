import { describe, expect, it } from "vitest";
import { VoiceTransportHealth } from "./voice-transport-health.js";

describe("VoiceTransportHealth", () => {
  it("does not trip on a single error", () => {
    const now = 1_000;
    const h = new VoiceTransportHealth({
      threshold: 5,
      windowMs: 30_000,
      now: () => now,
    });
    expect(h.noteError()).toBe(false);
  });

  it("trips once at threshold within window", () => {
    let now = 1_000;
    const h = new VoiceTransportHealth({
      threshold: 5,
      windowMs: 30_000,
      now: () => now,
    });
    expect(h.noteError()).toBe(false);
    now += 100;
    expect(h.noteError()).toBe(false);
    now += 100;
    expect(h.noteError()).toBe(false);
    now += 100;
    expect(h.noteError()).toBe(false);
    now += 100;
    expect(h.noteError()).toBe(true);
    // latch — further errors do not re-trip until clear
    now += 100;
    expect(h.noteError()).toBe(false);
  });

  it("does not count errors outside the window", () => {
    let now = 1_000;
    const h = new VoiceTransportHealth({
      threshold: 3,
      windowMs: 1_000,
      now: () => now,
    });
    h.noteError();
    h.noteError();
    now += 5_000;
    expect(h.noteError()).toBe(false); // only 1 in window
    now += 10;
    expect(h.noteError()).toBe(false);
    now += 10;
    expect(h.noteError()).toBe(true);
  });

  it("healthy streak clears latch after success", () => {
    let now = 1_000;
    const h = new VoiceTransportHealth({
      threshold: 2,
      windowMs: 30_000,
      healthyReset: 3,
      now: () => now,
    });
    h.noteError();
    expect(h.noteError()).toBe(true);
    h.noteSuccess();
    h.noteSuccess();
    h.noteSuccess();
    now += 10;
    h.noteError();
    expect(h.noteError()).toBe(true);
  });
});
