import { describe, expect, it } from "vitest";
import { SpeechQueue } from "./speech-queue.js";

describe("SpeechQueue", () => {
  it("serializes jobs", async () => {
    const q = new SpeechQueue();
    const order: number[] = [];
    const p1 = q.play(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 20));
      order.push(2);
    });
    const p2 = q.play(async () => {
      order.push(3);
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("interrupt aborts the current job", async () => {
    const q = new SpeechQueue();
    let sawAbort = false;
    let resolveStarted!: () => void;
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });
    const p = q.play(async (signal) => {
      resolveStarted();
      if (signal.aborted) {
        sawAbort = true;
        return;
      }
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            resolve();
          },
          { once: true },
        );
      });
    });
    await started;
    expect(q.isSpeaking).toBe(true);
    q.interrupt();
    await p;
    expect(sawAbort).toBe(true);
    expect(q.isSpeaking).toBe(false);
  });

  it("interrupt with no job is a no-op", () => {
    const q = new SpeechQueue();
    expect(() => q.interrupt()).not.toThrow();
  });
});
