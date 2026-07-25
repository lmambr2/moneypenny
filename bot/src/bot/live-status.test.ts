import { describe, expect, it } from "vitest";
import { PlayQueue } from "../audio/queue.js";
import { getDefaultConfig } from "../data/config.js";
import { buildLiveStatus } from "./live-status.js";

describe("buildLiveStatus", () => {
  it("reports offline TS and empty queue feedback", () => {
    const queue = new PlayQueue();
    const snap = buildLiveStatus({
      connected: false,
      name: "test-bot",
      config: getDefaultConfig(),
      queue,
      radio: { status: () => ({ songsUntilBumper: null, cuePending: false }) },
    });
    expect(snap.connected).toBe(false);
    expect(snap.feedback.some((l) => /offline/i.test(l))).toBe(true);
    expect(snap.feedback.some((l) => /Queue empty/i.test(l))).toBe(true);
  });
});
