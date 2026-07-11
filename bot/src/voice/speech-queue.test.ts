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

  it("interrupt aborts the running job, not the newest enqueued", async () => {
    const q = new SpeechQueue();
    let aAborted = false;
    let bRan = false;
    let bSawAbortedAtStart = false;
    let resolveAStarted!: () => void;
    const aStarted = new Promise<void>((r) => {
      resolveAStarted = r;
    });
    const pa = q.play(async (signal) => {
      resolveAStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aAborted = true;
            resolve();
          },
          { once: true },
        );
      });
    });
    const pb = q.play(async (signal) => {
      bRan = true;
      bSawAbortedAtStart = signal.aborted;
    });
    await aStarted;
    q.interrupt();
    await Promise.all([pa, pb]);
    expect(aAborted).toBe(true);
    expect(bRan).toBe(true);
    expect(bSawAbortedAtStart).toBe(false);
  });

  it("propagates an already-aborted external signal to the job", async () => {
    const q = new SpeechQueue();
    const ac = new AbortController();
    ac.abort();
    let sawAborted = false;
    await q.play(async (signal) => {
      sawAborted = signal.aborted;
    }, ac.signal);
    expect(sawAborted).toBe(true);
  });
});
