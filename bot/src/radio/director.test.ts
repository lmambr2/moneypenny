import { describe, it, expect, vi, beforeEach } from "vitest";
import { RadioDirector, type BuiltBumper } from "./director.js";
import { defaultRadioConfig, type RadioConfig } from "./types.js";
import type { PlayerState } from "../audio/player.js";

/** Test harness: mutable config + fakes for player, bumper factory, timers, clock. */
function harness(cfgOverrides: Partial<RadioConfig> = {}) {
  const cfg: RadioConfig = { ...defaultRadioConfig(), enabled: true, ...cfgOverrides };
  let nowMs = 1_000_000_000;
  let bumper: BuiltBumper | null = { path: "/bumpers/id.mp3", label: "id" };
  let playerState: PlayerState = "playing";
  let queueHasMore = true;
  const pendingTimers: Array<() => void> = [];

  const player = {
    getState: (): PlayerState => playerState,
    play: vi.fn(),
    resetFailures: vi.fn(),
  };
  const bumperFactory = { build: vi.fn(async () => bumper) };
  const playNext = vi.fn(async () => queueHasMore);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

  const director = new RadioDirector({
    getConfig: () => cfg,
    player,
    bumperFactory,
    playNext,
    logger,
    now: () => nowMs,
    setTimer: (fn) => {
      pendingTimers.push(fn);
      return pendingTimers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: vi.fn(),
  });

  return {
    director,
    player,
    bumperFactory,
    playNext,
    cfg,
    setNow: (ms: number) => (nowMs = ms),
    advanceNow: (ms: number) => (nowMs += ms),
    setBumper: (b: BuiltBumper | null) => (bumper = b),
    setPlayerState: (s: PlayerState) => (playerState = s),
    setQueueHasMore: (v: boolean) => (queueHasMore = v),
    fireTimers: () => {
      const fns = pendingTimers.splice(0);
      for (const fn of fns) fn();
    },
    pendingTimerCount: () => pendingTimers.length,
  };
}

describe("RadioDirector", () => {
  let h: ReturnType<typeof harness>;

  describe("disabled (byte-identical to today)", () => {
    beforeEach(() => (h = harness({ enabled: false })));

    it("just advances the queue, never a bumper", async () => {
      await h.director.onTrackBoundary();
      await h.director.onTrackBoundary();
      expect(h.playNext).toHaveBeenCalledTimes(2);
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.bumperFactory.build).not.toHaveBeenCalled();
    });
  });

  describe("every-N injection + pending-bumper guard", () => {
    beforeEach(() => {
      h = harness({ everyNSongs: 2, minPresentToBroadcast: 1 });
      h.director.onPoll([], 1); // one listener present (player is 'playing' → no dead-air arm)
    });

    it("plays a bumper after N song boundaries, then resumes without double-injecting", async () => {
      await h.director.onTrackBoundary(); // song
      await h.director.onTrackBoundary(); // song
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(2);

      await h.director.onTrackBoundary(); // bumper slot → inject
      expect(h.bumperFactory.build).toHaveBeenCalledTimes(1);
      expect(h.player.play).toHaveBeenCalledWith("/bumpers/id.mp3");
      expect(h.playNext).toHaveBeenCalledTimes(2); // did NOT advance the queue

      await h.director.onTrackBoundary(); // the bumper's own trackEnd → guard consumes it
      expect(h.player.play).toHaveBeenCalledTimes(1); // no second bumper
      expect(h.playNext).toHaveBeenCalledTimes(3); // advanced instead
    });

    it("advances (music first) when the bumper is not ready", async () => {
      h.setBumper(null);
      await h.director.onTrackBoundary(); // song
      await h.director.onTrackBoundary(); // song
      await h.director.onTrackBoundary(); // bumper slot, but build() → null
      expect(h.bumperFactory.build).toHaveBeenCalledTimes(1);
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(3); // fell through to playNext
    });
  });

  describe("gates", () => {
    it("suppresses bumpers when too few listeners are present", async () => {
      h = harness({ clock: { wheel: [{ slot: "bumper" }] }, minPresentToBroadcast: 2 });
      h.director.onPoll([], 1); // only 1 present, need 2
      await h.director.onTrackBoundary();
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(1);
    });

    it("enforces the cooldown between bumpers", async () => {
      h = harness({ clock: { wheel: [{ slot: "bumper" }] }, cooldownSeconds: 180, minPresentToBroadcast: 1 });
      h.director.onPoll([], 1);

      await h.director.onTrackBoundary(); // bumper 1
      expect(h.player.play).toHaveBeenCalledTimes(1);
      await h.director.onTrackBoundary(); // bumper's trackEnd → guard advances

      h.advanceNow(1000); // still inside the 180s cooldown
      await h.director.onTrackBoundary(); // wants a bumper but cooldown blocks
      expect(h.player.play).toHaveBeenCalledTimes(1); // no second bumper

      h.advanceNow(180_000); // cooldown elapsed
      await h.director.onTrackBoundary();
      expect(h.player.play).toHaveBeenCalledTimes(2);
    });

    it("respects quiet hours", async () => {
      h = harness({
        clock: { wheel: [{ slot: "bumper" }] },
        minPresentToBroadcast: 1,
        quietHours: [{ from: "00:00", to: "23:59" }], // effectively always quiet
      });
      h.director.onPoll([], 1);
      h.setNow(new Date(2026, 5, 30, 3, 0).getTime());
      await h.director.onTrackBoundary();
      expect(h.player.play).not.toHaveBeenCalled();
      expect(h.playNext).toHaveBeenCalledTimes(1);
    });
  });

  describe("classification floor (§6.3)", () => {
    function floorHarness(over: Partial<RadioConfig> = {}, resolveFloor?: (c: unknown[]) => string[]) {
      const hh = harness({ clock: { wheel: [{ slot: "bumper" }] }, minPresentToBroadcast: 1, ...over });
      const director = new RadioDirector({
        getConfig: () => ({ ...defaultRadioConfig(), enabled: true, clock: { wheel: [{ slot: "bumper" }] }, minPresentToBroadcast: 1, ...over }),
        player: hh.player,
        bumperFactory: hh.bumperFactory,
        playNext: hh.playNext,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
        resolveFloor,
        now: () => 1_000_000_000,
      });
      return { director, build: hh.bumperFactory.build };
    }

    it("passes the resolved floor (from polled members) to the factory", async () => {
      const resolve = vi.fn(() => ["unclassified", "restricted"]);
      const { director, build } = floorHarness({}, resolve);
      const clients = [{ uid: "a" }, { uid: "b" }];
      director.onPoll(clients, 2);
      await director.onTrackBoundary();
      expect(resolve).toHaveBeenCalledWith(clients);
      expect(build).toHaveBeenCalledWith(expect.anything(), ["unclassified", "restricted"]);
    });

    it("defaults to unclassified with no resolver or a throwing one (§14)", async () => {
      const { director, build } = floorHarness();
      director.onPoll([], 1);
      await director.onTrackBoundary();
      expect(build).toHaveBeenCalledWith(expect.anything(), ["unclassified"]);

      const { director: d2, build: b2 } = floorHarness({}, () => { throw new Error("ts down"); });
      d2.onPoll([], 1);
      await d2.onTrackBoundary();
      expect(b2).toHaveBeenCalledWith(expect.anything(), ["unclassified"]);
    });

    it("config classificationFloor override wins over the resolver", async () => {
      const { director, build } = floorHarness(
        { classificationFloor: ["unclassified"] },
        () => ["unclassified", "secret"],
      );
      director.onPoll([], 1);
      await director.onTrackBoundary();
      expect(build).toHaveBeenCalledWith(expect.anything(), ["unclassified"]);
    });
  });

  describe("dead air", () => {
    it("arms a fill timer when the queue runs dry and fills with a bumper", async () => {
      h = harness({ everyNSongs: 4, minPresentToBroadcast: 1 });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false); // queue is dry

      await h.director.onTrackBoundary(); // song slot → advance → playNext=false → arm timer
      expect(h.pendingTimerCount()).toBe(1);
      expect(h.player.play).not.toHaveBeenCalled();

      h.setPlayerState("idle"); // still idle when the timer fires
      h.fireTimers();
      await Promise.resolve();
      expect(h.bumperFactory.build).toHaveBeenCalledTimes(1);
      expect(h.player.play).toHaveBeenCalledWith("/bumpers/id.mp3");
    });

    it("does not fill if music resumed before the timer fired", async () => {
      h = harness({ minPresentToBroadcast: 1 });
      h.director.onPoll([], 1);
      h.setQueueHasMore(false);
      await h.director.onTrackBoundary();

      h.setPlayerState("playing"); // music came back
      h.fireTimers();
      await Promise.resolve();
      expect(h.player.play).not.toHaveBeenCalled();
    });
  });
});
