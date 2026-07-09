import { describe, it, expect, vi } from "vitest";
import {
  RelayScheduler,
  relaySongFromUrl,
  resolveRelayFromProfile,
} from "./relay.js";

describe("resolveRelayFromProfile", () => {
  it("returns null when no relayUrl", () => {
    expect(resolveRelayFromProfile({})).toBeNull();
    expect(resolveRelayFromProfile({ relayUrl: null })).toBeNull();
    expect(resolveRelayFromProfile({ relayUrl: "  " })).toBeNull();
  });

  it("accepts public stream URL with default interval", () => {
    const r = resolveRelayFromProfile({
      relayUrl: "https://icecast.example.org:8000/radio.mp3",
    });
    expect(r).toEqual({
      relayUrl: "https://icecast.example.org:8000/radio.mp3",
      bumperIntervalSec: 300,
    });
  });

  it("honors custom bumper interval", () => {
    const r = resolveRelayFromProfile({
      relayUrl: "https://stream.example.com/live",
      relayBumperIntervalSec: 60,
    });
    expect(r?.bumperIntervalSec).toBe(60);
  });

  it("rejects private / non-http URLs", () => {
    expect(resolveRelayFromProfile({ relayUrl: "http://127.0.0.1:8000/x" })).toBeNull();
    expect(resolveRelayFromProfile({ relayUrl: "ftp://x/y" })).toBeNull();
  });
});

describe("relaySongFromUrl", () => {
  it("builds a stream-platform song from the URL", () => {
    const s = relaySongFromUrl("https://icecast.example.org:8000/station.mp3");
    expect(s.platform).toBe("stream");
    expect(s.id).toBe("https://icecast.example.org:8000/station.mp3");
    expect(s.name).toMatch(/station/i);
    expect(s.artist).toBe("Relay");
  });
});

describe("RelayScheduler", () => {
  it("fires onBumper on the interval via injectable timers", async () => {
    const onBumper = vi.fn(async () => {});
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const scheduler = new RelayScheduler({
      onBumper,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      now: () => 1_000_000,
    });

    const started = scheduler.start({
      relayUrl: "https://icecast.example.org:8000/live",
      bumperIntervalSec: 120,
    });
    expect(started).toBe(true);
    expect(scheduler.active).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(120_000);

    // Simulate timer fire (async arm re-schedules after onBumper)
    timers[0]!.fn();
    await vi.waitFor(() => expect(onBumper).toHaveBeenCalledOnce());
    expect(scheduler.tickCount).toBe(1);
    expect(scheduler.status().relayUrl).toContain("icecast.example.org");
    await vi.waitFor(() => expect(timers.length).toBeGreaterThanOrEqual(2));

    scheduler.stop();
    expect(scheduler.active).toBe(false);
  });

  it("start(null) stops and does not schedule", () => {
    const onBumper = vi.fn();
    const scheduler = new RelayScheduler({ onBumper });
    expect(scheduler.start(null)).toBe(false);
    expect(onBumper).not.toHaveBeenCalled();
  });

  it("tickNow drives the real onBumper path", async () => {
    const onBumper = vi.fn(async () => {});
    const scheduler = new RelayScheduler({
      onBumper,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    });
    scheduler.start({
      relayUrl: "https://stream.example.com/a",
      bumperIntervalSec: 10,
    });
    await scheduler.tickNow();
    expect(onBumper).toHaveBeenCalledOnce();
  });

  it("stop/start(null) during in-flight onBumper does not re-arm", async () => {
    let resolveBumper!: () => void;
    const bumperPending = new Promise<void>((r) => {
      resolveBumper = r;
    });
    const onBumper = vi.fn(() => bumperPending);
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const clearTimer = vi.fn();
    const scheduler = new RelayScheduler({
      onBumper,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer,
      now: () => 1_000_000,
    });

    expect(
      scheduler.start({
        relayUrl: "https://icecast.example.org:8000/live",
        bumperIntervalSec: 30,
      }),
    ).toBe(true);
    expect(timers).toHaveLength(1);

    // Fire timer → onBumper starts but does not resolve yet
    timers[0]!.fn();
    await vi.waitFor(() => expect(onBumper).toHaveBeenCalledOnce());
    const ticksAfterFire = scheduler.tickCount;
    expect(ticksAfterFire).toBe(1);

    // Leave relay while bumper is in flight (same as !radio off / library ops)
    scheduler.stop();
    // Also exercise start(null) path used by BotInstance.onRelayChanged
    expect(scheduler.start(null)).toBe(false);

    expect(scheduler.getConfig()).toBeNull();
    expect(scheduler.active).toBe(false);
    const timerCountAfterStop = timers.length;

    // Resolve in-flight bumper — must NOT re-arm
    resolveBumper();
    await bumperPending;
    await Promise.resolve();
    await Promise.resolve();

    expect(timers.length).toBe(timerCountAfterStop); // no new arm
    expect(scheduler.tickCount).toBe(ticksAfterFire);
    expect(scheduler.active).toBe(false);
    expect(scheduler.getConfig()).toBeNull();
  });
});
